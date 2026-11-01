// Long-thread context eval for the native engine. No real API: fake provider servers (OpenAI chat, Anthropic Messages,
// Gemini, OpenAI Responses) enforce a small context limit while a scripted model drives tool rounds with large outputs
// and planted facts.
// Usage: npm run eval:context  (writes evals/reports/context-eval.md)
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

process.env.ROOTCLAW_RETRY_SCALE ??= "0.001";
const work = mkdtempSync(join(tmpdir(), "rootclaw-context-eval-"));
process.env.ROOTCLAW_DATA_DIR ??= join(work, "data");
const { OpenAICompatDriver } = await import("../../server/drivers/openai-compat.ts");
const { AnthropicDriver, GeminiDriver, OpenAIResponsesDriver } = await import("../../server/drivers/api-providers.ts");
type RuntimeEvent = import("../../server/contracts.ts").RuntimeEvent;

type Wire = "openai" | "anthropic" | "gemini" | "responses";
interface Scenario {
  id: string; name: string; wire: Wire; kind: "dump" | "paste";
  advertisedWindow?: number; enforcedLimit: number; turns: number; roundsPerTurn: number; outputBytes: number;
  carryTranscript?: boolean; minCumulativeWindows?: number;
}
const SCENARIOS: Scenario[] = [
  { id: "ctx-budget", name: "budget (window 8k, enforced 8k)", wire: "openai", kind: "dump", advertisedWindow: 8_000, enforcedLimit: 8_000, turns: 4, roundsPerTurn: 50, outputBytes: 6_000 },
  { id: "ctx-overflow", name: "overflow (advertised 16k, enforced 8k)", wire: "openai", kind: "dump", advertisedWindow: 16_000, enforcedLimit: 8_000, turns: 4, roundsPerTurn: 50, outputBytes: 6_000 },
  { id: "ctx-giant-paste", name: "giant paste (3× window user message, enforced 8k)", wire: "openai", kind: "paste", advertisedWindow: 8_000, enforcedLimit: 8_000, turns: 1, roundsPerTurn: 0, outputBytes: 0 },
  { id: "ctx-wire-openai", name: "OpenAI chat wire (advertised 16k, enforced 8k)", wire: "openai", kind: "dump", advertisedWindow: 16_000, enforcedLimit: 8_000, turns: 2, roundsPerTurn: 30, outputBytes: 6_000 },
  { id: "ctx-wire-anthropic", name: "Anthropic Messages wire (unknown window, enforced 8k)", wire: "anthropic", kind: "dump", enforcedLimit: 8_000, turns: 2, roundsPerTurn: 30, outputBytes: 6_000 },
  { id: "ctx-wire-gemini", name: "Gemini wire (unknown window, enforced 8k)", wire: "gemini", kind: "dump", enforcedLimit: 8_000, turns: 2, roundsPerTurn: 30, outputBytes: 6_000 },
  { id: "ctx-wire-responses", name: "OpenAI Responses wire (unknown window, enforced 8k, refusal names no limit)", wire: "responses", kind: "dump", enforcedLimit: 8_000, turns: 2, roundsPerTurn: 30, outputBytes: 6_000 },
  { id: "ctx-long-thread", name: "long thread (24 turns, transcript carried, enforced 8k)", wire: "openai", kind: "dump", advertisedWindow: 16_000, enforcedLimit: 8_000, turns: 24, roundsPerTurn: 12, outputBytes: 6_000, carryTranscript: true, minCumulativeWindows: 50 },
];

const serverTokens = (body: unknown) => Math.ceil(JSON.stringify(body).length / 4);
const FACT = /FACT-[A-Za-z0-9]+=[A-Za-z0-9]+/g;
const facts = (text: string) => new Set(text.match(FACT) ?? []);
const PASTE_FACT = "FACT-paste=v4242";
const PASTE_HEAD = "PASTE-HEAD-MARKER";
const PASTE_TAIL = "PASTE-TAIL-MARKER";

