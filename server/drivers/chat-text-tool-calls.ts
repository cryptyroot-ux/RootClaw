// Text recovery: at most one complete call at the end of the reply, otherwise nothing runs.
//
// Think prefix: from the start, drop whitespace and complete `<think>…</think>` blocks.
// The first `</think>` closes the block. Quotes inside it are not tracked, and the
// opener is forgotten when the block ends. A later or bare `</think>` does not
// discard earlier text.
//
// The call, after optional prose, is exactly one of:
// `<tool_call>` + one JSON object + `</tool_call>`,
// `<tool_call>` + one `<function=name>…</function>` + `</tool_call>`,
// `<function=name>…</function>`,
// or a reply that is only one JSON object or one fenced JSON object.
// Both close tags are required. Text inside JSON strings and `<parameter>` bodies
// is data, not another call. A second call, a mix, a missing close, or a call
// that begins inside an unclosed quotation is not recovered.
import { randomUUID } from "node:crypto";
import type { ChatToolCall } from "./openai-chat-protocol.ts";
import { object } from "./openai-chat-protocol.ts";

export interface OfferedTool {
  function: { name: string; parameters?: Record<string, unknown> };
}

export type TextToolCalls =
  /** `text` is what the model said before the call. */
  | { kind: "calls"; calls: ChatToolCall[]; text: string }
  /** It tried to call a tool and the call cannot be read: worth one request to send it again. */
  | { kind: "unreadable"; text: string };

const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";
const OPEN_FUNCTION = "<function=";
const FUNCTION_CLOSE = "</function>";
const THINK_OPEN = "<think>";
const THINK_END = "</think>";
const PARAMETER_CLOSE = "</parameter>";
const FENCED_JSON = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

type Quote = '"' | "'" | null;
type OneCall = ChatToolCall | "trailing" | "bad";

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

function openQuote(text: string, index: number): Quote {
  const mark = text[index];
  if (mark === '"') return '"';
  if (mark === "'" && (index === 0 || !/[A-Za-z0-9]/.test(text[index - 1]!))) return "'";
  return null;
}

/** The first `</think>` ends the block. Nothing inside the block is a call or a quote. */
function stripThinkPrefix(text: string): string {
  let start = 0;
  while (start < text.length) {
    let at = start;
    while (at < text.length && /\s/.test(text[at]!)) at++;
    if (!text.startsWith(THINK_OPEN, at)) break;
    const close = text.indexOf(THINK_END, at + THINK_OPEN.length);
    if (close === -1) break;
    start = close + THINK_END.length;
  }
  return text.slice(start);
}

function unmatchedQuote(text: string): boolean {
  let quote: Quote = null;
  for (let i = 0; i < text.length; i++) {
    if (quote) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === quote) quote = null;
      continue;
    }
    const opened = openQuote(text, i);
    if (opened) quote = opened;
  }
  return quote !== null;
}

function thinkMarkerOutsideQuotes(text: string): boolean {
  let quote: Quote = null;
  for (let i = 0; i < text.length; i++) {
    if (quote) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === quote) quote = null;
      continue;
    }
    const opened = openQuote(text, i);
    if (opened) { quote = opened; continue; }
    if (text.startsWith(THINK_OPEN, i) || text.startsWith(THINK_END, i)) return true;
  }
  return false;
}

function firstTagOutsideQuotes(text: string): number {
  let quote: Quote = null;
  for (let i = 0; i < text.length; i++) {
    if (quote) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === quote) quote = null;
      continue;
    }
    const opened = openQuote(text, i);
    if (opened) { quote = opened; continue; }
    if (text.startsWith(OPEN_TAG, i) || text.startsWith(OPEN_FUNCTION, i)) return i;
  }
  return -1;
}

function endOfJsonValue(text: string): number {
  if (!text.startsWith("{")) return -1;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const mark = text[i]!;
    if (inString) {
      if (mark === "\\") { i++; continue; }
      if (mark === '"') inString = false;
      continue;
    }
    if (mark === '"') { inString = true; continue; }
    if (mark === "{") depth++;
    else if (mark === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The matching `</parameter>`. A `<parameter=` inside the body is text, so it does not end the value. */
function parameterEnd(text: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < text.length) {
    const close = text.indexOf(PARAMETER_CLOSE, i);
    if (close === -1) return -1;
    const open = text.indexOf("<parameter=", i);
    if (open !== -1 && open < close) {
      depth++;
      i = open + "<parameter=".length;
      continue;
    }
    depth--;
    if (depth === 0) return close;
    i = close + PARAMETER_CLOSE.length;
  }
  return -1;
}

/** One `<function=…>…</function>`. The name is the outer tag. Parameter text is not another call. */
function readFunction(text: string): { name: string; args: Record<string, string>; length: number } | undefined {
  const open = /^<function=([^>\s]+)\s*>/.exec(text);
  if (!open) return undefined;
  let i = open[0].length;
  const args: Record<string, string> = {};
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith(FUNCTION_CLOSE, i)) return { name: open[1]!, args, length: i + FUNCTION_CLOSE.length };
    const param = /^<parameter=([^>\s]+)\s*>/.exec(text.slice(i));
    if (!param) return undefined;
    const valueAt = i + param[0].length;
    const close = parameterEnd(text, valueAt);
    if (close === -1) return undefined;
    args[param[1]!] = text.slice(valueAt, close);
    i = close + PARAMETER_CLOSE.length;
  }
  return undefined;
}

