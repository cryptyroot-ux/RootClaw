// A tool call a local model wrote as text instead of as a structured call. Local servers turn this text into tool_calls
// only when their chat template and parser match the model, and when they do not the call reaches us as the reply: Qwen
// through Ollama's /v1, a GGUF with a stock template, a server started without --jinja.
//
// The forms are the ones the servers' own parsers read: `<tool_call>{json}</tool_call>` (Hermes and Qwen templates),
// `<function=name><parameter=key>…` (Qwen coder templates) and a reply that is nothing but one JSON call. This is stricter
// than those parsers, which take a tag anywhere in the output: the calls must end the reply and name an offered tool, so
// a reply that quotes a call and goes on talking stays a reply. Reasoning is never read. A recovered call then takes the
// same schema check and approval as any other.
import { randomUUID } from "node:crypto";
import type { ChatToolCall } from "./openai-chat-protocol.ts";
import { object } from "./openai-chat-protocol.ts";

export interface OfferedTool {
  function: { name: string; parameters?: Record<string, unknown> };
}

export type TextToolCalls =
  /** `text` is what the model said before the calls. */
  | { kind: "calls"; calls: ChatToolCall[]; text: string }
  /** It tried to call a tool and the call cannot be read: worth one request to send it again. */
  | { kind: "unreadable"; text: string };

const MAX_CALLS = 32;
const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";
const OPEN_FUNCTION = "<function=";
const THINK_END = "</think>";

const FUNCTION_CLOSE = "</function>";
const THINK_OPEN = "<think>";
const FUNCTION_BLOCK = /^<function=([^>\s]+)\s*>([\s\S]*?)<\/function>\s*$/;
const PARAMETER = /<parameter=([^>\s]+)\s*>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g;
const FENCED_JSON = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

type Quote = '"' | "'" | null;

/** `'` between letters is a contraction, not a quotation. */
function openQuote(text: string, index: number): Quote {
  const mark = text[index];
  if (mark === '"') return '"';
  if (mark === "'" && (index === 0 || !/[A-Za-z0-9]/.test(text[index - 1]!))) return "'";
  return null;
}

/** Index of `needle` outside `"..."` and `'...'`. A backslash keeps the next character. */
function outsideQuotes(text: string, needle: string, from = 0): number {
  let quote: Quote = null;
  for (let i = from; i < text.length; i++) {
    if (quote) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === quote) quote = null;
      continue;
    }
    const opened = openQuote(text, i);
    if (opened) { quote = opened; continue; }
    if (text.startsWith(needle, i)) return i;
  }
  return -1;
}

/** Index of `needle` outside a JSON string. Prose quotes are not special here. */
function outsideJsonStrings(text: string, needle: string): number {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const mark = text[i];
    if (inString) {
      if (mark === "\\") { i++; continue; }
      if (mark === '"') inString = false;
      continue;
    }
    if (mark === '"') { inString = true; continue; }
    if (text.startsWith(needle, i)) return i;
  }
  return -1;
}

function parsedObject(text: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(text)); } catch { return undefined; }
}

function declaredType(tool: OfferedTool, key: string): unknown {
  return object(object(tool.function.parameters?.properties)?.[key])?.type;
}

/** A parameter's body is text; the tool's schema says when it is a number, an object or a list. */
function parameterValue(tool: OfferedTool, key: string, raw: string): unknown {
  const value = raw.replace(/^\n/, "").replace(/\n$/, "");
  const type = declaredType(tool, key);
  if (type === "string" || (Array.isArray(type) && type.includes("string"))) return value;
  try { return JSON.parse(value.trim()); } catch { return value; }
}

