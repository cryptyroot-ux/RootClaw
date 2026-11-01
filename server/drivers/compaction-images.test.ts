// Cut 04 AC-6: compaction folds old screenshots into text and keeps the tail's and the request's images.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { OpenAIChatMessage } from "./openai-chat.ts";
import { compactTurnMessages } from "./turn-context.ts";

const b64 = readFileSync(join(import.meta.dirname, "../../evals/fixtures/multimodal/rootclaw-04.png")).toString("base64");
const image = { type: "image_url" as const, image_url: { url: `data:image/png;base64,${b64}` } };
const imageCount = (messages: readonly OpenAIChatMessage[]) =>
  messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((part) => part.type === "image_url").length : 0), 0);

function screenshotTurn(rounds: number) {
  const request: OpenAIChatMessage = { role: "user", content: [{ type: "text", text: "Check the page" }, image] };
  const messages: OpenAIChatMessage[] = [{ role: "system", content: "sys" }, request];
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "computer_screenshot", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: `Screenshot captured ${i}` });
    messages.push({ role: "user", content: [{ type: "text", text: `Screenshot result from tool call c${i}:` }, image] });
  }
  return { messages, request };
}

test("compaction keeps exactly the tail's and the request's images and summarizes the rest as an image count", async () => {
  const { messages, request } = screenshotTurn(5);
  const prompts: string[] = [];
  const result = (await compactTurnMessages(messages, request, {
    keepExchanges: 2, summaryBudgetBytes: 50_000, protocol: "anthropic-messages",
    summarize: async (prompt) => { prompts.push(prompt); return "Took screenshots of the page."; },
  }))!;
  const next = result.messages;
  expect(next[2]).toBe(request);
  const tail = next.slice(3);
  expect(imageCount(next)).toBe(imageCount(tail) + 1);
  expect(imageCount(tail)).toBe(2);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("[1 image(s)]");
  expect(prompts[0]).not.toContain(b64.slice(0, 64));
  for (const [index, message] of next.entries()) {
    if (message.role !== "user" || !Array.isArray(message.content) || message === request) continue;
    const label = message.content[0]!;
    const id = label.type === "text" ? /^Screenshot result from tool call (\S+):$/.exec(label.text)?.[1] : undefined;
    expect(id).toBeDefined();
    expect(next[index - 1]).toMatchObject({ role: "tool", tool_call_id: id });
  }
});
