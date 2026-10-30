// Planner/verifier through a real driver turn against a scripted OpenAI-compatible server.
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

process.env.ROOTCLAW_RETRY_SCALE ??= "0.001";

import type { SendTurnInput } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { PLAN_TAG } from "./plan-verify.ts";

interface Body { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }>; stream?: boolean }
const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
function sse(response: ServerResponse, chunks: unknown[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const value of chunks) response.write(`data: ${JSON.stringify(value)}\n\n`);
  response.end("data: [DONE]\n\n");
}
const planCall = (status: string) => ({ index: 0, id: `plan_${randomUUID().slice(0, 6)}`, type: "function",
  function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ title: "Find the bug", status }, { title: "Fix and test it", status: "pending" }] }) } });

const MULTI = "First investigate why the build fails, then fix the config and run the tests, and finally summarize what changed.";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(rounds: Array<"plan" | "answer">, verdicts: string[] = []) {
  const streamed: Body[] = [];
  const checks: Body[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
    let data = "";
    for await (const part of request) data += part.toString();
    const body = JSON.parse(data) as Body;
    if (body.stream === false) {
      checks.push(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: verdicts[checks.length - 1] ?? '{"verdict":"pass","missing":[]}' }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10 } }));
      return;
    }
    streamed.push(body);
    const step = rounds[streamed.length - 1] ?? "answer";
    if (step === "plan") sse(response, [chunk({ content: null, tool_calls: [planCall("doing")] }, "tool_calls")]);
    else sse(response, [chunk({ content: `Answer ${streamed.length}.` }, "stop")]);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const instance = await OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "pv", enabled: true,
    config: { url: `${origin}/v1`, apiKeyEnv: "FIXTURE_PV_KEY" }, environment: { FIXTURE_PV_KEY: "fixture-pv-credential-1b2c" } });
  const recorder = recordEvents(instance.adapter);
  const threadId = randomUUID();
  cleanups.push(async () => {
    recorder.stop();
    await instance.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return {
    streamed, checks, recorder,
    run: async (input: Partial<SendTurnInput>) => {
      await instance.adapter.sendTurn({ threadId, text: MULTI, model: "m", system: "You are a bot.", ...input });
      return recorder.until((event) => event.type === "turn.completed");
    },
  };
}

const toolNames = (body: Body) => (body.tools ?? []).map((tool) => tool.function.name);
const ON = { mode: "plan+verify" as const, maxVerifyRetries: 1 };

describe("planner/verifier in a native turn", () => {
  it("stays off by default: no update_plan tool, no hint, no check", async () => {
    const f = await fixture(["answer"]);
    const done = await f.run({});
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(toolNames(f.streamed[0]!)).not.toContain("update_plan");
    expect(String(f.streamed[0]!.messages[0]!.content)).toBe("You are a bot.");
    expect(f.checks).toHaveLength(0);
  });

  it("does not plan a simple turn even with the flag on", async () => {
    const f = await fixture(["answer"]);
    await f.run({ text: "hi there, how are you?", planVerify: ON });
    expect(toolNames(f.streamed[0]!)).not.toContain("update_plan");
    expect(f.checks).toHaveLength(0);
    expect(f.recorder.events.some((event) => event.type === "plan.updated")).toBe(false);
  });

  it("plans a multi-step turn, pins the plan in the system message, and verifies the answer", async () => {
    const f = await fixture(["plan", "answer"]);
    const done = await f.run({ planVerify: ON });
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(toolNames(f.streamed[0]!)).toContain("update_plan");
    expect(String(f.streamed[0]!.messages[0]!.content)).toContain("[Planning]");
    const pinned = String(f.streamed[1]!.messages[0]!.content);
    expect(pinned).toContain(PLAN_TAG);
    expect(pinned).toContain("1. [~] Find the bug");
    expect(f.recorder.events.find((event) => event.type === "plan.updated")).toMatchObject({ revision: 1, reason: "initial" });
    expect(f.checks).toHaveLength(1);
    expect(f.recorder.events.find((event) => event.type === "verify.completed")).toMatchObject({ verdict: "pass", attempt: 1 });
  });

  it("sends a failed check back once, then ends unverified with a note", async () => {
    const fail = '{"verdict":"fail","missing":["tests were not run"]}';
    const f = await fixture(["plan", "answer", "answer"], [fail, fail]);
    const done = await f.run({ planVerify: ON });
    expect(done).toMatchObject({ ok: true, stopReason: "unverified" });
    expect(f.checks).toHaveLength(2);
    expect(f.streamed).toHaveLength(3);
    expect(String(f.streamed[2]!.messages.at(-1)!.content)).toContain("tests were not run");
    expect(f.recorder.events.some((event) => event.type === "runtime.notice" && /Unverified/.test(String((event as { message?: string }).message)))).toBe(true);
  });

  it("plans without checking in plan-only mode", async () => {
    const f = await fixture(["plan", "answer"]);
    const done = await f.run({ planVerify: { mode: "plan", maxVerifyRetries: 1 } });
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
    expect(f.checks).toHaveLength(0);
  });

  it("skips the check when the budget would be exceeded", async () => {
    const f = await fixture(["plan", "answer"]);
    const done = await f.run({ planVerify: ON, budget: { tokens: 1, warnAtPercent: 100, why: "tiny" } as never });
    expect(f.checks).toHaveLength(0);
    expect(done).toMatchObject({ ok: true });
  });
});