function toCall(name: string, args: Record<string, unknown>): ChatToolCall {
  return { id: `text_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function jsonCall(body: string, offered: ReadonlyMap<string, OfferedTool>): ChatToolCall | undefined {
  const parsed = parsedObject(body);
  if (typeof parsed?.name !== "string" || !offered.has(parsed.name)) return undefined;
  // Llama-family templates write `parameters`; an argument object some models double-encode is still that object.
  const raw = parsed.arguments ?? parsed.parameters ?? {};
  const args = typeof raw === "string" ? parsedObject(raw) : object(raw);
  return args ? toCall(parsed.name, args) : undefined;
}

function functionCall(body: string, offered: ReadonlyMap<string, OfferedTool>): ChatToolCall | undefined {
  const block = FUNCTION_BLOCK.exec(body);
  const tool = block ? offered.get(block[1]!) : undefined;
  if (!block || !tool) return undefined;
  const args: Record<string, unknown> = {};
  for (const [, key, raw] of block[2]!.matchAll(PARAMETER)) args[key!] = parameterValue(tool, key!, raw!);
  return toCall(block[1]!, args);
}

type CallBodies = { ok: true; bodies: string[] } | { ok: false };

/** A closed coder block, or failure when the tag is unclosed or swallows a later call. */
function takeFunction(text: string): { body: string; rest: string } | undefined {
  const close = text.indexOf(FUNCTION_CLOSE);
  const nested = text.indexOf(OPEN_FUNCTION, OPEN_FUNCTION.length);
  const tool = text.indexOf(OPEN_TAG);
  if (close === -1 || (nested !== -1 && nested < close) || (tool !== -1 && tool < close)) return undefined;
  const end = close + FUNCTION_CLOSE.length;
  return { body: text.slice(0, end), rest: text.slice(end) };
}

/** One `<tool_call>` body. JSON strings may contain tags; those tags are not calls. */
function takeToolCall(text: string): { body: string; rest: string; form: "json" | "coder" } | undefined {
  const trimmed = text.trimStart();
  if (trimmed.startsWith(OPEN_TAG)) return undefined;
  if (trimmed.startsWith(OPEN_FUNCTION)) {
    const coder = takeFunction(trimmed);
    if (!coder) return undefined;
    const after = coder.rest.trimStart();
    if (after.startsWith(CLOSE_TAG)) return { body: coder.body, rest: after.slice(CLOSE_TAG.length), form: "coder" };
    if (after === "") return { body: coder.body, rest: "", form: "coder" };
    return undefined;
  }
  const close = outsideJsonStrings(text, CLOSE_TAG);
  if (close === -1) {
    if (outsideJsonStrings(text, OPEN_TAG) !== -1 || outsideJsonStrings(text, OPEN_FUNCTION) !== -1) return undefined;
    return { body: text, rest: "", form: "json" };
  }
  const innerTool = outsideJsonStrings(text, OPEN_TAG);
  const innerFunction = outsideJsonStrings(text, OPEN_FUNCTION);
  if ((innerTool !== -1 && innerTool < close) || (innerFunction !== -1 && innerFunction < close)) return undefined;
  return { body: text.slice(0, close), rest: text.slice(close + CLOSE_TAG.length), form: "json" };
}

/** Complete calls only. Undefined when prose follows; `{ ok: false }` when the syntax is mixed or unfinished. */
function taggedBodies(text: string): CallBodies | undefined {
  const bodies: string[] = [];
  let form: "json" | "coder" | undefined;
  let rest = text;
  while (rest.trim()) {
    rest = rest.trimStart();
    if (rest.startsWith(OPEN_FUNCTION)) {
      if (form === "json") return { ok: false };
      const coder = takeFunction(rest);
      if (!coder) return { ok: false };
      form = "coder";
      bodies.push(coder.body);
      rest = coder.rest;
      continue;
    }
    if (!rest.startsWith(OPEN_TAG)) return undefined;
    const call = takeToolCall(rest.slice(OPEN_TAG.length));
    if (!call || (form && form !== call.form)) return { ok: false };
    form = call.form;
    bodies.push(call.body);
    rest = call.rest;
  }
  return { ok: true, bodies };
}

function firstCallAt(text: string): number {
  return outsideQuotes(text, OPEN_TAG) === -1 && outsideQuotes(text, OPEN_FUNCTION) === -1
    ? -1
    : Math.min(...[outsideQuotes(text, OPEN_TAG), outsideQuotes(text, OPEN_FUNCTION)].filter((at) => at !== -1));
}

/** Drops text through a real `<think>…</think>` pair. A quoted or bare `</think>` does not. */
function withoutThinking(text: string): string {
  let quote: Quote = null;
  let thinkAt = -1;
  let closeAt = -1;
  for (let i = 0; i < text.length; i++) {
    if (quote) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === quote) quote = null;
      continue;
    }
    const opened = openQuote(text, i);
    if (opened) { quote = opened; continue; }
    if (text.startsWith(THINK_OPEN, i)) thinkAt = i;
    else if (text.startsWith(THINK_END, i) && thinkAt !== -1 && thinkAt < i) closeAt = i;
  }
  return closeAt === -1 ? text : text.slice(closeAt + THINK_END.length);
}

/** Null when the reply is a reply. */
export function textToolCalls(reply: string, tools: readonly OfferedTool[]): TextToolCalls | null {
  const offered = new Map(tools.map((tool) => [tool.function.name, tool]));
  const text = withoutThinking(reply).trim();
  // A reply that is one JSON value is only that value. A tag inside an argument is not a second call.
  if (text.startsWith("{") || FENCED_JSON.test(text)) {
    const fenced = FENCED_JSON.exec(text)?.[1];
    const call = jsonCall(fenced ?? text, offered);
    return call ? { kind: "calls", calls: [call], text: "" } : null;
  }
  const at = firstCallAt(text);
  if (at === -1) return null;
  const said = text.slice(0, at).trimEnd();
  const parsed = taggedBodies(text.slice(at));
  // Calls followed by more words: an example or a quotation, not a request to run something.
  if (!parsed || !parsed.ok) return parsed ? { kind: "unreadable", text: said } : null;
  const bodies = parsed.bodies;
  if (!bodies.length || bodies.length > MAX_CALLS) return null;
  const calls: ChatToolCall[] = [];
  for (const body of bodies) {
    // Only a body that is the coder form is one. `<function=` inside JSON arguments stays argument text.
    const trimmed = body.trim();
    const call = trimmed.startsWith(OPEN_FUNCTION) ? functionCall(trimmed, offered) : jsonCall(trimmed, offered);
    if (!call) return { kind: "unreadable", text: said };
    calls.push(call);
  }
  return { kind: "calls", calls, text: said };
}

const MARKERS = [OPEN_TAG, OPEN_FUNCTION];

function partialMarkerLength(text: string): number {
  for (let length = Math.min(text.length, Math.max(...MARKERS.map((marker) => marker.length - 1))); length > 0; length--) {
    const tail = text.slice(-length);
    if (MARKERS.some((marker) => marker.startsWith(tail))) return length;
  }
  return 0;
}

/** Keeps a call out of the streamed reply: words before it show as they arrive, and from where a call might start the
 * text waits until the reply ends and `textToolCalls` has decided. */
export class TextCallHoldback {
  private seen = "";
  private shown = 0;

  feed(delta: string): string {
    this.seen += delta;
    const start = this.seen.trimStart();
    // A reply opening like this may be one bare JSON call, which is only known at the end.
    if (!start || start.startsWith("{") || "```".startsWith(start.slice(0, 3)) || start.startsWith("```")) return "";
    const at = firstCallAt(this.seen);
    const end = at !== -1 ? at : this.seen.length - partialMarkerLength(this.seen);
    if (end <= this.shown) return "";
    const visible = this.seen.slice(this.shown, end);
    this.shown = end;
    return visible;
  }

  /** What is still held, for a reply that turned out to have no call in it. */
  rest(): string {
    const held = this.seen.slice(this.shown);
    this.shown = this.seen.length;
    return held;
  }
}
