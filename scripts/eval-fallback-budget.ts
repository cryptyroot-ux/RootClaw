// Fake-server eval for the native fallback chain and budget guard. No real provider is called.
// Run: node --experimental-strip-types scripts/eval-fallback-budget.ts
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeEvent, SendTurnInput } from "../server/contracts.ts";
import { OpenAICompatDriver } from "../server/drivers/openai-compat.ts";
import { LimitFailovers } from "../server/limit-failover.ts";
import { LimitResetClock } from "../server/limit-resets.ts";

process.env.ROOTCLAW_RETRY_SCALE = "0.001";
type Mode = "ok" | "quota" | "tools";
const answer = (text: string, tokens = 20) => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: tokens, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`;
const toolRound = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "nope", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 900, completion_tokens: 200 } })}\n\ndata: [DONE]\n\n`;

function fake(name: string): Promise<{ server: Server; url: string; mode: { value: Mode }; hits: { n: number } }> {
  const mode = { value: "ok" as Mode }, hits = { n: 0 };
  const server = createServer((req, res) => {
    if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    hits.n++;
    req.resume();
    if (mode.value === "quota") { res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "You exceeded your current quota", code: "insufficient_quota" } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" }).end(mode.value === "tools" ? toolRound : answer(`answer from ${name}`));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    resolve({ server, url: `http://127.0.0.1:${port}/v1`, mode, hits });
  }));
}

async function engine(id: string, url: string) {
  return OpenAICompatDriver.create({ instanceId: id, displayName: id, enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url, apiKeyEnv: "FAKE_KEY", model: "m1" }), environment: { FAKE_KEY: "fake" } });
}

async function turn(instance: Awaited<ReturnType<typeof engine>>, threadId: string, extra: Partial<SendTurnInput> = {}) {
  const events: RuntimeEvent[] = [];
  const off = instance.adapter.onEvent((event) => { if (event.threadId === threadId) events.push(event); });
  await instance.adapter.sendTurn({ threadId, text: "hi", ...extra });
  for (let i = 0; i < 500 && !events.some((e) => e.type === "turn.completed"); i++) await new Promise((r) => setTimeout(r, 10));
  if (typeof off === "function") off();
  return events;
}

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => { checks.push([name, ok]); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); };

let clock = Date.now();
const dir = mkdtempSync(join(tmpdir(), "rootclaw-eval-"));
const [p, b] = await Promise.all([fake("primary"), fake("backup")]);
const engines = { primary: await engine("primary", p.url), backup: await engine("backup", b.url) };
const chain = ["primary", "backup"] as const;
const limits = new LimitResetClock({ accounts: () => [], now: () => clock, file: join(dir, "limit-holds.json") });
let current: string = "primary";
const notes: string[] = [];
const failovers = new LimitFailovers({ file: join(dir, "limit-failovers.json"), now: () => clock, blockedUntil: (e) => limits.blockedUntil(e),
  threadModel: () => ({ instanceId: current, model: "m1" }), switchBack: (row) => { current = row.from.instanceId; return true; },
  note: (_t, line) => notes.push(line), engineName: (e) => e });

// 1. A quota 429 on the primary: the next entry in the chain answers.
p.mode.value = "quota";
const failed = await turn(engines.primary, "t1");
for (const event of failed) limits.noteRuntimeEvent("primary", event);
const error = failed.find((e) => e.type === "runtime.error");
check("primary 429-quota flags an engine limit", error?.type === "runtime.error" && error.limit === "engine");
const next = chain.find((id) => id !== current && limits.blockedUntil(id) === null);
check("chain picks the backup while the primary is held", next === "backup" && limits.blockedUntil("primary") !== null);
failovers.record({ botId: "bot", threadId: "t1", from: { instanceId: "primary", model: "m1" }, to: { instanceId: "backup", model: "m1" }, resetsAt: null, at: clock });
current = "backup";
const carried = await turn(engines.backup, "t1");
check("backup answers the same request", carried.some((e) => e.type === "item.completed" && "text" in e && /answer from backup/.test(String(e.text))));

// 2. Cooldown: before it nothing moves; after it the thread returns to the primary, which answers again.
check("no return before the cooldown", failovers.restore("bot", "t1") === false && current === "backup");
p.mode.value = "ok";
clock += 25 * 60 * 60_000;
check("returns to the primary after the cooldown", failovers.restore("bot", "t1") === true && current === "primary" && notes.length === 1);
const back = await turn(engines.primary, "t1b");
check("primary answers after return", back.some((e) => e.type === "item.completed" && "text" in e && /answer from primary/.test(String(e.text))));
const reloaded = new LimitFailovers({ file: join(dir, "limit-failovers.json"), blockedUntil: () => null, threadModel: () => null, switchBack: () => true, note: () => {}, engineName: (e) => e });
check("failover rows persist to disk (cleared after return)", reloaded.list().length === 0);

// 3. Budget: a turn over its cap stops cleanly before another round.
b.mode.value = "tools";
const before = b.hits.n;
const capped = await turn(engines.backup, "t2", { budget: { tokens: 1_000, warnAtPercent: 80, why: "per-turn token cap of 1,000 tokens" } });
const done = capped.find((e) => e.type === "turn.completed");
const said = capped.find((e) => e.type === "runtime.error");
check("budget stop ends the turn with stopReason budget and a clear message", done?.type === "turn.completed" && done.stopReason === "budget"
  && said?.type === "runtime.error" && /reached its budget/.test(said.message) && b.hits.n - before === 1);

await Promise.all([engines.primary.dispose(), engines.backup.dispose()]);
p.server.close(); b.server.close();
const failedChecks = checks.filter(([, ok]) => !ok).length;
console.log(`${checks.length - failedChecks}/${checks.length} checks passed`);
process.exit(failedChecks ? 1 : 0);
