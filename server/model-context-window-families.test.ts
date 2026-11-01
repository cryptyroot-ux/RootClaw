import { describe, expect, it } from "vitest";
import { contextWindowFor, contextWindowInfo, DEFAULT_CONTEXT_WINDOW } from "./context-budget.ts";

const FAMILIES: Array<[string, number]> = [
  ["deepseek-chat", 128_000],
  ["deepseek-ai/DeepSeek-V3.1", 128_000],
  ["deepseek-v3.1:671b-cloud", 128_000],
  ["qwen3-coder:480b-cloud", 262_144],
  ["qwen/qwen3-235b-a22b", 131_072],
  ["kimi-k2:1t-cloud", 262_144],
  ["moonshotai/kimi-k2-instruct", 262_144],
  ["glm-4.6:cloud", 202_752],
  ["z-ai/glm-4.5", 131_072],
  ["meta-llama/llama-3.3-70b-instruct", 131_072],
  ["llama3.1:8b", 131_072],
  ["gemma4:31b", 131_072],
  ["gemma3:1b", 32_768],
  ["gpt-oss:120b-cloud", 131_072],
  ["openai/gpt-oss-20b", 131_072],
  ["mistral-large-latest", 131_072],
  ["mistralai/devstral-small", 131_072],
  ["codestral-latest", 262_144],
];

describe("context window registry for open-weight families", () => {
  it.each(FAMILIES)("%s has a known window of %i", (model, window) => {
    expect(contextWindowFor(model)).toBe(window);
    expect(contextWindowInfo(model)).toEqual({ window, estimated: false });
  });

  it("marks an unknown model as the estimated default", () => {
    expect(contextWindowFor("beam")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowInfo("beam")).toEqual({ window: DEFAULT_CONTEXT_WINDOW, estimated: true });
    expect(contextWindowInfo(undefined)).toEqual({ window: DEFAULT_CONTEXT_WINDOW, estimated: true });
    expect(contextWindowInfo("MiniMax-M3").estimated).toBe(true);
  });

  it("does not mark a window from the catalog or the provider as estimated", () => {
    expect(contextWindowInfo("beam", { default: "beam", options: [{ id: "beam", label: "Beam", contextWindow: 64_000 }] })).toEqual({ window: 64_000, estimated: false });
    expect(contextWindowInfo("beam", undefined, 32_000)).toEqual({ window: 32_000, estimated: false });
  });
});
