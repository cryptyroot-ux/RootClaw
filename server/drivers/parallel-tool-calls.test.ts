// Cut 03: Chat Completions requests that offer tools ask for parallel tool calls; a provider that refuses the field gets the request again without it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

type Body = { stream?: boolean; tools?: unknown[]; tool_choice?: unknown; parallel_tool_calls?: unknown };

const stream = (delta: object, finish: string) =>
  new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
const readCall = (n: number) => ({ tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt", limit: 1000 + n }) } }] });

/** A model that reads a file every round it may call tools and answers otherwise; `respond` can replace a chat reply. */
async function runTurns(id: string, turns: number, turnContext: object, respond?: (body: Body, raw: string, n: number) => Response | undefined) {
  const model = "parallel-m";
  const cwd = mkdtempSync(join(tmpdir(), `rootclaw-${id}-`));
  writeFileSync(join(cwd, "a.txt"), "alpha\n");
  const bodies: Body[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: model, context_length: 128_000 }] }));
    const raw = String(init!.body);
    const body = JSON.parse(raw) as Body;
    bodies.push(body);
    const replaced = respond?.(body, raw, bodies.length);
    if (replaced) return replaced;
    if (!body.tools?.length || body.tool_choice === "none") return stream({ content: "Done." }, "stop");
    return stream(readCall(bodies.length), "tool_calls");
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const inst = await OpenAICompatDriver.create({ instanceId: id, displayName: "Fixture", enabled: true,
    config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model }, environment: { TEST_KEY: "fixture-key" } });
  await inst.refreshModels!();
  const recorder = recordEvents(inst.adapter);
  try {
    for (let turn = 0; turn < turns; turn++) {
      await inst.adapter.sendTurn({ threadId: `${id}-${turn}`, text: "Read a.txt.", model, cwd, approvalMode: "full", turnContext });
      await recorder.until((event) => event.type === "turn.completed" && recorder.events.filter((seen) => seen.type === "turn.completed").length === turn + 1, 60_000);
    }
    return { bodies, events: recorder.events as Array<{ type: string; ok?: boolean; stopReason?: string | null }> };
  } finally { recorder.stop(); await inst.dispose(); }
}

describe("parallel_tool_calls on Chat Completions", () => {
  it("is true on every request that may call tools and absent from the closing request with tool_choice none", async () => {
    const { bodies, events } = await runTurns("parallel-on", 1, { maxTurnRequests: 3 });
    expect(bodies).toHaveLength(3);
    expect(bodies.slice(0, 2).map((body) => [Boolean(body.tools?.length), body.parallel_tool_calls])).toEqual([[true, true], [true, true]]);
    expect(bodies[2]!.tools).toEqual(bodies[0]!.tools);
    expect(bodies[2]!.tool_choice).toBe("none");
    expect("parallel_tool_calls" in bodies[2]!).toBe(false);
    expect(events.find((event) => event.type === "turn.completed")).toMatchObject({ ok: true, stopReason: "request_budget" });
  });

  it("is absent from a request without tools", async () => {
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "parallel-m", context_length: 128_000 }] }));
      bodies.push(JSON.parse(String(init!.body)) as Body);
      return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "Plain." }, finish_reason: "stop" }] }));
    }));
    const inst = await OpenAICompatDriver.create({ instanceId: "parallel-plain", displayName: "Fixture", enabled: true,
      config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: "parallel-m" }, environment: { TEST_KEY: "fixture-key" } });
    try {
      expect(await inst.generateText!("hello", { model: "parallel-m" })).toBe("Plain.");
    } finally { await inst.dispose(); }
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.tools).toBeUndefined();
    expect("parallel_tool_calls" in bodies[0]!).toBe(false);
  });

  it("resends once without the field after a 400 that names it, counts that resend, and leaves it off for the rest of the instance", async () => {
    const refusal = JSON.stringify({ error: { message: "Unrecognized request argument supplied: parallel_tool_calls", type: "invalid_request_error" } });
    const { bodies, events } = await runTurns("parallel-off", 2, { maxTurnRequests: 3 },
      (body) => (body.parallel_tool_calls !== undefined ? new Response(refusal, { status: 400 }) : undefined));
    expect(bodies[0]!.parallel_tool_calls).toBe(true);
    expect(bodies.slice(1).some((body) => "parallel_tool_calls" in body)).toBe(false);
    expect(bodies[1]!.tools?.length).toBeGreaterThan(0);
    expect(bodies).toHaveLength(6);
    const completed = events.filter((event) => event.type === "turn.completed");
    expect(completed).toHaveLength(2);
    expect(completed.every((event) => event.ok)).toBe(true);
  });
});
