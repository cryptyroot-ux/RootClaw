// Anthropic Messages API adapter: POST {base}/messages, SSE streaming, tool_use / tool_result, prompt caching.
// Caching marks the system prompt and the tool list with cache_control (generally available; no beta header).
import type { ChatToolCall } from "../openai-chat-protocol.ts";
import { ChatProtocolError } from "../openai-chat-protocol.ts";
import type { Completion, ModelAdapter, OpenAIChatMessage, Usage } from "../model-adapter.ts";
import { tokenCount } from "../model-adapter.ts";
import { dataUrl, parseJson, postJson, sseEvents, textOf } from "./http.ts";

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;
type Block = Record<string, unknown>;
type Message = { role: "user" | "assistant"; content: Block[] };

function userBlocks(content: OpenAIChatMessage["content"]): Block[] {
  if (typeof content === "string" || content === null) return [{ type: "text", text: content ?? "" }];
  return content.map((part): Block => {
    if (part.type === "text") return { type: "text", text: part.text };
    const inline = dataUrl(part.image_url.url);
    return inline ? { type: "image", source: { type: "base64", media_type: inline.mime, data: inline.data } }
      : { type: "image", source: { type: "url", url: part.image_url.url } };
  });
}

/** Canonical messages → Anthropic: system apart, tool results folded into the next user turn, roles alternating. */
export function anthropicRequest(messages: OpenAIChatMessage[]): { system: Block[]; messages: Message[] } {
  const system: Block[] = [];
  const out: Message[] = [];
  const push = (role: Message["role"], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "system") { const text = textOf(message.content); if (text) system.push({ type: "text", text }); continue; }
    if (message.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: textOf(message.content) }]);
      continue;
    }
    if (message.role === "assistant") {
      const blocks: Block[] = [];
      const text = textOf(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of message.tool_calls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(call.function.arguments || "{}"); } catch { input = {}; }
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      push("assistant", blocks);
      continue;
    }
    push("user", userBlocks(message.content));
  }
  if (system.length) system.at(-1)!.cache_control = { type: "ephemeral" };
  return { system, messages: out };
}

export function createAnthropicAdapter(options: { url: string; apiKey: string; maxTokens?: number; label?: string }): ModelAdapter {
  const label = options.label ?? "Anthropic";
  return {
    protocol: "anthropic-messages",
    async complete(request): Promise<Completion> {
      const { system, messages } = anthropicRequest(request.messages);
      const tools = request.tools.map((tool, index, all) => ({
        name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters,
        ...(index === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }));
      const response = await postJson(label, `${options.url}/messages`, { "x-api-key": options.apiKey, "anthropic-version": ANTHROPIC_VERSION }, {
        model: request.model, max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS, messages, stream: request.stream,
        ...(system.length ? { system } : {}), ...(tools.length ? { tools } : {}),
      }, request.signal);
      if (!request.stream) return fromMessage(parseJson(await response.text()), request);
      return fromStream(response, request);
    },
  };
}

function finish(text: string, reasoning: string, usage: Usage | null, calls: ChatToolCall[], stop: string | null): Completion {
  return { text, reasoning, usage, toolCalls: calls, finishReason: stop === "end_turn" || stop === "stop_sequence" ? "stop" : stop === "tool_use" ? "tool_calls" : stop === "max_tokens" ? "length" : stop, protocolReasoning: "", protocolReasoningDetails: [] };
}

function usageOf(raw: unknown, into?: Usage): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const input = tokenCount(u.input_tokens) + tokenCount(u.cache_read_input_tokens) + tokenCount(u.cache_creation_input_tokens);
  return { input: input || into?.input || 0, output: tokenCount(u.output_tokens) || into?.output || 0 };
}

function fromMessage(json: Record<string, unknown>, request: Parameters<ModelAdapter["complete"]>[0]): Completion {
  const blocks = Array.isArray(json.content) ? json.content as Block[] : [];
  let text = "", reasoning = "";
  const calls: ChatToolCall[] = [];
  for (const block of blocks) {
    if (block.type === "text") text += String(block.text ?? "");
    else if (block.type === "thinking") reasoning += String(block.thinking ?? "");
    else if (block.type === "tool_use") calls.push({ id: String(block.id), type: "function", function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) } });
  }
  const usage = usageOf(json.usage);
  request.onUsage?.({ model: typeof json.model === "string" ? json.model : request.model, input: usage.input, output: usage.output });
  return finish(text, reasoning, usage, calls, typeof json.stop_reason === "string" ? json.stop_reason : null);
}

async function fromStream(response: Response, request: Parameters<ModelAdapter["complete"]>[0]): Promise<Completion> {
  let text = "", reasoning = "", stop: string | null = null, usage: Usage | null = null, ended = false;
  const tools = new Map<number, { id: string; name: string; args: string }>();
  for await (const { data } of sseEvents(response, request.signal)) {
    const event = parseJson(data);
    switch (event.type) {
      case "message_start": usage = usageOf((event.message as Block | undefined)?.usage); break;
      case "content_block_start": {
        const block = event.content_block as Block | undefined;
        if (block?.type === "tool_use") tools.set(Number(event.index), { id: String(block.id), name: String(block.name), args: "" });
        break;
      }
      case "content_block_delta": {
        const delta = event.delta as Block | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") { text += delta.text; request.onDelta?.(delta.text, "assistant_text"); }
        else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") { reasoning += delta.thinking; request.onDelta?.(delta.thinking, "reasoning_text"); }
        else if (delta?.type === "input_json_delta") { const tool = tools.get(Number(event.index)); if (tool) tool.args += String(delta.partial_json ?? ""); }
        break;
      }
      case "message_delta":
        if (typeof (event.delta as Block | undefined)?.stop_reason === "string") stop = String((event.delta as Block).stop_reason);
        usage = usageOf(event.usage, usage ?? undefined);
        break;
      case "message_stop": ended = true; break;
      case "error": {
        const error = (event.error ?? {}) as Block;
        throw new ChatProtocolError(`Anthropic stream error: ${String(error.type ?? "")} ${String(error.message ?? "")}`.trim());
      }
      default: break;
    }
  }
  request.signal?.throwIfAborted();
  if (!ended && !stop) throw new ChatProtocolError("Stream ended before completion");
  const calls = [...tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => ({ id: tool.id, type: "function" as const, function: { name: tool.name, arguments: tool.args || "{}" } }));
  return finish(text, reasoning, usage, calls, stop);
}