function toolServerScript(dir: string, outputBytes: number) {
  const script = join(dir, `fake-dump-mcp-${outputBytes}.mjs`);
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

function pasteText(tokens: number) {
  const chars = tokens * 4;
  const line = (i: number) => `row ${i}: the quick brown fox jumps over the lazy dog near the river bank\n`;
  const rows: string[] = [];
  let length = 0, i = 0;
  while (length < chars / 2) { const row = line(i++); rows.push(row); length += row.length; }
  rows.push(`${PASTE_FACT}\n`);
  while (length < chars) { const row = line(i++); rows.push(row); length += row.length; }
  return `${PASTE_HEAD}\n${rows.join("")}${PASTE_TAIL}`;
}

type Item = { kind: "text"; role: string; text: string } | { kind: "call"; id: string; name: string; args: Record<string, unknown> } | { kind: "result"; id: string; text: string };
interface Parsed { items: Item[]; sized: unknown; stream: boolean; maxOut?: number }
type J = Record<string, any>;
const textOf = (value: unknown): string => typeof value === "string" ? value
  : Array.isArray(value) ? value.map((part) => typeof part === "string" ? part : String((part as J)?.text ?? "")).join("") : "";
const argsOf = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") { try { return JSON.parse(value || "{}"); } catch { return {}; } }
  return (value ?? {}) as Record<string, unknown>;
};

function parse(wire: Wire, url: string, body: J): Parsed {
  const items: Item[] = [];
  if (wire === "openai") {
    for (const m of body.messages ?? []) {
      if (m.role === "tool") items.push({ kind: "result", id: m.tool_call_id, text: textOf(m.content) });
      else {
        const text = textOf(m.content);
        if (text) items.push({ kind: "text", role: m.role, text });
        for (const c of m.tool_calls ?? []) items.push({ kind: "call", id: c.id, name: c.function.name, args: argsOf(c.function.arguments) });
      }
    }
    return { items, sized: { messages: body.messages, tools: body.tools }, stream: Boolean(body.stream), maxOut: body.max_tokens ?? body.max_completion_tokens };
  }
  if (wire === "anthropic") {
    for (const s of body.system ?? []) items.push({ kind: "text", role: "system", text: s.text });
    for (const m of body.messages ?? []) {
      for (const b of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) {
        if (b.type === "text") items.push({ kind: "text", role: m.role, text: b.text });
        else if (b.type === "tool_use") items.push({ kind: "call", id: b.id, name: b.name, args: argsOf(b.input) });
        else if (b.type === "tool_result") items.push({ kind: "result", id: b.tool_use_id, text: textOf(b.content) });
      }
    }
    return { items, sized: { system: body.system, messages: body.messages, tools: body.tools }, stream: Boolean(body.stream), maxOut: body.max_tokens };
  }
  if (wire === "gemini") {
    for (const p of body.systemInstruction?.parts ?? []) items.push({ kind: "text", role: "system", text: p.text });
    for (const c of body.contents ?? []) {
      for (const p of c.parts) {
        if (typeof p.text === "string") items.push({ kind: "text", role: c.role, text: p.text });
        else if (p.functionCall) items.push({ kind: "call", id: p.functionCall.id, name: p.functionCall.name, args: argsOf(p.functionCall.args) });
        else if (p.functionResponse) items.push({ kind: "result", id: p.functionResponse.id, text: textOf(p.functionResponse.response?.result ?? p.functionResponse.response?.error) });
      }
    }
    return { items, sized: { systemInstruction: body.systemInstruction, contents: body.contents, tools: body.tools }, stream: url.includes("streamGenerateContent"), maxOut: body.generationConfig?.maxOutputTokens };
  }
  if (body.instructions) items.push({ kind: "text", role: "system", text: body.instructions });
  for (const i of body.input ?? []) {
    if (i.type === "function_call") items.push({ kind: "call", id: i.call_id, name: i.name, args: argsOf(i.arguments) });
    else if (i.type === "function_call_output") items.push({ kind: "result", id: i.call_id, text: textOf(i.output) });
    else items.push({ kind: "text", role: i.role, text: textOf(i.content) });
  }
  return { items, sized: { instructions: body.instructions, input: body.input, tools: body.tools }, stream: Boolean(body.stream), maxOut: body.max_output_tokens };
}

