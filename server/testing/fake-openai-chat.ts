// A stand-in OpenAI-compatible chat server for verification fixtures: GET /v1/models and POST /v1/chat/completions
// (streaming or not). By default it answers "Fixture reply: <last user text>" in a few chunks, and when the last user
// text names a tool as `CALL_TOOL <name> <json args>` it asks for that tool once, then answers after the tool result.
// Every request body is kept, so a test can read what the native engine sent.
//
// It is scriptable, so tests that drove the removed CLI fakes can drive the native engine the same way. A script is
// read from the environment given at start (FAKE_CHAT_* names; the old FAKE_CLAUDE_* names are accepted for the knobs
// below), then from the JSON file at FAKE_CHAT_SCRIPT on every request, then from `set()`; later sources win.
//   mode         happy (default) | slow (holds the reply until `gate` exists; a gate body of "fail" answers HTTP 500)
//                | hang (never answers until the request is aborted) | error (HTTP 500 on every call)
//   gate         file path for `slow` (FAKE_CHAT_GATE / FAKE_CLAUDE_SLOW_FINISH_GATE)
//   replies      replies used in order, one per turn's final answer; past the end, the default reply
//   toolCalls    [{name, input?, round?}] asked for in tool round `round` (default 0) of every turn, before its answer
//   sequence     [[calls], [calls], ...]: streamed request N asks for entry N (empty or past the end: answer). Unlike
//                `round`, it does not read the history, so it keeps counting after the engine compacts older steps away
//   routes       [{match, reply?, toolCalls?, mode?}]: the first whose `match` (a regex) finds the user text overrides
//   models       model ids GET /models lists (default: ["fixture-model"])
//   dump         file path: the latest request as {model, prompt, systemPrompt, messages, tools}
//   prompts      file path: every turn's user text appended as one JSON line
//   cost         USD the final answer's usage reports as `cost`, as OpenRouter does (FAKE_CHAT_COST)
//   release      with hang: once this file exists the turn answers "released" (FAKE_CHAT_RELEASE / FAKE_CLAUDE_RELEASE)
//   finishGate   with hang: once this file exists the turn answers "fixture turn completed" (…_FINISH_GATE)
// One-shot helpers (non-streamed requests: titles, memory upkeep, setup answers) never touch `dump`:
//   setupFile    the new bot's setup-card answers; missing fails the call (…_SETUP_FILE); setupDump records its prompt
//   textFile     every other one-shot's reply; missing or "__FAIL__" fails the call (…_TEXT_FILE); textDump records it
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

export const FAKE_OPENAI_MODEL = "fixture-model";

/** `round` (default 0) is which tool round of the turn asks for the call, so a turn can call, read results, then call again. */
export interface FakeToolCall { name: string; input?: Record<string, unknown>; round?: number }
export interface FakeRoute { match: string; reply?: string; toolCalls?: FakeToolCall[]; mode?: FakeMode }
export type FakeMode = "happy" | "slow" | "hang" | "error";
export interface FakeScript {
  mode?: FakeMode; gate?: string; replies?: string[]; toolCalls?: FakeToolCall[]; sequence?: FakeToolCall[][]; routes?: FakeRoute[];
  models?: string[]; dump?: string; prompts?: string; cost?: number;
  release?: string; finishGate?: string; setupFile?: string; setupDump?: string; textFile?: string; textDump?: string;
}

export interface FakeOpenAiChat {
  url: string;
  requests: Array<Record<string, unknown>>;
  /** Merge script fields for every later request. */
  set(script: FakeScript): void;
  stop(): Promise<void>;
}

const MODES: readonly FakeMode[] = ["happy", "slow", "hang", "error"];
type Message = { role?: string; content?: unknown };
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => (part as { text?: unknown })?.text).filter((text) => typeof text === "string").join("") : "";
const json = <T>(text: string | undefined): T | undefined => { if (!text) return undefined; try { return JSON.parse(text) as T; } catch { return undefined; } };

/** The script the environment describes; FAKE_CHAT_* wins over the legacy FAKE_CLAUDE_* name for the same knob. */
export function scriptFromEnv(env: NodeJS.ProcessEnv): FakeScript {
  const pick = (name: string, legacy?: string) => env[`FAKE_CHAT_${name}`] || (legacy ? env[`FAKE_CLAUDE_${legacy}`] : undefined) || undefined;
  const mode = pick("MODE", "MODE");
  const script: FakeScript = {};
  if (mode && (MODES as readonly string[]).includes(mode)) script.mode = mode as FakeMode;
  const gate = pick("GATE", "SLOW_FINISH_GATE");
  if (gate) script.gate = gate;
  const replies = json<unknown[]>(pick("REPLIES", "REPLIES"));
  if (Array.isArray(replies)) script.replies = replies.map((reply) => Array.isArray(reply) ? reply.join("\n\n") : String(reply));
  const calls = json<FakeToolCall[]>(pick("TOOL_CALLS", "TOOL_CALLS"));
  if (Array.isArray(calls)) script.toolCalls = calls.map(({ name, input, round }) => ({ name, ...(input ? { input } : {}), ...(typeof round === "number" ? { round } : {}) }));
  const routes = json<FakeRoute[]>(pick("ROUTES", "TEXT_ROUTES"));
  if (Array.isArray(routes)) script.routes = routes;
  const models = json<string[]>(pick("MODELS"));
  if (Array.isArray(models) && models.length) script.models = models;
  const dump = pick("DUMP", "DUMP");
  if (dump) script.dump = dump;
  const prompts = pick("PROMPTS", "PROMPTS");
  if (prompts) script.prompts = prompts;
  const cost = Number(pick("COST"));
  if (pick("COST") && Number.isFinite(cost) && cost >= 0) script.cost = cost;
  for (const [key, name] of [["release", "RELEASE"], ["finishGate", "FINISH_GATE"], ["setupFile", "SETUP_FILE"], ["setupDump", "SETUP_DUMP"],
    ["textFile", "TEXT_FILE"], ["textDump", "TEXT_DUMP"]] as const) {
    const value = pick(name, name);
    if (value) script[key] = value;
  }
  return script;
}

