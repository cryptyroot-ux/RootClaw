import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";
import { estimateRequestTokens, minOutputTokens, TokenCalibration, turnInputBudget } from "./turn-context.ts";
import { requestTooLargeMessage } from "../../shared/request-too-large.ts";

afterEach(() => { vi.unstubAllGlobals(); });

const MODEL = "small-local";

function words(tokens: number): string {
  const unit = "alpha beta gamma delta epsilon zeta eta theta iota kappa ";
  let text = unit;
  while (estimateRequestTokens([{ role: "user", content: text }], [], MODEL) < tokens) text += unit.repeat(20);
  return text;
}

type Sent = { userText: string; maxTokens?: number; tokens: number };

async function send(text: string, window: number, opts: { workspace?: boolean } = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: MODEL, context_length: window }] }));
    const body = JSON.parse(String(init!.body)) as { stream?: boolean; max_tokens?: number; messages: Array<{ role: string; content: unknown }> };
    const user = body.messages.filter((message) => message.role === "user").map((message) => String(message.content)).join("\n");
    sent.push({ userText: user, maxTokens: body.max_tokens, tokens: estimateRequestTokens(body.messages as never, [], MODEL) });
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] }));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const inst = await OpenAICompatDriver.create({ instanceId: `fit-${window}-${text.length}-${opts.workspace ? 1 : 0}`, displayName: "Fixture", enabled: true,
    config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: "fixture-key" } });
  await inst.refreshModels!();
  const recorder = recordEvents(inst.adapter);
  const dir = mkdtempSync(join(tmpdir(), "rootclaw-fit-"));
  try {
    await inst.adapter.sendTurn({ threadId: `fit-${text.length}`, text, model: MODEL, approvalMode: "full",
      ...(opts.workspace ? { cwd: dir, turnContext: { offloadDir: join(dir, ".offload") } } : {}) });
    const done = await recorder.until((event) => event.type === "turn.completed") as { ok?: boolean };
    const errors = recorder.events.filter((event) => event.type === "runtime.error").map((event) => (event as { message?: string }).message);
    return { sent, ok: done.ok, errors };
  } finally { recorder.stop(); await inst.dispose(); }
}

describe("a pasted message that fits", () => {
  it("is sent whole even when it is over half the budget", async () => {
    const window = 16_384;
    const paste = words(Math.floor(turnInputBudget(window) * 0.6));
    const { sent, ok } = await send(paste, window, { workspace: true });
    expect(ok).toBe(true);
    expect(sent[0]!.userText).toContain(paste);
  });

  it("keeps as much of an oversized paste as the budget allows", async () => {
    const window = 16_384;
    const budget = turnInputBudget(window);
    const { sent, ok } = await send(words(Math.floor(budget * 1.5)), window, { workspace: true });
    expect(ok).toBe(true);
    expect(sent[0]!.tokens).toBeLessThanOrEqual(budget);
    expect(sent[0]!.tokens).toBeGreaterThan(budget * 0.5);
  });
});

describe("a paste cut again on a later round", () => {
  it("points at one saved copy that holds the whole original text", async () => {
    const window = 16_384;
    const budget = turnInputBudget(window);
    const paste = `${words(Math.floor(budget * 1.5))} FACT-QX-4417 ${words(Math.floor(budget * 0.3))}`;
    const toolResult = words(Math.floor(budget * 0.3));
    const dir = mkdtempSync(join(tmpdir(), "rootclaw-recut-"));
    writeFileSync(join(dir, "notes.txt"), toolResult);
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: MODEL, context_length: window }] }));
      const body = JSON.parse(String(init!.body)) as { stream?: boolean; messages: Array<{ role: string; content: unknown }> };
      if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "summary" }, finish_reason: "stop" }] }));
      round++;
      if (round <= 2) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${round}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.txt" }) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }));
    const inst = await OpenAICompatDriver.create({ instanceId: "fit-recut", displayName: "Fixture", enabled: true,
      config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: "fixture-key" } });
    await inst.refreshModels!();
    const recorder = recordEvents(inst.adapter);
    try {
      await inst.adapter.sendTurn({ threadId: "fit-recut", text: paste, model: MODEL, approvalMode: "full", cwd: dir,
        turnContext: { offloadDir: join(dir, ".offload") } });
      await recorder.until((event) => event.type === "turn.completed");
    } finally { recorder.stop(); await inst.dispose(); }
    const saved = readdirSync(join(dir, ".offload"), { recursive: true }).map(String).filter((name) => statSync(join(dir, ".offload", name)).isFile());
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.map((name) => readFileSync(join(dir, ".offload", name), "utf8")).every((text) => text.includes("FACT-QX-4417"))).toBe(true);
  });
});

describe("a request that leaves no room for the reply", () => {
  const window = 8_000;
  const text = () => words(window - 200);

  it("fails as too large instead of asking for a sliver of output", async () => {
    const { sent, ok, errors } = await send(text(), window);
    expect(ok).toBe(false);
    expect(sent.filter((request) => request.maxTokens !== undefined && request.maxTokens < minOutputTokens(window))).toEqual([]);
    expect(errors.join("\n")).toContain(requestTooLargeMessage(MODEL));
  });

  it("shrinks the pasted message first when it can, and keeps a usable reply budget", async () => {
    const { sent, ok } = await send(text(), window, { workspace: true });
    expect(ok).toBe(true);
    for (const request of sent) if (request.maxTokens !== undefined) expect(request.maxTokens).toBeGreaterThanOrEqual(minOutputTokens(window));
    expect(sent[0]!.tokens).toBeLessThanOrEqual(turnInputBudget(window));
  });
});

describe("calibration after an overflow retry", () => {
  it("compares the provider's count with the request it actually took", async () => {
    const model = "calib-model";
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: model, context_length: 32_768 }] }));
      const body = JSON.parse(String(init!.body)) as { stream?: boolean; messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };
      const estimate = estimateRequestTokens(body.messages as never, (body.tools ?? []) as never, model);
      if (estimate > 6_000) return new Response(JSON.stringify({ error: { message: "Your input exceeds the context window of this model. Please adjust your input and try again." } }), { status: 400 });
      const usage = { prompt_tokens: estimate * 2, completion_tokens: 5 };
      if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "## Goal\n- summary" }, finish_reason: "stop" }], usage }));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
    }));
    const inst = await OpenAICompatDriver.create({ instanceId: "calib", displayName: "Fixture", enabled: true,
      config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model }, environment: { TEST_KEY: "fixture-key" } });
    await inst.refreshModels!();
    const transcript = Array.from({ length: 12 }, (_, index) => [
      { role: "user" as const, text: `Question ${index}: ${words(400)}` },
      { role: "assistant" as const, text: `Answer ${index}: ${words(400)}` },
    ]).flat();
    const recorder = recordEvents(inst.adapter);
    try {
      await inst.adapter.sendTurn({ threadId: "calib", text: "And now?", model, transcript });
      const done = await recorder.until((event) => event.type === "turn.completed") as { ok?: boolean };
      expect(done.ok).toBe(true);
    } finally { recorder.stop(); await inst.dispose(); }
    expect(new TokenCalibration(model, "calib").apply(1_000)).toBeGreaterThanOrEqual(1_900);
  });
});