function refuse(wire: Wire, res: ServerResponse, tokens: number, limit: number, maxOut = 0) {
  res.statusCode = 400;
  res.setHeader("content-type", "application/json");
  const inputFits = tokens <= limit;
  const error = wire === "openai" ? { error: { message: inputFits
      ? `This model's maximum context length is ${limit} tokens. However, you requested ${tokens + maxOut} tokens (${tokens} in the messages, ${maxOut} in the completion). Please reduce the length of the messages or completion.`
      : `This model's maximum context length is ${limit} tokens. However, your messages resulted in ${tokens} tokens.`, code: "context_length_exceeded" } }
    : wire === "anthropic" ? { type: "error", error: { type: "invalid_request_error", message: inputFits
      ? `input length and \`max_tokens\` exceed context limit: ${tokens} + ${maxOut} > ${limit}, decrease input length or \`max_tokens\` and try again`
      : `prompt is too long: ${tokens} tokens > ${limit} maximum` } }
    : wire === "gemini" ? { error: { code: 400, message: `The input token count (${tokens}) exceeds the maximum number of tokens allowed (${limit}).`, status: "INVALID_ARGUMENT" } }
    : { error: { message: "Your input exceeds the context window of this model. Please adjust your input and try again.", type: "invalid_request_error", param: "input", code: "context_length_exceeded" } };
  res.end(JSON.stringify(error));
}

const sse = (events: unknown[], done = false) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
const anthropicSse = (events: J[]) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

