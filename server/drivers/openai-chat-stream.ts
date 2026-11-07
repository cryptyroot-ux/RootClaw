import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, object } from "./openai-chat-protocol.ts";
import type { Completion, Usage } from "./model-adapter.ts";
import { completionError, completionUsage, usageFrom, type CompletionJson } from "./openai-chat-errors.ts";

export async function readChatCompletionStream(body: ReadableStream<Uint8Array> | null, options: {
  reasoning: boolean;
  noBodyError: string;
  contentText?: (content: unknown) => string;
  onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void;
  onBytes(): void;
}): Promise<Completion> {
  if (!body) throw new Error(options.noBodyError);
  let text = "";
  let reasoning = "";
  let protocolReasoning = "";
  let usage: Usage | null = null;
  let finishReason: string | null = null;
  let malformedFrame = false;
  let sawChoice = false;
  const calls = new ChatToolCalls();
  const details = new ChatReasoningDetails();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeDataLine = (line: string, atEof = false): boolean => {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return true;
    let chunk: CompletionJson;
    try { chunk = JSON.parse(data) as CompletionJson; }
    catch {
      if (!atEof) malformedFrame = true;
      return false;
    }
    const chunkError = completionError(chunk, "streaming completion error");
    if (chunkError) throw chunkError;
    const choice = chunk.choices?.find((row) => row.index === undefined || row.index === 0);
    const delta = choice?.delta;
    if (object(delta)) sawChoice = true;
    if (delta?.function_call) throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
    calls.add(delta?.tool_calls, true);
    details.add(delta?.reasoning_details);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const reasoningPart = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof reasoningPart === "string") protocolReasoning += reasoningPart;
    const reasoningDelta = options.reasoning && typeof reasoningPart === "string" ? reasoningPart : "";
    const contentDelta = options.contentText ? options.contentText(delta?.content) : typeof delta?.content === "string" ? delta.content : "";
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      options.onDelta?.(reasoningDelta, "reasoning_text");
    }
    if (contentDelta) {
      text += contentDelta;
      options.onDelta?.(contentDelta, "assistant_text");
    }
    const tokenUsage = completionUsage(chunk);
    if (tokenUsage) usage = usageFrom(tokenUsage);
    return false;
  };
  try {
    readLoop: for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        const line = buffer.trim();
        if (line && line !== "data: [DONE]") consumeDataLine(line, true);
        // MiniMax's api.minimax.io/v1 closes after finish_reason without sending [DONE].
        if (buffer.trim() === "data: [DONE]" || finishReason) break;
        if (!sawChoice) {
          let response: CompletionJson | undefined;
          try { response = JSON.parse(buffer) as CompletionJson; } catch { response = undefined; }
          const bodyError = response ? completionError(response, "completion error") : null;
          if (bodyError) throw bodyError;
        }
        throw new ChatProtocolError("Stream ended before completion");
      }
      options.onBytes();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new ChatProtocolError("provider stream frame exceeded the size limit");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (consumeDataLine(line)) break readLoop;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!sawChoice) throw new ChatProtocolError("provider returned no streaming completion choice");
  return { text, reasoning, usage, toolCalls: calls.finish(finishReason, malformedFrame), finishReason, protocolReasoning, protocolReasoningDetails: details.blocks };
}
