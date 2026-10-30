// Fake-server eval: every API provider driver answers a turn through its own wire protocol and flags a quota 429
// for failover. No real provider is called. Run: node --experimental-strip-types scripts/eval-adapters.ts
import { createServer } from "node:http";

import type { AnyProviderDriver, RuntimeEvent } from "../server/contracts.ts";
import { AnthropicDriver, GeminiDriver, OllamaCloudDriver, OpenAIResponsesDriver } from "../server/drivers/api-providers.ts";

process.env.ROOTCLAW_RETRY_SCALE = "0.001";
const ev = (event: string | null, data: unknown) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const WIRE: Record<string, { path: RegExp; body: string }> = {
  anthropic: { path: /\/messages$/, body: [
    ev("message_start", { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi from anthropic" } }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }),
    ev("message_stop", { type: "message_stop" })].join("") },
  gemini: { path: /:streamGenerateContent\?alt=sse$/, body: ev(null, { candidates: [{ content: { parts: [{ text: "hi from gemini" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } }) },
  "openai-responses": { path: /\/responses$/, body: [
    ev("response.output_text.delta", { type: "response.output_text.delta", delta: "hi from responses" }),
    ev("response.completed", { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 4 } } })].join("") },
  ollama: { path: /\/chat\/completions$/, body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi from ollama" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n` },
};

let quota = false;
let failures = 0;
const server = createServer((req, res) => {
  req.resume();
  const wire = Object.values(WIRE).find((w) => w.path.test(req.url ?? ""));
  if (!wire) { res.writeHead(404).end(JSON.stringify({ data: [] })); return; }
  if (quota) { res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "You exceeded your current quota, check billing" } })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" }).end(wire.body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

async function turn(driver: AnyProviderDriver, threadId: string) {
  const instance = await driver.create({ instanceId: driver.driverKind, displayName: driver.driverKind, enabled: true,
    config: driver.decodeConfig({ url: base, key: "fake-key", model: "m" }), environment: {} });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((e) => events.push(e));
  await instance.adapter.sendTurn({ threadId, text: "hello" });
  for (let i = 0; i < 400 && !events.some((e) => e.type === "turn.completed"); i++) await new Promise((r) => setTimeout(r, 5));
  await instance.dispose();
  return events;
}

for (const driver of [AnthropicDriver, GeminiDriver, OpenAIResponsesDriver, OllamaCloudDriver]) {
  quota = false;
  const ok = await turn(driver, `${driver.driverKind}-ok`);
  const text = ok.filter((e) => e.type === "content.delta").map((e) => (e.type === "content.delta" ? e.delta : "")).join("");
  const done = ok.find((e) => e.type === "turn.completed");
  const pass1 = done?.type === "turn.completed" && done.ok && text.includes(`hi from ${driver.driverKind === "openai-responses" ? "responses" : driver.driverKind}`)
    && JSON.stringify(done.usage) === JSON.stringify({ input: 12, output: 4 });
  quota = true;
  const failed = await turn(driver, `${driver.driverKind}-quota`);
  const error = failed.find((e) => e.type === "runtime.error");
  const pass2 = error?.type === "runtime.error" && error.limit === "engine";
  if (!pass1 || !pass2) failures++;
  console.log(`${pass1 ? "PASS" : "FAIL"} ${driver.driverKind}: streamed answer + usage`);
  console.log(`${pass2 ? "PASS" : "FAIL"} ${driver.driverKind}: 429 quota → engine limit (failover)`);
}
server.close();
process.exit(failures ? 1 : 0);
