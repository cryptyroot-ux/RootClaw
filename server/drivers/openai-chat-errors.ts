// Reading a chat-completions provider's answers and failures: usage, error frames, and the 400s that mean a model
// cannot take tools, reasoning replay or its own tool call. Moved out of openai-chat.ts unchanged.
import { ChatProtocolError, object } from "./openai-chat-protocol.ts";
import type { Usage } from "./model-adapter.ts";
import { HttpStatusError, RETRYABLE_STATUSES } from "./retry.ts";

export interface CompletionJson {
  model?: string;
  choices?: Array<{
    index?: number;
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    finish_reason?: string | null;
  }>;
  error?: unknown;
  base_resp?: { status_code?: unknown; status_msg?: unknown };
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cost?: number };
  /** Groq reports streaming usage in its final x_groq envelope. */
  x_groq?: { usage?: CompletionJson["usage"] };
}

/** MiniMax reports auth, balance and parameter failures as `base_resp` with HTTP 200. */
export function providerError(json: CompletionJson): string | null {
  if (typeof json.error === "string") return json.error;
  const error = object(json.error);
  if (error) return typeof error.message === "string" ? error.message : "unknown error";
  const code = json.base_resp?.status_code;
  if (typeof code === "number" && code !== 0) {
    const msg = typeof json.base_resp?.status_msg === "string" ? json.base_resp.status_msg : "";
    return `upstream error ${code}${msg ? `: ${msg}` : ""}`;
  }
  return null;
}

const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

/** A failed response's own error message, then its machine code (trial-credit.ts parses it), else the raw body. */
export function httpErrorDetail(body: string, limit = 500): string {
  let json: CompletionJson | undefined;
  try { json = object(JSON.parse(body)); } catch { json = undefined; }
  const message = json ? providerError(json) : null;
  if (!message || message === "unknown error") return body.slice(0, limit);
  const code = object(json?.error)?.code;
  const suffix = typeof code === "string" && MACHINE_CODE.test(code) ? ` (${code})` : "";
  return message.slice(0, limit) + suffix;
}

export const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0,
      ...(typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? { costUsd: usage.cost } : {}) }
    : null;

export const completionUsage = (json: CompletionJson) => json.usage ?? json.x_groq?.usage;

export function rejectsToolsParameter(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  let envelope: Record<string, unknown> | undefined;
  try { envelope = object(JSON.parse(body)); } catch { return false; }
  const error = object(envelope?.error);
  if (error?.param === "tools" && error.code === "unsupported_parameter") return true;
  const message = error?.message ?? envelope?.error;
  return typeof message === "string" && (
    /\bdoes not support (?:tools|tool calling|function calling)(?:[.!]?$|[.!]?\s)/i.test(message) ||
    /\b(?:tools|tool calling|function calling) (?:is|are) not supported\b/i.test(message) ||
    /^(?:unsupported|unknown|unrecognized) (?:parameter|field):?\s*['"]?tools['"]?[.!]?$/i.test(message.trim())
  );
}

export class UnsupportedReasoningReplayError extends Error {}

/** DeepSeek-style providers need `reasoning_content` echoed on a tool-call message; Groq rejects it. */
export function rejectsReasoningReplay(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  let envelope: Record<string, unknown> | undefined;
  try { envelope = object(JSON.parse(body)); } catch { return false; }
  const message = object(envelope?.error)?.message ?? envelope?.error;
  return typeof message === "string" && /\breasoning_content\b/.test(message) &&
    /\b(?:unsupported|not supported|unknown|unrecognized|unexpected|not permitted|not allowed)\b/i.test(message);
}

/** Groq fails a completion with `tool_use_failed` when a generated tool call is invalid: usually a
 *  tool it was not offered (gpt-oss inventing a "json" tool), sometimes arguments missing the schema. */
/** A model refusing its own tool call gets three tries in all, independent of the transport retry cap. */
export const REFUSED_TOOL_CALL_ATTEMPTS = 3;

export class RejectedToolCallError extends ChatProtocolError {
  readonly refusal: Record<string, unknown>;
  constructor(message: string, refusal: Record<string, unknown>) {
    super(message);
    this.refusal = refusal;
  }
}

export const toolCallRefusal = (error: unknown) => {
  const body = object(error);
  return body?.code === "tool_use_failed" ? body : undefined;
};

export function refusedToolCall(status: number, body: string) {
  if (status !== 400) return undefined;
  try { return toolCallRefusal(object(JSON.parse(body))?.error); } catch { return undefined; }
}

export function completionError(json: CompletionJson, label: string): Error | null {
  const message = providerError(json);
  if (!message) return null;
  const text = `provider returned a ${label}: ${message.slice(0, 200)}`;
  const refusal = toolCallRefusal(json.error);
  if (refusal) return new RejectedToolCallError(text, refusal);
  // An error frame inside a 200 answer that carries a retryable status (OpenRouter sends an upstream 502/503/429 this
  // way, e.g. {"error":{"code":502,"metadata":{"error_type":"provider_unavailable"}}}) is the same transient failure as
  // that HTTP status, so it gets the same retry while nothing has streamed yet.
  const code = Number((json.error as { code?: unknown } | undefined)?.code);
  if (RETRYABLE_STATUSES.has(code)) return new HttpStatusError(text, code);
  return new ChatProtocolError(text);
}

export function refusedToolCallFailure(error: RejectedToolCallError, earlierSteps: boolean): string {
  const words = typeof error.refusal.message === "string" ? error.refusal.message : error.message;
  const tool = /attempted to call tool '([^']+)'/.exec(words)?.[1];
  const what = tool ? `tried to use a tool it was not given ("${tool}")` : "made a tool call the provider rejected";
  const next = earlierSteps
    ? "The steps before it already ran, so ask only for what's left."
    : "Nothing ran. Retry; if it keeps happening, rephrase the request or choose another model.";
  return `The model ${what}. ${next} Provider: ${words.slice(0, 200)}`;
}
