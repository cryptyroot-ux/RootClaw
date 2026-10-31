// Shared wire plumbing for ModelAdapters: one POST, the error contract, and a server-sent-events reader.
import { refusesRequestSize, RequestTooLargeError } from "../chat-size-limit.ts";
import { ChatProtocolError } from "../openai-chat-protocol.ts";
import { HttpStatusError, parseRetryAfter } from "../retry.ts";
import { refusesContextLength } from "../turn-context.ts";
import { fetchFresh } from "../http-client.ts";

const DETAIL_CHARS = 300;
/** Overflow wording turn-context.ts does not know: Gemini's "input token count (…) exceeds the maximum number of tokens". */
const PROVIDER_OVERFLOW = /exceeds the maximum number of tokens/i;

/** The error contract: an oversized request is RequestTooLargeError, anything else HttpStatusError. 529 (Anthropic
 * "overloaded") is carried as 503 so retry.ts treats it as a transient server error. */
export function httpFailure(label: string, status: number, body: string, payloadBytes: number, retryAfter: string | null): Error {
  const message = `${label} HTTP ${status}${body ? `: ${body.replace(/\s+/g, " ").slice(0, DETAIL_CHARS)}` : ""}`;
  if (refusesRequestSize(status, body) || refusesContextLength(status, body) || (status === 400 && PROVIDER_OVERFLOW.test(body))) return new RequestTooLargeError(message, payloadBytes);
  return new HttpStatusError(message, status === 529 ? 503 : status, parseRetryAfter(retryAfter));
}

export async function postJson(label: string, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  const payload = JSON.stringify(body);
  const response = await fetchFresh(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload, signal, redirect: "error" },
    fetch, { onStale: () => console.warn(`${label}: stale keep-alive socket; resending once on a fresh connection`) });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw httpFailure(label, response.status, text, Buffer.byteLength(payload), response.headers.get("retry-after"));
  }
  return response;
}

/** The most one server-sent event (or an unfinished line) may hold. */
const MAX_SSE_EVENT_CHARS = 4_000_000;

export interface SseEvent { event: string; data: string }

/** Parses a text/event-stream body into events; `data:` lines of one event are joined with "\n". */
export async function* sseEvents(response: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  if (!response.body) throw new ChatProtocolError("provider returned no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let eventChars = 0;
  const flush = (): SseEvent | null => {
    const out = data.length ? { event: event || "message", data: data.join("\n") } : null;
    event = ""; data = []; eventChars = 0;
    return out;
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_EVENT_CHARS) throw new ChatProtocolError("provider stream frame exceeded the size limit");
      // Lines end in \r\n, \n or a lone \r (the SSE spec, audit N09); a \r last in the buffer waits for what follows.
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match || (match[0] === "\r" && match.index === buffer.length - 1 && !done)) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === "") { const out = flush(); if (out) yield out; continue; }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") {
          // The limit is on the whole event, not one line: many small data: lines add up (audit N10).
          eventChars += value.length + 1;
          if (eventChars > MAX_SSE_EVENT_CHARS) throw new ChatProtocolError("provider stream event exceeded the size limit");
          data.push(value);
        }
      }
      if (done) {
        if (buffer.trim()) { const line = buffer.trim(); if (line.startsWith("data:")) data.push(line.slice(5).trim()); }
        const out = flush(); if (out) yield out;
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function parseJson(data: string): Record<string, unknown> {
  try {
    const value = JSON.parse(data) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new ChatProtocolError("provider sent a malformed stream event");
}

/** A data: URL image as (mime, base64), or null for a remote URL. */
export function dataUrl(url: string): { mime: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mime: match[1]!, data: match[2]! } : null;
}

export const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("") : "";
