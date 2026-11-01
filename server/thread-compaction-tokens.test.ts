import { describe, expect, it } from "vitest";
import { compactBudget, contextWindowFor, learnContextWindow, shouldCompact, threadTokens } from "./context-budget.ts";
import { TokenCalibration } from "./drivers/turn-context.ts";

const MODEL = "gemma4:31b";

function denseHistory(tokens: number): string[] {
  const texts: string[] = [];
  for (let index = 0; threadTokens(texts, MODEL) < tokens; index++) {
    const row = Array.from({ length: 40 }, (_, k) => `{"id":${index * 40 + k},"ok":true,"v":[${k},${k + 1},${k + 2}],"k":"a${k}"}`);
    texts.push(`[${row.join(",")}]`, `if(a[${index}]){b(${index});}else{c(${index},[1,2]);}`.repeat(30));
  }
  return texts;
}

const bytesOf = (texts: string[]) => texts.reduce((n, text) => n + Buffer.byteLength(text), 0);

describe("thread compaction counts tokens, not bytes", () => {
  it("compacts dense JSON and code that byte/4 would let through", () => {
    const window = contextWindowFor(MODEL);
    const budget = compactBudget(window);
    const texts = denseHistory(budget);
    const bytes = bytesOf(texts);
    expect(Math.ceil(bytes / 4)).toBeLessThan(budget);
    expect(shouldCompact({ estimatedBytes: bytes, budget, window })).toBe(false);
    expect(shouldCompact({ estimatedTokens: threadTokens(texts, MODEL), estimatedBytes: bytes, budget, window })).toBe(true);
  });

  it("still prefers the provider's own measurement", () => {
    const window = contextWindowFor(MODEL);
    const texts = denseHistory(compactBudget(window));
    expect(shouldCompact({ contextTokens: 1_000, estimatedTokens: threadTokens(texts, MODEL), budget: compactBudget(window), window })).toBe(false);
  });

  it("applies the model's learned calibration", () => {
    const model = "calibrated-model";
    const texts = ["plain words in a short note"];
    const raw = threadTokens(texts, model);
    new TokenCalibration(model).observe(100, 200);
    expect(threadTokens(texts, model)).toBe(Math.ceil(raw * 2));
  });

  it("uses the window learned from an overflow refusal", () => {
    learnContextWindow("thread-inst", MODEL, 16_000);
    const window = contextWindowFor(MODEL, undefined, undefined, "thread-inst");
    expect(window).toBe(16_000);
    const texts = denseHistory(compactBudget(window));
    expect(shouldCompact({ estimatedTokens: threadTokens(texts, MODEL), budget: compactBudget(window), window })).toBe(true);
    expect(shouldCompact({ estimatedTokens: threadTokens(texts, MODEL), budget: compactBudget(contextWindowFor(MODEL)), window: contextWindowFor(MODEL) })).toBe(false);
  });
});
