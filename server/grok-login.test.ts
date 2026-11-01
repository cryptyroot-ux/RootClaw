import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GrokLogin } from "./grok-login.ts";
import { grokSubscriptionStatus, readGrokSignIn, XAI_CLIENT_ID } from "./grok-subscription.ts";
import { createGrokLoginRoutes } from "./routes/grok-login.ts";
import type { RouteContext } from "./routes/table.ts";

const SECRETS = ["device-secret-1", "access-secret-1", "refresh-secret-1"];
type Step = { status?: number; body: Record<string, unknown> };

/** auth.x.ai stand-in: the device code answer, then one scripted answer per token poll. */
function fakeXai(polls: Step[], device: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; form: Record<string, string>; headers: Headers }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(String(init?.body))), headers: new Headers(init?.headers) });
    if (url === "https://auth.x.ai/oauth2/device/code") {
      return Response.json({ device_code: "device-secret-1", user_code: "WDJB-MJHT", verification_uri: "https://accounts.x.ai/device",
        verification_uri_complete: "https://accounts.x.ai/device?user_code=WDJB-MJHT", expires_in: 900, interval: 5, ...device });
    }
    const step = polls.shift() ?? { status: 400, body: { error: "authorization_pending" } };
    return Response.json(step.body, { status: step.status ?? 200 });
  });
  return { fetch, calls };
}
const PENDING = { status: 400, body: { error: "authorization_pending" } };
const SLOW = { status: 400, body: { error: "slow_down" } };
const GRANTED = { body: { access_token: "access-secret-1", refresh_token: "refresh-secret-1", expires_in: 10_800, token_type: "Bearer" } };

let dir = "";
let file = "";
let waits: number[] = [];
const sleep = async (ms: number) => { waits.push(ms); await new Promise((resolve) => setTimeout(resolve, 1)); };
const login = (xai: ReturnType<typeof fakeXai>, onChange = vi.fn()) => new GrokLogin({ fetch: xai.fetch as never, file, sleep, onChange });

