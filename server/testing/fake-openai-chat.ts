// A stand-in OpenAI-compatible chat server for verification fixtures: GET /v1/models and a streaming
// POST /v1/chat/completions. It answers "Fixture reply: <last user text>" in a few chunks, and when the last
// user text names a tool as `CALL_TOOL <name> <json args>` it asks for that tool once, then answers after
// the tool result. Every request body is kept, so a test can read what the native engine sent.
import { createServer, type Server } from "node:http";

export interface FakeOpenAiChat {
  url: string;
  requests: Array<Record<string, unknown>>;
  stop(): Promise<void>;
}

export const FAKE_OPENAI_MODEL = "fixture-model";

type Message = { role?: string; content?: unknown };
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => (part as { text?: unknown })?.text).filter((text) => typeof text === "string").join("") : "";

export async function startFakeOpenAiChat(): Promise<FakeOpenAiChat> {
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: FAKE_OPENAI_MODEL, object: "model", context_length: 128_000 }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* an empty body answers like an empty chat */ }
    requests.push(body);
    const messages = (Array.isArray(body.messages) ? body.messages : []) as Message[];
    const last = messages.at(-1);
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    // The engine prefixes context to a user turn; the person's words are its last line.
    const userText = textOf(lastUser?.content).trim().split("\n").at(-1)?.trim() ?? "";
    const call = last?.role === "user" ? /CALL_TOOL\s+(\S+)(?:\s+(\{.*\}))?/s.exec(userText) : null;
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: FAKE_OPENAI_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (body.stream !== true) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "fixture", object: "chat.completion", model: FAKE_OPENAI_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: `Fixture reply: ${userText}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (call) {
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: call[1], arguments: call[2] ?? "{}" } }] }));
      res.write(chunk({}, "tool_calls"));
    } else {
      const reply = last?.role === "tool" ? `Fixture reply: tool finished` : `Fixture reply: ${userText}`;
      for (const piece of reply.match(/.{1,12}/gs) ?? [reply]) res.write(chunk({ content: piece }));
      res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake OpenAI chat server has no port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
