// A stand-in OpenAI-compatible chat server for verification fixtures: GET /v1/models and POST /v1/chat/completions
// (streaming or not). By default it answers "Fixture reply: <last user text>" in a few chunks, and when the last user
// text names a tool as `CALL_TOOL <name> <json args>` it asks for that tool once, then answers after the tool result.
// Every request body is kept, so a test can read what the native engine sent.
//
// It is scriptable, so tests that drove the removed CLI fakes can drive the native engine the same way. A script is
// read from the environment given at start (FAKE_CHAT_* names; the old FAKE_CLAUDE_* names are accepted for the knobs
// below), then from the JSON file at FAKE_CHAT_SCRIPT on every request, then from `set()`; later sources win.
//   mode         happy (default) | slow (holds the reply until `gate` exists; a gate body of "fail" answers HTTP 500)
//                | hang (never answers until the request is aborted) | error (HTTP errorStatus, default 500,
//                with errorMessage, on every streamed call)
//   gate         file path for `slow` (FAKE_CHAT_GATE / FAKE_CLAUDE_SLOW_FINISH_GATE)
//   gates        folder for `slow`, instead of `gate`: each conversation waits for <gates>/<its working folder's name>.gate,
//                so a test can release one thread's turn at a time (FAKE_CHAT_GATES)
//   replies      replies used in order, one per turn's final answer; past the end, the default reply
//   toolCalls    [{name, input?, round?, allowUnlisted?}] asked for in tool round `round` (default 0); allowUnlisted
//                makes the fake deliver a scripted call even when that tool was not included in the request
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
//   textRoutes   {marker: reply}: a one-shot whose prompt contains a marker answers its reply (FAKE_CHAT_TEXT_ROUTES, a JSON
//                object or a file holding one; the legacy FAKE_CLAUDE_TEXT_ROUTES file too)
//   textUsage    the `usage` object one-shots report (default 1 prompt and 1 completion token); null reports none
// FAKE_CHAT_ROOM_PLAN (FAKE_CLAUDE_ROOM_PLAN) is a room-plan file, re-read on every streamed request. A missing or
// unreadable file, or a bot the plan does not name, falls through to the script above. One-shots never consume a turn.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { ownTurnText } from "./room-handoff-agent.ts";

export const FAKE_OPENAI_MODEL = "fixture-model";

/** `round` (default 0) is which tool round of the turn asks for the call, so a turn can call, read results, then call again. */
export interface FakeToolCall { name: string; input?: Record<string, unknown>; round?: number; allowUnlisted?: boolean }
export interface FakeRoute { match: string; reply?: string; toolCalls?: FakeToolCall[]; mode?: FakeMode }
export type FakeMode = "happy" | "slow" | "hang" | "error";
export interface FakeScript {
  mode?: FakeMode; gate?: string; gates?: string; replies?: string[]; toolCalls?: FakeToolCall[]; sequence?: FakeToolCall[][]; routes?: FakeRoute[];
  models?: string[]; dump?: string; prompts?: string; cost?: number;
  errorStatus?: number; errorMessage?: string;
  release?: string; finishGate?: string; setupFile?: string; setupDump?: string; textFile?: string; textDump?: string;
  textRoutes?: Record<string, string>; textRoutesFile?: string; textUsage?: Record<string, unknown> | null;
}

