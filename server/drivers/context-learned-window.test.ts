import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";
import { contextWindowFor, contextWindowInfo, learnContextWindow } from "../context-budget.ts";
import { overflowLimit } from "./turn-context.ts";

afterEach(() => { vi.unstubAllGlobals(); });

describe("overflowLimit", () => {
  it.each([
    ["OpenAI / vLLM", "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.", 8192],
    ["Anthropic", "prompt is too long: 210,000 tokens > 200,000 maximum", 200_000],
    ["Anthropic (input + max_tokens)", "input length and `max_tokens` exceed context limit: 196407 + 8192 > 200000, decrease input length or `max_tokens` and try again", 200_000],
    ["Gemini", "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).", 1_048_576],
    ["llama.cpp", "the request exceeds the available context size (16384 tokens), try increasing it", 16_384],
    ["generic", "input exceeds the context window of 32000 tokens", 32_000],
  ])("reads the limit from a %s refusal", (_name, message, limit) => {
    expect(overflowLimit(message)).toBe(limit);
  });

  it("returns nothing when the refusal names no limit", () => {
    expect(overflowLimit("Your input exceeds the context window of this model. Please adjust your input and try again.")).toBeUndefined();
    expect(overflowLimit("your messages resulted in 9001 tokens")).toBeUndefined();
  });
});

describe("learned window", () => {
  const catalog = { default: "m", options: [{ id: "m", label: "m", contextWindow: 16_000 }] };

  it("lowers the window only for the instance and model that refused", () => {
    learnContextWindow("inst-a", "m", 8_000);
    expect(contextWindowFor("m", catalog, undefined, "inst-a")).toBe(8_000);
    expect(contextWindowInfo("m", catalog, undefined, "inst-a")).toEqual({ window: 8_000, estimated: false });
    expect(contextWindowFor("m", catalog, undefined, "inst-b")).toBe(16_000);
    expect(contextWindowFor("n", undefined, undefined, "inst-a")).toBe(128_000);
    learnContextWindow("inst-a", "m", 12_000);
    expect(contextWindowFor("m", catalog, undefined, "inst-a")).toBe(8_000);
  });

  it("never raises a declared window", () => {
    learnContextWindow("inst-c", "m", 64_000);
    expect(contextWindowFor("m", catalog, undefined, "inst-c")).toBe(16_000);
  });
});

const ADVERTISED = 16_384;
const ENFORCED = 8_000;
const MODEL = "small-local";

const NAMED = (tokens: number) => `This model's maximum context length is ${ENFORCED} tokens. However, your messages resulted in ${tokens} tokens.`;
const UNNAMED = () => "Your input exceeds the context window of this model. Please adjust your input and try again.";

function fakeServer(refusal: (tokens: number) => string = NAMED) {
  const seen = { rejected: 0, accepted: [] as number[], overLimitAfterRefusal: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: MODEL, context_length: ADVERTISED }] }));
    const raw = String(init!.body);
    const body = JSON.parse(raw) as { stream?: boolean; max_tokens?: number };
    const tokens = Math.ceil(raw.length / 4);
    const total = tokens + (body.max_tokens ?? 0);
    if (seen.rejected && total > ENFORCED) seen.overLimitAfterRefusal++;
    if (total > ENFORCED) {
      seen.rejected++;
      return new Response(JSON.stringify({ error: { message: refusal(tokens), type: "invalid_request_error", code: "context_length_exceeded" } }), { status: 400 });
    }
    seen.accepted.push(tokens);
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Summary: earlier notes." }, finish_reason: "stop" }], usage: { prompt_tokens: tokens, completion_tokens: 5 } }));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: tokens, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
  }));
  return seen;
}

function history(turns: number) {
  const transcript: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (let index = 0; index < turns; index++) {
    transcript.push({ role: "user", text: `Question ${index}: ${"notes about the project and its parts ".repeat(40)}` });
    transcript.push({ role: "assistant", text: `Answer ${index}: ${"the parts fit together as described ".repeat(40)}` });
  }
  return transcript;
}

async function runTurns(instanceId: string, refusal?: (tokens: number) => string) {
  const seen = fakeServer(refusal);
  const inst = await OpenAICompatDriver.create({ instanceId, displayName: "Fixture", enabled: true,
    config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: "fixture-key" } });
  await inst.refreshModels!();
  const recorder = recordEvents(inst.adapter);
  try {
    expect(contextWindowFor(MODEL, inst.models, undefined, instanceId)).toBe(ADVERTISED);
    for (let turn = 0; turn < 4; turn++) {
      const done = recorder.events.filter((event) => event.type === "turn.completed").length;
      await inst.adapter.sendTurn({ threadId: `${instanceId}-${turn}`, text: `Turn ${turn}: what next?`, model: MODEL, transcript: history(12) });
      await recorder.until((event) => event.type === "turn.completed" && recorder.events.filter((e) => e.type === "turn.completed").length > done);
    }
    const failed = recorder.events.filter((event) => event.type === "turn.completed" && (event as { state?: string }).state === "failed").length;
    return { ...seen, failed, window: contextWindowFor(MODEL, inst.models, undefined, instanceId) };
  } finally { recorder.stop(); await inst.dispose(); }
}

describe("overflow on a window smaller than advertised", () => {
  it("is refused at most once per model, then fits the learned window", async () => {
    const seen = await runTurns("learn");
    expect(seen.failed).toBe(0);
    expect(seen.rejected).toBeLessThanOrEqual(1);
    expect(Math.max(...seen.accepted)).toBeLessThanOrEqual(ENFORCED);
    expect(seen.window).toBe(ENFORCED);
  });

  it("learns a lower window from a refusal that names no limit", async () => {
    const seen = await runTurns("learn-unnamed", UNNAMED);
    expect(seen.failed).toBe(0);
    expect(seen.rejected).toBeLessThanOrEqual(2);
    expect(Math.max(...seen.accepted)).toBeLessThanOrEqual(ENFORCED);
    expect(seen.window).toBeLessThan(ADVERTISED);
  });

  it("learns a window from an unnamed refusal that never lands above the real limit", async () => {
    const seen = await runTurns("learn-unnamed-strict", UNNAMED);
    expect(seen.failed).toBe(0);
    expect(seen.window).toBeLessThan(ADVERTISED);
    expect(seen.overLimitAfterRefusal).toBe(0);
  });
});
