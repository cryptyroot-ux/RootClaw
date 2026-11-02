// The API driver rides fetch, so the fake is a stubbed globalThis.fetch scripting HTTP failures and SSE bodies.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { disconnectGrok, grokStoreFile, grokSubscriptionStatus } from "../grok-subscription.ts";
import { forgetKey } from "../key-rejections.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { GrokDriver } from "./grok.ts";

const SSE_BODY = (text: string) =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "data: [DONE]",
    "",
  ].join("\n");

const FIXTURE = join(import.meta.dirname, "../../evals/fixtures/multimodal/rootclaw-04.png");

const sseResponse = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

describe("GrokDriver turns (fake fetch)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let previousFetch: typeof globalThis.fetch;
  /** Script of responses/errors consumed in order; empty = succeed with text. */
  let script: Array<{ status?: number; sse?: string }> = [];
  let calls = 0;
  let requestedModels: string[] = [];

  const create = async () => {
    instance = await GrokDriver.create({
      instanceId: "grok-test",
      displayName: "Grok Test",
      environment: { XAI_API_KEY: "xai-fake" },
      enabled: true,
      config: { url: "https://fake.xai.invalid/v1", apiKeyEnv: "XAI_API_KEY" },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    process.env.FAKE_GROK_RETRY_SCALE = "0.001";
    previousFetch = globalThis.fetch;
    calls = 0;
    requestedModels = [];
    globalThis.fetch = (async (_url, init) => {
      requestedModels.push((JSON.parse(String(init?.body)) as { model: string }).model);
      const step = script.shift();
      calls++;
      if (!step || step.sse !== undefined) return sseResponse(step?.sse ?? SSE_BODY("done from fake grok"));
      return new Response(`HTTP ${step.status} body`, { status: step.status });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = previousFetch;
    delete process.env.FAKE_GROK_RETRY_SCALE;
    recorder?.stop();
    await instance?.dispose();
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    script = [];
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.map((e) => e.type)).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "grok")).toBe(true);
    expect(recorder.events.find((e) => e.type === "item.completed")).toMatchObject({
      itemType: "assistant_text",
      text: "done from fake grok",
    });
  });

  it("records the resolved default model in native diagnostics", async () => {
    script = [];
    await create();
    const threadId = "t-default-model-log";
    await instance.adapter.sendTurn({ threadId, text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");

    const entries = readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { dir: string; msg: { model?: string } });
    expect(entries.find((entry) => entry.dir === "out")?.msg.model).toBe("grok-4.7");
    expect(requestedModels).toEqual(["grok-4.7"]);
    expect(instance.models.options).toContainEqual({ id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 });
  });

  it("smoke: offers ask_user and returns the person's reply verbatim", async () => {
    const askBody = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"ask1","type":"function","function":{"name":"ask_user","arguments":'
      + JSON.stringify(JSON.stringify({ questions: [{ question: "Ship the fixture?", options: [{ label: "Yes" }, { label: "No" }] }] }))
      + '}}]}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    const bodies: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      calls++;
      bodies.push(String(init?.body));
      return sseResponse(bodies.length === 1 ? askBody : SSE_BODY("done from fake grok"));
    }) as typeof fetch;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-ask", text: "go" });
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "question", tool: "ask_user", choices: ["Yes", "No"] });
    const reply = "The user answered your questions.\n\nQ: Ship the fixture?\nA: Yes";
    expect(await instance.adapter.respondToRequest("t-ask", opened.requestId!, { behavior: "answer", message: reply })).toBe("answered");
    const completed = await recorder.until((event) => event.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true });
    expect(bodies[0]).toContain('"ask_user"');
    expect(JSON.parse(JSON.parse(bodies[1]!).messages.at(-1).content).result).toBe(reply);
  }, 20_000);

  it("auto-retries transient 429/5xx responses, then completes once", async () => {
    script = [{ status: 429 }, { status: 503 }];
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-retry", text: "go" });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);

    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0)).toBe(true);
    expect(retries.map((e) => e.reason)).toEqual(["rate_limited", "server_error"]);
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(1);
    expect(calls).toBe(3);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, turnId });
  }, 20_000);

  it("stops at the attempt cap and settles as failed", async () => {
    script = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cap", text: "go" });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);

    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2, 3]);
    expect(calls).toBe(4);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  }, 20_000);

  it("never retries a terminal auth or invalid-request failure", async () => {
    script = [{ status: 401 }];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "go" });
    await recorder.until((e) => e.threadId === "t-auth" && e.type === "turn.completed" && e.ok === false);

    expect(recorder.events.filter((e) => e.threadId === "t-auth" && e.type === "turn.retrying")).toHaveLength(0);
    expect(calls).toBe(1);

    script = [{ status: 400 }];
    await instance.adapter.sendTurn({ threadId: "t-badreq", text: "go" });
    await recorder.until((e) => e.threadId === "t-badreq" && e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.filter((e) => e.type === "turn.retrying" && e.threadId === "t-badreq")).toHaveLength(0);
  }, 20_000);

  it("never retries after assistant text already streamed (duplicate-text hazard)", async () => {
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "half an answer" } }] })}\n\n`));
        setTimeout(() => controller.error(new Error("connection reset by peer")), 10);
      },
    });
    globalThis.fetch = (async () => {
      calls++;
      return new Response(failingStream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-partial", text: "go" });
    await recorder.until((e) => e.threadId === "t-partial" && e.type === "turn.completed" && e.ok === false);

    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.filter((e) => e.threadId === "t-partial" && e.type === "turn.retrying")).toHaveLength(0);
    expect(calls).toBe(1);
  }, 20_000);

  it("an interrupt during the retry backoff cancels cleanly without another attempt", async () => {
    script = [{ status: 503 }];
    process.env.FAKE_GROK_RETRY_SCALE = "60"; // long backoff — we cancel inside it
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel-backoff", text: "go" });
    await recorder.until((e) => e.type === "turn.retrying");

    await instance.adapter.interruptTurn("t-cancel-backoff");
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(calls).toBe(1);
    expect(recorder.events.at(-1)).toMatchObject({
      type: "turn.completed",
      ok: false,
      stopReason: "interrupted",
    });
  }, 20_000);

  it("declares no interactive channels this engine cannot honor", async () => {
    script = [];
    await create();
    await expect(instance.adapter.respondToRequest("t-x", "r", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("can drive a desktop: computer, local computer and browser tools, unless tools are off", async () => {
    await create();
    expect(instance.adapter.capabilities).toMatchObject({ computerMcp: true, localComputerMcp: true, browserMcp: true, nativeImageInput: true });
    await instance.dispose();
    instance = await GrokDriver.create({
      instanceId: "grok-tools-off", displayName: "Grok Off", environment: { XAI_API_KEY: "xai-fake" }, enabled: true,
      config: { url: "https://fake.xai.invalid/v1", apiKeyEnv: "XAI_API_KEY", tools: false },
    });
    expect(instance.adapter.capabilities).toMatchObject({ computerMcp: false, localComputerMcp: false, browserMcp: false });
  });

  it("sends an attached image to grok-4.7 as an image part", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(String(init?.body));
      return sseResponse(SSE_BODY("done from fake grok"));
    }) as typeof fetch;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-image", text: "What does the image say?", model: "grok-4.7", approvalMode: "full",
      cwd: mkdtempSync(join(tmpdir(), "rootclaw-grok-")), images: [{ path: FIXTURE, mime: "image/png", bytes: readFileSync(FIXTURE).length }] });
    await recorder.until((e) => e.type === "turn.completed");
    const content = (JSON.parse(bodies[0]!) as { messages: Array<{ content: unknown }> }).messages.at(-1)!.content as Array<{ type: string; image_url?: { url: string } }>;
    expect(content.filter((part) => part.type === "image_url")).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(FIXTURE).toString("base64")}` } }]);
  });
});

