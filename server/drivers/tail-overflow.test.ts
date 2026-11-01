import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";
import { estimateRequestTokens, minOutputTokens } from "./turn-context.ts";
import { requestTooLargeMessage } from "../../shared/request-too-large.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const MODEL = "tail-local";
const log = (lines: number, marker = "") => Array.from({ length: lines }, (_, i) => `2026-10-31T01:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 13} handled req-${String(i).padStart(5, "0")} in ${(i * 37) % 900}ms${i === Math.floor(lines / 2) ? ` ${marker}` : ""}`).join("\n");

type Sent = { stream: boolean; tokens: number; maxTokens?: number; refused: boolean; text: string };

async function run(id: string, window: number, file: string, opts: { offload?: boolean; offloadBytes?: number; script?: string[][]; text?: string; transcript?: Array<{ role: "user" | "assistant"; text: string }> } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "rootclaw-tail-"));
  writeFileSync(join(cwd, "big.log"), file);
  const script = opts.script ?? [["big.log"]];
  const sent: Sent[] = [];
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: MODEL, context_length: window }] }));
    const body = JSON.parse(String(init!.body)) as { stream?: boolean; max_tokens?: number; messages: never[]; tools?: never[] };
    const tokens = estimateRequestTokens(body.messages, body.tools ?? [], MODEL);
    const refused = tokens + (body.max_tokens ?? 0) > window;
    sent.push({ stream: Boolean(body.stream), tokens, maxTokens: body.max_tokens, refused, text: JSON.stringify(body.messages) });
    if (refused) return new Response(JSON.stringify({ error: { message: `This model's maximum context length is ${window} tokens. However, you requested ${tokens + (body.max_tokens ?? 0)} tokens.` } }), { status: 400 });
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "## Goal\n- read the log" }, finish_reason: "stop" }] }));
    const paths = script[calls++];
    const round = calls;
    const delta = paths ? { tool_calls: paths.map((path, index) => ({ index, id: `c${round}_${index}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path }) } })) } : { content: "Done." };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: paths ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const inst = await OpenAICompatDriver.create({ instanceId: id, displayName: "Fixture", enabled: true,
    config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: "fixture-key" } });
  await inst.refreshModels!();
  const recorder = recordEvents(inst.adapter);
  const offloadDir = join(cwd, ".offload");
  try {
    await inst.adapter.sendTurn({ threadId: id, text: opts.text ?? "Read big.log and report.", model: MODEL, cwd, approvalMode: "full", ...(opts.transcript ? { transcript: opts.transcript } : {}),
      ...(opts.offload === false ? {} : { turnContext: { offloadDir, ...(opts.offloadBytes ? { offloadBytes: opts.offloadBytes } : {}) } }) });
    const done = await recorder.until((event) => event.type === "turn.completed", 30_000) as { ok?: boolean };
    const errors = recorder.events.filter((event) => event.type === "runtime.error").map((event) => (event as { message?: string }).message ?? "");
    let saved: string[] = [];
    try { saved = readdirSync(offloadDir, { recursive: true }).map(String).filter((name) => statSync(join(offloadDir, name)).isFile()).map((name) => readFileSync(join(offloadDir, name), "utf8")); } catch { /* none */ }
    return { ok: done.ok, errors, sent, saved };
  } finally { recorder.stop(); await inst.dispose(); }
}

const WINDOW = 16_384;
const FILE = log(230, "ERROR-MARK-7731");
const BATCH = ["big.log", "big.log", "big.log", "big.log"];

describe("a kept tail over the window: one round's tool results, each under the offload threshold", () => {
  it("offloads them without a summary call and sends one request that fits", async () => {
    expect(Buffer.byteLength(FILE)).toBeLessThan(16_000);
    const { ok, sent, saved } = await run("tail-fit", WINDOW, FILE, { script: [BATCH] });
    expect(ok).toBe(true);
    expect(sent.filter((request) => !request.stream)).toEqual([]);
    expect(sent.filter((request) => request.refused)).toEqual([]);
    expect(sent.filter((request) => request.stream).length).toBe(2);
    const second = sent[1]!;
    expect(second.tokens + (second.maxTokens ?? 0)).toBeLessThanOrEqual(WINDOW);
    expect(second.maxTokens ?? Infinity).toBeGreaterThanOrEqual(minOutputTokens(WINDOW));
    expect(second.text).toMatch(/handle out_[A-Za-z0-9_-]+/);
    expect(second.text).toContain("2026-10-31T01:00:00Z");
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((text) => text.includes("ERROR-MARK-7731") && text.includes(FILE.split("\n").at(-1)!))).toBe(true);
  });

  it("pays at most the one summary its earlier history needs, never one per attempt", async () => {
    const transcript = Array.from({ length: 4 }, (_, index) => [
      { role: "user" as const, text: `Question ${index}: ${log(40)}` },
      { role: "assistant" as const, text: `Answer ${index}: ${log(40)}` },
    ]).flat();
    const { ok, sent } = await run("tail-history", WINDOW, FILE, { script: [BATCH], transcript });
    expect(ok).toBe(true);
    expect(sent.filter((request) => request.refused)).toEqual([]);
    expect(sent.filter((request) => !request.stream).length).toBeLessThanOrEqual(1);
    for (const request of sent) expect(request.tokens + (request.maxTokens ?? 0)).toBeLessThanOrEqual(WINDOW);
  });

  it("does the same for one result kept whole by a large configured offload threshold", async () => {
    const file = log(1_000);
    const { ok, sent } = await run("tail-cfg", WINDOW, file, { offloadBytes: 1_000_000 });
    expect(ok).toBe(true);
    expect(sent.filter((request) => !request.stream)).toEqual([]);
    expect(sent.filter((request) => request.refused)).toEqual([]);
    expect(sent.filter((request) => request.stream).length).toBe(2);
  });

  it("fails cleanly, without summary calls or an over-limit request, when offload is off", async () => {
    const { ok, sent, errors } = await run("tail-none", WINDOW, FILE, { offload: false, script: [BATCH] });
    expect(ok).toBe(false);
    expect(errors.join("\n")).toContain(requestTooLargeMessage(MODEL));
    expect(sent.filter((request) => !request.stream)).toEqual([]);
    expect(sent.filter((request) => request.refused)).toEqual([]);
    expect(sent.length).toBe(1);
  });
});

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97} note${i % 31}`).join(" ");

async function refusingProvider(id: string, limit: number) {
  let summaries = 0;
  let streamed = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: MODEL, context_length: 131_072 }] }));
    const body = JSON.parse(String(init!.body)) as { stream?: boolean; messages: never[]; tools?: never[] };
    if (!body.stream) { summaries++; return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "## Goal\n- answer" }, finish_reason: "stop" }] })); }
    streamed++;
    if (estimateRequestTokens(body.messages, body.tools ?? [], MODEL) > limit) return new Response(JSON.stringify({ error: { message: "Your input exceeds the context window of this model. Please adjust your input and try again." } }), { status: 400 });
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const inst = await OpenAICompatDriver.create({ instanceId: id, displayName: "Fixture", enabled: true,
    config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: "fixture-key" } });
  await inst.refreshModels!();
  const transcript = Array.from({ length: 12 }, (_, index) => [
    { role: "user" as const, text: `Question ${index}: ${words(700)}` },
    { role: "assistant" as const, text: `Answer ${index}: ${words(700)}` },
  ]).flat();
  const recorder = recordEvents(inst.adapter);
  try {
    await inst.adapter.sendTurn({ threadId: id, text: "And now?", model: MODEL, transcript });
    const done = await recorder.until((event) => event.type === "turn.completed", 30_000) as { ok?: boolean };
    return { ok: done.ok, summaries, streamed, overflowCompactions: lines.filter((line) => /compaction #\d+ \(overflow\)/.test(line)).length };
  } finally { recorder.stop(); await inst.dispose(); }
}

/** A provider that counts twice what the estimate says and never reports usage, so every round that adds a tool
 * result overflows again although the window it names is already known. */
async function underCounted(id: string, rounds: number) {
  const window = 20_000;
  const cwd = mkdtempSync(join(tmpdir(), "rootclaw-under-"));
  writeFileSync(join(cwd, "part.log"), log(150));
  let summaries = 0;
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: MODEL, context_length: window }] }));
    const body = JSON.parse(String(init!.body)) as { stream?: boolean; max_tokens?: number; messages: never[]; tools?: never[] };
    const counted = 2 * estimateRequestTokens(body.messages, body.tools ?? [], MODEL);
    if (counted > window) return new Response(JSON.stringify({ error: { message: `This model's maximum context length is ${window} tokens. However, your messages resulted in ${counted} tokens.` } }), { status: 400 });
    if (!body.stream) { summaries++; return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "## Goal\n- read" }, finish_reason: "stop" }] })); }
    const more = calls++ < rounds;
    const delta = more ? { tool_calls: [{ index: 0, id: `u${calls}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "part.log" }) } }] } : { content: "Done." };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: more ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const inst = await OpenAICompatDriver.create({ instanceId: id, displayName: "Fixture", enabled: true,
    config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: "fixture-key" } });
  await inst.refreshModels!();
  const recorder = recordEvents(inst.adapter);
  try {
    await inst.adapter.sendTurn({ threadId: id, text: "Read part.log again each step.", model: MODEL, cwd, approvalMode: "full", turnContext: { offloadDir: join(cwd, ".offload") } });
    const done = await recorder.until((event) => event.type === "turn.completed", 30_000) as { ok?: boolean };
    const errors = recorder.events.filter((event) => event.type === "runtime.error").map((event) => (event as { message?: string }).message ?? "");
    return { ok: done.ok, errors, summaries, overflowCompactions: lines.filter((line) => /compaction #\d+ \(overflow\)/.test(line)).length };
  } finally { recorder.stop(); await inst.dispose(); }
}

describe("overflow recovery", () => {
  it("pays for at most two overflow summaries in a turn, then fails cleanly", async () => {
    const { ok, summaries, overflowCompactions } = await refusingProvider("tail-cap", 100);
    expect(ok).toBe(false);
    expect(overflowCompactions).toBeLessThanOrEqual(2);
    expect(summaries).toBeLessThanOrEqual(2);
  });

  it("stops paying for summaries after two in a turn whose rounds keep overflowing", async () => {
    const { ok, errors, summaries, overflowCompactions } = await underCounted("tail-under", 8);
    expect(overflowCompactions).toBeLessThanOrEqual(2);
    expect(summaries).toBeLessThanOrEqual(2);
    if (!ok) expect(errors.join("\n")).toContain(requestTooLargeMessage(MODEL));
  });

  it("still recovers when one summary is enough", async () => {
    const { ok, overflowCompactions } = await refusingProvider("tail-once", 40_000);
    expect(ok).toBe(true);
    expect(overflowCompactions).toBeLessThanOrEqual(2);
  });
});
