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
async function turn(messages: unknown[], signal?: AbortSignal) {
  const response = await post({ messages }, signal);
  const text = await response.text();
  const deltas = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta ?? {});
  return { status: response.status, text: deltas.map((delta) => delta.content ?? "").join(""),
    calls: deltas.flatMap((delta) => delta.tool_calls ?? []).map((call: any) => [call.function.name, JSON.parse(call.function.arguments)]) };
}
const user = (content: string) => [{ role: "user", content }];

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
    expect((await turn([...user("go"), { role: "assistant" }, { role: "tool", content: "{}" }])).text).toBe("Fixture reply: go");
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
});
