import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptFromEnv, startFakeOpenAiChat, type FakeOpenAiChat } from "./fake-openai-chat.ts";

let fake: FakeOpenAiChat | undefined;
afterEach(async () => { await fake?.stop(); fake = undefined; });

const post = (body: Record<string, unknown>, signal?: AbortSignal) => fetch(`${fake!.url}/chat/completions`, {
  method: "POST", body: JSON.stringify({ model: "fixture-model", stream: true, ...body }), signal });
/** The streamed reply's text and tool calls. */
async function turn(messages: unknown[], signal?: AbortSignal, extra: Record<string, unknown> = {}) {
  const response = await post({ messages, ...extra }, signal);
  const text = await response.text();
  const deltas = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta ?? {});
  return { status: response.status, text: deltas.map((delta) => delta.content ?? "").join(""),
    calls: deltas.flatMap((delta) => delta.tool_calls ?? []).map((call: any) => [call.function.name, JSON.parse(call.function.arguments)]) };
}
const user = (content: string) => [{ role: "user", content }];
const called = { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "{}" } }] };

describe("the scriptable native fake", () => {
  it("echoes by default and honours CALL_TOOL", async () => {
    fake = await startFakeOpenAiChat();
    expect((await turn(user("hello"))).text).toBe("Fixture reply: hello");
    expect((await turn(user('CALL_TOOL read_file {"path":"a"}'))).calls).toEqual([["read_file", { path: "a" }]]);
    expect((await turn([...user("x"), { role: "assistant", tool_calls: [] }, { role: "tool", content: "{}" }])).text).toBe("Fixture reply: tool finished");
  });

  it("uses scripted replies in order, then the default", async () => {
    fake = await startFakeOpenAiChat({ FAKE_CLAUDE_REPLIES: JSON.stringify(["one", ["two", "three"]]) });
    expect([(await turn(user("a"))).text, (await turn(user("b"))).text, (await turn(user("c"))).text])
      .toEqual(["one", "two\n\nthree", "Fixture reply: c"]);
  });

  it("asks for scripted tool calls at a turn's start and answers after their results", async () => {
    fake = await startFakeOpenAiChat({ FAKE_CHAT_TOOL_CALLS: JSON.stringify([{ name: "shell", input: { command: "echo hi" } }, { name: "list_dir" }]) });
    expect((await turn(user("go"))).calls).toEqual([["shell", { command: "echo hi" }], ["list_dir", {}]]);
    expect((await turn([...user("go"), called, { role: "tool", content: "{}" }])).text).toBe("Fixture reply: go");
  });

  it("asks for each round's calls once the earlier round has its results", async () => {
    fake = await startFakeOpenAiChat({ FAKE_CHAT_TOOL_CALLS: JSON.stringify([{ name: "a" }, { name: "b", round: 1 }]) });
    expect((await turn(user("go"))).calls).toEqual([["a", {}]]);
    const first = [...user("go"), called, { role: "tool", content: "{}" }];
    expect((await turn(first)).calls).toEqual([["b", {}]]);
    expect((await turn([...first, called, { role: "tool", content: "{}" }])).text).toBe("Fixture reply: go");
  });

  it("holds a slow reply until its gate exists, and fails on a gate that says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const gate = join(dir, "gate");
    fake = await startFakeOpenAiChat({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
    let done = false;
    const pending = turn(user("wait")).then((result) => { done = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(done).toBe(false);
    writeFileSync(gate, "");
    expect((await pending).text).toBe("Fixture reply: wait");
    writeFileSync(gate, "fail");
    expect((await turn(user("again"))).status).toBe(500);
  });

  it("streams planned progress before a gated final answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-progress-"));
    const planPath = join(dir, "room-plan.json");
    const ready = join(dir, "ready");
    const gate = join(dir, "gate");
    const id = "bot-progress";
    writeFileSync(planPath, JSON.stringify({ [id]: { turns: [{
      progress: "Still working", progressAfterGate: "Finishing now", readyFile: ready, gateFile: gate, reply: "Done",
    }] } }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = "File locations for this bot (absolute paths): " + JSON.stringify({
      sharedBotFolder: `/tmp/workspaces/${id}`, currentWorkingFolder: `/tmp/tasks/${id}/thread-1`,
    });
    const pending = post({ messages: [{ role: "system", content: system }, { role: "user", content: "start" }] }).catch((error) => ({ error }));
    await expect.poll(() => existsSync(ready), { timeout: 3_000 }).toBe(true);
    const early = await Promise.race([pending, new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), 500))]);
    expect(early).toHaveProperty("status");
    if (!("status" in early)) return;
    const reader = early.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    const streamedText = () => body.split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "")
      .join("");
    const readChunk = async (phase: string) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out reading ${phase}`)), 3_000); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    while (!streamedText().includes("Still working")) {
      const chunk = await readChunk("progress before gate");
      if (chunk.done) break;
      body += decoder.decode(chunk.value);
    }
    expect(streamedText()).toContain("Still working");
    writeFileSync(gate, "open");
    for (;;) {
      const chunk = await readChunk("completion after gate");
      if (chunk.done) break;
      body += decoder.decode(chunk.value);
    }
    expect(streamedText()).toContain("Finishing now");
    expect(streamedText()).toContain("Done");
  });

  it("does not hold one bot behind another bot's unfinished tool turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-parallel-bots-"));
    const planPath = join(dir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      "bot-first": { steps: [{ tool: "do_work" }], reply: "First done" },
      "bot-second": { reply: "Second done" },
    }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = (id: string) => "File locations for this bot (absolute paths): " + JSON.stringify({
      sharedBotFolder: `/tmp/workspaces/${id}`, currentWorkingFolder: `/tmp/tasks/${id}/thread-1`,
    });
    const first = await turn([
      { role: "system", content: system("bot-first") },
      { role: "user", content: "start work" },
    ]);
    expect(first.calls).toEqual([["agents_do_work", {}]]);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const second = await Promise.race([
      turn([{ role: "system", content: system("bot-second") }, { role: "user", content: "answer now" }])
        .then((value) => ({ value })),
      new Promise<{ timeout: true }>((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), 1_000); }),
    ]);
    if (timer) clearTimeout(timer);
    expect(second).toHaveProperty("value");
    if ("value" in second) expect(second.value.text).toBe("Second done");
  });

  it("hangs until the request is aborted, and errors in error mode", async () => {
    fake = await startFakeOpenAiChat({ FAKE_CHAT_MODE: "hang" });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 150);
    await expect(turn(user("x"), abort.signal)).rejects.toThrow();
    fake.set({ mode: "error" });
    expect((await turn(user("x"))).status).toBe(500);
  });

  it("routes by user text, lists scripted models, and reads a live script file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const file = join(dir, "script.json");
    fake = await startFakeOpenAiChat({ FAKE_CHAT_SCRIPT: file, FAKE_CHAT_MODELS: JSON.stringify(["fixture-model", "fixture-model-2"]),
      FAKE_CHAT_ROUTES: JSON.stringify([{ match: "weather", reply: "sunny" }]) });
    expect((await turn(user("the weather?"))).text).toBe("sunny");
    expect(((await (await fetch(`${fake.url}/models`)).json()) as { data: Array<{ id: string }> }).data.map((model) => model.id)).toEqual(["fixture-model", "fixture-model-2"]);
    writeFileSync(file, JSON.stringify({ replies: ["from file"] }));
    expect((await turn(user("anything"))).text).toBe("from file");
  });

  it("re-reads one-shot text routes from a file between requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-text-routes-"));
    const routes = join(dir, "routes.json");
    writeFileSync(routes, JSON.stringify({ "CAPTURE-MARKER": "first capture" }));
    fake = await startFakeOpenAiChat({ FAKE_CLAUDE_TEXT_ROUTES: routes });
    const once = async () => (await (await post({ stream: false, messages: user("CAPTURE-MARKER") })).json() as any)
      .choices[0].message.content;

    expect(await once()).toBe("first capture");
    writeFileSync(routes, JSON.stringify({ "CAPTURE-MARKER": "second capture" }));
    expect(await once()).toBe("second capture");
  });

  it("dumps the latest request and appends each turn's prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    fake = await startFakeOpenAiChat({ FAKE_CLAUDE_DUMP: join(dir, "dump.json"), FAKE_CLAUDE_PROMPTS: join(dir, "prompts.jsonl") });
    await turn([{ role: "system", content: "be brief" }, ...user("first")]);
    await turn(user("second"));
    expect(JSON.parse(readFileSync(join(dir, "dump.json"), "utf8"))).toMatchObject({ model: "fixture-model", prompt: "second" });
    expect(readFileSync(join(dir, "prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual(["first", "second"]);
    expect(existsSync(join(dir, "dump.json"))).toBe(true);
  });

  it("reports a scripted cost on the answer's usage", async () => {
    fake = await startFakeOpenAiChat({ FAKE_CHAT_COST: "0.01" });
    const text = await (await post({ messages: user("hi") })).text();
    expect(text).toContain('"cost":0.01');
  });

  it("ignores unknown modes and malformed JSON knobs", () => {
    expect(scriptFromEnv({ FAKE_CLAUDE_MODE: "dead-session", FAKE_CHAT_REPLIES: "[", FAKE_CHAT_MODELS: "[]" })).toEqual({});
  });

  it("ends a hanging turn once its release file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    fake = await startFakeOpenAiChat({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: join(dir, "release") });
    const pending = turn(user("x"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(join(dir, "release"), "");
    expect((await pending).text).toBe("released");
  });

  it("answers one-shots from their files, failing without one, and keeps them out of the turn dump", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const [textFile, setupFile, dump, textDump] = ["text", "setup", "dump.json", "text.json"].map((name) => join(dir, name));
    fake = await startFakeOpenAiChat({ FAKE_CLAUDE_TEXT_FILE: textFile, FAKE_CLAUDE_SETUP_FILE: setupFile, FAKE_CHAT_DUMP: dump, FAKE_CLAUDE_TEXT_DUMP: textDump });
    const once = async (content: string) => {
      const response = await post({ stream: false, messages: user(content) });
      return response.ok ? ((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content : response.status;
    };
    expect(await once("title this")).toBe(500);
    writeFileSync(textFile, "A title");
    expect(await once("title this")).toBe("A title");
    expect(JSON.parse(readFileSync(textDump, "utf8")).prompt).toBe("title this");
    expect(await once("You write the answer options for the first message of a new bot")).toBe(500);
    writeFileSync(setupFile, "[]");
    expect(await once("You write the answer options for the first message of a new bot")).toBe("[]");
    expect(existsSync(dump)).toBe(false);
  });

  it("replays a room plan, keeps plan-only tool keys in evidence, and holds a gated teammate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const planPath = join(dir, "room-plan.json");
    const gate = join(dir, "gate");
    const [sender, teammate] = ["bot-sender", "bot-teammate"];
    writeFileSync(planPath, JSON.stringify({
      [sender]: {
        steps: [{ arguments: { bot_ids: [teammate], request_key: "map-check", message: "look" } }],
        reply: "Sent.",
        resumeReply: "The teammate finished.",
      },
      [teammate]: { gateFile: gate, reply: "Done." },
    }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = (id: string, thread: string) => "File locations for this bot (absolute paths): " + JSON.stringify({
      sharedBotFolder: "/tmp/workspaces/" + id, currentWorkingFolder: "/tmp/task-workspaces/" + id + "/" + thread,
    });
    const loader = { type: "function", function: { name: "load_tools", description: "Load more tools.\nagents_coordinate_bots: Ask teammates.", parameters: { type: "object", properties: { names: { type: "array" } }, additionalProperties: false } } };
    const coordinate = { type: "function", function: { name: "agents_coordinate_bots", parameters: { type: "object", additionalProperties: false, properties: { bot_ids: {}, message: {} }, required: ["bot_ids", "message"] } } };
    const senderSystem = system(sender, "thread-1");
    expect((await turn([{ role: "system", content: senderSystem }, { role: "user", content: "ask" }], undefined, { tools: [loader] })).calls)
      .toEqual([["load_tools", { names: ["agents_coordinate_bots"] }]]);
    const called = await turn([
      { role: "system", content: senderSystem },
      { role: "user", content: "ask" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["agents_coordinate_bots"] }) } }] },
      { role: "tool", tool_call_id: "c1", content: JSON.stringify({ ok: true, result: "Loaded agents_coordinate_bots" }) },
    ], undefined, { tools: [loader, coordinate] });
    expect(called.calls).toEqual([["agents_coordinate_bots", { bot_ids: [teammate], message: "look" }]]);
    expect(existsSync(planPath + ".evidence.jsonl")).toBe(false);
    let teammateDone = false;
    const teammateTurn = turn([{ role: "system", content: system(teammate, "thread-2") }, { role: "user", content: "work" }])
      .then((result) => { teammateDone = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(teammateDone).toBe(false);
    const answered = await turn([
      { role: "system", content: senderSystem },
      { role: "user", content: "ask" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "load_tools", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: JSON.stringify({ ok: true, result: "loaded" }) },
      { role: "assistant", tool_calls: [{ id: "c2", type: "function", function: { name: "agents_coordinate_bots", arguments: JSON.stringify({ bot_ids: [teammate], message: "look" }) } }] },
      { role: "tool", tool_call_id: "c2", content: JSON.stringify({ ok: true, result: "queued" }) },
    ]);
    expect(answered.text).toBe("Sent.");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(teammateDone).toBe(false);
    writeFileSync(gate, "");
    expect((await teammateTurn).text).toBe("Done.");
    const rows = readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.botId)).toEqual([sender, teammate]);
    expect(rows[0]).toMatchObject({ turnIndex: 0, threadId: "thread-1", evidence: [{ step: { arguments: { bot_ids: [teammate], request_key: "map-check", message: "look" } } }] });
    const resumed = await turn([{ role: "system", content: senderSystem }, { role: "user", content: "Your downstream room requests have settled. Review." }]);
    expect(resumed.text).toBe("The teammate finished.");
  });

  it("advances a room plan after a provider turn is stopped before it replies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-aborted-turn-"));
    const planPath = join(dir, "room-plan.json");
    const ready = join(dir, "first-ready");
    const gate = join(dir, "first-gate");
    const id = "bot-aborted";
    writeFileSync(planPath, JSON.stringify({ [id]: { turns: [
      { readyFile: ready, gateFile: gate, reply: "first reply" },
      { reply: "second reply" },
    ] } }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = "File locations for this bot (absolute paths): " + JSON.stringify({
      sharedBotFolder: `/tmp/workspaces/${id}`, currentWorkingFolder: `/tmp/tasks/${id}/thread-1`,
    });
    const abort = new AbortController();
    const stopped = turn([{ role: "system", content: system }, ...user("FIRST-JOB")], abort.signal);
    await expect.poll(() => existsSync(ready), { timeout: 3_000 }).toBe(true);
    abort.abort();
    await expect(stopped).rejects.toThrow();
    writeFileSync(gate, "open");

    expect((await turn([{ role: "system", content: system }, ...user("SECOND-JOB")])).text).toBe("second reply");
    const requests = readFileSync(`${planPath}.requests.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(requests.map((request) => [request.botId, request.turnIndex, request.prompt])).toEqual([
      [id, 0, "FIRST-JOB"], [id, 1, "SECOND-JOB"],
    ]);
  });

  it("can fail one bot's API request without changing another bot's room plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-bot-mode-"));
    const planPath = join(dir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      "bot-a": { turns: [{ reply: "A first reply" }, { reply: "A second reply" }] },
      "bot-b": { reply: "B reply" },
    }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    fake.setBotMode("bot-a", "error");
    const ask = (id: string) => turn([
      { role: "system", content: "File locations for this bot (absolute paths): " + JSON.stringify({
        sharedBotFolder: `/tmp/workspaces/${id}`, currentWorkingFolder: `/tmp/tasks/${id}/thread-1`,
      }) },
      ...user("go"),
    ]);

    expect((await ask("bot-a")).status).toBe(500);
    expect((await ask("bot-b")).text).toBe("B reply");
    fake.setBotMode("bot-a", undefined);
    expect((await ask("bot-a")).text).toBe("A first reply");
    expect((await ask("bot-a")).text).toBe("A second reply");
  });

  it("selects match-based room script entries once and refuses an unscripted turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const planPath = join(dir, "room-plan.json");
    const id = "bot-scripted";
    writeFileSync(planPath, JSON.stringify({
      [id]: { script: [
        { key: "later", match: ["LATER-JOB"], reply: "later reply" },
        { key: "first", match: ["FIRST-JOB"], reply: "first reply" },
        { key: "repeat", match: ["REPEAT-JOB"], reply: "repeat reply", repeat: true },
      ] },
    }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = "File locations for this bot (absolute paths): " + JSON.stringify({
      sharedBotFolder: `/tmp/workspaces/${id}`, currentWorkingFolder: `/tmp/tasks/${id}/thread-1`,
    });
    const ask = (text: string) => turn([{ role: "system", content: system }, { role: "user", content: text }]);

    expect((await ask("FIRST-JOB: go")).text).toBe("first reply");
    expect((await ask("LATER-JOB: go")).text).toBe("later reply");
    expect((await ask("FIRST-JOB: again")).status).toBe(500);
    expect((await ask("REPEAT-JOB: once")).text).toBe("repeat reply");
    expect((await ask("REPEAT-JOB: twice")).text).toBe("repeat reply");

    const rows = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.planKey ?? (row.unplanned ? "unplanned" : undefined))).toEqual(["first", "later", "unplanned", "repeat", "repeat"]);
  });

  it("selects a room plan branch when the current prompt matches it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-by-prompt-"));
    const planPath = join(dir, "room-plan.json");
    const id = "bot-by-prompt";
    writeFileSync(planPath, JSON.stringify({ [id]: {
      reply: "base reply",
      byPrompt: [{ promptIncludes: "NESTED-JOB", plan: { reply: "nested reply" } }],
    } }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = "File locations for this bot (absolute paths): " + JSON.stringify({
      sharedBotFolder: `/tmp/workspaces/${id}`, currentWorkingFolder: `/tmp/tasks/${id}/thread-1`,
    });
    const ask = (text: string) => turn([{ role: "system", content: system }, { role: "user", content: text }]);

    expect((await ask("ordinary request")).text).toBe("base reply");
    expect((await ask("NESTED-JOB follow-up")).text).toBe("nested reply");
  });

  it("matches a room script against the current turn without recalled passages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-recalled-"));
    const planPath = join(dir, "room-plan.json");
    const id = "bot-recalled";
    writeFileSync(planPath, JSON.stringify({ [id]: { script: [
      { key: "stale", match: ["STALE-JOB"], reply: "stale script" },
      { key: "current", match: ["NEW-JOB"], reply: "current script" },
    ] } }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = "File locations for this bot (absolute paths): " + JSON.stringify({
      sharedBotFolder: `/tmp/workspaces/${id}`, currentWorkingFolder: `/tmp/tasks/${id}/thread-1`,
    });
    const prompt = "Recalled for this message from another conversation:\nSTALE-JOB: old request\n[end of recalled passages]\nNEW-JOB: handle this request.";

    expect((await turn([{ role: "system", content: system }, ...user(prompt)])).text).toBe("current script");
    const rows = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.planKey)).toEqual(["current"]);
  });

  it("refuses an indexed turn the plan does not have, and a tool outcome the plan did not declare", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const planPath = join(dir, "room-plan.json");
    const id = "bot-a";
    writeFileSync(planPath, JSON.stringify({
      [id]: { turns: [{ steps: [{ tool: "shell", arguments: { command: "nope" } }], reply: "ran" }] },
    }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = "File locations for this bot (absolute paths): " + JSON.stringify({ sharedBotFolder: "/tmp/workspaces/" + id, currentWorkingFolder: "/tmp/task-workspaces/" + id + "/thread-9" });
    const tools = [{ type: "function", function: { name: "shell", parameters: { type: "object", properties: { command: {} }, additionalProperties: false } } }];
    const history = [{ role: "system", content: system }, { role: "user", content: "go" }];
    expect((await turn(history, undefined, { tools })).calls).toEqual([["shell", { command: "nope" }]]);
    const refused = await turn([
      ...history,
      { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "nope" }) } }] },
      { role: "tool", tool_call_id: "c", content: JSON.stringify({ ok: false, result: "denied" }) },
    ], undefined, { tools });
    expect(refused.status).toBe(500);
    const evidence = planPath + ".evidence.jsonl";
    expect(JSON.parse(readFileSync(evidence, "utf8")).evidence[0].response.result.isError).toBe(true);
    expect((await turn([{ role: "system", content: system }, { role: "user", content: "again" }])).status).toBe(500);
    expect(readFileSync(evidence, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
