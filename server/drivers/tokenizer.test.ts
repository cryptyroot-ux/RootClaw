import { describe, expect, it } from "vitest";
import { countTokens, encodingForModel, estimateTokensByChars, prepareTokenizer } from "./tokenizer.ts";
import { estimateRequestTokens } from "./turn-context.ts";

describe("tokenizer", () => {
  it("maps model families to encodings and leaves unknown models on the estimate", () => {
    expect(encodingForModel("gpt-4o-mini")).toBe("o200k_base");
    expect(encodingForModel("openai/gpt-5.1")).toBe("o200k_base");
    expect(encodingForModel("gpt-6.1-sol")).toBe("o200k_base");
    expect(encodingForModel("o3-mini")).toBe("o200k_base");
    expect(encodingForModel("gpt-4-turbo")).toBe("cl100k_base");
    expect(encodingForModel("MyCombo")).toBeNull();
    expect(encodingForModel("claude-sonnet-5-5")).toBeNull();
    expect(encodingForModel(undefined)).toBeNull();
  });

  it("uses chars/3.5 for unknown models", async () => {
    expect(await prepareTokenizer("MyCombo")).toBe(false);
    expect(countTokens("abcdefg", "MyCombo")).toBe(2);
    expect(countTokens("", "gpt-4o")).toBe(0);
  });

  it("counts exactly once the encoding is loaded, special-token text included", async () => {
    expect(await prepareTokenizer("gpt-4o")).toBe(true);
    expect(countTokens("hello world", "gpt-4o")).toBe(2);
    expect(countTokens("say <|endoftext|> now", "gpt-4o")).toBeGreaterThan(3);
    const code = "export function add(a: number, b: number) { return a + b; }\n".repeat(50);
    // Code is denser than the chars/3.5 guess: the exact count is what keeps compaction honest.
    expect(countTokens(code, "gpt-4o")).toBe(900);
    expect(estimateTokensByChars(code)).toBe(858);
  });

  it("feeds request estimates", async () => {
    await prepareTokenizer("gpt-4o");
    const messages = [{ role: "user" as const, content: "hello world" }];
    expect(estimateRequestTokens(messages, [], "gpt-4o")).toBe(3 + 4 + 2);
    expect(estimateRequestTokens(messages, [], "MyCombo")).toBe(3 + 4 + Math.ceil(11 / 3.5));
  });
});
