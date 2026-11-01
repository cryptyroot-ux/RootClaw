import { afterEach, describe, expect, it } from "vitest";
import { MalformedToolCallError } from "../openai-chat-protocol.ts";
import { createAnthropicAdapter } from "./anthropic.ts";
import { createGeminiAdapter, geminiRequest } from "./gemini.ts";
import { sseEvents } from "./http.ts";
import { createOpenAIResponsesAdapter } from "./openai-responses.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const serve = (body: string) => {
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }),
    { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
};
const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const tools = [{ type: "function" as const, function: { name: "write_file", description: "", parameters: { type: "object" } } }];
const request = (withTools = true) => ({ messages: [{ role: "user" as const, content: "hi" }], model: "m", stream: true, tools: withTools ? tools : [] });

describe("truncated tool calls never run (audit N06)", () => {
  it("Anthropic: tool input cut at max_tokens is malformed, even when it parses", async () => {
    serve(sse([{ type: "message_start", message: { usage: {} } }, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "write_file" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.txt\",\"content\":\"VALID\"}" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: {} }, { type: "message_stop" }]));
    await expect(createAnthropicAdapter({ url: "http://x", apiKey: "k" }).complete(request() as never)).rejects.toBeInstanceOf(MalformedToolCallError);
  });
  it("Responses: an incomplete response with a function call is malformed, not tool_calls", async () => {
    serve(sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "function_call", call_id: "c1", name: "write_file", arguments: "{\"path\":\"a" }] } }]));
    await expect(createOpenAIResponsesAdapter({ url: "http://x", apiKey: "k" }).complete(request() as never)).rejects.toBeInstanceOf(MalformedToolCallError);
  });
});

describe("Gemini (audit N07, N08)", () => {
  it("a stream that ends without a finishReason is an error, not a finished answer", async () => {
    serve(sse([{ candidates: [{ content: { parts: [{ text: "Step 1: delete the build folder, then" }] } }] }]));
    await expect(createGeminiAdapter({ url: "http://x", apiKey: "k" }).complete(request(false) as never)).rejects.toThrow(/ended before completion/);
  });
  it("a stream with finishReason STOP still finishes", async () => {
    serve(sse([{ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }] }]));
    expect((await createGeminiAdapter({ url: "http://x", apiKey: "k" }).complete(request(false) as never)).finishReason).toBe("stop");
  });
  it("a failed tool result is sent as an error", () => {
    const messages = [{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "shell", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: JSON.stringify({ ok: false, result: "exit code 1" }) }, { role: "tool", tool_call_id: "t1", content: JSON.stringify({ ok: true, result: "fine" }) }];
    const parts = geminiRequest(messages as never).contents.at(-1)!.parts as Array<{ functionResponse: { response: Record<string, unknown> } }>;
    expect(parts[0]!.functionResponse.response).toHaveProperty("error");
    expect(parts.at(-1)!.functionResponse.response).toHaveProperty("result");
  });
});

describe("server-sent events (audit N09, N10)", () => {
  const collect = async (response: Response) => { const out = []; for await (const event of sseEvents(response)) out.push(event); return out; };
  it("splits lines on a lone CR", async () => {
    expect(await collect(new Response("data: {\"a\":1}\r\rdata: {\"a\":2}\r\r"))).toEqual([{ event: "message", data: "{\"a\":1}" }, { event: "message", data: "{\"a\":2}" }]);
  });
  it("keeps CRLF across chunk boundaries", async () => {
    const body = new ReadableStream({ start(c) { const e = new TextEncoder(); c.enqueue(e.encode("data: 1\r")); c.enqueue(e.encode("\n\r\n")); c.close(); } });
    expect(await collect(new Response(body))).toEqual([{ event: "message", data: "1" }]);
  });
  it("bounds one event made of many small data: lines", async () => {
    const line = `data: ${"x".repeat(100)}\n`;
    const body = new ReadableStream({ start(c) { const e = new TextEncoder(); for (let i = 0; i < 50_000; i++) c.enqueue(e.encode(line)); c.enqueue(e.encode("\n")); c.close(); } });
    await expect(collect(new Response(body))).rejects.toThrow(/size limit/);
  });
});

describe("tool calls without a stop reason never run (audit N06d)", () => {
  const toolStream = (stopDelta: object) => sse([{ type: "message_start", message: { usage: {} } }, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "write_file" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.txt\",\"content\":\"COMPLETE_BUT_NO_STOP_REASON\"}" } },
    { type: "message_delta", delta: stopDelta, usage: { output_tokens: 5 } }, { type: "message_stop" }]);
  it("Anthropic: a stream that ends with message_stop but no stop_reason is malformed, even when the input parses", async () => {
    serve(toolStream({}));
    await expect(createAnthropicAdapter({ url: "http://x", apiKey: "k" }).complete(request() as never)).rejects.toBeInstanceOf(MalformedToolCallError);
  });
  it("Anthropic: the same stream with stop_reason tool_use still runs its call", async () => {
    serve(toolStream({ stop_reason: "tool_use" }));
    const completion = await createAnthropicAdapter({ url: "http://x", apiKey: "k" }).complete(request() as never);
    expect(completion).toMatchObject({ finishReason: "tool_calls", toolCalls: [{ function: { name: "write_file", arguments: "{\"path\":\"a.txt\",\"content\":\"COMPLETE_BUT_NO_STOP_REASON\"}" } }] });
  });
  it("Anthropic: text alone with no stop_reason still finishes", async () => {
    serve(sse([{ type: "message_start", message: { usage: {} } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }, { type: "message_stop" }]));
    expect((await createAnthropicAdapter({ url: "http://x", apiKey: "k" }).complete(request(false) as never)).text).toBe("hi");
  });
});
