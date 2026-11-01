// A key that changes mid-turn (a renewed sign-in) is redacted from what the model echoes, not only the turn's first key.
import { describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

describe("per-request key redaction", () => {
  it("redacts the exact key each request sent when the key changes between reads", async () => {
    const sentKeys: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("authorization")!.replace("Bearer ", "");
      sentKeys.push(key);
      const chunk = { choices: [{ delta: { content: `echo ${key} done` }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }));
    let reads = 0;
    const runtime = createOpenAIChatRuntime({
      input: { instanceId: "rekey", displayName: "Rekey", enabled: true, config: {}, environment: {} },
      driverKind: "rekey", get apiKey() { return `mellowpuddle${++reads}x`; }, apiUrl: "https://rekey.invalid/v1",
      models: () => ({ default: "m", options: [{ id: "m", label: "m" }] }),
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Rekey", missingKeyError: "no key", unavailableReason: "no key", timeoutMs: 10_000, includeUsageInCompleted: true,
      nativeLog: { source: "rekey", outgoing: () => ({}), incoming: () => ({}) },
    });
    const events: RuntimeEvent[] = [];
    runtime.adapter.onEvent((event) => events.push(event));
    await runtime.adapter.sendTurn({ threadId: "t", text: "hi", cwd: undefined });
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn.completed")).toBe(true));
    await runtime.dispose();
    vi.unstubAllGlobals();
    expect(sentKeys).toHaveLength(1);
    const text = events.filter((e) => e.type === "content.delta").map((e) => e.type === "content.delta" ? e.delta : "").join("");
    expect(text).toBe("echo [redacted] done");
    expect(JSON.stringify(events)).not.toContain(sentKeys[0]);
  });
});