export interface FakeOpenAiChat {
  url: string;
  requests: Array<Record<string, unknown>>;
  /** Merge script fields for every later request. */
  set(script: FakeScript): void;
  /** Override one bot's provider response mode without affecting other room members. */
  setBotMode(botId: string, mode: FakeMode | undefined): void;
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
  const gates = pick("GATES");
  if (gates) script.gates = gates;
  const replies = json<unknown[]>(pick("REPLIES", "REPLIES"));
  if (Array.isArray(replies)) script.replies = replies.map((reply) => Array.isArray(reply) ? reply.join("\n\n") : String(reply));
  const calls = json<FakeToolCall[]>(pick("TOOL_CALLS", "TOOL_CALLS"));
  if (Array.isArray(calls)) script.toolCalls = calls.map(({ name, input, round, allowUnlisted }) => ({ name, ...(input ? { input } : {}), ...(typeof round === "number" ? { round } : {}), ...(allowUnlisted ? { allowUnlisted: true } : {}) }));
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
  const textRoutesRaw = pick("TEXT_ROUTES", "TEXT_ROUTES");
  const inlineTextRoutes = json<unknown>(textRoutesRaw);
  const textRoutesFile = inlineTextRoutes === undefined && textRoutesRaw && existsSync(textRoutesRaw) ? textRoutesRaw : undefined;
  const textRoutes = inlineTextRoutes ?? (textRoutesFile ? json<unknown>(readFileSync(textRoutesFile, "utf8")) : undefined);
  if (textRoutes && typeof textRoutes === "object" && !Array.isArray(textRoutes)) script.textRoutes = textRoutes as Record<string, string>;
  if (textRoutesFile) script.textRoutesFile = textRoutesFile;
  const textUsage = pick("TEXT_USAGE") ? json<Record<string, unknown> | null>(pick("TEXT_USAGE")) : undefined;
  if (textUsage !== undefined) script.textUsage = textUsage;
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
  const unfinished = new Set<string>();
  const activeRoomTurnIndexes = new Map<string, number>();
  const nextRoomTurnIndexes = new Map<string, number>();
  const botModes = new Map<string, FakeMode>();
  let evidenceChain = Promise.resolve();
  const writeEvidence = (path: string, row: unknown): Promise<void> => {
    const run = evidenceChain.then(() => { appendFileSync(path, `${JSON.stringify(row)}\n`); });
    evidenceChain = run.then(() => undefined, () => undefined);
    return run;
  };
  const current = (): FakeScript => {
    const file = env.FAKE_CHAT_SCRIPT && existsSync(env.FAKE_CHAT_SCRIPT) ? json<FakeScript>(readFileSync(env.FAKE_CHAT_SCRIPT, "utf8")) ?? {} : {};
    const textRoutes = base.textRoutesFile
      ? json<unknown>(existsSync(base.textRoutesFile) ? readFileSync(base.textRoutesFile, "utf8") : "")
      : undefined;
    return {
      ...base,
      ...(base.textRoutesFile ? { textRoutes: textRoutes && typeof textRoutes === "object" && !Array.isArray(textRoutes) ? textRoutes as Record<string, string> : {} } : {}),
      ...file,
      ...live,
    };
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
    const currentTurnText = ownTurnText({ message: { content: prompt } });
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
      const routed = setup ? undefined : Object.entries(script.textRoutes ?? {}).find(([marker]) => messages.some((message) => textOf(message.content).includes(marker)))?.[1];
      const text = routed !== undefined ? routed
        : !file && !setup ? `Fixture reply: ${userText}` : file && existsSync(file) ? readFileSync(file, "utf8") : "__FAIL__";
      if (text.trim() === "__FAIL__") { fail("fixture one-shot failed"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "fixture", object: "chat.completion", model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        ...(script.textUsage === null ? {} : { usage: script.textUsage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) }));
      return;
    }
    const __systemPrompt = textOf(messages.find((message) => message.role === "system")?.content);
    let __cwd: string | undefined;
    try { const __m = __systemPrompt.match(/"currentWorkingFolder":\s*"([^"]+)"/); if (__m) __cwd = JSON.parse(`"${__m[1]}"`); } catch { /* ignore */ }
    const system = messages.filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n");
    const botId = pathTail(fileLocations(system)?.sharedBotFolder);
    if (script.dump) writeFileSync(script.dump, JSON.stringify({ model, prompt, systemPrompt: __systemPrompt, cwd: __cwd, ...(botId ? { botId } : {}),
      messages, tools: body.tools ?? [], mcpConfig: { mcpServers: mountedServers(Array.isArray(body.tools) ? body.tools : []) } }, null, 2));
    if (newTurn && script.prompts && body.stream === true) appendFileSync(script.prompts, `${JSON.stringify(prompt)}\n`);
    const botMode = botId ? botModes.get(botId) : undefined;
    if (await replayRoomPlan({ env, res, body, messages, model, prompt, currentTurnText, system, newTurn, botMode, unfinished,
      activeTurnIndexes: activeRoomTurnIndexes, nextTurnIndexes: nextRoomTurnIndexes, writeEvidence })) return;
    const route = script.routes?.find((entry) => { try { return new RegExp(entry.match).test(currentTurnText); } catch { return false; } });
    const mode = botMode ?? route?.mode ?? script.mode ?? "happy";
    if (mode === "error") {
      res.writeHead(script.errorStatus ?? 500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: script.errorMessage ?? "fixture provider error" } }));
      return;
    }
    let released: string | undefined;
    if (mode === "hang") {
      for (;;) {
        if (res.destroyed || res.socket?.destroyed !== false) return;
        if (script.finishGate && existsSync(script.finishGate)) { released = "fixture turn completed"; break; }
        if (script.release && existsSync(script.release)) { released = "released"; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
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
    const requestedCalls: Array<{ name: string; arguments: string; allowUnlisted?: boolean }> = called ? [{ name: called[1]!, arguments: called[2] ?? "{}" }]
      : scripted.map((call) => ({ name: call.name, arguments: JSON.stringify(call.input ?? {}), allowUnlisted: call.allowUnlisted }));
    const offered = Array.isArray(body.tools)
      ? new Set(body.tools.map((tool) => (tool as { function?: { name?: unknown } })?.function?.name).filter((name): name is string => typeof name === "string"))
      : null;
    const calls = !called && offered ? requestedCalls.filter((call) => call.allowUnlisted || offered.has(call.name)) : requestedCalls;
    if (mode === "slow" && body.stream === true && calls.length === 0) {
      const gate = script.gates && __cwd ? join(script.gates, `${basename(__cwd)}.gate`) : script.gate;
      while (!gate || !existsSync(gate)) {
        if (res.destroyed || res.socket?.destroyed !== false) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (readFileSync(gate, "utf8").trim() === "fail") {
        res.writeHead(script.errorStatus ?? 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: script.errorMessage ?? "fixture turn failed" } })); return;
      }
    }
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
    setBotMode: (botId, mode) => { if (mode) botModes.set(botId, mode); else botModes.delete(botId); },
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** The MCP servers a request's tools came from, keyed like the old CLI dump's mcpConfig.mcpServers (server_tool names;
 * tools held back behind load_tools count too). Native workspace tools are not servers. */
const NATIVE_TOOLS = /^(shell|read_file|write_file|edit_file|apply_patch|grep|glob|list_dir|git_\w+|web_fetch|web_search|ask_user|read_tool_output|update_plan|load_tools)$/;
function mountedServers(tools: unknown[]): Record<string, { tools: string[] }> {
  const servers: Record<string, { tools: string[] }> = {};
  const names: string[] = [];
  for (const tool of tools as { function?: { name?: string; description?: string } }[]) {
    const name = tool.function?.name ?? "";
    if (name === "load_tools") for (const line of (tool.function?.description ?? "").split("\n").slice(1)) names.push(line.split(":")[0]!.trim());
    else names.push(name);
  }
  for (const name of names) {
    if (!name || NATIVE_TOOLS.test(name) || !name.includes("_")) continue;
    const server = name.slice(0, name.indexOf("_"));
    (servers[server] ??= { tools: [] }).tools.push(name.slice(server.length + 1));
  }
  return servers;
}

const SETTLED = "Your downstream room requests have settled.";
const LOCATIONS = "File locations for this bot (absolute paths): ";

interface PlanStep { tool?: string; arguments?: Record<string, unknown>; expectError?: boolean }
interface PlanTurn {
  steps?: PlanStep[];
  resumeSteps?: PlanStep[];
  reply?: string;
  resumeReply?: string;
  progress?: string;
  progressAfterGate?: string;
  gateFile?: string;
  readyFile?: string;
  delayMs?: number;
  fail?: boolean;
  failResumed?: boolean;
  script?: ScriptEntry[];
  byPrompt?: Array<{ promptIncludes: string; plan: PlanTurn }>;
  turns?: PlanTurn[];
}
interface ScriptEntry extends PlanTurn { key: string; match: string[]; repeat?: boolean }
interface ToolDef { name: string; parameters: { properties?: Record<string, unknown>; additionalProperties?: boolean } }
type ChatMessage = Message & { tool_call_id?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };

function fileLocations(system: string): { currentWorkingFolder?: string; sharedBotFolder?: string } | undefined {
  const at = system.indexOf(LOCATIONS);
  if (at < 0 || system[at + LOCATIONS.length] !== "{") return undefined;
  const start = at + LOCATIONS.length;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < system.length; i++) {
    const ch = system[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      if (--depth === 0) {
        try { return JSON.parse(system.slice(start, i + 1)) as { currentWorkingFolder?: string; sharedBotFolder?: string }; }
        catch { return undefined; }
      }
    }
  }
  return undefined;
}

