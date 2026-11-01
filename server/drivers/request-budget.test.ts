import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { recordEvents } from "../testing/events.ts";
import { parseConfigPatch, parseStoredConfig, type AppConfig } from "../config.ts";
import { settingsTurnFields } from "../turn-settings.ts";
import { turnContextSettings, type OpenAIChatMessage } from "./openai-chat.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); during = undefined; });
/** Runs while the fake provider holds request `n`, with the turn's steer at hand. */
let during: ((n: number, steer: (text: string) => Promise<string>) => Promise<void>) | undefined;

const log = (step: number, lines: number) => Array.from({ length: lines }, (_, i) => `2026-10-31T0${step}:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 13} handled request req-${step}${String(i).padStart(5, "0")} in ${(i * 37) % 900}ms`).join("\n");

type Body = { stream?: boolean; messages: OpenAIChatMessage[]; tools?: unknown[]; tool_choice?: unknown; model: string };
type Event = { type: string; ok?: boolean; stopReason?: string | null; message?: string; itemType?: string; text?: string };

const stream = (delta: object, finish: string, usage: object) =>
  new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`);
const readCall = (n: number, path: string) => ({ tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path, limit: 1000 + n }) } }] });

/** A model that calls read_file every round it is offered tools, and answers only when it has none. */
async function runTurn(id: string, files: Record<string, string>, turnContext: object, fail?: (n: number) => Response | undefined) {
  const model = "budget-m";
  const cwd = mkdtempSync(join(tmpdir(), `rootclaw-${id}-`));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  const names = Object.keys(files);
  const bodies: Body[] = [];
  let steer: (text: string) => Promise<string> = async () => "unavailable";
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: model, context_length: 128_000 }] }));
    const raw = String(init!.body);
    const body = JSON.parse(raw) as Body;
    bodies.push(body);
    await during?.(bodies.length, steer);
    const failed = fail?.(bodies.length);
    if (failed) return failed;
    const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 5 };
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "## Goal\n- read logs" }, finish_reason: "stop" }], usage }));
    if (body.tool_choice === "none" || !body.tools?.length) return stream({ content: "Read what fit in the budget; the rest is unread." }, "stop", usage);
    const chats = bodies.filter((entry) => entry.stream).length;
    return stream(readCall(chats, names[(chats - 1) % names.length]), "tool_calls", usage);
  }));
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { lines.push(args.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const inst = await OpenAICompatDriver.create({ instanceId: id, displayName: "Fixture", enabled: true,
    config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model }, environment: { TEST_KEY: "fixture-key" } });
  await inst.refreshModels!();
  steer = (text) => inst.adapter.steer!(id, text);
  const recorder = recordEvents(inst.adapter);
  try {
    await inst.adapter.sendTurn({ threadId: id, text: "Read each log, one per step.", model, cwd, approvalMode: "full", turnContext });
    await recorder.until((event) => event.type === "turn.completed", 60_000);
    return { bodies, lines, events: recorder.events as Event[] };
  } finally { recorder.stop(); await inst.dispose(); }
}

const done = (events: Event[]) => events.find((event) => event.type === "turn.completed")!;

describe("per-turn request budget (engine.maxTurnRequests)", () => {
  it("stops a tool-calling model at exactly 5 requests, a compaction summary included, with a final answer that may not call tools", async () => {
    const files = { "a.log": log(1, 70), "b.log": log(2, 70), "c.log": log(3, 70) };
    const { bodies, lines, events } = await runTurn("budget-5", files, { compactAt: 8_000, keepExchanges: 1, maxTurnRequests: 5 });
    expect(bodies).toHaveLength(5);
    expect(bodies.filter((body) => !body.stream)).toHaveLength(1);
    expect(bodies.slice(0, 4).filter((body) => body.stream).every((body) => body.tools?.length)).toBe(true);
    expect(bodies[4]!.stream).toBe(true);
    expect(bodies[4]!.tools).toEqual(bodies[3]!.tools);
    expect(bodies[4]!.tool_choice).toBe("none");
    expect(bodies.slice(0, 4).some((body) => "tool_choice" in body)).toBe(false);
    expect(JSON.stringify(bodies[4]!.messages.at(-1))).toContain("last model request of this turn");
    expect(done(events)).toMatchObject({ ok: true, stopReason: "request_budget" });
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
    expect(events.some((event) => event.type === "item.completed" && event.itemType === "assistant_text" && /Read what fit/.test(event.text ?? ""))).toBe(true);
    expect(events.some((event) => event.type === "runtime.notice" && /request/i.test(event.message ?? ""))).toBe(true);
    expect(lines.some((line) => line.includes("request budget reached"))).toBe(true);
  });

  it("counts a transient retry against the budget", async () => {
    vi.stubEnv("ROOTCLAW_RETRY_SCALE", "0");
    const { bodies, events } = await runTurn("budget-retry", { "a.log": "one line" }, { maxTurnRequests: 3 },
      (n) => (n === 1 ? new Response("upstream down", { status: 503 }) : undefined));
    expect(bodies).toHaveLength(3);
    expect(bodies[2]!.tools?.length).toBeGreaterThan(0);
    expect(bodies[2]!.tool_choice).toBe("none");
    expect(done(events)).toMatchObject({ ok: true, stopReason: "request_budget" });
  });

  it("refuses a steer that arrives during the final request, as at the 64th step, and reads one sent before it", async () => {
    const outcomes: string[] = [];
    during = async (n, steer) => { if (n >= 2) outcomes.push(await steer(`note during request ${n}`)); };
    const { bodies, events } = await runTurn("budget-steer", { "a.log": "one line" }, { maxTurnRequests: 3 });
    expect(bodies).toHaveLength(3);
    expect(outcomes).toEqual(["steered", "refused"]);
    expect(JSON.stringify(bodies[2]!.messages)).toContain("note during request 2");
    expect(done(events)).toMatchObject({ ok: true, stopReason: "request_budget" });
  });

  it("keeps the 64-step cap and its message without the setting", async () => {
    const { bodies, events } = await runTurn("budget-off", { "a.log": "one line" }, {});
    expect(bodies.filter((body) => body.stream)).toHaveLength(64);
    expect(done(events)).toMatchObject({ ok: false });
    expect(events.find((event) => event.type === "runtime.error")?.message).toContain("Stopped after 64 steps without a final answer.");
  }, 60_000);
});

describe("maxTurnRequests settings", () => {
  it("rejects values outside 2..64 in config decode", () => {
    for (const bad of [0, 1, 65, 2.5]) {
      expect(() => parseStoredConfig({ engine: { maxTurnRequests: bad } })).toThrow();
      expect(() => parseConfigPatch({ engine: { maxTurnRequests: bad } })).toThrow();
    }
    expect(parseStoredConfig({ engine: { maxTurnRequests: 2 } }).engine?.maxTurnRequests).toBe(2);
    expect(parseStoredConfig({ engine: { maxTurnRequests: 64 } }).engine?.maxTurnRequests).toBe(64);
  });

  it("passes the setting to the turn, and reads ROOTCLAW_MAX_TURN_REQUESTS only within 2..64", () => {
    expect(settingsTurnFields({ engine: { maxTurnRequests: 12 } } as AppConfig, "/tmp/rootclaw-budget", false, "/tmp").turnContext.maxTurnRequests).toBe(12);
    expect(settingsTurnFields({} as AppConfig, "/tmp/rootclaw-budget", false, "/tmp").turnContext).not.toHaveProperty("maxTurnRequests");
    vi.stubEnv("ROOTCLAW_MAX_TURN_REQUESTS", "8");
    expect(turnContextSettings(undefined).maxTurnRequests).toBe(8);
    expect(turnContextSettings({ maxTurnRequests: 20 }).maxTurnRequests).toBe(20);
    for (const bad of ["1", "65", "3.5", "x"]) {
      vi.stubEnv("ROOTCLAW_MAX_TURN_REQUESTS", bad);
      expect(turnContextSettings(undefined).maxTurnRequests).toBeUndefined();
    }
  });
});
