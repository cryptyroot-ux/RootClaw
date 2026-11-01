import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";
import { compactTurnMessages } from "./turn-context.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const log = (step: number, lines: number) => Array.from({ length: lines }, (_, i) => `2026-10-31T0${step}:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 13} handled request req-${step}${String(i).padStart(5, "0")} in ${(i * 37) % 900}ms`).join("\n");

describe("compaction that would save next to nothing", () => {
  it("is skipped without a summary call when only a small exchange can be folded", async () => {
    const request: OpenAIChatMessage = { role: "user", content: "Read the logs." };
    const call = (id: string, path: string): OpenAIChatMessage => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }] });
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: "You are careful." }, request,
      call("a", "answer.txt"), { role: "tool", tool_call_id: "a", content: "ok" },
      call("b", "logs/b.log"), { role: "tool", tool_call_id: "b", content: log(2, 300) },
    ];
    const summarize = vi.fn(async () => "summary");
    const result = await compactTurnMessages(messages, request, { summarize, summaryBudgetBytes: 8_000, targetTokens: 2_000, minSavedTokens: 500 });
    expect(result).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
  });
});

describe("compaction that cannot bring the turn under its budget", () => {
  it("is skipped without a summary call when the newest exchange alone is over the limit", async () => {
    const request: OpenAIChatMessage = { role: "user", content: "Read the logs." };
    const call = (id: string, path: string): OpenAIChatMessage => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }] });
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: "You are careful." }, request,
      call("a", "logs/a.log"), { role: "tool", tool_call_id: "a", content: log(1, 300) },
      call("b", "logs/b.log"), { role: "tool", tool_call_id: "b", content: log(2, 300) },
    ];
    const summarize = vi.fn(async () => "summary");
    const result = await compactTurnMessages(messages, request, { summarize, summaryBudgetBytes: 8_000, targetTokens: 2_000, minSavedTokens: 500, fitWithinTokens: 4_000 });
    expect(result).toBeNull();
    expect(summarize).not.toHaveBeenCalled();
    const without = await compactTurnMessages(messages, request, { summarize, summaryBudgetBytes: 8_000, targetTokens: 2_000, minSavedTokens: 500 });
    expect(without).not.toBeNull();
  });
});

describe("a turn whose single tool results exceed the budget", () => {
  it("does not pay a summary call each round for folds that cannot reach the budget", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rootclaw-thrash-"));
    for (const step of [1, 2, 3]) writeFileSync(join(cwd, `big${step}.log`), log(step, 120));
    for (const step of [1, 2]) writeFileSync(join(cwd, `small${step}.txt`), "ok\n");
    const script = ["big1.log", "small1.txt", "big2.log", "small2.txt", "big3.log"];
    let calls = 0;
    let summaries = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m", context_length: 128_000 }] }));
      const raw = String(init!.body);
      const body = JSON.parse(raw) as { stream?: boolean };
      const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 5 };
      if (!body.stream) { summaries++; return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "## Goal\n- read logs" }, finish_reason: "stop" }], usage })); }
      const path = script[calls++];
      const delta = path ? { tool_calls: [{ index: 0, id: `c${calls}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }] } : { content: "Done." };
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: path ? "tool_calls" : "stop" }], usage })}\n\ndata: [DONE]\n\n`);
    }));
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
    const inst = await OpenAICompatDriver.create({ instanceId: "thrash", displayName: "Fixture", enabled: true,
      config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: "m" }, environment: { TEST_KEY: "fixture-key" } });
    await inst.refreshModels!();
    const recorder = recordEvents(inst.adapter);
    try {
      await inst.adapter.sendTurn({ threadId: "thrash", text: "Read each log, one per step.", model: "m", cwd, approvalMode: "full", turnContext: { compactAt: 3_000 } });
      const done = await recorder.until((event) => event.type === "turn.completed", 30_000) as { ok?: boolean };
      expect(done.ok).toBe(true);
    } finally { recorder.stop(); await inst.dispose(); }
    const compactions = lines.filter((line) => line.includes("[context] compaction")).map((line) => line.match(/~(\d+) → ~(\d+)/)!.slice(1).map(Number) as [number, number]);
    for (const [before, after] of compactions) expect(before - after).toBeGreaterThanOrEqual(300);
    expect(summaries).toBe(compactions.length);
    expect(summaries).toBeLessThanOrEqual(2);
  });
});
