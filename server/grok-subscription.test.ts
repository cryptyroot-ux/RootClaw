import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  disconnectGrok, ensureGrokSubscriptionFresh, GROK_RENEW_FAILED, grokStoreFile, grokSubscriptionStatus, grokSubscriptionToken,
  readGrokSignIn, renewGrokSignIn, saveGrokSignIn, XAI_CLIENT_ID,
} from "./grok-subscription.ts";

const HOUR = 3_600_000;
let dir = "";
let file = "";
const store = (fields: Record<string, unknown>) => writeFileSync(file, JSON.stringify({
  access_token: "token-1", refresh_token: "refresh-1", expires_at: new Date(Date.now() + 3 * HOUR).toISOString(), ...fields,
}), { mode: 0o600 });
const soon = () => ({ expires_at: new Date(Date.now() + 5 * 60_000).toISOString() });
const stored = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const renewed = (delayMs = 0) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return new Response(JSON.stringify({ access_token: "token-2", refresh_token: "refresh-2", expires_in: 10_800, token_type: "Bearer" }), { status: 200 });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grok-sub-"));
  file = join(dir, "xai-subscription.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("RootClaw's own SuperGrok store", () => {
  it("lives in RootClaw's private data dir, not the Grok CLI's", () => {
    expect(grokStoreFile().startsWith(DATA_DIR)).toBe(true);
    expect(grokStoreFile()).not.toContain(".grok");
  });

  it("saves a sign-in atomically, private to the owner, and serves it while valid", () => {
    expect(grokSubscriptionStatus(file)).toEqual({ signedIn: false, reconnect: false });
    saveGrokSignIn(file, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 10_800 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["xai-subscription.json"]);
    expect(readGrokSignIn(file)).toMatchObject({ token: "token-1", refreshToken: "refresh-1" });
    expect(grokSubscriptionStatus(file)).toEqual({ signedIn: true, reconnect: false });
    expect(grokSubscriptionToken({ file })).toBe("token-1");
    store({ access_token: "token-old", refresh_token: null, expires_at: new Date(Date.now() - 1_000).toISOString() });
    expect(grokSubscriptionToken({ file })).toBe("");
  });

  it("disconnect deletes the stored tokens", () => {
    store({});
    disconnectGrok(file);
    expect(existsSync(file)).toBe(false);
    expect(grokSubscriptionStatus(file)).toEqual({ signedIn: false, reconnect: false });
    expect(() => disconnectGrok(file)).not.toThrow();
  });

  it("the status never carries a token", () => {
    store({});
    expect(JSON.stringify(grokSubscriptionStatus(file))).not.toMatch(/token-1|refresh-1/);
  });
});

describe("renewing the sign-in", () => {
  it("leaves a token with time left alone", async () => {
    store({});
    const fetch = renewed();
    expect(await renewGrokSignIn(file, fetch as never)).toMatchObject({ token: "token-1" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renews with RootClaw's one client id, bare form, no Grok CLI headers, and writes back 0600 atomically", async () => {
    store(soon());
    const fetch = renewed();
    expect(await renewGrokSignIn(file, fetch as never)).toMatchObject({ token: "token-2", refreshToken: "refresh-2" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://auth.x.ai/oauth2/token");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: XAI_CLIENT_ID });
    const headers = new Headers(init?.headers);
    expect(headers.has("x-xai-token-auth")).toBe(false);
    expect([...headers.values()].join(" ")).not.toContain("xai-grok-cli");
    expect(stored()).toMatchObject({ access_token: "token-2", refresh_token: "refresh-2" });
    expect(Date.parse(String(stored().expires_at)) - Date.now()).toBeGreaterThan(2.9 * HOUR);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["xai-subscription.json"]);
  });

  it("two refreshes at once make exactly one token call and both get the new token", async () => {
    store(soon());
    const fetch = renewed(50);
    const both = await Promise.all([ensureGrokSubscriptionFresh({ file, fetch: fetch as never }), ensureGrokSubscriptionFresh({ file, fetch: fetch as never })]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(both).toEqual(["token-2", "token-2"]);
    expect(stored().refresh_token).toBe("refresh-2");
  });

  it("a token xAI refused renews once even with time left, keeping the sign-in; a token already replaced is left alone", async () => {
    store({});
    const fetch = renewed(30);
    const both = await Promise.all([renewGrokSignIn(file, fetch as never, "token-1"), renewGrokSignIn(file, fetch as never, "token-1")]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(both.map((signIn) => signIn?.token)).toEqual(["token-2", "token-2"]);
    expect(await renewGrokSignIn(file, fetch as never, "token-1")).toMatchObject({ token: "token-2", refreshToken: "refresh-2" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(grokSubscriptionStatus(file)).toEqual({ signedIn: true, reconnect: false });
  });

  it("waits on another process's lock and skips the call once that one renewed", async () => {
    store(soon());
    writeFileSync(`${file}.lock`, "");
    setTimeout(() => { store({ access_token: "token-other", refresh_token: "refresh-other" }); rmSync(`${file}.lock`); }, 150);
    const fetch = renewed();
    expect(await renewGrokSignIn(file, fetch as never)).toMatchObject({ token: "token-other" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("takes over a stale lock", async () => {
    store(soon());
    writeFileSync(`${file}.lock`, "");
    utimesSync(`${file}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(await renewGrokSignIn(file, renewed() as never)).toMatchObject({ token: "token-2" });
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("keeps a sign-in that changed during the call", async () => {
    store(soon());
    const fetch = vi.fn(async () => {
      store({ access_token: "token-new-login", refresh_token: "refresh-new-login" });
      return new Response(JSON.stringify({ access_token: "token-2", refresh_token: "refresh-2", expires_in: 10_800 }), { status: 200 });
    });
    expect(await renewGrokSignIn(file, fetch as never)).toMatchObject({ token: "token-new-login" });
    expect(stored()).toMatchObject({ access_token: "token-new-login", refresh_token: "refresh-new-login" });
  });

  it("invalid_grant signs out into the reconnect state; other refusals throw only a safe message", async () => {
    store(soon());
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh-1 revoked" }), { status: 400 }));
    expect(await renewGrokSignIn(file, refused as never)).toBeNull();
    expect(grokSubscriptionStatus(file)).toEqual({ signedIn: false, reconnect: true });
    store(soon());
    const down = vi.fn(async () => new Response("upstream refresh-1 oops", { status: 503 }));
    await expect(renewGrokSignIn(file, down as never)).rejects.toThrow(GROK_RENEW_FAILED);
    await renewGrokSignIn(file, down as never).catch((error: Error) => expect(error.message).not.toContain("refresh-1"));
    expect(stored().access_token).toBe("token-1");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("a token near its end is still served while it renews in the background", async () => {
    store(soon());
    const fetch = renewed(20);
    expect(grokSubscriptionToken({ file, fetch: fetch as never })).toBe("token-1");
    await vi.waitFor(() => expect(stored().access_token).toBe("token-2"));
    expect(grokSubscriptionToken({ file, fetch: fetch as never })).toBe("token-2");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