function pathTail(path: string | undefined): string | undefined {
  if (!path || /\s/.test(path)) return undefined;
  return basename(path) || undefined;
}

function readPlan(path: string): Record<string, PlanTurn> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, PlanTurn>;
  } catch { return undefined; }
}

function countTurns(path: string, botId: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).filter((line) => {
    try {
      const row = JSON.parse(line) as { botId?: string; providerError?: boolean };
      return row.botId === botId && row.providerError !== true;
    } catch { return false; }
  }).length;
}

function listedTools(body: Record<string, unknown>): ToolDef[] {
  if (!Array.isArray(body.tools)) return [];
  return body.tools.map((tool) => {
    const fn = (tool as { function?: { name?: string; parameters?: ToolDef["parameters"] } }).function;
    return { name: fn?.name ?? "", parameters: fn?.parameters ?? {} };
  });
}

function wireName(tool: string | undefined, defs: ToolDef[]): string {
  const bare = tool || "coordinate_bots";
  if (defs.some((def) => def.name === bare) || NATIVE_TOOLS.test(bare)) return bare;
  if (/^(agents|computer|browser|data)_/.test(bare)) return bare;
  return `agents_${bare}`;
}

function publishedArgs(args: Record<string, unknown>, def: ToolDef | undefined): Record<string, unknown> {
  const properties = def?.parameters.properties;
  if (def?.parameters.additionalProperties !== false || !properties) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => Object.prototype.hasOwnProperty.call(properties, key)));
}

