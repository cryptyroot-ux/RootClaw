// A reused keep-alive socket that the server (or a proxy in front of it) already dropped must not fail a request,
// cost a backoff wait, or use up the transport retry budget. The local server below resets any reused socket that
// sat idle, the way a proxy with a short idle timeout and no Keep-Alive hint does.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

process.env.ROOTCLAW_RETRY_SCALE ??= "0.001";

import { recordEvents } from "../testing/events.ts";
import { postJson } from "./adapters/http.ts";
import { fetchFresh, isStaleSocketError } from "./http-client.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const IDLE_MS = 150;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function staleServer() {
  const lastUse = new WeakMap<Socket, number>();
  const stats = { resets: 0, served: 0 };
  const server: Server = createServer((request, response) => {
    const last = lastUse.get(request.socket);
    if (last !== undefined && Date.now() - last > IDLE_MS) { stats.resets++; request.socket.resetAndDestroy(); return; }
    let body = "";
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      stats.served++;
      response.on("finish", () => lastUse.set(request.socket, Date.now()));
      if (request.url?.endsWith("/models")) { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
      if (JSON.parse(body || "{}").stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      } else { response.setHeader("content-type", "application/json"); response.end('{"ok":true}'); }
    });
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, stats };
}

describe("stale keep-alive sockets", () => {
  it("adapters' postJson recovers on a fresh connection, at once", async () => {
    const { origin, stats } = await staleServer();
    expect((await postJson("fixture", `${origin}/v1/x`, {}, {})).status).toBe(200);
    await sleep(IDLE_MS * 3);
    const started = Date.now();
    expect((await postJson("fixture", `${origin}/v1/x`, {}, {})).status).toBe(200);
    expect(stats.resets).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a native turn after idle neither fails nor spends a backoff retry", async () => {
    const { origin, stats } = await staleServer();
    const instance = await OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "stale", enabled: true,
      config: { url: `${origin}/v1`, apiKeyEnv: "FIXTURE_STALE_KEY" }, environment: { FIXTURE_STALE_KEY: "fixture-stale-credential-9d1e" } });
    const recorder = recordEvents(instance.adapter);
    cleanups.push(async () => { recorder.stop(); await instance.dispose(); });
    const turn = async () => {
      const { turnId } = await instance.adapter.sendTurn({ threadId: randomUUID(), text: "hi", model: "m" });
      return recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    };
    expect(await turn()).toMatchObject({ ok: true });
    await sleep(IDLE_MS * 3);
    expect(await turn()).toMatchObject({ ok: true });
    expect(stats.resets).toBeGreaterThanOrEqual(1);
    expect(recorder.events.filter((event) => event.type === "turn.retrying")).toHaveLength(0);
  });

  it("never resends to an origin that never answered, or for other failures or an aborted call", async () => {
    let resets = 0;
    const server = createServer((request) => { resets++; request.socket.resetAndDestroy(); });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    await expect(fetchFresh(url, { method: "POST", body: "{}" })).rejects.toThrow("fetch failed");
    expect(resets).toBe(1);
    const aborted = new AbortController();
    const failing = async () => { aborted.abort(); throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); };
    let calls = 0;
    await expect(fetchFresh("http://127.0.0.1:9/never", { method: "POST", body: "{}", signal: aborted.signal }, async () => { calls++; return failing(); })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(isStaleSocketError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }))).toBe(false);
    expect(isStaleSocketError(new Error("HTTP 500"))).toBe(false);
  });

  it("resends once only: a second reset on the fresh connection surfaces", async () => {
    let served = 0;
    let resets = 0;
    const server = createServer((request, response) => {
      if (served++ === 0) { response.end("ok"); return; }
      resets++;
      request.socket.resetAndDestroy();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    expect((await fetchFresh(url, { method: "POST", body: "{}" })).status).toBe(200);
    await expect(fetchFresh(url, { method: "POST", body: "{}" })).rejects.toThrow("fetch failed");
    expect(resets).toBe(2);
  });
});
