// Gemini API adapter: POST {base}/models/{model}:streamGenerateContent?alt=sse (or :generateContent), function calling.
// Auth: an API key (x-goog-api-key) or an OAuth access token (Authorization: Bearer) from Google sign-in.
import type { ChatToolCall } from "../openai-chat-protocol.ts";
import { ChatProtocolError, MalformedToolCallError } from "../openai-chat-protocol.ts";
import { toolFailed } from "./anthropic.ts";
import type { Completion, ModelAdapter, OpenAIChatMessage, Usage } from "../model-adapter.ts";
import { tokenCount } from "../model-adapter.ts";
import { dataUrl, parseJson, postJson, sseEvents, textOf } from "./http.ts";

type Part = Record<string, unknown>;
type Content = { role: "user" | "model"; parts: Part[] };

/** JSON Schema keywords Gemini's function declarations reject. */
const UNSUPPORTED_SCHEMA_KEYS = new Set(["$schema", "$id", "$ref", "$defs", "definitions", "additionalProperties", "default", "examples", "const", "patternProperties", "unevaluatedProperties"]);

export function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    out[key] = key === "properties" && child && typeof child === "object"
      ? Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, geminiSchema(schema)]))
      : geminiSchema(child);
  }
  return out;
}

export function geminiRequest(messages: OpenAIChatMessage[]): { systemInstruction?: { parts: Part[] }; contents: Content[] } {
  const system: string[] = [];
  const contents: Content[] = [];
  const names = new Map<string, string>();
  const push = (role: Content["role"], parts: Part[]) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of messages) {
    if (message.role === "system") { const text = textOf(message.content); if (text) system.push(text); continue; }
    if (message.role === "assistant") {
      const parts: Part[] = [];
      const text = textOf(message.content);
      if (text) parts.push({ text });
      for (const call of message.tool_calls ?? []) {
        names.set(call.id, call.function.name);
        let args: unknown = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
        parts.push({ functionCall: { id: call.id, name: call.function.name, args } });
      }
      push("model", parts);
      continue;
    }
    if (message.role === "tool") {
      const id = message.tool_call_id ?? "";
      // A failed result goes as "error", the field Gemini reads as a failed call (audit N08); a success as "result".
      const content = textOf(message.content);
      push("user", [{ functionResponse: { id, name: names.get(id) ?? "tool", response: toolFailed(content) ? { error: content } : { result: content } } }]);
      continue;
    }
    const parts: Part[] = typeof message.content === "string" || message.content === null ? [{ text: message.content ?? "" }]
      : message.content.map((part) => {
        if (part.type === "text") return { text: part.text };
        const inline = dataUrl(part.image_url.url);
        return inline ? { inlineData: { mimeType: inline.mime, data: inline.data } } : { fileData: { fileUri: part.image_url.url } };
      });
    push("user", parts);
  }
  return { ...(system.length ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } } : {}), contents };
}

export function createGeminiAdapter(options: { url: string; apiKey?: string; accessToken?: () => Promise<string>; projectId?: string; label?: string }): ModelAdapter {
  const label = options.label ?? "Gemini";
  return {
    protocol: "gemini",
    async complete(request): Promise<Completion> {
      const tools = request.tools.length ? [{ functionDeclarations: request.tools.map((tool) => ({
        name: tool.function.name, description: tool.function.description, parameters: geminiSchema(tool.function.parameters),
      })) }] : undefined;
      const auth: Record<string, string> = options.accessToken
        ? { authorization: `Bearer ${await options.accessToken()}`, ...(options.projectId ? { "x-goog-user-project": options.projectId } : {}) }
        : { "x-goog-api-key": options.apiKey ?? "" };
      const model = request.model.replace(/^models\//, "");
      const method = request.stream ? "streamGenerateContent?alt=sse" : "generateContent";
      const response = await postJson(label, `${options.url}/models/${encodeURIComponent(model)}:${method}`, auth,
        { ...geminiRequest(request.messages), ...(tools ? { tools } : {}), ...(request.maxTokens ? { generationConfig: { maxOutputTokens: request.maxTokens } } : {}) }, request.signal);
      const state = { text: "", reasoning: "", usage: null as Usage | null, calls: [] as ChatToolCall[], finish: null as string | null };
      const take = (chunk: Record<string, unknown>) => {
        if (chunk.error) throw new ChatProtocolError(`Gemini error: ${JSON.stringify(chunk.error).slice(0, 300)}`);
        const candidate = (Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined) as Record<string, unknown> | undefined;
        const parts = ((candidate?.content as Record<string, unknown> | undefined)?.parts ?? []) as Part[];
        for (const part of parts) {
          if (typeof part.text === "string") {
            if (part.thought === true) { state.reasoning += part.text; request.onDelta?.(part.text, "reasoning_text"); }
            else { state.text += part.text; request.onDelta?.(part.text, "assistant_text"); }
          } else if (part.functionCall && typeof part.functionCall === "object") {
            const call = part.functionCall as Record<string, unknown>;
            state.calls.push({ id: typeof call.id === "string" && call.id ? call.id : `call_${state.calls.length}_${Date.now().toString(36)}`,
              type: "function", function: { name: String(call.name), arguments: JSON.stringify(call.args ?? {}) } });
          }
        }
        if (typeof candidate?.finishReason === "string") state.finish = candidate.finishReason;
        const meta = chunk.usageMetadata as Record<string, unknown> | undefined;
        if (meta) state.usage = { input: tokenCount(meta.promptTokenCount), output: tokenCount(meta.candidatesTokenCount) + tokenCount(meta.thoughtsTokenCount) };
        if (candidate?.finishReason === "SAFETY" || (chunk.promptFeedback as Record<string, unknown> | undefined)?.blockReason) {
          throw new ChatProtocolError("Gemini blocked this request (safety)");
        }
      };
      if (request.stream) for await (const { data } of sseEvents(response, request.signal)) take(parseJson(data));
      else take(parseJson(await response.text()));
      request.signal?.throwIfAborted();
      // A stream that stops without a finishReason was cut off, however much text came first (audit N07).
      if (!state.finish) throw new ChatProtocolError("Stream ended before completion");
      if (state.calls.length && state.finish === "MAX_TOKENS") throw new MalformedToolCallError("provider tool calls were truncated (MAX_TOKENS)");
      if (state.usage) request.onUsage?.({ model: request.model, input: state.usage.input, output: state.usage.output });
      const finishReason = state.calls.length ? "tool_calls" : state.finish === "STOP" ? "stop" : state.finish === "MAX_TOKENS" ? "length" : state.finish.toLowerCase();
      return { text: state.text, reasoning: state.reasoning, usage: state.usage, toolCalls: state.calls, finishReason, protocolReasoning: "", protocolReasoningDetails: [] };
    },
  };
}
