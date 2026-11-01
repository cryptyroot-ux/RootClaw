import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicDriver } from "./api-providers.ts";
import { recordEvents } from "../testing/events.ts";
import { DEFAULT_OUTPUT_TOKENS, estimateRequestTokens, minOutputTokens, outputReserve, outputTokensFor, turnInputBudget } from "./turn-context.ts";

afterEach(() => { vi.unstubAllGlobals(); });

describe("output reserve", () => {
  it.each([8_000, 32_768, 200_000, 1_000_000])("leaves room for the reply in a %i-token window", (window) => {
    for (const compactAt of [undefined, 0.5, 0.9, 0.99, 5_000_000]) {
      expect(turnInputBudget(window, compactAt) + outputReserve(window)).toBeLessThanOrEqual(window);
    }
  });

  it("caps the reply to what is left of the window and stays silent when the default fits", () => {
    expect(outputTokensFor(8_000, 6_000)).toBeLessThanOrEqual(2_000);
    expect(outputTokensFor(8_000, 6_000)).toBeGreaterThan(0);
    expect(outputTokensFor(200_000, 120_000)).toBeUndefined();
    expect(outputTokensFor(200_000, 195_000)! + 195_000).toBeLessThanOrEqual(200_000);
  });

  it("reports no usable room once the input crowds out a minimal reply", () => {
    expect(minOutputTokens(8_000)).toBeGreaterThanOrEqual(256);
    expect(minOutputTokens(1_000_000)).toBe(outputReserve(1_000_000) / 4);
    expect(outputTokensFor(8_000, 9_000)).toBe(0);
    expect(outputTokensFor(8_000, 7_900)).toBeLessThan(minOutputTokens(8_000));
  });
});

const WINDOW = 32_768;
const MODEL = "gemma3:1b";

function words(tokens: number): string {
  const unit = "alpha beta gamma delta epsilon zeta eta theta iota kappa ";
  let text = unit;
  while (estimateRequestTokens([{ role: "user", content: text }], [], MODEL) < tokens) text += unit.repeat(200);
  return text;
}

async function anthropicBodies(text: string, transcript?: Array<{ role: "user" | "assistant"; text: string }>) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).includes("/models")) return new Response(JSON.stringify({ data: [{ id: MODEL }] }));
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    bodies.push(body);
    if (!body.stream) return new Response(JSON.stringify({ content: [{ type: "text", text: "## Goal\n- summary" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }));
    const events = [
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }));
  const inst = await AnthropicDriver.create({ instanceId: "reserve", displayName: "Fixture", enabled: true,
    config: AnthropicDriver.decodeConfig({ url: "https://anthropic.invalid/v1", key: "fixture-key", model: MODEL }), environment: {} });
  const recorder = recordEvents(inst.adapter);
  try {
    await inst.adapter.sendTurn({ threadId: `reserve-${text.length}`, text, model: MODEL, ...(transcript ? { transcript } : {}) });
    await recorder.until((event) => event.type === "turn.completed");
  } finally { recorder.stop(); await inst.dispose(); }
  return bodies;
}

describe("Anthropic max_tokens", () => {
  it("keeps the adapter default when the input leaves room for it", async () => {
    const [body] = await anthropicBodies("hello");
    expect(body!.max_tokens).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  it("never asks for more output than the window has left beside the input", async () => {
    const text = words(26_000);
    const input = estimateRequestTokens([{ role: "user", content: text }], [], MODEL);
    const [body] = await anthropicBodies(text);
    expect(body!.max_tokens).toBeLessThan(DEFAULT_OUTPUT_TOKENS);
    expect(Number(body!.max_tokens)).toBeLessThanOrEqual(WINDOW - input);
  });

  it("caps the compaction summary request to the output reserve", async () => {
    const turn = words(1_500);
    const transcript = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? "assistant" as const : "user" as const, text: turn }));
    const bodies = await anthropicBodies("What next?", transcript);
    const summaries = bodies.filter((body) => !body.stream);
    expect(summaries.length).toBeGreaterThan(0);
    for (const body of summaries) expect(Number(body.max_tokens)).toBeLessThanOrEqual(outputReserve(WINDOW));
  });
});

describe("Anthropic refusal for the reply ceiling alone", () => {
  it("resends the same small request under the learned window instead of failing", async () => {
    const limit = 8_000;
    const sent: Array<{ input: number; maxTokens: number }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).includes("/models")) return new Response(JSON.stringify({ data: [{ id: "ceiling-model" }] }));
      const body = JSON.parse(String(init!.body)) as { max_tokens: number; stream?: boolean };
      const tokens = Math.ceil(String(init!.body).length / 4);
      sent.push({ input: tokens, maxTokens: body.max_tokens });
      if (tokens + body.max_tokens > limit) {
        return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `input length and \`max_tokens\` exceed context limit: ${tokens} + ${body.max_tokens} > ${limit}, decrease input length or \`max_tokens\` and try again` } }), { status: 400 });
      }
      const events = [
        ["message_start", { type: "message_start", message: { usage: { input_tokens: tokens, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }));
    const inst = await AnthropicDriver.create({ instanceId: "ceiling", displayName: "Fixture", enabled: true,
      config: AnthropicDriver.decodeConfig({ url: "https://anthropic.invalid/v1", key: "fixture-key", model: "ceiling-model" }), environment: {} });
    const recorder = recordEvents(inst.adapter);
    try {
      await inst.adapter.sendTurn({ threadId: "ceiling", text: "hello", model: "ceiling-model" });
      const done = await recorder.until((event) => event.type === "turn.completed") as { ok?: boolean };
      expect(done.ok).toBe(true);
    } finally { recorder.stop(); await inst.dispose(); }
    expect(sent).toHaveLength(2);
    expect(sent[1]!.input + sent[1]!.maxTokens).toBeLessThanOrEqual(limit);
  });
});