function coderCall(name: string, rawArgs: Record<string, string>, offered: ReadonlyMap<string, OfferedTool>): ChatToolCall | undefined {
  const tool = offered.get(name);
  if (!tool) return undefined;
  const args: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(rawArgs)) args[key] = parameterValue(tool, key, raw);
  return toCall(name, args);
}

function afterCall(rest: string, call: ChatToolCall | undefined): OneCall {
  if (!call) return "bad";
  if (rest.trim() === "") return call;
  const more = rest.trimStart();
  if (more.startsWith(OPEN_TAG) || more.startsWith(OPEN_FUNCTION)) return "bad";
  return "trailing";
}

/** One closed call that finishes `text`, or why it is not that. */
function oneClosedCall(text: string, offered: ReadonlyMap<string, OfferedTool>): OneCall {
  if (text.startsWith(OPEN_TAG)) {
    const inner = text.slice(OPEN_TAG.length);
    const trimmed = inner.trimStart();
    const lead = inner.length - trimmed.length;
    if (trimmed.startsWith(OPEN_FUNCTION)) {
      const fn = readFunction(trimmed);
      if (!fn) return "bad";
      let i = lead + fn.length;
      while (i < inner.length && /\s/.test(inner[i]!)) i++;
      if (!inner.startsWith(CLOSE_TAG, i)) return "bad";
      return afterCall(inner.slice(i + CLOSE_TAG.length), coderCall(fn.name, fn.args, offered));
    }
    if (!trimmed.startsWith("{")) return "bad";
    const jsonEnd = endOfJsonValue(trimmed);
    if (jsonEnd < 0) return "bad";
    let i = lead + jsonEnd;
    while (i < inner.length && /\s/.test(inner[i]!)) i++;
    if (!inner.startsWith(CLOSE_TAG, i)) return "bad";
    return afterCall(inner.slice(i + CLOSE_TAG.length), jsonCall(trimmed.slice(0, jsonEnd), offered));
  }
  if (text.startsWith(OPEN_FUNCTION)) {
    const fn = readFunction(text);
    if (!fn) return "bad";
    return afterCall(text.slice(fn.length), coderCall(fn.name, fn.args, offered));
  }
  return "bad";
}

/** Null when the reply is a reply. */
export function textToolCalls(reply: string, tools: readonly OfferedTool[]): TextToolCalls | null {
  const offered = new Map(tools.map((tool) => [tool.function.name, tool]));
  const text = stripThinkPrefix(reply).trim();
  if (text.startsWith("{") || FENCED_JSON.test(text)) {
    const fenced = FENCED_JSON.exec(text)?.[1];
    const call = jsonCall((fenced ?? text).trim(), offered);
    return call ? { kind: "calls", calls: [call], text: "" } : null;
  }
  const at = firstTagOutsideQuotes(text);
  if (at === -1) return null;
  const said = text.slice(0, at).trimEnd();
  if (unmatchedQuote(said) || thinkMarkerOutsideQuotes(said)) return null;
  const parsed = oneClosedCall(text.slice(at).trimStart(), offered);
  if (parsed === "trailing") return null;
  if (parsed === "bad") return { kind: "unreadable", text: said };
  return { kind: "calls", calls: [parsed], text: said };
}

const MARKERS = [OPEN_TAG, OPEN_FUNCTION];

function partialMarkerLength(text: string): number {
  for (let length = Math.min(text.length, Math.max(...MARKERS.map((marker) => marker.length - 1))); length > 0; length--) {
    const tail = text.slice(-length);
    if (MARKERS.some((marker) => marker.startsWith(tail))) return length;
  }
  return 0;
}

function earliestTag(text: string): number {
  const tool = text.indexOf(OPEN_TAG);
  const fn = text.indexOf(OPEN_FUNCTION);
  if (tool === -1) return fn;
  if (fn === -1) return tool;
  return Math.min(tool, fn);
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
    const at = earliestTag(this.seen);
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
