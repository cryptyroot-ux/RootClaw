// Handwritten wire fixtures per adapter: streaming text, tool calls, usage, and errors mapped into failover.
import { afterEach, describe, expect, it, vi } from "vitest";

import { RequestTooLargeError } from "../chat-size-limit.ts";
import { failoverKind } from "../failover.ts";
import type { ChatToolDefinition } from "../chat-mcp-tools.ts";
import type { ModelAdapter, OpenAIChatMessage } from "../model-adapter.ts";
import { HttpStatusError } from "../retry.ts";
import { anthropicRequest, createAnthropicAdapter } from "./anthropic.ts";
import { createGeminiAdapter, geminiRequest, geminiSchema } from "./gemini.ts";
import { createOpenAIResponsesAdapter, responsesInput } from "./openai-responses.ts";

afterEach(() => vi.unstubAllGlobals());

const sse = (events: Array<[string | null, unknown]>) => new Response(
  events.map(([event, data]) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } });
const err = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stub(response: () => Response) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return response();
  }));
  return calls;
}

const tool: ChatToolDefinition = { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } };
const history: OpenAIChatMessage[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Read a.txt" },
  { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] },
  { role: "tool", tool_call_id: "call_1", content: "hello" },
];

async function run(adapter: ModelAdapter, messages = history, tools = [tool]) {
  const deltas: string[] = [];
  const completion = await adapter.complete({ model: "m", messages, tools, stream: true, onDelta: (d) => deltas.push(d) });
  return { completion, deltas };
}

async function failure(adapter: ModelAdapter) {
  return await adapter.complete({ model: "m", messages: history, tools: [], stream: true }).then(() => null, (e: Error) => e);
}

describe("Anthropic Messages adapter", () => {
  it("translates history: system apart and cached, tool_use and tool_result blocks", () => {
    const request = anthropicRequest(history);
    expect(request.system).toEqual([{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }]);
    expect(request.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(request.messages[1]!.content[0]).toEqual({ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.txt" } });
    expect(request.messages[2]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "call_1", content: "hello" });
  });

  it("streams text, collects a tool call and usage, and sends the API headers", async () => {
    const calls = stub(() => sse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading" } }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"b.txt\"}" } }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } }],
      ["message_stop", { type: "message_stop" }],
    ]));
    const { completion, deltas } = await run(createAnthropicAdapter({ url: "https://api.anthropic.test/v1", apiKey: "sk-ant" }));
    expect(calls[0]!.url).toBe("https://api.anthropic.test/v1/messages");
    expect(calls[0]!.headers).toMatchObject({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
    expect((calls[0]!.body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "read_file", cache_control: { type: "ephemeral" } });
    expect(deltas.join("")).toBe("Reading");
    expect(completion.toolCalls).toEqual([{ id: "toolu_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"b.txt\"}" } }]);
    expect(completion).toMatchObject({ finishReason: "tool_calls", usage: { input: 120, output: 30 } });
  });

  it("maps errors into retry and failover", async () => {
    stub(() => err(429, { type: "error", error: { type: "rate_limit_error", message: "Your credit balance is too low; billing" } }));
    expect(failoverKind(await failure(createAnthropicAdapter({ url: "https://a.test/v1", apiKey: "k" })) as Error, { aborted: false, produced: false })).toBe("quota");
    stub(() => err(400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }));
    expect(await failure(createAnthropicAdapter({ url: "https://a.test/v1", apiKey: "k" }))).toBeInstanceOf(RequestTooLargeError);
    stub(() => err(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    const overloaded = await failure(createAnthropicAdapter({ url: "https://a.test/v1", apiKey: "k" }));
    expect(overloaded).toBeInstanceOf(HttpStatusError);
    expect((overloaded as HttpStatusError).status).toBe(503);
  });
});

