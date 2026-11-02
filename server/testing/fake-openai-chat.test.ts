import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { OpenAICompatDriver } from "../drivers/openai-compat.ts";
import { recordEvents } from "./events.ts";
import { scriptFromEnv, startFakeOpenAiChat, unplannedTurns, type FakeOpenAiChat } from "./fake-openai-chat.ts";

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
  it("replays a keyed script by the user's own words, once per key unless it repeats, and fails an unplanned turn loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const planPath = join(dir, "room-plan.json");
    const id = "bot-s";
    writeFileSync(planPath, JSON.stringify({
      [id]: { script: [
        { key: "open", match: ["OPEN the job."], steps: [{ tool: "shell", arguments: { command: "open" } }], reply: "Opened." },
        { key: "ping", match: ["PING"], repeat: true, reply: "Pong." },
        { key: "review", match: ["Your downstream room requests have settled."], reply: "Reviewed." },
      ] },
    }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = { role: "system", content: "File locations for this bot (absolute paths): " + JSON.stringify({ sharedBotFolder: "/tmp/workspaces/" + id, currentWorkingFolder: "/tmp/task-workspaces/" + id + "/thread-s" }) };
    const tools = [{ type: "function", function: { name: "shell", parameters: { type: "object", properties: { command: {} }, additionalProperties: false } } }];
    const opening = [system, { role: "user", content: "OPEN the job." }];
    expect((await turn(opening, undefined, { tools })).calls).toEqual([["shell", { command: "open" }]]);
    expect((await turn([...opening,
      { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "open" }) } }] },
      { role: "tool", tool_call_id: "c", content: JSON.stringify({ ok: true, result: "done" }) },
    ], undefined, { tools })).text).toBe("Opened.");
    expect((await turn([system, { role: "user", content: "PING" }])).text).toBe("Pong.");
    expect((await turn([system, { role: "user", content: "PING" }])).text).toBe("Pong.");
    const quoted = "Earlier: you said \"OPEN the job.\"\n[Now reply to the user's latest message:]\nYour downstream room requests have settled. Review.";
    expect((await turn([system, { role: "user", content: quoted }])).text).toBe("Reviewed.");
    const again = await turn([system, { role: "user", content: "OPEN the job." }]);
    expect(again.status).toBe(422);
    const unplanned = await turn([system, { role: "user", content: "Something nobody planned." }]);
    expect(unplanned.status).toBe(422);
    expect(await (await post({ messages: [system, { role: "user", content: "Something nobody planned." }] })).text()).toContain("Unplanned fixture turn for bot-s");
    const rows = readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.planKey ?? (row.unplanned ? "unplanned" : undefined))).toEqual(["open", "ping", "ping", "review", "unplanned", "unplanned", "unplanned"]);
    expect(rows[0]).toMatchObject({ botId: id, threadId: "thread-s", evidence: [{ step: { tool: "shell" } }] });
    expect(unplannedTurns(planPath).map((row) => [row.botId, row.turnIndex, row.prompt])).toEqual([
      [id, 4, "OPEN the job."], [id, 5, "Something nobody planned."], [id, 6, "Something nobody planned."]]);
  });

  it("lists a plan's unplanned turns from its evidence", () => {
    const planPath = join(mkdtempSync(join(tmpdir(), "fake-chat-")), "room-plan.json");
    expect(unplannedTurns(planPath)).toEqual([]);
    writeFileSync(planPath + ".evidence.jsonl", [{ botId: "a", turnIndex: 0, planKey: "k" }, { botId: "b", turnIndex: 0, unplanned: true, prompt: "huh" }]
      .map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect(unplannedTurns(planPath)).toEqual([{ botId: "b", turnIndex: 0, unplanned: true, prompt: "huh" }]);
  });

  it("hands a once-only key to just one of two parallel turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const planPath = join(dir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({ "bot-p": { script: [{ key: "k", match: ["GO"], delayMs: 100, reply: "went" }] } }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = (thread: string) => ({ role: "system", content: "File locations for this bot (absolute paths): " + JSON.stringify({ sharedBotFolder: "/tmp/workspaces/bot-p", currentWorkingFolder: "/tmp/task-workspaces/bot-p/" + thread }) });
    const both = await Promise.all([turn([system("a"), { role: "user", content: "GO" }]), turn([system("b"), { role: "user", content: "GO" }])]);
    expect(both.map((answer) => answer.status).sort()).toEqual([200, 422]);
    expect(unplannedTurns(planPath)).toHaveLength(1);
    const rows = readFileSync(planPath + ".evidence.jsonl", "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.planKey ?? (row.unplanned ? "unplanned" : undefined)).sort()).toEqual(["k", "unplanned"]);
  });

  it("fails an unplanned turn once through the engine, without retrying it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const planPath = join(dir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({ "bot-e": { script: [{ key: "k", match: ["never said"], reply: "x" }] } }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const instance = await OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "plan", enabled: true,
      config: { url: fake.url, apiKeyEnv: "FIXTURE_PLAN_KEY" }, environment: { FIXTURE_PLAN_KEY: "fixture-plan-credential-7e" } });
    const recorder = recordEvents(instance.adapter);
    try {
      const system = "File locations for this bot (absolute paths): " + JSON.stringify({ sharedBotFolder: "/tmp/workspaces/bot-e", currentWorkingFolder: "/tmp/task-workspaces/bot-e/t" });
      await instance.adapter.sendTurn({ threadId: randomUUID(), text: "hi", model: "fixture-model", approvalMode: "full", system });
      expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
      expect(unplannedTurns(planPath)).toHaveLength(1);
      expect(fake.requests.filter((body) => body.stream === true)).toHaveLength(1);
    } finally { recorder.stop(); await instance.dispose(); }
  }, 30_000);

  it("refuses a plan that gives one bot both a script and indexed turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const planPath = join(dir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({ "bot-x": { turns: [{ reply: "a" }], script: [{ key: "k", match: ["GO"] }] } }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = { role: "system", content: "File locations for this bot (absolute paths): " + JSON.stringify({ sharedBotFolder: "/tmp/workspaces/bot-x", currentWorkingFolder: "/tmp/task-workspaces/bot-x/t" }) };
    const response = await post({ messages: [system, { role: "user", content: "GO" }] });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain(`Room plan ${planPath}: bot-x has both script and turns`);
  });

  it("keeps an indexed plan's turns in order beside a scripted bot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-chat-"));
    const planPath = join(dir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      "bot-i": { turns: [{ reply: "first" }, { reply: "second" }] },
      "bot-s": { script: [{ key: "only", match: ["GO"], reply: "went" }] },
    }));
    fake = await startFakeOpenAiChat({ FAKE_CHAT_ROOM_PLAN: planPath });
    const system = (id: string) => ({ role: "system", content: "File locations for this bot (absolute paths): " + JSON.stringify({ sharedBotFolder: "/tmp/workspaces/" + id, currentWorkingFolder: "/tmp/task-workspaces/" + id + "/t" }) });
    expect((await turn([system("bot-i"), { role: "user", content: "GO" }])).text).toBe("first");
    expect((await turn([system("bot-s"), { role: "user", content: "GO" }])).text).toBe("went");
    expect((await turn([system("bot-i"), { role: "user", content: "anything" }])).text).toBe("second");
    expect((await turn([system("bot-i"), { role: "user", content: "more" }])).status).toBe(500);
  });
});