function toolOk(content: string): boolean | undefined {
  const start = content.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      if (--depth === 0) {
        try {
          const parsed = JSON.parse(content.slice(start, i + 1)) as { ok?: unknown };
          return typeof parsed.ok === "boolean" ? parsed.ok : undefined;
        } catch { return undefined; }
      }
    }
  }
  return undefined;
}

function answeredCalls(messages: Message[]): Array<{ name: string; content: string }> {
  const start = messages.findLastIndex((message) => message.role === "user");
  const calls: Array<{ name: string; id?: string; content?: string }> = [];
  for (const message of messages.slice(start + 1) as ChatMessage[]) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) calls.push({ name: call.function?.name ?? "", id: call.id });
    } else if (message.role === "tool") {
      const open = (message.tool_call_id ? calls.find((call) => call.id === message.tool_call_id && call.content === undefined) : undefined)
        ?? calls.find((call) => call.content === undefined);
      if (open) open.content = textOf(message.content);
    }
  }
  return calls.flatMap((call) => call.content === undefined ? [] : [{ name: call.name, content: call.content }]);
}

/** Replays one streamed turn from FAKE_CHAT_ROOM_PLAN. A parent that emits a real tool call stays unfinished until its
 * reply is recorded, so a teammate's reply cannot land first. Returns false when this request is not a planned turn. */
