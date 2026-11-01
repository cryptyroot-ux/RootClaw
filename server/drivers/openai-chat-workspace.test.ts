// The native workspace tools through a real driver turn: approval gating, prompt, skills, parallel order.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

process.env.ROOTCLAW_RETRY_SCALE ??= "0.001";

import type { SendTurnInput } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { shellSandbox } from "./workspace-tools.ts";

// CI runners may lack bubblewrap; the shell fails closed there (audit N02), so these tests opt out explicitly.
if (shellSandbox() === null) process.env.ROOTCLAW_SHELL_SANDBOX = "off";

interface Body { messages: Array<{ role: string; content: unknown; tool_call_id?: string }>; tools?: Array<{ function: { name: string } }> }
const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
function sse(response: ServerResponse, chunks: unknown[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const value of chunks) response.write(`data: ${JSON.stringify(value)}\n\n`);
  response.end("data: [DONE]\n\n");
}
const calls = (list: Array<[string, Record<string, unknown>]>) => list.map(([name, args], index) =>
  ({ index, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(rounds: Array<Array<[string, Record<string, unknown>]>>) {
  const base = mkdtempSync(join(tmpdir(), "rootclaw-ws-turn-"));
  const cwd = join(base, "work");
  mkdirSync(cwd);
  const requests: Body[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
    let data = "";
    for await (const part of request) data += part.toString();
    const body = JSON.parse(data) as Body & { stream?: boolean };
    if (body.stream === false) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: "summary" }, finish_reason: "stop" }] })); return; }
    requests.push(body);
    const round = rounds[requests.length - 1];
    if (round) sse(response, [chunk({ content: null, tool_calls: calls(round) }, "tool_calls")]);
    else sse(response, [chunk({ content: "Done." }, "stop")]);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const instance = await OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "ws", enabled: true,
    config: { url: `${origin}/v1`, apiKeyEnv: "FIXTURE_WS_KEY" }, environment: { FIXTURE_WS_KEY: "fixture-ws-credential-7f3a9c" } });
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
    base, cwd, requests, recorder, threadId, instance, toolMessages,
    start: (input: Partial<SendTurnInput> = {}) => instance.adapter.sendTurn({ threadId, text: "work", model: "m", cwd, ...input }),
    completed: () => recorder.until((event) => event.type === "turn.completed"),
  };
}

describe("native workspace tools in a turn", () => {
  it("mounts the tools and their prompt when the turn has a folder", async () => {
    const f = await fixture([]);
    await f.start({ system: "You are a bot." });
    await f.completed();
    const names = f.requests[0]!.tools!.map((tool) => tool.function.name);
    expect(names).toEqual(expect.arrayContaining(["shell", "read_file", "write_file", "edit_file", "apply_patch", "grep", "glob", "list_dir", "git_status", "git_commit", "web_fetch"]));
    expect(String(f.requests[0]!.messages[0]!.content)).toMatch(/^You are a bot\.\n\nYou have workspace tools/);
  });

  it("asks before a write in Ask mode and writes nothing when denied", async () => {
    const f = await fixture([[["write_file", { path: "a.txt", content: "x" }]]]);
    await f.start();
    const opened = await f.recorder.until((event) => event.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission" });
    await f.instance.adapter.respondToRequest(f.threadId, opened.requestId!, { behavior: "deny" });
    await f.completed();
    expect(existsSync(join(f.cwd, "a.txt"))).toBe(false);
    expect(f.toolMessages(1)[0]).toMatchObject({ ok: false });
  });

  it("asks before shell and runs it once allowed", async () => {
    const f = await fixture([[["shell", { command: "echo hi > out.txt" }]]]);
    await f.start();
    const opened = await f.recorder.until((event) => event.type === "request.opened");
    await f.instance.adapter.respondToRequest(f.threadId, opened.requestId!, { behavior: "allow" });
    await f.completed();
    expect(readFileSync(join(f.cwd, "out.txt"), "utf8")).toBe("hi\n");
  });

  it("names the exact shell command and its real folder on the card, for the saved-command allowlist", async () => {
    const f = await fixture([[["shell", { command: "ls", cwd: "sub" }]]]);
    mkdirSync(join(f.cwd, "real"));
    symlinkSync(join(f.cwd, "real"), join(f.cwd, "sub"));
    await f.start();
    const opened = await f.recorder.until((event) => event.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error("expected a card");
    expect(opened.command).toEqual({ command: "ls", cwd: realpathSync(join(f.cwd, "real")) });
    expect(opened.commandLine).toBe("ls");
    await f.instance.adapter.respondToRequest(f.threadId, opened.requestId!, { behavior: "deny" });
    await f.completed();
  });

  it("names no command scope for a write, or a shell folder outside the workspace", async () => {
    const f = await fixture([[["shell", { command: "ls", cwd: "/" }]]]);
    await f.start();
    const opened = await f.recorder.until((event) => event.type === "request.opened");
    if (opened.type !== "request.opened") throw new Error("expected a card");
    expect(opened.command).toBeUndefined();
    await f.instance.adapter.respondToRequest(f.threadId, opened.requestId!, { behavior: "deny" });
    await f.completed();
  });

  it("reads without asking", async () => {
    const f = await fixture([[["read_file", { path: "r.txt" }]]]);
    writeFileSync(join(f.cwd, "r.txt"), "hello\n");
    await f.start();
    await f.completed();
    expect(f.recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(f.toolMessages(1)[0]!.result).toContain("hello");
  });

  it("keeps call order with reads in parallel around a sequential write (Full access)", async () => {
    const f = await fixture([[
      ["read_file", { path: "one.txt" }], ["grep", { pattern: "two" }], ["write_file", { path: "w.txt", content: "w" }],
      ["read_file", { path: "w.txt" }], ["list_dir", {}],
    ]]);
    writeFileSync(join(f.cwd, "one.txt"), "one\n");
    writeFileSync(join(f.cwd, "two.txt"), "two\n");
    await f.start({ approvalMode: "full" });
    await f.completed();
    const results = f.toolMessages(1);
    expect(results.map((result) => result.id)).toEqual(["call_0", "call_1", "call_2", "call_3", "call_4"]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[3]!.result).toContain("\tw"); // the read after the write sees it
  });

  it("lets the bot read a skill named in its prompt, outside the folder, but not write it", async () => {
    const skill = join(f0(), "SKILL.md");
    function f0() { const dir = mkdtempSync(join(tmpdir(), "rootclaw-skill-")); cleanups.push(() => removeTempDir(dir)); return dir; }
    writeFileSync(skill, "# Skill body");
    const f = await fixture([[["read_file", { path: skill }], ["write_file", { path: skill, content: "x" }]]]);
    await f.start({ approvalMode: "full", system: `Skills:\n- s: Demo. Read ${JSON.stringify(skill)}.` });
    await f.completed();
    const [read, write] = f.toolMessages(1);
    expect(read!.result).toContain("# Skill body");
    expect(write).toMatchObject({ ok: false });
    expect(readFileSync(skill, "utf8")).toBe("# Skill body");
  });

  it("mounts nothing for a confined guest turn", async () => {
    const f = await fixture([]);
    await f.start({ guestConfined: true } as Partial<SendTurnInput>);
    await f.completed();
    expect((f.requests[0]!.tools ?? []).map((tool) => tool.function.name)).not.toContain("shell");
  });
});
