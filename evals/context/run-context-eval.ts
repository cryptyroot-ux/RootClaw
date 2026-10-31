// Long-thread context eval for the native engine. No real API: a fake OpenAI-compatible server enforces a small
// context limit while a scripted model drives ~200 tool rounds with large outputs and planted facts.
// Usage: npm run eval:context  (writes evals/reports/context-eval.md)
import { createServer, type IncomingMessage } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

process.env.ROOTCLAW_RETRY_SCALE ??= "0.001";
const work = mkdtempSync(join(tmpdir(), "rootclaw-context-eval-"));
process.env.ROOTCLAW_DATA_DIR ??= join(work, "data");
const { OpenAICompatDriver } = await import("../../server/drivers/openai-compat.ts");
type RuntimeEvent = import("../../server/contracts.ts").RuntimeEvent;

interface Scenario { name: string; advertisedWindow: number; enforcedLimit: number; turns: number; roundsPerTurn: number; outputBytes: number }
const SCENARIOS: Scenario[] = [
  { name: "budget (window 8k, enforced 8k)", advertisedWindow: 8_000, enforcedLimit: 8_000, turns: 4, roundsPerTurn: 50, outputBytes: 6_000 },
  { name: "overflow (advertised 16k, enforced 8k)", advertisedWindow: 16_000, enforcedLimit: 8_000, turns: 4, roundsPerTurn: 50, outputBytes: 6_000 },
];

const serverTokens = (body: unknown) => Math.ceil(JSON.stringify(body).length / 4);
const FACT = /FACT-[A-Za-z0-9]+=[A-Za-z0-9]+/g;
const facts = (text: string) => new Set(text.match(FACT) ?? []);

function toolServerScript(dir: string, outputBytes: number) {
  const script = join(dir, "fake-dump-mcp.mjs");
  writeFileSync(script, `#!/usr/bin/env node
    const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk; let nl;
      while ((nl = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        const m = JSON.parse(line);
        if (m.method === "initialize") send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2024-11-05",capabilities:{tools:{}}}});
        else if (m.method === "tools/list") send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"dump",description:"Return a big log",inputSchema:{type:"object",properties:{step:{type:"integer"},fact:{type:"string"}},additionalProperties:false}}]}});
        else if (m.method === "tools/call") {
          const a = m.params.arguments || {};
          const head = (a.fact ? a.fact + " " : "") + "log for step " + a.step + "\\n";
          let body = head; let i = 0;
          while (body.length < ${outputBytes}) body += "step " + a.step + " line " + (i++) + " lorem ipsum dolor sit amet\\n";
          send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:body}]}});
        }
      }
    });`);
  chmodSync(script, 0o755);
  return script;
}

const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => { let s = ""; req.on("data", (c) => s += c); req.on("end", () => resolve(s)); });
const sseText = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\ndata: [DONE]\n\n`;
const sseCall = (id: string, name: string, args: unknown) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`;

