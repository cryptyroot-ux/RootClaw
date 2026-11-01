// The native loop drives any ModelAdapter: streaming, tool rounds, usage, and the failover error contract.
import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import type { Completion, ModelAdapter, ModelRequest } from "./model-adapter.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { HttpStatusError } from "./retry.ts";

process.env.ROOTCLAW_RETRY_SCALE ??= "0.001";

const done = (text: string, extra: Partial<Completion> = {}): Completion => ({
  text, reasoning: "", usage: { input: 10, output: 2 }, toolCalls: [], finishReason: "stop", protocolReasoning: "", protocolReasoningDetails: [], ...extra,
});

async function run(adapter: ModelAdapter) {
  const runtime = createOpenAIChatRuntime({
    input: { instanceId: "fake", displayName: "Fake", enabled: true, config: {}, environment: {} },
    driverKind: "fake", apiKey: "k", apiUrl: "https://fake.invalid/v1", adapter,
    models: () => ({ default: "m", options: [{ id: "m", label: "m" }] }),
    requestBody: () => { throw new Error("the OpenAI wire path must not run"); },
    httpErrorLabel: "Fake", missingKeyError: "no key", unavailableReason: "no key", timeoutMs: 10_000, includeUsageInCompleted: true,
    nativeLog: { source: "fake", outgoing: () => ({}), incoming: () => ({}) },
  });
  const events: RuntimeEvent[] = [];
  runtime.adapter.onEvent((event) => events.push(event));
  await runtime.adapter.sendTurn({ threadId: "t", text: "hi", cwd: undefined });
  for (let i = 0; i < 400 && !events.some((e) => e.type === "turn.completed"); i++) await new Promise((r) => setTimeout(r, 5));
  await runtime.dispose();
  return events;
}

describe("ModelAdapter seam", () => {
  it("streams the adapter's deltas and reports its usage", async () => {
    const seen: ModelRequest[] = [];
    const events = await run({ protocol: "fake", complete: async (request) => {
      seen.push(request);
      request.onDelta?.("Hel", "assistant_text");
      request.onDelta?.("lo", "assistant_text");
      return done("Hello");
    } });
    expect(seen[0]).toMatchObject({ model: "m", stream: true });
    expect(seen[0]!.messages.at(-1)).toMatchObject({ role: "user" });
    expect(events.filter((e) => e.type === "content.delta").map((e) => e.type === "content.delta" ? e.delta : "").join("")).toBe("Hello");
    const completed = events.find((e) => e.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true, usage: { input: 10, output: 2 } });
  });

  it("feeds an adapter's HTTP failure into retry and failover", async () => {
    let calls = 0;
    const events = await run({ protocol: "fake", complete: async () => {
      calls++;
      throw new HttpStatusError("Fake HTTP 429: You exceeded your current quota", 429);
    } });
    expect(calls).toBe(1);
    const error = events.find((e) => e.type === "runtime.error");
    expect(error).toMatchObject({ limit: "engine" });
  });
});

describe("tool calls with no finish reason (audit N06d)", () => {
  const call = { id: "c1", type: "function" as const, function: { name: "write_file", arguments: "{\"path\":\"a.txt\",\"content\":\"x\"}" } };
  const rounds = (protocol: string) => {
    const seen: number[] = [];
    let n = 0;
    const adapter: ModelAdapter = { protocol, complete: async () => {
      seen.push(++n);
      return n === 1 ? done("", { toolCalls: [call], finishReason: null }) : done("ok");
    } };
    return { adapter, seen };
  };
  it("an Anthropic round never runs them: the engine asks for the round again", async () => {
    const { adapter, seen } = rounds("anthropic-messages");
    const events = await run(adapter);
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.retrying", reason: "malformed_tool_call" }));
    expect(JSON.stringify(events)).not.toContain("write_file");
    expect(seen.length).toBe(2);
  });
  it("an OpenAI-compatible round that ended on [DONE] without one still runs them", async () => {
    const { adapter, seen } = rounds("openai-chat");
    const events = await run(adapter);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "turn.retrying" }));
    expect(JSON.stringify(events)).toContain("write_file");
    expect(seen.length).toBe(2);
  });
});