it("grok preserves an explicit tools-off connection and rejects ambiguous flags", () => {
  expect(GrokDriver.decodeConfig({})).not.toHaveProperty("tools");
  expect(GrokDriver.decodeConfig({ tools: false })).toMatchObject({ tools: false });
  expect(GrokDriver.decodeConfig({ tools: true })).toMatchObject({ tools: true });
  expect(() => GrokDriver.decodeConfig({ tools: "false" })).toThrow("tools must be a boolean");
});

describe("GrokDriver server key", () => {
  const previousKey = process.env.XAI_API_KEY;
  let previousFetch: typeof globalThis.fetch;
  let authorizations: string[] = [];
  beforeEach(() => {
    process.env.XAI_API_KEY = "xai-server-secret";
    previousFetch = globalThis.fetch;
    authorizations = [];
    globalThis.fetch = (async (_url, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return sseResponse(SSE_BODY("ok"));
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = previousKey;
  });
  const turn = async (config: Record<string, unknown>, environment: Record<string, string> = {}) => {
    const instance = await GrokDriver.create({ instanceId: "grok-key", displayName: "Grok Key", environment, enabled: true, config: GrokDriver.decodeConfig(config) });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: `t-key-${Math.random()}`, text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    await instance.dispose();
  };

  it("never sends the server's XAI_API_KEY to a custom URL", async () => {
    await expect(turn({ url: "https://proxy.example.invalid/v1" })).rejects.toThrow(/Save an xAI API key/);
    expect(authorizations).toEqual([]);
  });

  it("sends it to xAI, and a custom URL gets the workspace key", async () => {
    await turn({});
    await turn({ url: "https://proxy.example.invalid/v1" }, { XAI_API_KEY: "xai-workspace" });
    expect(authorizations).toEqual(["Bearer xai-server-secret", "Bearer xai-workspace"]);
  });
});

describe("GrokDriver SuperGrok sign-in", () => {
  let previousFetch: typeof globalThis.fetch;
  let sent: Headers[] = [];
  let tokenCalls: Record<string, string>[] = [];
  let chat: (authorization: string) => Response = () => sseResponse(SSE_BODY("ok"));
  let renewal: () => Response = () => Response.json({ access_token: "supergrok-token-b", refresh_token: "refresh-b", expires_in: 10_800 });
  const authorizations = () => sent.map((headers) => headers.get("authorization") ?? "");
  const signIn = (token: string, expiresInMs: number, refreshToken: string | null = null) => writeFileSync(grokStoreFile(), JSON.stringify({
    access_token: token, refresh_token: refreshToken, expires_at: new Date(Date.now() + expiresInMs).toISOString(),
  }), { mode: 0o600 });
  const storedRefresh = () => (JSON.parse(readFileSync(grokStoreFile(), "utf8")) as { refresh_token?: string }).refresh_token;
  beforeEach(() => {
    ensureDirs();
    previousFetch = globalThis.fetch;
    sent = [];
    tokenCalls = [];
    chat = () => sseResponse(SSE_BODY("ok"));
    renewal = () => Response.json({ access_token: "supergrok-token-b", refresh_token: "refresh-b", expires_in: 10_800 });
    globalThis.fetch = (async (url, init) => {
      if (String(url) === "https://auth.x.ai/oauth2/token") {
        tokenCalls.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
        return renewal();
      }
      const headers = new Headers(init?.headers);
      sent.push(headers);
      return chat(headers.get("authorization") ?? "");
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    disconnectGrok();
    for (const key of ["supergrok-token-a", "supergrok-token-b", "xai-fallback"]) forgetKey(key);
  });
  const turn = async (config: Record<string, unknown> = {}, environment: Record<string, string> = { XAI_API_KEY: "xai-fallback" }) => {
    const threadId = `t-sub-${Math.random()}`;
    const instance = await GrokDriver.create({ instanceId: "grok-sub", displayName: "Grok Sub", environment, enabled: true, config: GrokDriver.decodeConfig(config) });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId, text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    await instance.dispose();
    return threadId;
  };
  const refusing = (status: number, body: string) => (authorization: string) =>
    authorization === "Bearer supergrok-token-a" ? new Response(body, { status }) : sseResponse(SSE_BODY("ok"));

  it("sends RootClaw's stored sign-in as a bare Bearer to xAI, with no Grok CLI headers and no token in the log", async () => {
    signIn("supergrok-token-a", 3 * 3_600_000);
    const threadId = await turn();
    expect(authorizations()).toEqual(["Bearer supergrok-token-a"]);
    for (const headers of sent) {
      expect(headers.has("x-xai-token-auth")).toBe(false);
      expect([...headers.values()].join(" ")).not.toContain("xai-grok-cli");
    }
    expect(readFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "utf8")).not.toContain("supergrok-token-a");
  });

  it("a 401 on the sign-in renews it once and stays signed in: refresh token kept, no reconnect, the new token next", async () => {
    signIn("supergrok-token-a", 3 * 3_600_000, "refresh-a");
    chat = refusing(401, JSON.stringify({ error: "unauthorized" }));
    await turn();
    await vi.waitFor(() => expect(storedRefresh()).toBe("refresh-b"));
    await turn();
    expect(authorizations()).toEqual(["Bearer supergrok-token-a", "Bearer xai-fallback", "Bearer supergrok-token-b"]);
    expect(tokenCalls).toEqual([expect.objectContaining({ grant_type: "refresh_token", refresh_token: "refresh-a" })]);
    expect(grokSubscriptionStatus()).toEqual({ signedIn: true, reconnect: false });
  });

  it("a 401 whose renewal gets invalid_grant asks to reconnect and uses the API key", async () => {
    signIn("supergrok-token-a", 3 * 3_600_000, "refresh-a");
    chat = refusing(401, JSON.stringify({ error: "unauthorized" }));
    renewal = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await turn();
    await vi.waitFor(() => expect(grokSubscriptionStatus()).toEqual({ signedIn: false, reconnect: true }));
    await turn();
    expect(authorizations()).toEqual(["Bearer supergrok-token-a", "Bearer xai-fallback", "Bearer xai-fallback"]);
    expect(tokenCalls).toHaveLength(1);
  });

  it("a 403 on the sign-in (one model off the tier) resends only that request with the API key; the next turn tries the sign-in again", async () => {
    signIn("supergrok-token-a", 3 * 3_600_000, "refresh-a");
    chat = refusing(403, JSON.stringify({ error: "This model requires a SuperGrok subscription" }));
    await turn();
    await turn();
    expect(authorizations()).toEqual(["Bearer supergrok-token-a", "Bearer xai-fallback", "Bearer supergrok-token-a", "Bearer xai-fallback"]);
    expect(tokenCalls).toEqual([]);
    expect(storedRefresh()).toBe("refresh-a");
    expect(grokSubscriptionStatus()).toEqual({ signedIn: true, reconnect: false });
  });

  it("a 403 on the sign-in sends exactly two requests: the sign-in, then the API key once", async () => {
    signIn("supergrok-token-a", 3 * 3_600_000, "refresh-a");
    chat = () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    await turn();
    expect(authorizations()).toEqual(["Bearer supergrok-token-a", "Bearer xai-fallback"]);
  });

  it("a 403 on the sign-in with no API key fails that turn only; the next turn still sends the sign-in", async () => {
    const serverKey = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    signIn("supergrok-token-a", 3 * 3_600_000, "refresh-a");
    chat = refusing(403, JSON.stringify({ error: "This model requires a SuperGrok subscription" }));
    try {
      await turn({}, {});
      chat = () => sseResponse(SSE_BODY("ok"));
      await turn({}, {});
    } finally {
      if (serverKey !== undefined) process.env.XAI_API_KEY = serverKey;
    }
    expect(authorizations()).toEqual(["Bearer supergrok-token-a", "Bearer supergrok-token-a"]);
    expect(tokenCalls).toEqual([]);
    expect(storedRefresh()).toBe("refresh-a");
    expect(grokSubscriptionStatus()).toEqual({ signedIn: true, reconnect: false });
  });

  it("an API key refused with 403 still fails the turn once, with no retry and no sign-in involved", async () => {
    chat = () => new Response(JSON.stringify({ error: "This model requires a higher tier" }), { status: 403 });
    await turn();
    expect(authorizations()).toEqual(["Bearer xai-fallback"]);
    expect(tokenCalls).toEqual([]);
  });

  it("falls back to the key for an expired sign-in it cannot renew, and never sends the sign-in elsewhere", async () => {
    signIn("supergrok-token-old", -60_000);
    await turn();
    signIn("supergrok-token-b", 3 * 3_600_000);
    await turn({ url: "https://proxy.example.invalid/v1" });
    expect(authorizations()).toEqual(["Bearer xai-fallback", "Bearer xai-fallback"]);
  });
});
