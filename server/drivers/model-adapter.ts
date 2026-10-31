// The provider-agnostic seam of the native engine loop (openai-chat runtime). The loop speaks one canonical message
// shape (OpenAI Chat Completions: system/user/assistant/tool, tool_calls) and hands each round to a ModelAdapter that
// translates it to its provider's wire API, streams text/reasoning deltas back, and reports usage.
//
// Error contract (what feeds retry.ts and failover.ts):
// - HTTP failures throw HttpStatusError(message, status, retryAfterMs): 429/5xx retry, quota/auth/404 fail over.
// - A request the provider refuses as too large / over the context window throws RequestTooLargeError: the loop
//   compacts once, then resends smaller, then fails over (`context`).
// - A malformed or empty reply throws ChatProtocolError: never retried, never failed over.
// - The adapter must honour `signal` (the person's stop, the idle timeout) and never retry by itself.
import type { TextGenerationOptions } from "../contracts.ts";
import type { ChatContentPart } from "./chat-images.ts";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import type { ChatToolCall } from "./openai-chat-protocol.ts";

/** The loop's canonical message (OpenAI Chat Completions shape). */
export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: Record<string, unknown>[];
}

export interface Usage {
  input: number;
  output: number;
  /** The provider's own charge for the call in USD, when it reports one (OpenRouter's `usage.cost`). */
  costUsd?: number;
}

/** One round's result. `protocolReasoning*` are echoed back on the next request by providers that require it. */
export interface Completion {
  text: string;
  reasoning: string;
  usage: Usage | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  protocolReasoning: string;
  protocolReasoningDetails: Record<string, unknown>[];
}

export type DeltaKind = "assistant_text" | "reasoning_text";

export interface ModelRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools: ChatToolDefinition[];
  /** false for one-shot helper calls (summaries, titles). */
  stream: boolean;
  signal?: AbortSignal;
  onDelta?: (delta: string, kind: DeltaKind) => void;
  /** Helper calls report the provider's own accounting (model, tokens, cost) here. */
  onUsage?: TextGenerationOptions["onUsage"];
  /** Output-token ceiling for small helper calls (the verifier); absent leaves the provider default. */
  maxTokens?: number;
}

export interface ModelAdapter {
  /** Wire protocol name, for logs: "openai-chat", "anthropic-messages", "gemini", "openai-responses", … */
  readonly protocol: string;
  complete(request: ModelRequest): Promise<Completion>;
}

/** Usage counts from a provider, clamped to non-negative integers. */
export const tokenCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
