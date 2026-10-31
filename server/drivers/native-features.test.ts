// The native engine's built-in agent features, end to end through a real driver turn against the scriptable fake
// provider (server/testing/fake-openai-chat.ts): apply_patch, parallel read-only tools, mid-turn context compaction,
// web_fetch/web_search behind the approval gate, and reading a skill.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

process.env.ROOTCLAW_RETRY_SCALE ??= "0.001";

import type { SendTurnInput } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { startFakeOpenAiChat, type FakeToolCall } from "../testing/fake-openai-chat.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Msg = { role: string; content?: unknown; tool_call_id?: string };

async function fixture(toolCalls: FakeToolCall[], sequence?: FakeToolCall[][]) {
  const base = mkdtempSync(join(tmpdir(), "rootclaw-native-features-"));
  const cwd = join(base, "work");
  mkdirSync(cwd);
  const fake = await startFakeOpenAiChat();
  fake.set({ toolCalls, replies: ["Done."], ...(sequence ? { sequence } : {}) });
  const instance = await OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "nf", enabled: true,
    config: { url: fake.url, apiKeyEnv: "FIXTURE_NF_KEY" }, environment: { FIXTURE_NF_KEY: "fixture-nf-credential-1b2c" } });
  const recorder = recordEvents(instance.adapter);
  const threadId = randomUUID();
  cleanups.push(async () => { recorder.stop(); await instance.dispose(); await fake.stop(); await removeTempDir(base); });
  const streamed = () => fake.requests.filter((body) => body.stream === true);
  /** Tool results the model saw, in the order it saw them, from the last streamed request. */
  const toolResults = () => ((streamed().at(-1)?.messages ?? []) as Msg[]).filter((m) => m.role === "tool")
    .map((m) => ({ id: m.tool_call_id, ...JSON.parse(String(m.content)) as { ok: boolean; result: string } }));
  return {
    cwd, fake, recorder, streamed, toolResults, instance, threadId,
    start: (input: Partial<SendTurnInput> = {}) => instance.adapter.sendTurn({ threadId, text: "work", model: "fixture-model", cwd, ...input }),
    completed: () => recorder.until((event) => event.type === "turn.completed"),
  };
}