function call(handler: ReturnType<typeof createGrokLoginRoutes>, method: string, path: string) {
  const out: { status?: number; body?: unknown } = {};
  const url = new URL(`http://127.0.0.1:8799${path}`);
  const ctx = {
    req: { headers: { host: url.host } } as IncomingMessage, res: {} as ServerResponse, url, path, method,
    json: ((_res: ServerResponse, status: number, body: unknown) => { out.status = status; out.body = body; }) as RouteContext["json"],
    readBody: (async () => ({})) as unknown as RouteContext["readBody"], auth: {} as RouteContext["auth"],
  } satisfies RouteContext;
  return handler(ctx).then(() => out);
}
const settled = (routes: ReturnType<typeof createGrokLoginRoutes>) => vi.waitFor(async () => {
  const { body } = await call(routes, "GET", "/api/oauth/xai/status");
  expect((body as { state: string }).state).not.toBe("pending");
  return body;
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grok-login-"));
  file = join(dir, "xai-subscription.json");
  waits = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("SuperGrok device sign-in (RFC 8628)", () => {
  it("returns only xAI's page, the code and its lifetime, then polls pending → slow_down → signed in", async () => {
    const xai = fakeXai([PENDING, SLOW, GRANTED]);
    const onChange = vi.fn();
    const routes = createGrokLoginRoutes(login(xai, onChange));
    const started = await call(routes, "POST", "/api/oauth/xai/start");
    expect(started).toEqual({ status: 200, body: { url: "https://accounts.x.ai/device?user_code=WDJB-MJHT", code: "WDJB-MJHT", expiresIn: 900 } });
    expect(xai.calls[0]!.form).toEqual({ client_id: XAI_CLIENT_ID, scope: "openid profile email offline_access grok-cli:access api:access" });
    expect(await settled(routes)).toEqual({ state: "signed-in" });
    expect(waits).toEqual([5_000, 5_000, 10_000]);
    expect(xai.calls.slice(1).map((c) => c.form)).toEqual(Array(3).fill({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "device-secret-1", client_id: XAI_CLIENT_ID }));
    expect(readGrokSignIn(file)).toMatchObject({ token: "access-secret-1", refreshToken: "refresh-secret-1" });
    expect(grokSubscriptionStatus(file)).toEqual({ signedIn: true, reconnect: false });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reports a declined and an expired code in safe words and stores nothing", async () => {
    for (const [step, words] of [[{ status: 400, body: { error: "access_denied" } }, /declined/], [{ status: 400, body: { error: "expired_token" } }, /expired/]] as const) {
      const routes = createGrokLoginRoutes(login(fakeXai([PENDING, step])));
      expect((await call(routes, "POST", "/api/oauth/xai/start")).status).toBe(200);
      expect(await settled(routes)).toEqual({ state: "failed", error: expect.stringMatching(words) });
      expect(existsSync(file)).toBe(false);
    }
  });

  it("refuses a verification page that is not xAI's own https sign-in", async () => {
    for (const device of [{ verification_uri: "http://accounts.x.ai/device", verification_uri_complete: undefined },
      { verification_uri: "https://accounts.x.ai.evil.test/device", verification_uri_complete: undefined },
      { verification_uri: "https://evil.test/device", verification_uri_complete: "https://evil.test/device?user_code=WDJB-MJHT" }]) {
      const xai = fakeXai([GRANTED], device);
      const routes = createGrokLoginRoutes(login(xai));
      const started = await call(routes, "POST", "/api/oauth/xai/start");
      expect(started.status).toBe(409);
      expect(JSON.stringify(started.body)).not.toContain("evil");
      expect(xai.calls).toHaveLength(1);
    }
    const fallback = createGrokLoginRoutes(login(fakeXai([], { verification_uri_complete: "https://accounts.x.ai/device?user_code=OTHER" })));
    expect((await call(fallback, "POST", "/api/oauth/xai/start")).body).toMatchObject({ url: "https://accounts.x.ai/device" });
  });

  it("runs one sign-in at a time; cancel stops polling; disconnect deletes the tokens", async () => {
    const xai = fakeXai([]);
    const onChange = vi.fn();
    const routes = createGrokLoginRoutes(login(xai, onChange));
    const [first, second] = await Promise.all([call(routes, "POST", "/api/oauth/xai/start"), call(routes, "POST", "/api/oauth/xai/start")]);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(xai.calls.filter((c) => c.url.endsWith("/device/code"))).toHaveLength(1);
    expect((await call(routes, "POST", "/api/oauth/xai/cancel")).body).toEqual({ state: "failed", error: "SuperGrok sign-in cancelled." });
    const polls = xai.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(xai.calls.length).toBeLessThanOrEqual(polls + 1);
    const again = createGrokLoginRoutes(login(fakeXai([GRANTED]), onChange));
    await call(again, "POST", "/api/oauth/xai/start");
    await settled(again);
    expect(existsSync(file)).toBe(true);
    expect((await call(again, "POST", "/api/oauth/xai/disconnect")).status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect(grokSubscriptionStatus(file)).toEqual({ signedIn: false, reconnect: false });
    expect((await call(again, "GET", "/api/oauth/xai/start")).status).toBe(405);
  });

  it("never logs or returns a token or the device code, and sends no Grok CLI headers", async () => {
    const written: string[] = [];
    const capture = (...args: unknown[]) => { written.push(args.map(String).join(" ")); };
    const spies = [vi.spyOn(console, "log").mockImplementation(capture), vi.spyOn(console, "info").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture), vi.spyOn(console, "error").mockImplementation(capture),
      vi.spyOn(console, "debug").mockImplementation(capture)];
    try {
      const xai = fakeXai([PENDING, { status: 500, body: { error: "server_error", error_description: "device-secret-1" } }, GRANTED]);
      const routes = createGrokLoginRoutes(login(xai));
      const bodies = [await call(routes, "POST", "/api/oauth/xai/start"), await call(routes, "GET", "/api/oauth/xai/status"), { body: await settled(routes) },
        await call(routes, "GET", "/api/oauth/xai/status"), { body: grokSubscriptionStatus(file) }, await call(routes, "POST", "/api/oauth/xai/disconnect")];
      const out = JSON.stringify(bodies) + written.join("\n");
      for (const secret of SECRETS) expect(out).not.toContain(secret);
      for (const { headers } of xai.calls) {
        expect(headers.has("x-xai-token-auth")).toBe(false);
        expect([...headers.values()].join(" ")).not.toContain("xai-grok-cli");
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
