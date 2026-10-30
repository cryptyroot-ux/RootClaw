import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppConfig } from "../config.ts";
import { PendingOAuth } from "../oauth/oauth.ts";
import { createOAuthRoutes } from "./oauth.ts";
import { PASS, type RouteContext } from "./table.ts";

function call(handler: ReturnType<typeof createOAuthRoutes>, method: string, href: string) {
  const out: { status?: number; body?: unknown; html?: string } = {};
  const res = { writeHead: (status: number) => { out.status = status; return { end: (html: string) => { out.html = html; } }; } } as unknown as ServerResponse;
  const url = new URL(href);
  const ctx = {
    req: { headers: { host: url.host } } as IncomingMessage, res, url, path: url.pathname, method,
    json: ((_res: ServerResponse, status: number, body: unknown) => { out.status = status; out.body = body; }) as RouteContext["json"],
    readBody: (async () => ({})) as unknown as RouteContext["readBody"], auth: {} as RouteContext["auth"],
  } satisfies RouteContext;
  return handler(ctx).then((result) => ({ ...out, result }));
}

describe("official OAuth routes", () => {
  it("runs OpenRouter PKCE end to end and saves the exchanged key", async () => {
    const saved: Array<Partial<AppConfig>> = [];
    const pending = new PendingOAuth();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ key: "sk-or-v1-new" }))) as unknown as typeof fetch;
    const routes = createOAuthRoutes({ config: () => ({}), save: async (patch) => { saved.push(patch); }, pending, fetch: fetchImpl });
    const started = await call(routes, "POST", "http://127.0.0.1:8799/api/oauth/openrouter/start");
    const auth = new URL((started.body as { url: string }).url);
    const callback = new URL(auth.searchParams.get("callback_url")!);
    expect(callback.pathname).toBe("/api/oauth/openrouter/callback");
    callback.searchParams.set("code", "the-code");
    const finished = await call(routes, "GET", callback.href);
    expect(finished.status).toBe(200);
    expect(saved).toEqual([{ openrouter: { key: "sk-or-v1-new" } }]);
    const replay = await call(routes, "GET", callback.href);
    expect(replay.status).toBe(400);
  });

  it("refuses Google sign-in until the person's own client is configured, then stores the refresh token", async () => {
    const config: AppConfig = {};
    const saved: Array<Partial<AppConfig>> = [];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "ya29", refresh_token: "1//r", expires_in: 3600 }))) as unknown as typeof fetch;
    const routes = createOAuthRoutes({ config: () => config, save: async (patch) => { saved.push(patch); }, fetch: fetchImpl });
    expect((await call(routes, "POST", "http://127.0.0.1:8799/api/oauth/google/start")).status).toBe(409);
    config.gemini = { oauth: { clientId: "cid" } };
    const started = await call(routes, "POST", "http://127.0.0.1:8799/api/oauth/google/start");
    const state = new URL((started.body as { url: string }).url).searchParams.get("state")!;
    const finished = await call(routes, "GET", `http://127.0.0.1:8799/api/oauth/google/callback?state=${state}&code=c`);
    expect(finished.status).toBe(200);
    expect(saved[0]).toEqual({ gemini: { oauth: { clientId: "cid", refreshToken: "1//r" } } });
  });

  it("passes on other paths", async () => {
    const routes = createOAuthRoutes({ config: () => ({}), save: async () => {} });
    expect((await call(routes, "GET", "http://127.0.0.1:8799/api/other")).result).toBe(PASS);
  });
});