/** A local page server that counts how many requests are in flight at once. */
async function slowPages(delayMs: number) {
  let inFlight = 0;
  let peak = 0;
  const server = createServer((request, response) => {
    inFlight++; peak = Math.max(peak, inFlight);
    setTimeout(() => { inFlight--; response.writeHead(200, { "content-type": "text/plain" }); response.end(`page ${request.url}`); }, delayMs);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, peak: () => peak };
}

function allowPrivateWeb() {
  const before = process.env.ROOTCLAW_WEB_ALLOW_PRIVATE;
  process.env.ROOTCLAW_WEB_ALLOW_PRIVATE = "1";
  cleanups.push(async () => { if (before === undefined) delete process.env.ROOTCLAW_WEB_ALLOW_PRIVATE; else process.env.ROOTCLAW_WEB_ALLOW_PRIVATE = before; });
}

describe("native engine features (fake provider)", () => {
  it("apply_patch edits a file the model patched, all or nothing", async () => {
    const patch = "--- a/greet.js\n+++ b/greet.js\n@@ -1 +1 @@\n-module.exports = () => 'hi';\n+module.exports = () => 'hello';\n";
    const f = await fixture([{ name: "apply_patch", input: { patch } }]);
    writeFileSync(join(f.cwd, "greet.js"), "module.exports = () => 'hi';\n");
    await f.start({ approvalMode: "full" });
    await f.completed();
    expect(f.toolResults()[0]).toMatchObject({ ok: true });
    expect(readFileSync(join(f.cwd, "greet.js"), "utf8")).toBe("module.exports = () => 'hello';\n");
  });

  it("refuses a patch whose context does not match and leaves the file alone", async () => {
    const patch = "--- a/greet.js\n+++ b/greet.js\n@@ -1 +1 @@\n-module.exports = () => 'nope';\n+module.exports = () => 'hello';\n";
    const f = await fixture([{ name: "apply_patch", input: { patch } }]);
    writeFileSync(join(f.cwd, "greet.js"), "module.exports = () => 'hi';\n");
    await f.start({ approvalMode: "full" });
    await f.completed();
    expect(f.toolResults()[0]).toMatchObject({ ok: false });
    expect(readFileSync(join(f.cwd, "greet.js"), "utf8")).toBe("module.exports = () => 'hi';\n");
  });

  it("runs read-only calls of one round concurrently and returns results in call order", async () => {
    allowPrivateWeb();
    const pages = await slowPages(300);
    const f = await fixture(["a", "b", "c"].map((p) => ({ name: "web_fetch", input: { url: `${pages.origin}/${p}` } })));
    await f.start({ approvalMode: "full" });
    await f.completed();
    expect(pages.peak()).toBeGreaterThanOrEqual(2);
    const results = f.toolResults();
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(results.map((r) => /page \/(\w)/.exec(r.result)?.[1])).toEqual(["a", "b", "c"]);
  });

  it("compacts older steps mid-turn when a small context budget is passed, and still finishes", async () => {
    const big = (tag: string) => `${tag} `.repeat(3_000);
    const f = await fixture([], [
      [{ name: "read_file", input: { path: "one.txt" } }],
      [{ name: "read_file", input: { path: "two.txt" } }],
      [{ name: "read_file", input: { path: "three.txt" } }],
    ]);
    writeFileSync(join(f.cwd, "one.txt"), big("alpha"));
    writeFileSync(join(f.cwd, "two.txt"), big("bravo"));
    writeFileSync(join(f.cwd, "three.txt"), "small\n");
    await f.start({ approvalMode: "full", turnContext: { compactAt: 4_000 } } as Partial<SendTurnInput>);
    const done = await f.completed();
    expect(done).toMatchObject({ type: "turn.completed" });
    expect(f.fake.requests.some((body) => body.stream === false && JSON.stringify(body.messages).includes("You compact"))).toBe(true);
    const last = JSON.stringify(f.streamed().at(-1)?.messages);
    expect(last).not.toContain("alpha alpha alpha alpha");
    expect(f.streamed().length).toBe(4);
  });

  it("cards web_fetch and web_search in Ask mode, and a denied fetch never reaches the network", async () => {
    allowPrivateWeb();
    const pages = await slowPages(0);
    const f = await fixture([{ name: "web_fetch", input: { url: `${pages.origin}/x` } }, { name: "web_search", input: { query: "rootclaw" } }]);
    await f.start({ approvalMode: "ask" });
    for (const tool of ["web_fetch", "web_search"]) {
      const opened = await f.recorder.until((event) => event.type === "request.opened" && JSON.stringify(event).includes(tool));
      expect(opened).toMatchObject({ requestType: "permission" });
      await f.instance.adapter.respondToRequest(f.threadId, opened.requestId!, { behavior: "deny" });
    }
    await f.completed();
    expect(pages.peak()).toBe(0);
    expect(f.toolResults().map((r) => r.ok)).toEqual([false, false]);
  });

  it("runs web_fetch once allowed and hands the page text to the model", async () => {
    allowPrivateWeb();
    const pages = await slowPages(0);
    const f = await fixture([{ name: "web_fetch", input: { url: `${pages.origin}/doc` } }]);
    await f.start({ approvalMode: "ask" });
    const opened = await f.recorder.until((event) => event.type === "request.opened");
    await f.instance.adapter.respondToRequest(f.threadId, opened.requestId!, { behavior: "allow" });
    await f.completed();
    expect(f.toolResults()[0]).toMatchObject({ ok: true });
    expect(f.toolResults()[0]!.result).toContain("page /doc");
  });

  it("reads a skill named in the system prompt, outside the workspace, read-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rootclaw-nf-skill-"));
    cleanups.push(() => removeTempDir(dir));
    const skill = join(dir, "SKILL.md");
    writeFileSync(skill, "# Release notes skill\nAlways end with SHIPPED.\n");
    const f = await fixture([{ name: "read_file", input: { path: skill } }]);
    await f.start({ approvalMode: "full", system: `Skills:\n- release-notes: Writes release notes. Read ${JSON.stringify(skill)} before using it.` });
    await f.completed();
    expect(f.toolResults()[0]).toMatchObject({ ok: true });
    expect(f.toolResults()[0]!.result).toContain("Always end with SHIPPED.");
  });
});

