// OpenAI Responses API adapter: POST {base}/responses (stream), function tools, `store: false` (stateless: the loop
// resends the whole conversation each round, as with Chat Completions).
import type { ChatToolCall } from "../openai-chat-protocol.ts";
import { ChatProtocolError, MalformedToolCallError } from "../openai-chat-protocol.ts";
import type { Completion, ModelAdapter, OpenAIChatMessage, Usage } from "../model-adapter.ts";
import { tokenCount } from "../model-adapter.ts";
import { HttpStatusError } from "../retry.ts";
import { RequestTooLargeError } from "../chat-size-limit.ts";
import { parseJson, postJson, sseEvents, textOf } from "./http.ts";

type Item = Record<string, unknown>;

export function responsesInput(messages: OpenAIChatMessage[]): { instructions?: string; input: Item[] } {
  const instructions: string[] = [];
  const input: Item[] = [];
  for (const message of messages) {
    if (message.role === "system") { const text = textOf(message.content); if (text) instructions.push(text); continue; }
    if (message.role === "tool") { input.push({ type: "function_call_output", call_id: message.tool_call_id ?? "", output: textOf(message.content) }); continue; }
    if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of message.tool_calls ?? []) input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" });
      continue;
    }
    const content = typeof message.content === "string" || message.content === null ? [{ type: "input_text", text: message.content ?? "" }]
      : message.content.map((part) => (part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: part.image_url.url }));
    input.push({ role: "user", content });
  }
  return { ...(instructions.length ? { instructions: instructions.join("\n\n") } : {}), input };
}

function failed(response: Item | undefined, label: string): Error {
  const error = (response?.error ?? {}) as Item;
  const code = String(error.code ?? ""), message = `${label} ${code}: ${String(error.message ?? "response failed")}`.slice(0, 400);
  if (code === "context_length_exceeded") return new RequestTooLargeError(message, 0);
  if (code === "rate_limit_exceeded") return new HttpStatusError(message, 429);
  if (code === "insufficient_quota") return new HttpStatusError(`${message} (quota)`, 429);
  if (code === "server_error") return new HttpStatusError(message, 500);
  return new ChatProtocolError(message);
}

export function createOpenAIResponsesAdapter(options: { url: string; apiKey: string; label?: string; reasoningSummary?: boolean }): ModelAdapter {
  const label = options.label ?? "OpenAI";
  return {
    protocol: "openai-responses",
    async complete(request): Promise<Completion> {
      const tools = request.tools.map((tool) => ({ type: "function", name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
      const response = await postJson(label, `${options.url}/responses`, { authorization: `Bearer ${options.apiKey}` }, {
        model: request.model, ...responsesInput(request.messages), stream: request.stream, store: false,
        ...(request.maxTokens ? { max_output_tokens: Math.max(16, request.maxTokens) } : {}),
        ...(tools.length ? { tools } : {}), ...(options.reasoningSummary ? { reasoning: { summary: "auto" } } : {}),
      }, request.signal);
      let text = "", reasoning = "", usage: Usage | null = null, status: string | null = null;
      const calls = new Map<string, ChatToolCall>();
      const finalItems = (body: Item) => {
        for (const item of (Array.isArray(body.output) ? body.output : []) as Item[]) {
          if (item.type === "function_call") calls.set(String(item.call_id), { id: String(item.call_id), type: "function", function: { name: String(item.name), arguments: String(item.arguments ?? "{}") } });
        }
        const u = body.usage as Item | undefined;
        if (u) usage = { input: tokenCount(u.input_tokens), output: tokenCount(u.output_tokens) };
        status = typeof body.status === "string" ? body.status : status;
      };
      if (!request.stream) {
        const body = parseJson(await response.text());
        if (body.status === "failed") throw failed(body, label);
        for (const item of (Array.isArray(body.output) ? body.output : []) as Item[]) {
          if (item.type === "message") for (const part of (item.content ?? []) as Item[]) if (part.type === "output_text") text += String(part.text ?? "");
        }
        finalItems(body);
      } else {
        for await (const { data } of sseEvents(response, request.signal)) {
          if (data === "[DONE]") break;
          const event = parseJson(data);
          switch (event.type) {
            case "response.output_text.delta": text += String(event.delta ?? ""); request.onDelta?.(String(event.delta ?? ""), "assistant_text"); break;
            case "response.reasoning_summary_text.delta": reasoning += String(event.delta ?? ""); request.onDelta?.(String(event.delta ?? ""), "reasoning_text"); break;
            case "response.completed": case "response.incomplete": finalItems((event.response ?? {}) as Item); break;
            case "response.failed": throw failed(event.response as Item | undefined, label);
            case "error": throw failed({ error: event }, label);
            default: break;
          }
        }
      }
      request.signal?.throwIfAborted();
      if (!status) throw new ChatProtocolError("Stream ended before completion");
      if (usage) request.onUsage?.({ model: request.model, input: (usage as Usage).input, output: (usage as Usage).output });
      const toolCalls = [...calls.values()];
      // An incomplete response (max_output_tokens…) may carry a cut-short function call: never run it (audit N06).
      if (toolCalls.length && status !== "completed") throw new MalformedToolCallError(`provider tool calls were truncated (${status})`);
      return { text, reasoning, usage, toolCalls, finishReason: toolCalls.length ? "tool_calls" : status === "completed" ? "stop" : "length", protocolReasoning: "", protocolReasoningDetails: [] };
    },
  };
}