export async function startFakeOpenAiChat(env: NodeJS.ProcessEnv = {}): Promise<FakeOpenAiChat> {
  const requests: Array<Record<string, unknown>> = [];
  const base = scriptFromEnv(env);
  let live: FakeScript = {};
  let replyIndex = 0;
  let streamedCount = 0;
  const current = (): FakeScript => {
    const file = env.FAKE_CHAT_SCRIPT && existsSync(env.FAKE_CHAT_SCRIPT) ? json<FakeScript>(readFileSync(env.FAKE_CHAT_SCRIPT, "utf8")) ?? {} : {};
    return { ...base, ...file, ...live };
  };
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const script = current();
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: (script.models ?? [FAKE_OPENAI_MODEL]).map((id) => ({ id, object: "model", context_length: 128_000 })) }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* an empty body answers like an empty chat */ }
    requests.push(body);
    const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
    const last = messages.at(-1);
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const prompt = textOf(lastUser?.content);
    // The engine prefixes context to a user turn; the person's words are its last line.
    const userText = prompt.trim().split("\n").at(-1)?.trim() ?? "";
    const model = typeof body.model === "string" ? body.model : FAKE_OPENAI_MODEL;
    const newTurn = last?.role === "user";
    if (body.stream !== true) {
      // A one-shot helper: the setup card's answers, else any other text job.
      const fail = (message: string) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message } })); };
      const setup = prompt.startsWith("You write the answer options for the first message of a new bot");
      if (setup && script.setupDump) writeFileSync(script.setupDump, JSON.stringify({ model, prompt }, null, 2));
      if (!setup && script.textDump) writeFileSync(script.textDump, JSON.stringify({ model, prompt }, null, 2));
      const file = setup ? script.setupFile : script.textFile;
      const text = !file && !setup ? `Fixture reply: ${userText}` : file && existsSync(file) ? readFileSync(file, "utf8") : "__FAIL__";
      if (text.trim() === "__FAIL__") { fail("fixture one-shot failed"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "fixture", object: "chat.completion", model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    if (script.dump) writeFileSync(script.dump, JSON.stringify({ model, prompt, systemPrompt: textOf(messages.find((message) => message.role === "system")?.content),
      messages, tools: body.tools ?? [] }, null, 2));
    if (newTurn && script.prompts && body.stream === true) appendFileSync(script.prompts, `${JSON.stringify(prompt)}\n`);
    const route = script.routes?.find((entry) => { try { return new RegExp(entry.match).test(prompt); } catch { return false; } });
    const mode = route?.mode ?? script.mode ?? "happy";
    if (mode === "error") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fixture provider error" } })); return; }
    let released: string | undefined;
    if (mode === "hang") {
      for (;;) {
        if (res.destroyed || res.socket?.destroyed !== false) return;
        if (script.finishGate && existsSync(script.finishGate)) { released = "fixture turn completed"; break; }
        if (script.release && existsSync(script.release)) { released = "released"; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (mode === "slow" && body.stream === true) {
      while (!script.gate || !existsSync(script.gate)) {
        if (res.destroyed || res.socket?.destroyed !== false) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (readFileSync(script.gate, "utf8").trim() === "fail") {
        res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "fixture turn failed" } })); return;
      }
    }
    // Tool calls: an explicit CALL_TOOL, else the route's or script's list, asked for once at the start of a turn.
    const called = newTurn ? /CALL_TOOL\s+(\S+)(?:\s+(\{.*\}))?/s.exec(userText) : null;
    const sinceUser = messages.slice(messages.findLastIndex((message) => message.role === "user") + 1);
    const round = sinceUser.filter((message) => message.role === "assistant" && (message as { tool_calls?: unknown[] }).tool_calls?.length).length;
    const step = body.stream === true ? streamedCount++ : -1;
    const scripted = body.stream !== true ? []
      : script.sequence ? script.sequence[step] ?? []
      : (route?.toolCalls ?? script.toolCalls ?? []).filter((call) => (call.round ?? 0) === round);
    const calls = called ? [{ name: called[1]!, arguments: called[2] ?? "{}" }]
      : scripted.map((call) => ({ name: call.name, arguments: JSON.stringify(call.input ?? {}) }));
    const answer = (): string => {
      if (released) return released;
      if (route?.reply !== undefined) return route.reply;
      if (script.replies && replyIndex < script.replies.length) return script.replies[replyIndex++]!;
      return last?.role === "tool" && !scripted.length && !script.toolCalls?.length && !script.sequence ? "Fixture reply: tool finished" : `Fixture reply: ${userText}`;
    };
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (calls.length) {
      res.write(chunk({ role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `call_${requests.length}_${index}`, type: "function",
        function: { name: call.name, arguments: call.arguments } })) }));
      res.write(chunk({}, "tool_calls"));
    } else {
      const reply = answer();
      for (const piece of reply.match(/.{1,12}/gs) ?? [reply]) res.write(chunk({ content: piece }));
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, ...(script.cost !== undefined ? { cost: script.cost } : {}) } })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake OpenAI chat server has no port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    set: (script) => { live = { ...live, ...script }; },
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