async function runScenario(s: Scenario) {
  const stats = { requests: 0, maxRequestTokens: 0, maxAcceptedTokens: 0, rejected: 0, summaryCalls: 0, readCalls: 0, readOk: 0 };
  let plan = { turn: 0, round: 0 };
  let callSeq = 0;
  let pendingRead = "";
  const planted: string[][] = Array.from({ length: s.turns }, () => []);
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fake-small", context_length: s.advertisedWindow }] }));
      return;
    }
    const body = JSON.parse(await readBody(req));
    stats.requests++;
    const tokens = serverTokens({ messages: body.messages, tools: body.tools });
    stats.maxRequestTokens = Math.max(stats.maxRequestTokens, tokens);
    if (tokens > s.enforcedLimit) {
      stats.rejected++;
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: `This model's maximum context length is ${s.enforcedLimit} tokens. However, your messages resulted in ${tokens} tokens.`, code: "context_length_exceeded" } }));
      return;
    }
    stats.maxAcceptedTokens = Math.max(stats.maxAcceptedTokens, tokens);
    const all = JSON.stringify(body.messages);
    const first = body.messages[0];
    res.setHeader("content-type", body.stream ? "text/event-stream" : "application/json");
    if (!body.stream && body.messages.length === 1 && String(first.content).startsWith("You compact")) {
      // The fake summarizer keeps every planted fact it is shown (a capable model should too).
      stats.summaryCalls++;
      const kept = [...facts(String(first.content))];
      res.end(JSON.stringify({ choices: [{ message: { content: `## Goal\n- run the dump steps\n## Facts and constraints\n${kept.map((f) => `- ${f}`).join("\n") || "- none"}\n## Open todos / next steps\n- continue` }, finish_reason: "stop" }] }));
      return;
    }
    const last = body.messages.at(-1);
    if (last.role === "tool" && pendingRead === last.tool_call_id) {
      try { const r = JSON.parse(last.content); if (r.ok && String(r.result).startsWith("[out_")) stats.readOk++; } catch {}
    }
    if (plan.round < s.roundsPerTurn) {
      const r = plan.round++;
      const id = `call_${++callSeq}`;
      // Every 10th step pages the previous offloaded output back.
      const handle = last.role === "tool" ? String(last.content).match(/out_[A-Za-z0-9_-]{6,64}/)?.[0] : undefined;
      if (r % 10 === 9 && handle) { stats.readCalls++; pendingRead = id; res.end(sseCall(id, "read_tool_output", { handle, offset: 0, limit: 500 })); return; }
      const fact = r % 7 === 0 ? `FACT-t${plan.turn}r${r}=v${(plan.turn * 1000 + r) * 37 % 9973}` : undefined;
      if (fact) planted[plan.turn]!.push(fact);
      res.end(sseCall(id, "fx_dump", { step: r, ...(fact ? { fact } : {}) }));
      return;
    }
    const seen = facts(all);
    res.end(sseText(`Done. Facts I still see: ${[...seen].join(", ") || "none"}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const tools = toolServerScript(work, s.outputBytes);
  const instance = await OpenAICompatDriver.create({
    instanceId: "eval", displayName: "Eval", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "K", model: "fake-small" }),
    environment: { K: "fake" },
  });
  await instance.refreshModels?.();
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  const logs: string[] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => { logs.push(args.join(" ")); };
  const results: Array<{ turn: number; ok: boolean; error?: string; planted: number; retained: number }> = [];
  const offloadDir = join(work, `offload-${s.enforcedLimit}-${s.advertisedWindow}`);
  try {
    for (let turn = 0; turn < s.turns; turn++) {
      plan = { turn, round: 0 };
      const before = events.length;
      await instance.adapter.sendTurn({ threadId: `ctx-${s.advertisedWindow}`, text: `Run ${s.roundsPerTurn} dump steps for batch ${turn}, then list every FACT you saw.`,
        approvalMode: "full", integrations: { custom: { fx: { command: tools, args: [], env: {} } } }, turnContext: { offloadDir, offloadBytes: 4_000 } });
      const started = Date.now();
      while (!events.slice(before).some((e) => e.type === "turn.completed")) {
        if (Date.now() - started > 120_000) throw new Error("turn timed out");
        await new Promise((r) => setTimeout(r, 20));
      }
      const mine = events.slice(before);
      const done = mine.find((e) => e.type === "turn.completed") as Extract<RuntimeEvent, { type: "turn.completed" }>;
      const error = mine.find((e) => e.type === "runtime.error") as { message?: string } | undefined;
      const answer = mine.filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text").map((e) => (e as { text: string }).text).join("\n");
      const said = facts(answer);
      results.push({ turn, ok: done.ok, ...(error?.message ? { error: error.message.slice(0, 200) } : {}), planted: planted[turn]!.length, retained: planted[turn]!.filter((f) => said.has(f)).length });
    }
  } finally {
    console.info = info;
    await instance.dispose();
    server.close();
  }
  const compactions = logs.filter((l) => l.includes("[context] compaction"));
  return { s, stats, results, compactions: compactions.length, overflowCompactions: compactions.filter((l) => l.includes("(overflow)")).length,
    offloads: logs.filter((l) => l.includes("[context] offloaded")).length };
}

const runs = [];
for (const s of SCENARIOS) runs.push(await runScenario(s));
rmSync(work, { recursive: true, force: true });

const lines = ["# Context eval (native engine)", "", `Run: ${new Date().toISOString()}`, "",
  "Fake OpenAI-compatible server, scripted model, no real API quota. Request size is the server's own count (JSON chars / 4).", ""];
let pass = true;
for (const run of runs) {
  const planted = run.results.reduce((n, r) => n + r.planted, 0);
  const retained = run.results.reduce((n, r) => n + r.retained, 0);
  const survived = run.results.every((r) => r.ok);
  const underLimit = run.stats.maxAcceptedTokens <= run.s.enforcedLimit && run.overflowCompactions >= run.stats.rejected;
  pass &&= survived && retained === planted && underLimit;
  lines.push(`## ${run.s.name}`, "",
    "| Metric | Value |", "|---|---|",
    `| Turns × tool rounds | ${run.s.turns} × ${run.s.roundsPerTurn} (${run.s.turns * run.s.roundsPerTurn} rounds, ${run.s.outputBytes}-byte outputs) |`,
    `| Thread survived (no fatal error) | ${survived ? "YES" : "NO"} (${run.results.filter((r) => r.ok).length}/${run.results.length} turns ok) |`,
    `| Model requests | ${run.stats.requests} (summaries ${run.stats.summaryCalls}) |`,
    `| Max accepted request tokens | ${run.stats.maxAcceptedTokens} (enforced limit ${run.s.enforcedLimit}) |`,
    `| Max request tokens incl. rejected | ${run.stats.maxRequestTokens} |`,
    `| Requests rejected as too large | ${run.stats.rejected} (recovered by forced compaction: ${run.overflowCompactions}) |`,
    `| Compactions | ${run.compactions} |`,
    `| Tool outputs offloaded | ${run.offloads} |`,
    `| read_tool_output pages ok | ${run.stats.readOk}/${run.stats.readCalls} |`,
    `| Fact retention | ${retained}/${planted} (${planted ? Math.round(retained / planted * 100) : 100}%) |`, "");
  for (const r of run.results) if (!r.ok) lines.push(`- turn ${r.turn} failed: ${r.error ?? "unknown"}`);
}
lines.push(`**Result: ${pass ? "PASS" : "FAIL"}**`, "");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "reports", "context-eval.md");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n"));
console.log(lines.join("\n"));
process.exit(pass ? 0 : 1);
