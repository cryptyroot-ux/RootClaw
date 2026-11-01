import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";
import { estimateRequestTokens, TokenCalibration } from "./turn-context.ts";
import { contextWindowFor, learnContextWindow, noteAcceptedRequest } from "../context-budget.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const log = (step: number, lines: number) => Array.from({ length: lines }, (_, i) => `2026-10-31T0${step}:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 13} handled request req-${step}${String(i).padStart(5, "0")} in ${(i * 37) % 900}ms`).join("\n");

type Reply = (body: { stream?: boolean; messages: OpenAIChatMessage[]; tools?: unknown[]; model: string }, raw: string) => Response;

async function runTurn(id: string, model: string, files: Record<string, string>, reply: Reply, turnContext?: { compactAt: number }) {
  const cwd = mkdtempSync(join(tmpdir(), `rootclaw-${id}-`));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: model, context_length: 128_000 }] }));
    const raw = String(init!.body);
    return reply(JSON.parse(raw), raw);
  }));
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const inst = await OpenAICompatDriver.create({ instanceId: id, displayName: "Fixture", enabled: true,
    config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model }, environment: { TEST_KEY: "fixture-key" } });
  await inst.refreshModels!();
  const recorder = recordEvents(inst.adapter);
  try {
    await inst.adapter.sendTurn({ threadId: id, text: "Read each log, one per step.", model, cwd, approvalMode: "full", ...(turnContext ? { turnContext } : {}) });
    const done = await recorder.until((event) => event.type === "turn.completed", 30_000) as { ok?: boolean };
    expect(done.ok).toBe(true);
  } finally { recorder.stop(); await inst.dispose(); }
  return lines;
}

const stream = (delta: object, finish: string, usage: object) =>
  new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`);
const readCall = (n: number, path: string) => ({ tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } }] });

// Finding 1: AC-8 long-context made 10 compactions in 12 rounds, each landing ~16k over a 12k budget, because the kept
// exchange plus tool schemas alone exceed the target. Each pass costs a summary request and frees nothing lasting.
describe("lock 1: no compaction every round when one tool result alone exceeds the budget", () => {
  it("spends at most one summary request across three oversized reads", async () => {
    const script = ["a.log", "b.log", "c.log"];
    let calls = 0;
    let summaries = 0;
    await runTurn("lock-thrash", "m", { "a.log": log(1, 300), "b.log": log(2, 300), "c.log": log(3, 300) }, (body, raw) => {
      const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 5 };
      if (!body.stream) { summaries++; return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "## Goal\n- read logs" }, finish_reason: "stop" }], usage })); }
      const path = script[calls++];
      return path ? stream(readCall(calls, path), "tool_calls", usage) : stream({ content: "Done." }, "stop", usage);
    }, { compactAt: 3_000 });
    expect(summaries).toBeLessThanOrEqual(1);
  });
});

// Finding 2: a learned window only ever shrinks; a later accepted request larger than it never restores it.
describe("lock 2: a learned window recovers once the provider accepts more", () => {
  it("raises the window to at least what the same model accepted", () => {
    learnContextWindow("lock-recover", "m2", 50_000);
    expect(contextWindowFor("m2", undefined, 128_000, "lock-recover")).toBe(50_000);
    noteAcceptedRequest("lock-recover", "m2", 90_000);
    expect(contextWindowFor("m2", undefined, 128_000, "lock-recover")).toBeGreaterThanOrEqual(90_000);
  });
});

// Finding 3: calibration compares the provider's count of the request actually sent with an estimate taken before an
// overflow retry compacted it, so the learned ratio collapses (clamped to 1) and later requests under-count.
describe("lock 3: calibration uses the estimate of the request actually sent", () => {
  it("keeps the true 2x ratio after an overflow retry that compacted the turn", async () => {
    const model = "lock-cal-m";
    const script = ["a.log", "b.log"];
    let calls = 0;
    let refusedOnce = false;
    await runTurn("lock-cal", model, { "a.log": log(1, 300), "b.log": log(2, 300) }, (body) => {
      const usage = { prompt_tokens: 2 * estimateRequestTokens(body.messages, (body.tools ?? []) as never, model), completion_tokens: 5 };
      if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "## Goal\n- read logs" }, finish_reason: "stop" }], usage }));
      if (calls === script.length && !refusedOnce) {
        refusedOnce = true;
        return new Response(JSON.stringify({ error: { message: "This model's maximum context length was exceeded. Please reduce the length of the messages." } }), { status: 400 });
      }
      const path = script[calls++];
      return path ? stream(readCall(calls, path), "tool_calls", usage) : stream({ content: "Done." }, "stop", usage);
    });
    expect(refusedOnce).toBe(true);
    expect(new TokenCalibration(model, "lock-cal").apply(1_000)).toBeGreaterThanOrEqual(1_900);
  });
});