async function replayRoomPlan(input: {
  env: NodeJS.ProcessEnv; res: ServerResponse; body: Record<string, unknown>; messages: Message[];
  model: string; prompt: string; currentTurnText: string; system: string; newTurn: boolean; botMode?: FakeMode; unfinished: Set<string>;
  activeTurnIndexes: Map<string, number>; nextTurnIndexes: Map<string, number>;
  writeEvidence: (path: string, row: unknown) => Promise<void>;
}): Promise<boolean> {
  const planPath = input.env.FAKE_CHAT_ROOM_PLAN || input.env.FAKE_CLAUDE_ROOM_PLAN;
  if (!planPath) return false;
  const plan = readPlan(planPath);
  if (!plan) return false;
  const locations = fileLocations(input.system);
  const botId = pathTail(locations?.sharedBotFolder);
  const botPlan = botId ? plan[botId] : undefined;
  if (!botId || !botPlan || typeof botPlan !== "object") return false;
  const promptBranch = botPlan.byPrompt?.find(({ promptIncludes }) => input.currentTurnText.includes(promptIncludes));
  const selectedPlan = promptBranch?.plan ?? botPlan;
  const { res, model, prompt, currentTurnText, system, newTurn, botMode, unfinished, activeTurnIndexes, nextTurnIndexes, writeEvidence } = input;
  const gone = () => res.destroyed || res.socket?.destroyed === true;
  const evidencePath = `${planPath}.evidence.jsonl`;
  const requestsPath = `${planPath}.requests.jsonl`;
  const threadId = pathTail(locations?.currentWorkingFolder) ?? "";
  const turnKey = `${botId}:${threadId}`;
  const requestRows = existsSync(requestsPath) ? readFileSync(requestsPath, "utf8").trim().split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as { botId?: string; threadId?: string; turnIndex?: number; consumesPlan?: boolean }]; } catch { return []; }
  }) : [];
  const latestRequest = requestRows.findLast((row) => row.botId === botId && row.threadId === threadId);
  let turnIndex: number;
  if (newTurn) {
    const next = nextTurnIndexes.get(botId) ?? Math.max(
      requestRows.filter((row) => row.botId === botId && row.consumesPlan !== false).length,
      countTurns(evidencePath, botId),
    );
    turnIndex = next;
    const consumesPlan = botMode !== "error";
    nextTurnIndexes.set(botId, next + (consumesPlan ? 1 : 0));
    activeTurnIndexes.set(turnKey, turnIndex);
    await writeEvidence(requestsPath, { botId, threadId, turnIndex, model, prompt, system, consumesPlan,
      resumed: system.includes(SETTLED) || prompt.includes(SETTLED) });
  } else {
    turnIndex = activeTurnIndexes.get(turnKey) ?? latestRequest?.turnIndex ?? countTurns(evidencePath, botId);
  }
  if (botMode === "error") {
    const resumed = system.includes(SETTLED) || prompt.includes(SETTLED);
    await writeEvidence(evidencePath, { botId, turnIndex, threadId, model, prompt, system, evidence: [], resumed, providerError: true });
    activeTurnIndexes.delete(turnKey);
    if (!gone()) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Scripted API provider error" } }));
    }
    return true;
  }
  const previous = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8").trim().split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as { botId?: string; planKey?: string }]; } catch { return []; }
  }) : [];
  const script = Array.isArray(selectedPlan.script) ? selectedPlan.script : undefined;
  const used = new Set(previous.filter((row) => row.botId === botId && row.planKey).map((row) => row.planKey!));
  const matches = (entry: ScriptEntry) => Array.isArray(entry.match) && entry.match.every((marker) => currentTurnText.includes(marker));
  const entry = script?.find((candidate) => !candidate.repeat && !used.has(candidate.key) && matches(candidate))
    ?? script?.find((candidate) => candidate.repeat && matches(candidate));
  const indexed = Boolean(entry) || Array.isArray(selectedPlan.turns);
  const turn = entry ?? (Array.isArray(selectedPlan.turns) ? selectedPlan.turns[turnIndex] : selectedPlan);
  const resumed = system.includes(SETTLED) || prompt.includes(SETTLED);
  if (script && !entry) {
    await writeEvidence(evidencePath, { botId, turnIndex, threadId, system, prompt, evidence: [], resumed, unplanned: true });
    activeTurnIndexes.delete(turnKey);
    if (!gone()) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Unplanned fixture turn for ${botId}: ${prompt.slice(-300)}` } }));
    }
    return true;
  }
  if (!turn) {
    activeTurnIndexes.delete(turnKey);
    if (!gone()) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Unexpected extra fixture turn ${turnIndex} for ${botId}` } }));
    }
    return true;
  }
  const steps = indexed ? turn.steps ?? [] : resumed ? turn.resumeSteps ?? [] : turn.steps ?? [];
  const reply = indexed ? turn.reply ?? `Result from ${botId}`
    : resumed ? turn.resumeReply ?? `Summary from ${botId}`
    : turn.reply ?? `Result from ${botId}`;
  const evidence: Array<{ step: PlanStep; response: { error?: { message: string }; result: { isError: boolean } } }> = [];
  const row = () => ({ botId, turnIndex, threadId, ...(entry ? { planKey: entry.key } : {}), system, prompt, evidence, resumed });
  for (const call of answeredCalls(input.messages)) {
    if (call.name === "load_tools") continue;
    const step = steps[evidence.length];
    if (!step) break;
    const failed = toolOk(call.content) === false;
    evidence.push({ step, response: failed ? { error: { message: "tool failed" }, result: { isError: true } } : { result: { isError: false } } });
    if (Boolean(step.expectError) !== failed) {
      await writeEvidence(evidencePath, row());
      unfinished.delete(botId);
        activeTurnIndexes.delete(turnKey);
      if (!gone()) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unexpected tool outcome" } }));
      }
      return true;
    }
  }
  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  let streamStarted = false;
  const startStream = () => {
    if (streamStarted) return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    streamStarted = true;
  };
  const writeText = (text: string) => {
    startStream();
    for (const piece of text.match(/.{1,12}/gs) ?? [text]) res.write(frame({ content: piece }));
  };
  const sendCalls = (calls: Array<{ name: string; arguments: string }>, hold: boolean) => {
    if (hold) {
      unfinished.add(botId);
      let sent = false;
      res.on("close", () => { if (!sent) unfinished.delete(botId); });
      sent = true;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(frame({ role: "assistant", tool_calls: calls.map((call, index) => ({
      index, id: `call_${turnIndex}_${evidence.length}_${index}`, type: "function", function: { name: call.name, arguments: call.arguments },
    })) }));
    res.write(frame({}, "tool_calls"));
    res.end("data: [DONE]\n\n");
  };
  if (evidence.length < steps.length) {
    const step = steps[evidence.length]!;
    const defs = listedTools(input.body);
    const name = wireName(step.tool, defs);
    if (!defs.some((def) => def.name === name) && defs.some((def) => def.name === "load_tools")) {
      sendCalls([{ name: "load_tools", arguments: JSON.stringify({ names: [name] }) }], false);
      return true;
    }
    sendCalls([{ name, arguments: JSON.stringify(publishedArgs(step.arguments ?? {}, defs.find((def) => def.name === name))) }], true);
    return true;
  }
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitUntil = async (ready: () => boolean, capMs?: number): Promise<boolean> => {
    const deadline = capMs === undefined ? undefined : Date.now() + capMs;
    while (!ready()) {
      if (gone()) return false;
      if (deadline !== undefined && Date.now() >= deadline) return !gone();
      await pause(20);
    }
    return !gone();
  };
  if (turn.readyFile) writeFileSync(turn.readyFile, "ready");
  if (turn.progress) writeText(turn.progress);
  if (turn.gateFile && !(await waitUntil(() => existsSync(turn.gateFile!)))) {
    unfinished.delete(botId);
    activeTurnIndexes.delete(turnKey);
    if (streamStarted && !gone()) res.end();
    return true;
  }
  if (turn.progressAfterGate) writeText(turn.progressAfterGate);
  if (typeof turn.delayMs === "number" && turn.delayMs > 0) {
    const end = Date.now() + turn.delayMs;
    while (Date.now() < end) {
        if (gone()) { unfinished.delete(botId); activeTurnIndexes.delete(turnKey); return true; }
      await pause(Math.min(20, end - Date.now()));
    }
  }
  await writeEvidence(evidencePath, row());
  unfinished.delete(botId);
  activeTurnIndexes.delete(turnKey);
  const fail = (Boolean(turn.fail) && (indexed || !resumed)) || (Boolean(turn.failResumed) && resumed);
  if (fail) {
    if (!gone()) {
      if (streamStarted) res.end();
      else {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: turn.failResumed && resumed
          ? "Scripted failure of a resumed turn"
          : "Scripted addressed agent failure" } }));
      }
    }
    return true;
  }
  if (gone()) return true;
  startStream();
  for (const piece of reply.match(/.{1,12}/gs) ?? [reply]) res.write(frame({ content: piece }));
  res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
  res.end("data: [DONE]\n\n");
  return true;
}
