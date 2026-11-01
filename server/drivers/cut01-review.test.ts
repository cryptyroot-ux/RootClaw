// Cut 01 review findings: the pinned plan counts in the fit checks, and an abort during a summary call is not
// turned into a fallback summary.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";
import { compactTurnMessages, estimateRequestTokens, minOutputTokens } from "./turn-context.ts";
import { carryPlan, PLAN_TAG } from "./plan-verify.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const MODEL = "plan-local";
const WINDOW = 8_192;
const log = (lines: number) => Array.from({ length: lines }, (_, i) => `2026-10-31T01:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 13} handled req-${String(i).padStart(5, "0")} in ${(i * 37) % 900}ms`).join("\n");
// Eight dense step titles (the most a plan holds): about a thousand tokens once pinned.
const STEPS = Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}`, title: `s${i}${"a1b2c3".repeat(20)}`.slice(0, 120), status: i === 0 ? "doing" as const : "pending" as const }));

describe("a large pinned plan", () => {
  it("is measured with the request, so the pasted message is shortened for it instead of the turn failing", async () => {
    // A plan carried over from a failover is pinned from the first round, next to a pasted message over the budget.
    carryPlan("plan-fit", { steps: STEPS, revisions: 0 });
    const cwd = mkdtempSync(join(tmpdir(), "rootclaw-plan-fit-"));
    const sent: Array<{ tokens: number; maxTokens?: number; refused: boolean; plan: boolean }> = [];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: MODEL, context_length: WINDOW }] }));
      const body = JSON.parse(String(init!.body)) as { stream?: boolean; max_tokens?: number; messages: OpenAIChatMessage[]; tools?: never[] };
      const tokens = estimateRequestTokens(body.messages, body.tools ?? [], MODEL);
      const refused = tokens + (body.max_tokens ?? 0) > WINDOW;
      sent.push({ tokens, maxTokens: body.max_tokens, refused, plan: JSON.stringify(body.messages).includes(STEPS[1]!.title) && JSON.stringify(body.messages.at(-1)).includes(PLAN_TAG.slice(1, 20)) });
      if (refused) return new Response(JSON.stringify({ error: { message: `This model's maximum context length is ${WINDOW} tokens.` } }), { status: 400 });
      calls++;
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inst = await OpenAICompatDriver.create({ instanceId: "plan-fit", displayName: "Fixture", enabled: true,
      config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: "fixture-key" } });
    await inst.refreshModels!();
    const recorder = recordEvents(inst.adapter);
    try {
      const text = `Here is the build log.\n\n${log(400)}`;
      await inst.adapter.sendTurn({ threadId: "plan-fit", text, model: MODEL, cwd, approvalMode: "full",
        planVerify: { mode: "plan", maxVerifyRetries: 0 }, turnContext: { compactAt: 0.99, offloadDir: join(cwd, ".offload") } } as never);
      const done = await recorder.until((event) => event.type === "turn.completed", 30_000) as { ok?: boolean };
      expect(done.ok).toBe(true);
      expect(sent.filter((request) => request.refused)).toEqual([]);
      const planned = sent.filter((request) => request.plan);
      expect(planned.length).toBe(calls);
      expect(calls).toBeGreaterThan(0);
      for (const request of planned) {
        expect(request.tokens + (request.maxTokens ?? 0)).toBeLessThanOrEqual(WINDOW);
        expect(request.maxTokens ?? Infinity).toBeGreaterThanOrEqual(minOutputTokens(WINDOW));
      }
    } finally { recorder.stop(); await inst.dispose(); }
  });
});

describe("a turn aborted while its summary is being written", () => {
  const request: OpenAIChatMessage = { role: "user", content: "Read the logs." };
  const call = (id: string): OpenAIChatMessage => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }] });
  const messages: OpenAIChatMessage[] = [{ role: "system", content: "You are careful." }, request,
    call("a"), { role: "tool", tool_call_id: "a", content: log(200) }, call("b"), { role: "tool", tool_call_id: "b", content: log(200) },
    call("c"), { role: "tool", tool_call_id: "c", content: "ok" }];

  it("rethrows the abort instead of writing a fallback summary", async () => {
    const abort = new AbortController();
    const summarize = vi.fn(async () => { abort.abort(); throw new DOMException("This operation was aborted", "AbortError"); });
    await expect(compactTurnMessages(messages, request, { summarize, summaryBudgetBytes: 8_000, keepExchanges: 1, signal: abort.signal } as never)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rethrows when the signal is aborted even if the error is a plain one", async () => {
    const abort = new AbortController();
    const summarize = vi.fn(async () => { abort.abort(); throw new Error("socket closed"); });
    await expect(compactTurnMessages(messages, request, { summarize, summaryBudgetBytes: 8_000, keepExchanges: 1, signal: abort.signal } as never)).rejects.toThrow("socket closed");
  });

  it("still falls back to a deterministic summary on any other error", async () => {
    const summarize = vi.fn(async () => { throw new Error("HTTP 500"); });
    const result = await compactTurnMessages(messages, request, { summarize, summaryBudgetBytes: 8_000, keepExchanges: 1 });
    expect(result?.summarizer).toBe("fallback");
  });
});
