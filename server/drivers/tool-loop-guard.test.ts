// Cut 03 AC-2: the cross-round loop guard, through a real driver turn against a fake OpenAI-compatible server.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ROOTCLAW_RETRY_SCALE ??= "0.001";

const executed = vi.hoisted(() => [] as string[]);
vi.mock("./workspace-tools.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./workspace-tools.ts")>();
  return { ...original, executeWorkspaceTool: (...args: Parameters<typeof original.executeWorkspaceTool>) => {
    executed.push(args[0]);
    return original.executeWorkspaceTool(...args);
  } };
});

import type { SendTurnInput } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { toolCallSignature } from "./tool-loop-guard.ts";

interface Body { messages: Array<{ role: string; content: unknown; tool_call_id?: string }>; tools?: unknown[]; tool_choice?: string; parallel_tool_calls?: boolean }
type Round = Array<[string, Record<string, unknown> | string]>;
const usage = { prompt_tokens: 10, completion_tokens: 2 };
const mayCall = (body: Body) => Boolean(body.tools?.length) && body.tool_choice !== "none";
function sse(response: ServerResponse, delta: unknown, finish: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], usage })}\n\ndata: [DONE]\n\n`);
}

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { executed.length = 0; });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** script(n, body) gives the n-th chat request's tool calls (0-based); none means a final answer. */
async function fixture(script: (n: number, body: Body) => Round | undefined) {
  const base = mkdtempSync(join(tmpdir(), "rootclaw-loop-guard-"));
  const cwd = join(base, "work");
  mkdirSync(cwd);
  const requests: Body[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
    let data = "";
    for await (const part of request) data += part.toString();
    const body = JSON.parse(data) as Body;
    requests.push(body);
    const round = script(requests.length - 1, body);
    if (round) sse(response, { content: null, tool_calls: round.map(([name, args], index) => ({ index, id: `r${requests.length}_${index}`, type: "function",
      function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } })) }, "tool_calls");
    else sse(response, { content: "Final answer." }, "stop");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const instance = await OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "loop", enabled: true,
    config: { url: `${origin}/v1`, apiKeyEnv: "FIXTURE_LOOP_KEY" }, environment: { FIXTURE_LOOP_KEY: "fixture-loop-credential-5b1e" } });
  const recorder = recordEvents(instance.adapter);
  const threadId = randomUUID();
  cleanups.push(async () => {
    recorder.stop();
    await instance.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await removeTempDir(base);
  });
  const toolMessages = (index: number) => requests[index]!.messages.filter((message) => message.role === "tool")
    .map((message) => ({ id: message.tool_call_id, ...JSON.parse(String(message.content)) as { ok: boolean; result: string } }));
  return {
    cwd, requests, recorder, threadId, instance, toolMessages,
    start: (input: Partial<SendTurnInput> = {}) => instance.adapter.sendTurn({ threadId, text: "work", model: "m", cwd, approvalMode: "full", ...input }),
    completed: () => recorder.until((event) => event.type === "turn.completed"),
  };
}

describe("tool call signature", () => {
  it("(d) treats a different JSON key order as the same call", () => {
    expect(toolCallSignature("read_file", '{"path":"a.txt","offset":1}')).toBe(toolCallSignature("read_file", '{"offset":1,"path":"a.txt"}'));
    expect(toolCallSignature("read_file", '{"a":{"y":1,"x":2}}')).toBe(toolCallSignature("read_file", '{"a":{"x":2,"y":1}}'));
    expect(toolCallSignature("read_file", '{"path":"a.txt"}')).not.toBe(toolCallSignature("grep", '{"path":"a.txt"}'));
    expect(toolCallSignature("read_file", '{"path":"a.txt"}')).not.toBe(toolCallSignature("read_file", '{"path":"b.txt"}'));
  });
});

describe("loop guard in a turn", () => {
  it("(a) answers an identical read with no change in between from the earlier result, without running it again", async () => {
    const f = await fixture((n) => n < 2 ? [["read_file", { path: "a.txt" }]] : undefined);
    writeFileSync(join(f.cwd, "a.txt"), "alpha\n");
    await f.start();
    const done = await f.completed();
    expect(executed).toEqual(["read_file"]);
    expect(f.requests).toHaveLength(3);
    const second = f.toolMessages(2)[1]!;
    expect(second.ok).toBe(true);
    expect(second.result).toContain("Identical to the call in round 1");
    expect(second.result).toContain("alpha");
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
  });

  it("(b) runs an identical read again after a successful edit", async () => {
    const f = await fixture((n) => [[["read_file", { path: "a.txt" }]], [["edit_file", { path: "a.txt", old_string: "alpha", new_string: "beta" }]], [["read_file", { path: "a.txt" }]]][n] as Round | undefined);
    writeFileSync(join(f.cwd, "a.txt"), "alpha\n");
    await f.start();
    await f.completed();
    expect(executed).toEqual(["read_file", "edit_file", "read_file"]);
    expect(f.toolMessages(3)[2]!.result).toContain("beta");
    expect(f.toolMessages(3)[2]!.result).not.toContain("Identical to the call");
  });

  it("(c) ends a model that keeps making the same call: a fourth request that keeps the tools with tool_choice none, then tool_loop with the final text", async () => {
    const f = await fixture((_n, body) => mayCall(body) ? [["read_file", { path: "a.txt" }]] : undefined);
    writeFileSync(join(f.cwd, "a.txt"), "alpha\n");
    await f.start();
    const done = await f.completed();
    expect(f.requests).toHaveLength(4);
    expect(f.requests.slice(0, 3).every((body) => body.tools?.length && body.tool_choice === undefined && body.parallel_tool_calls === true)).toBe(true);
    expect(f.requests[3]!.tools).toEqual(f.requests[0]!.tools);
    expect(f.requests[3]!.tool_choice).toBe("none");
    expect(f.requests[3]).not.toHaveProperty("parallel_tool_calls");
    expect(done).toMatchObject({ ok: true, stopReason: "tool_loop" });
    expect(f.recorder.events.some((event) => event.type === "runtime.notice" && String((event as { message?: unknown }).message).includes("same tool call"))).toBe(true);
    expect(f.recorder.events.some((event) => event.type === "item.completed" && (event as { itemType?: string }).itemType === "assistant_text"
      && (event as { text?: string }).text === "Final answer.")).toBe(true);
    expect(f.recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
  });

  it("(c) does not run a call the provider still returns on the closing request, and ends tool_loop", async () => {
    const f = await fixture((_n, body) => body.tools?.length ? [["write_file", { content: "x", path: "w.txt" }]] : undefined);
    await f.start();
    const done = await f.completed();
    expect(f.requests).toHaveLength(4);
    expect(f.requests[3]!.tool_choice).toBe("none");
    expect(executed).toEqual(["write_file", "write_file", "write_file"]);
    expect(done).toMatchObject({ ok: true, stopReason: "tool_loop" });
    expect(f.recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
  });

  it("(c) refuses a message steered during the closing request, as at the last step, so it waits for the next turn", async () => {
    const steered: Array<Promise<unknown>> = [];
    const f = await fixture((_n, body) => {
      if (mayCall(body)) return [["read_file", { path: "a.txt" }]];
      steered.push(f.instance.adapter.steer!(f.threadId, "one more thing"));
      return undefined;
    });
    writeFileSync(join(f.cwd, "a.txt"), "alpha\n");
    await f.start();
    expect(await f.completed()).toMatchObject({ ok: true, stopReason: "tool_loop" });
    expect(await Promise.all(steered)).toEqual(["refused"]);
  });

  it("(c) also stops a mutating call repeated three times, each one run", async () => {
    const f = await fixture((_n, body) => mayCall(body) ? [["write_file", { content: "x", path: "w.txt" }]] : undefined);
    await f.start();
    const done = await f.completed();
    expect(executed).toEqual(["write_file", "write_file", "write_file"]);
    expect(f.requests).toHaveLength(4);
    expect(f.requests[3]!.tool_choice).toBe("none");
    expect(done).toMatchObject({ ok: true, stopReason: "tool_loop" });
  });

  it("(d) counts the same call with its keys reordered towards the limit", async () => {
    const order = ['{"path":"a.txt","limit":5}', '{"limit":5,"path":"a.txt"}', '{"path":"a.txt","limit":5}'];
    const f = await fixture((n, body) => mayCall(body) && n < 3 ? [["read_file", order[n]!]] : undefined);
    writeFileSync(join(f.cwd, "a.txt"), "alpha\n");
    await f.start();
    const done = await f.completed();
    expect(executed).toEqual(["read_file"]);
    expect(done).toMatchObject({ stopReason: "tool_loop" });
  });

  it("(e) does not count denied calls", async () => {
    const f = await fixture((n) => n < 3 ? [["write_file", { path: "w.txt", content: "x" }]] : undefined);
    await f.start({ approvalMode: "ask" });
    for (let denied = 0; denied < 3; denied++) {
      const opened = await f.recorder.until((event) => event.type === "request.opened" && !f.recorder.events.some((later) =>
        later.type === "request.resolved" && (later as { requestId?: string }).requestId === (event as { requestId?: string }).requestId));
      await f.instance.adapter.respondToRequest(f.threadId, (opened as { requestId: string }).requestId, { behavior: "deny" });
      await f.recorder.until((event) => event.type === "request.resolved" && (event as { requestId?: string }).requestId === (opened as { requestId: string }).requestId);
    }
    const done = await f.completed();
    expect(executed).toEqual([]);
    expect(f.requests).toHaveLength(4);
    expect(f.requests[3]!.tools?.length).toBeGreaterThan(0);
    expect(done).not.toMatchObject({ stopReason: "tool_loop" });
  });
});
