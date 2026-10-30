// The native engine flags a failure the next AI in the bot's chain can take, and meters its budget.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

process.env.ROOTCLAW_RETRY_SCALE ??= "0.001";
afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

async function runTurn(reply: (call: number) => Response, extra: Partial<SendTurnInput> = {}) {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => String(url).endsWith("/chat/completions") ? reply(call++) : new Response("", { status: 404 })));
  const instance = await OpenAICompatDriver.create({
    instanceId: "primary", displayName: "Primary", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "https://llm.example/v1", apiKeyEnv: "LLM_KEY", model: "m1" }),
    environment: { LLM_KEY: "secret" },
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  await instance.adapter.sendTurn({ threadId: "thread", text: "hi", ...extra });
  await vi.waitFor(() => { if (!events.some((event) => event.type === "turn.completed")) throw new Error("running"); }, { timeout: 10_000 });
  await instance.dispose();
  const error = events.find((event) => event.type === "runtime.error");
  const done = events.find((event) => event.type === "turn.completed");
  if (done?.type !== "turn.completed") throw new Error("no completion");
  return { events, error: error?.type === "runtime.error" ? error : undefined, done };
}

describe("native fallback chain signals", () => {
  it("a quota 429 holds the engine", async () => {
    const { error } = await runTurn(() => json(429, { error: { message: "You exceeded your current quota", code: "insufficient_quota" } }));
    expect(error?.limit).toBe("engine");
  });

  it("a 5xx that outlasts retry holds the model for a cooldown", async () => {
    const before = Date.now();
    const { error } = await runTurn(() => json(503, { error: { message: "Service Unavailable" } }));
    expect(error?.limit).toBe("model");
    expect(error?.limitResetsAt).toBeGreaterThan(before + 9 * 60_000);
  });

  it("an unknown model holds the model; a bad key reads as signed out", async () => {
    expect((await runTurn(() => json(404, { error: { message: "model not found" } }))).error?.limit).toBe("model");
    const auth = await runTurn(() => json(401, { error: { message: "Invalid API key" } }));
    expect(auth.error?.limit).toBeUndefined();
    expect(auth.done.stopReason).toBe("auth_required");
  });

  it("a request the person caused never switches", async () => {
    const { error, done } = await runTurn(() => json(400, { error: { message: "Bad Request: invalid parameter" } }));
    expect(error?.limit).toBeUndefined();
    expect(done.stopReason).toBe("error");
  });
});

describe("native budget guard", () => {
  const toolRound = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"nope","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":900,"completion_tokens":200}}\n\ndata: [DONE]\n\n';
  it("stops before another round once the turn reaches its cap, with a neutral notice", async () => {
    const { error, events, done } = await runTurn(() => sse(toolRound), { budget: { tokens: 1_000, warnAtPercent: 80, why: "per-turn token cap of 1,000 tokens" } });
    // A budget stop is the person's own limit doing its job: a neutral notice, not an error, and nothing for failover.
    expect(done.stopReason).toBe("budget");
    expect(done.ok).toBe(true);
    expect(error).toBeUndefined();
    expect(events.filter((event) => event.type === "runtime.notice" && /reached its budget \(per-turn token cap of 1,000 tokens\)/.test(event.message))).toHaveLength(1);
  });

  it("warns once at the warn line", async () => {
    let n = 0;
    const answer = 'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":850,"completion_tokens":10}}\n\ndata: [DONE]\n\n';
    const { events, done } = await runTurn(() => sse(n++ === 0 ? answer : answer), { budget: { tokens: 1_000, warnAtPercent: 80, why: "cap" } });
    expect(done.ok).toBe(true);
    expect(events.filter((event) => event.type === "runtime.notice" && /80% of its budget/.test(event.message))).toHaveLength(1);
  });
});

describe("native run record", () => {
  it("a normal finish says end_turn", async () => {
    const { done } = await runTurn(() => sse(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
  });

  it("records a quota failure as a failed run on its model, flagged for the chain", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createRunStore } = await import("../run-store.ts");
    const { setRunRecorder } = await import("./openai-chat.ts");
    const dir = mkdtempSync(join(tmpdir(), "native-runs-"));
    const runs = createRunStore({ dataDir: dir });
    setRunRecorder(runs);
    try {
      const { done } = await runTurn(() => json(429, { error: { message: "You exceeded your current quota", code: "insufficient_quota" } }), { botId: "b1" });
      const run = createRunStore({ dataDir: dir }).get(done.turnId!)!;
      expect(run).toMatchObject({ botId: "b1", threadId: "thread", instanceId: "primary", chain: ["m1"], status: "failed", failover: true });
      expect(run.errors.length).toBe(1);
      expect(run.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      setRunRecorder(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