function reply(wire: Wire, res: ServerResponse, stream: boolean, tokens: number, out: { text: string } | { call: { id: string; name: string; args: unknown } }) {
  res.setHeader("content-type", stream ? "text/event-stream" : "application/json");
  const text = "text" in out ? out.text : "";
  const call = "call" in out ? out.call : undefined;
  if (wire === "openai") {
    const usage = { prompt_tokens: tokens, completion_tokens: 10 };
    if (!stream) return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }));
    return res.end(sse(call
      ? [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }]
      : [{ choices: [{ index: 0, delta: { content: text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }], true));
  }
  if (wire === "anthropic") {
    if (!stream) return res.end(JSON.stringify({ model: "fake-small", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: tokens, output_tokens: 10 } }));
    return res.end(anthropicSse([
      { type: "message_start", message: { usage: { input_tokens: tokens, output_tokens: 1 } } },
      call ? { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } } : { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      call ? { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } } : { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]));
  }
  if (wire === "gemini") {
    const chunk = { candidates: [{ content: { role: "model", parts: [call ? { functionCall: { id: call.id, name: call.name, args: call.args } } : { text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: tokens, candidatesTokenCount: 10 } };
    return res.end(stream ? sse([chunk]) : JSON.stringify(chunk));
  }
  const output = call ? [{ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }];
  const response = { status: "completed", output, usage: { input_tokens: tokens, output_tokens: 10 } };
  if (!stream) return res.end(JSON.stringify(response));
  return res.end(sse([...(text ? [{ type: "response.output_text.delta", delta: text }] : []), { type: "response.completed", response }]));
}

function pairingViolations(items: Item[]) {
  let violations = 0;
  items.forEach((item, index) => {
    if (item.kind === "result" && !items.slice(0, index).some((o) => o.kind === "call" && o.id === item.id)) violations++;
    if (item.kind === "call" && !items.slice(index + 1).some((o) => o.kind === "result" && o.id === item.id)) violations++;
  });
  return violations;
}

async function driverFor(s: Scenario, port: number) {
  const base = `http://127.0.0.1:${port}`;
  const common = { instanceId: `eval-${s.id}`, displayName: "Eval", enabled: true, environment: { K: "fake" } };
  if (s.wire === "openai") return OpenAICompatDriver.create({ ...common, config: OpenAICompatDriver.decodeConfig({ url: `${base}/v1`, apiKeyEnv: "K", model: "fake-small" }) });
  const driver = s.wire === "anthropic" ? AnthropicDriver : s.wire === "gemini" ? GeminiDriver : OpenAIResponsesDriver;
  return driver.create({ ...common, config: driver.decodeConfig({ url: `${base}/${s.wire === "gemini" ? "v1beta" : "v1"}`, key: "fake", model: "fake-small" }) });
}

const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => { let s = ""; req.on("data", (c) => s += c); req.on("end", () => resolve(s)); });

async function runScenario(s: Scenario) {
  const stats = { requests: 0, maxRequestTokens: 0, maxAcceptedTokens: 0, acceptedTokens: 0, rejected: 0, summaryCalls: 0, readCalls: 0, readOk: 0,
    pairingViolations: 0, reserveViolations: 0, pasteShape: false };
  let plan = { turn: 0, round: 0 };
  let callSeq = 0;
  const planted: string[][] = Array.from({ length: s.turns }, () => []);
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.includes("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fake-small", ...(s.advertisedWindow ? { context_length: s.advertisedWindow } : {}) }],
        models: [{ name: "models/fake-small", supportedGenerationMethods: ["generateContent"] }] }));
      return;
    }
    const parsed = parse(s.wire, req.url ?? "", JSON.parse(await readBody(req)));
    stats.requests++;
    const tokens = serverTokens(parsed.sized);
    stats.maxRequestTokens = Math.max(stats.maxRequestTokens, tokens);
    // Real OpenAI, Anthropic and Responses servers refuse input + max output over the window; Gemini caps output instead.
    const overWithOutput = tokens + (parsed.maxOut ?? 0) > s.enforcedLimit;
    if (overWithOutput && stats.rejected > 0) stats.reserveViolations++;
    if (tokens > s.enforcedLimit || (overWithOutput && s.wire !== "gemini")) { stats.rejected++; refuse(s.wire, res, tokens, s.enforcedLimit, parsed.maxOut); return; }
    stats.maxAcceptedTokens = Math.max(stats.maxAcceptedTokens, tokens);
    stats.acceptedTokens += tokens;
    const { items } = parsed;
    const firstText = items.find((i) => i.kind === "text" && i.role !== "system") as Extract<Item, { kind: "text" }> | undefined;
    if (!parsed.stream && items.length === 1 && firstText?.text.startsWith("You compact")) {
      // The fake summarizer keeps every planted fact it is shown (a capable model should too).
      stats.summaryCalls++;
      const kept = [...facts(firstText.text)];
      reply(s.wire, res, false, tokens, { text: `## Goal\n- run the steps\n## Facts and constraints\n${kept.map((f) => `- ${f}`).join("\n") || "- none"}\n## Open todos / next steps\n- continue` });
      return;
    }
    stats.pairingViolations += pairingViolations(items);
    const all = items.map((i) => i.kind === "call" ? JSON.stringify(i.args) : i.text).join("\n");
    const last = items.at(-1);
    const lastRead = last?.kind === "result" ? last.text.match(/\[(out_[A-Za-z0-9_-]{6,64}): characters \d+–\d+ of \d+(?:; next offset (\d+))?/) : null;
    if (lastRead) stats.readOk++;
    const id = `call_${++callSeq}`;
    if (s.kind === "paste") {
      if (!stats.pasteShape) {
        const user = items.filter((i): i is Extract<Item, { kind: "text" }> => i.kind === "text" && i.role === "user").map((i) => i.text).join("\n");
        stats.pasteShape = user.includes(PASTE_HEAD) && user.includes(PASTE_TAIL) && /handle out_[A-Za-z0-9_-]{6,64}/.test(user) && !user.includes(PASTE_FACT);
      }
      const handle = all.match(/handle (out_[A-Za-z0-9_-]{6,64})/)?.[1];
      const next = lastRead ? (lastRead[2] ? Number(lastRead[2]) : undefined) : Number(all.match(/"offset":(\d+)/)?.[1] ?? 0);
      if (!all.includes(PASTE_FACT) && handle && next !== undefined && stats.readCalls < 40) {
        stats.readCalls++;
        reply(s.wire, res, true, tokens, { call: { id, name: "read_tool_output", args: { handle, offset: next, limit: 8000 } } });
        return;
      }
      reply(s.wire, res, true, tokens, { text: `Done. Facts I still see: ${[...facts(all)].join(", ") || "none"}` });
      return;
    }
    if (plan.round < s.roundsPerTurn) {
      const r = plan.round++;
      // Every 10th step pages the previous offloaded output back.
      const handle = last?.kind === "result" ? last.text.match(/out_[A-Za-z0-9_-]{6,64}/)?.[0] : undefined;
      if (r % 10 === 9 && handle) { stats.readCalls++; reply(s.wire, res, true, tokens, { call: { id, name: "read_tool_output", args: { handle, offset: 0, limit: 500 } } }); return; }
      const fact = r % 7 === 0 ? `FACT-t${plan.turn}r${r}=v${(plan.turn * 1000 + r) * 37 % 9973}` : undefined;
      if (fact) planted[plan.turn]!.push(fact);
      reply(s.wire, res, true, tokens, { call: { id, name: "fx_dump", args: { step: r, ...(fact ? { fact } : {}) } } });
      return;
    }
    reply(s.wire, res, true, tokens, { text: `Done. Facts I still see: ${[...facts(all)].join(", ") || "none"}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const tools = toolServerScript(work, s.outputBytes || 1_000);
  const instance = await driverFor(s, port);
  await instance.refreshModels?.();
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  const logs: string[] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => { logs.push(args.join(" ")); };
  const results: Array<{ turn: number; ok: boolean; error?: string; planted: number; retained: number }> = [];
  const offloadDir = join(work, `offload-${s.id}`);
  const transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
  try {
    for (let turn = 0; turn < s.turns; turn++) {
      plan = { turn, round: 0 };
      const before = events.length;
      const text = s.kind === "paste" ? `Here is the log I pasted; find the FACT in it.\n${pasteText(s.enforcedLimit * 3)}`
        : `Run ${s.roundsPerTurn} dump steps for batch ${turn}, then list every FACT you saw.`;
      if (s.kind === "paste") planted[turn]!.push(PASTE_FACT);
      await instance.adapter.sendTurn({ threadId: s.id, text, approvalMode: "full", ...(s.carryTranscript ? { transcript: [...transcript] } : {}),
        integrations: { custom: { fx: { command: tools, args: [], env: {} } } }, turnContext: { offloadDir, offloadBytes: 4_000 } });
      const started = Date.now();
      while (!events.slice(before).some((e) => e.type === "turn.completed")) {
        if (Date.now() - started > 180_000) throw new Error("turn timed out");
        await new Promise((r) => setTimeout(r, 20));
      }
      const mine = events.slice(before);
      const done = mine.find((e) => e.type === "turn.completed") as Extract<RuntimeEvent, { type: "turn.completed" }>;
      const error = mine.find((e) => e.type === "runtime.error") as { message?: string } | undefined;
      const answer = mine.filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text").map((e) => (e as { text: string }).text).join("\n");
      const said = facts(answer);
      results.push({ turn, ok: done.ok, ...(error?.message ? { error: error.message.slice(0, 200) } : {}), planted: planted[turn]!.length, retained: planted[turn]!.filter((f) => said.has(f)).length });
      transcript.push({ role: "user", text }, { role: "assistant", text: answer || "(no answer)" });
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
  "Fake provider servers (OpenAI chat, Anthropic Messages, Gemini, OpenAI Responses), scripted model, no real API quota.",
  "Request size is the server's own count (JSON chars / 4); OpenAI, Anthropic and Responses refuse input + max output over the limit; each refusal uses that provider's own wording.", ""];
let pass = true;
for (const run of runs) {
  const planted = run.results.reduce((n, r) => n + r.planted, 0);
  const retained = run.results.reduce((n, r) => n + r.retained, 0);
  const survived = run.results.every((r) => r.ok);
  const underLimit = run.stats.maxAcceptedTokens <= run.s.enforcedLimit;
  const learnedOnce = run.stats.rejected <= 1;
  const retention = planted ? retained / planted : 1;
  const cumulative = run.stats.acceptedTokens / run.s.enforcedLimit;
  const checks = [survived, underLimit, learnedOnce, run.stats.pairingViolations === 0, run.stats.reserveViolations === 0,
    run.s.minCumulativeWindows ? retention >= 0.95 && cumulative >= run.s.minCumulativeWindows : retained === planted,
    run.s.kind === "paste" ? run.stats.pasteShape && run.stats.readOk > 0 : true];
  const ok = checks.every(Boolean);
  pass &&= ok;
  lines.push(`## ${run.s.id}: ${run.s.name}`, "",
    "| Metric | Value |", "|---|---|",
    `| Wire | ${run.s.wire} |`,
    run.s.kind === "paste" ? `| User message | ${run.s.enforcedLimit * 3} tokens (3× enforced limit), fact planted mid-paste |`
      : `| Turns × tool rounds | ${run.s.turns} × ${run.s.roundsPerTurn} (${run.s.turns * run.s.roundsPerTurn} rounds, ${run.s.outputBytes}-byte outputs${run.s.carryTranscript ? ", transcript carried" : ""}) |`,
    `| Thread survived (no fatal error) | ${survived ? "YES" : "NO"} (${run.results.filter((r) => r.ok).length}/${run.results.length} turns ok) |`,
    `| Model requests | ${run.stats.requests} (summaries ${run.stats.summaryCalls}) |`,
    `| Max accepted request tokens | ${run.stats.maxAcceptedTokens} (enforced limit ${run.s.enforcedLimit}) |`,
    `| Max request tokens incl. rejected | ${run.stats.maxRequestTokens} |`,
    `| Requests rejected as too large | ${run.stats.rejected} (forced overflow compactions: ${run.overflowCompactions}) |`,
    `| Cumulative accepted input | ${run.stats.acceptedTokens} tokens (${cumulative.toFixed(1)}× enforced limit) |`,
    `| Pairing violations (orphan result or unanswered call) | ${run.stats.pairingViolations} |`,
    `| Input + max output over limit (after learning) | ${run.stats.reserveViolations} |`,
    `| Compactions | ${run.compactions} |`,
    `| Outputs or messages offloaded | ${run.offloads} |`,
    `| read_tool_output pages ok | ${run.stats.readOk}/${run.stats.readCalls} |`,
    ...(run.s.kind === "paste" ? [`| Request kept head, tail and handle (middle omitted) | ${run.stats.pasteShape ? "YES" : "NO"} |`] : []),
    `| Fact retention | ${retained}/${planted} (${Math.round(retention * 100)}%) |`,
    `| Scenario | ${ok ? "PASS" : "FAIL"} |`, "");
  for (const r of run.results) if (!r.ok) lines.push(`- turn ${r.turn} failed: ${r.error ?? "unknown"}`);
}
lines.push(`**Result: ${pass ? "PASS" : "FAIL"}**`, "");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "reports", "context-eval.md");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n"));
console.log(lines.join("\n"));
process.exit(pass ? 0 : 1);