describe("a failed read does not fail the turn", () => {
  it("finishes ok when the only failed call in the last round was a read-only workspace tool", async () => {
    const f = await fixture([{ name: "read_file", input: { path: "missing.txt" } }]);
    await f.start({ approvalMode: "full" });
    const done = await f.completed();
    expect(f.toolResults()[0]).toMatchObject({ ok: false });
    expect(done).toMatchObject({ ok: true });
    expect((done as { stopReason?: string }).stopReason).not.toBe("tool_error");
  });

  it("still fails the turn when a write failed in the last round", async () => {
    const f = await fixture([{ name: "edit_file", input: { path: "missing.txt", old_string: "a", new_string: "b" } }]);
    await f.start({ approvalMode: "full" });
    const done = await f.completed();
    expect(f.toolResults()[0]).toMatchObject({ ok: false });
    expect(done).toMatchObject({ ok: false, stopReason: "tool_error" });
  });
});

describe("an error frame inside a 200 stream", () => {
  async function erroringProvider(code: number) {
    let calls = 0;
    const server = createServer(async (request, response) => {
      for await (const _ of request) { /* drain */ }
      if (request.url?.endsWith("/models")) { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
      calls++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (calls === 1) {
        response.write(": OPENROUTER PROCESSING\n\n");
        response.end(`data: ${JSON.stringify({ choices: [], error: { code, message: "JSON error injected into SSE stream", metadata: { error_type: "provider_unavailable" } } })}\n\n`);
        return;
      }
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "recovered" }, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const instance = await OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "err", enabled: true,
      config: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "FIXTURE_ERR_KEY" }, environment: { FIXTURE_ERR_KEY: "fixture-err-credential-9d" } });
    const recorder = recordEvents(instance.adapter);
    cleanups.push(async () => { recorder.stop(); await instance.dispose(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
    const threadId = randomUUID();
    await instance.adapter.sendTurn({ threadId, text: "hi", model: "m", approvalMode: "full" });
    return { done: await recorder.until((event) => event.type === "turn.completed"), calls: () => calls };
  }

  it("retries an in-stream upstream 502 before anything streamed, like an HTTP 502", async () => {
    const run = await erroringProvider(502);
    expect(run.done).toMatchObject({ ok: true });
    expect(run.calls()).toBe(2);
  });

  it("does not retry a non-retryable in-stream error", async () => {
    const run = await erroringProvider(400);
    expect(run.done).toMatchObject({ ok: false });
    expect(run.calls()).toBe(1);
  });
});

describe("compaction keeps a finding from the middle of a long tool result", () => {
  it("shows the summarizer the ERROR line buried mid-log, not just the head and tail", async () => {
    const log = (n: number, needle?: number) => Array.from({ length: n }, (_, i) => i === needle
      ? "2026-10-31T02:11:00Z ERROR worker-4 failed request req-2-77731: upstream reset"
      : `2026-10-31T02:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 13} handled request req-${String(i).padStart(6, "0")} in ${(i * 37) % 900}ms`).join("\n");
    const f = await fixture([], [
      [{ name: "read_file", input: { path: "a.log" } }],
      [{ name: "read_file", input: { path: "b.log" } }],
      [{ name: "read_file", input: { path: "c.log" } }],
    ]);
    writeFileSync(join(f.cwd, "a.log"), log(300));
    writeFileSync(join(f.cwd, "b.log"), log(300, 211));
    writeFileSync(join(f.cwd, "c.log"), log(300));
    await f.start({ approvalMode: "full", turnContext: { compactAt: 12_000 } } as Partial<SendTurnInput>);
    await f.completed();
    const prompts = f.fake.requests.filter((body) => body.stream === false).map((body) => JSON.stringify(body.messages)).filter((text) => text.includes("You compact"));
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.some((text) => text.includes("req-2-77731"))).toBe(true);
  });
});