describe("Gemini adapter", () => {
  it("translates history and strips schema keywords Gemini rejects", () => {
    const request = geminiRequest(history);
    expect(request.systemInstruction).toEqual({ parts: [{ text: "Be brief." }] });
    expect(request.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(request.contents[1]!.parts[0]).toEqual({ functionCall: { id: "call_1", name: "read_file", args: { path: "a.txt" } } });
    expect(request.contents[2]!.parts[0]).toEqual({ functionResponse: { id: "call_1", name: "read_file", response: { result: "hello" } } });
    expect(geminiSchema(tool.function.parameters)).not.toHaveProperty("additionalProperties");
  });

  it("streams text and a function call over SSE with the API key header", async () => {
    const calls = stub(() => sse([
      [null, { candidates: [{ content: { role: "model", parts: [{ text: "Sure" }] } }] }],
      [null, { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "c.txt" } } }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 7 } }],
    ]));
    const { completion, deltas } = await run(createGeminiAdapter({ url: "https://gl.test/v1beta", apiKey: "AIza" }));
    expect(calls[0]!.url).toBe("https://gl.test/v1beta/models/m:streamGenerateContent?alt=sse");
    expect(calls[0]!.headers).toMatchObject({ "x-goog-api-key": "AIza" });
    expect(deltas.join("")).toBe("Sure");
    expect(completion.toolCalls[0]!.function).toEqual({ name: "read_file", arguments: "{\"path\":\"c.txt\"}" });
    expect(completion).toMatchObject({ finishReason: "tool_calls", usage: { input: 50, output: 7 } });
  });

  it("uses a Bearer token in OAuth mode and maps RESOURCE_EXHAUSTED quota and token-limit errors", async () => {
    const calls = stub(() => err(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota, please check your plan and billing details." } }));
    const quota = await failure(createGeminiAdapter({ url: "https://gl.test/v1beta", accessToken: async () => "ya29.token" }));
    expect(calls[0]!.headers).toMatchObject({ authorization: "Bearer ya29.token" });
    expect(failoverKind(quota as Error, { aborted: false, produced: false })).toBe("quota");
    stub(() => err(400, { error: { code: 400, message: "The input token count (2000000) exceeds the maximum number of tokens allowed (1048576)." } }));
    expect(await failure(createGeminiAdapter({ url: "https://gl.test/v1beta", apiKey: "k" }))).toBeInstanceOf(RequestTooLargeError);
  });
});

describe("OpenAI Responses adapter", () => {
  it("translates history into stateless input items", () => {
    const { instructions, input } = responsesInput(history);
    expect(instructions).toBe("Be brief.");
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Read a.txt" }] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
      { type: "function_call_output", call_id: "call_1", output: "hello" },
    ]);
  });

  it("streams output text and returns function calls and usage from response.completed", async () => {
    const calls = stub(() => sse([
      ["response.output_text.delta", { type: "response.output_text.delta", delta: "Done " }],
      ["response.output_text.delta", { type: "response.output_text.delta", delta: "reading" }],
      ["response.completed", { type: "response.completed", response: { status: "completed", usage: { input_tokens: 40, output_tokens: 9 },
        output: [{ type: "function_call", call_id: "fc_1", name: "read_file", arguments: "{\"path\":\"d.txt\"}" }] } }],
    ]));
    const { completion, deltas } = await run(createOpenAIResponsesAdapter({ url: "https://oa.test/v1", apiKey: "sk" }));
    expect(calls[0]!.url).toBe("https://oa.test/v1/responses");
    expect(calls[0]!.body).toMatchObject({ store: false, stream: true, tools: [{ type: "function", name: "read_file" }] });
    expect(deltas.join("")).toBe("Done reading");
    expect(completion).toMatchObject({ finishReason: "tool_calls", usage: { input: 40, output: 9 }, toolCalls: [{ id: "fc_1" }] });
  });

  it("maps HTTP quota and in-stream context overflow", async () => {
    stub(() => err(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } }));
    expect(failoverKind(await failure(createOpenAIResponsesAdapter({ url: "https://oa.test/v1", apiKey: "k" })) as Error, { aborted: false, produced: false })).toBe("quota");
    stub(() => sse([["response.failed", { type: "response.failed", response: { status: "failed", error: { code: "context_length_exceeded", message: "Your input exceeds the context window" } } }]]));
    expect(await failure(createOpenAIResponsesAdapter({ url: "https://oa.test/v1", apiKey: "k" }))).toBeInstanceOf(RequestTooLargeError);
  });
});
