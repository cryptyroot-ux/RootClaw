import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";
import { prepareTokenizer, TOKEN_COUNT_CACHE_MAX_CHARS, TokenCountCache, tokenCountCache } from "./tokenizer.ts";
import { estimateRequestTokens, offloadRequest, offloadTail, planCompaction } from "./turn-context.ts";

const encoder = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("gpt-tokenizer/encoding/o200k_base", async (importOriginal) => {
  const actual = await importOriginal<typeof import("gpt-tokenizer/encoding/o200k_base")>();
  return { ...actual, countTokens: (text: string, options?: unknown) => { encoder.calls.push(text); return actual.countTokens(text, options as never); } };
});

const MODEL = "gpt-4o";
const long = (n: number, seed: string) => `${seed} `.repeat(Math.ceil(300 / (seed.length + 1))) + `line ${n}: ${"lorem ipsum dolor sit amet ".repeat(12)}`;
const tool = (name: string): ChatToolDefinition => ({ type: "function", function: { name, description: `${name} tool. ${"Reads and writes files in the workspace. ".repeat(8)}`, parameters: { type: "object", properties: { path: { type: "string" } } } } });
const longCalls = () => encoder.calls.filter((text) => text.length >= 256);

function history(count: number): OpenAIChatMessage[] {
  const messages: OpenAIChatMessage[] = [{ role: "system", content: long(0, "system prompt") }, { role: "user", content: long(1, "the task") }];
  for (let i = 0; messages.length < count; i++) {
    messages.push({ role: "assistant", content: long(i, "thinking"), tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `src/${"deep/".repeat(60)}file${i}.ts` }) } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: JSON.stringify({ ok: true, result: long(i, "file body") }) });
  }
  return messages;
}

/** The count with nothing memoized: what estimateRequestTokens returned before the cache. */
function uncached(messages: readonly OpenAIChatMessage[], tools: readonly ChatToolDefinition[]) {
  tokenCountCache.clear();
  return estimateRequestTokens(messages, tools, MODEL);
}

describe("token count cache", () => {
  beforeAll(async () => { expect(await prepareTokenizer(MODEL)).toBe(true); });
  beforeEach(() => { tokenCountCache.clear(); encoder.calls = []; });

  it("gives the same estimate with and without the cache, after in-place offload and unpin too", () => {
    const dir = mkdtempSync(join(tmpdir(), "token-cache-"));
    const tools = [tool("read"), tool("write")];
    const messages = history(40);
    const request = messages[1]!;
    const check = () => {
      const cold = uncached(messages, tools);
      estimateRequestTokens(messages, tools, MODEL);
      expect(estimateRequestTokens(messages, tools, MODEL)).toBe(cold);
    };
    check();
    request.content = `${"a huge pinned request. ".repeat(4_000)}`;
    estimateRequestTokens(messages, tools, MODEL);
    expect(offloadRequest(request, { dir, threadId: "t", turnId: "u", maxTokens: 2_000, model: MODEL }).length).toBe(1);
    check();
    const last = messages.at(-1)!;
    last.content = JSON.stringify({ ok: true, result: "tool output line\n".repeat(6_000) });
    estimateRequestTokens(messages, tools, MODEL);
    expect(offloadTail(messages, request, { dir, threadId: "t", tools, model: MODEL, fitWithinTokens: 3_000, targetTokens: 2_500 }).length).toBe(1);
    check();
    // unpinPlan: the request is unpinned and folded by a later plan; the rebuilt list must still count the same.
    const plan = planCompaction(messages, request, 2)!;
    const rebuilt = plan.build("summary of the folded steps");
    estimateRequestTokens(rebuilt, tools, MODEL);
    const cold = uncached(rebuilt, tools);
    estimateRequestTokens(rebuilt, tools, MODEL);
    expect(estimateRequestTokens(rebuilt, tools, MODEL)).toBe(cold);
  });

  it("does not encode an unchanged 200-message history again", () => {
    const tools = [tool("read")];
    const messages = history(200);
    const first = estimateRequestTokens(messages, tools, MODEL);
    expect(longCalls().length).toBeGreaterThan(200);
    encoder.calls = [];
    expect(estimateRequestTokens(messages, tools, MODEL)).toBe(first);
    expect(longCalls()).toEqual([]);
  });

  it("encodes only the new message, and the tool schemas when they change", () => {
    const messages = history(60);
    estimateRequestTokens(messages, [tool("read")], MODEL);
    encoder.calls = [];
    const added = long(999, "a brand new tool result");
    messages.push({ role: "user", content: added });
    estimateRequestTokens(messages, [tool("read")], MODEL);
    expect(longCalls()).toEqual([added]);
    encoder.calls = [];
    const tools = [tool("read"), tool("grep")];
    estimateRequestTokens(messages, tools, MODEL);
    expect(longCalls()).toEqual([JSON.stringify(tools)]);
  });

  it("never holds more characters than its limit, dropping the least recently used", () => {
    const cache = new TokenCountCache(1_000);
    const compute = vi.fn((text: string) => text.length);
    const a = "a".repeat(400), b = "b".repeat(400), c = "c".repeat(400);
    cache.count("o200k_base", a, compute);
    cache.count("o200k_base", b, compute);
    cache.count("o200k_base", a, compute);
    cache.count("o200k_base", c, compute);
    expect(cache.chars).toBeLessThanOrEqual(1_000);
    compute.mockClear();
    cache.count("o200k_base", a, compute);
    expect(compute).not.toHaveBeenCalled();
    cache.count("o200k_base", b, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.chars).toBeLessThanOrEqual(1_000);
    cache.count("o200k_base", "x".repeat(2_000), compute);
    expect(cache.chars).toBeLessThanOrEqual(1_000);

    for (let i = 0; i * 100_000 < TOKEN_COUNT_CACHE_MAX_CHARS * 1.5; i++) {
      estimateRequestTokens([{ role: "user", content: `${i} ${"word ".repeat(20_000)}` }], [], "MyCombo");
      expect(tokenCountCache.chars).toBeLessThanOrEqual(TOKEN_COUNT_CACHE_MAX_CHARS);
    }
  });
});
