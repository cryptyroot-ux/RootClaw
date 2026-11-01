import { afterEach, describe, expect, it, vi } from "vitest";
import { threadTokens } from "../context-budget.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { estimateRequestTokens, TokenCalibration } from "./turn-context.ts";

afterEach(() => { vi.unstubAllGlobals(); });

let models = 0;
const fresh = () => `ema-model-${++models}-${Date.now()}`;

describe("token calibration (EMA per instance and model)", () => {
  it("settles on a steady ratio", () => {
    const model = fresh();
    for (let i = 0; i < 10; i++) new TokenCalibration(model, "instA").observe(1_000, 1_200);
    const applied = new TokenCalibration(model, "instA").apply(1_000);
    expect(applied).toBeGreaterThanOrEqual(1_200 * 0.95);
    expect(applied).toBeLessThanOrEqual(1_200 * 1.05);
  });

  it("moves only part of the way on one outlier", () => {
    const model = fresh();
    const calibration = new TokenCalibration(model, "instA");
    for (let i = 0; i < 10; i++) calibration.observe(1_000, 1_200);
    calibration.observe(1_000, 3_000);
    expect(calibration.apply(1_000)).toBeLessThanOrEqual(1_740);
    expect(new TokenCalibration(model, "instA").apply(1_000)).toBeLessThanOrEqual(1_740);
    expect(calibration.apply(1_000)).toBeGreaterThan(1_200);
    // provider() still answers with the last count the provider reported.
    expect(calibration.provider(1_000)).toBe(3_000);
  });

  it("keeps two instances serving the same model apart", () => {
    const model = fresh();
    new TokenCalibration(model, "instA").observe(1_000, 2_000);
    expect(new TokenCalibration(model, "instA").apply(1_000)).toBe(2_000);
    expect(new TokenCalibration(model, "instB").apply(1_000)).toBe(1_000);
  });

  it("stays between 1 and 3", () => {
    const high = new TokenCalibration(fresh(), "instA");
    for (let i = 0; i < 20; i++) high.observe(100, 900);
    expect(high.apply(100)).toBe(300);
    const low = new TokenCalibration(fresh(), "instA");
    for (let i = 0; i < 20; i++) low.observe(100, 40);
    expect(low.apply(100)).toBe(100);
  });

  it("threadTokens reads the ratio a native turn learned on the same instance", async () => {
    const model = fresh();
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: model, context_length: 32_768 }] }));
      const body = JSON.parse(String(init!.body)) as { messages: never[]; tools?: never[] };
      const usage = { prompt_tokens: 2 * estimateRequestTokens(body.messages, body.tools ?? [], model), completion_tokens: 3 };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
    }));
    const inst = await OpenAICompatDriver.create({ instanceId: "thread-cal-A", displayName: "Fixture", enabled: true,
      config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model }, environment: { TEST_KEY: "fixture-key" } });
    await inst.refreshModels!();
    const recorder = recordEvents(inst.adapter);
    try {
      await inst.adapter.sendTurn({ threadId: "thread-cal", text: "hello there", model });
      await recorder.until((event) => event.type === "turn.completed");
    } finally { recorder.stop(); await inst.dispose(); }
    const texts = ["a short note about the plan", "and a reply to it"];
    const raw = threadTokens(texts, model, "thread-cal-B");
    expect(threadTokens(texts, model, "thread-cal-A")).toBe(Math.ceil(raw * 2) );
  });
});
