import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { exchangeGoogleCode, exchangeOpenRouterCode, googleAccessToken, googleAuthUrl, openRouterAuthUrl, PendingOAuth, pkcePair } from "./oauth.ts";

const fakeFetch = (handler: (url: string, init: RequestInit) => Response) => vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {})) as unknown as typeof fetch;

describe("PKCE", () => {
  it("derives the S256 challenge from the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("lets each started sign-in be finished once, by its own provider, within ten minutes", () => {
    let now = 0;
    const pending = new PendingOAuth(() => now);
    const { state } = pending.start("openrouter", "http://127.0.0.1:8799/cb");
    expect(pending.take("google", state)).toBeNull();
    const again = pending.start("openrouter", "http://127.0.0.1:8799/cb");
    expect(pending.take("openrouter", again.state)).toMatchObject({ redirectUri: "http://127.0.0.1:8799/cb" });
    expect(pending.take("openrouter", again.state)).toBeNull();
    const late = pending.start("google", "x");
    now += 11 * 60_000;
    expect(pending.take("google", late.state)).toBeNull();
  });
});

describe("OpenRouter PKCE", () => {
  it("builds the auth URL and exchanges the code for a key", async () => {
    const url = new URL(openRouterAuthUrl("http://127.0.0.1:8799/api/oauth/openrouter/callback?state=s", "chal"));
    expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const fetchImpl = fakeFetch((target, init) => {
      expect(target).toBe("https://openrouter.ai/api/v1/auth/keys");
      expect(JSON.parse(String(init.body))).toEqual({ code: "c", code_verifier: "v", code_challenge_method: "S256" });
      return new Response(JSON.stringify({ key: "sk-or-v1-fixture" }));
    });
    expect(await exchangeOpenRouterCode("c", "v", fetchImpl)).toBe("sk-or-v1-fixture");
    await expect(exchangeOpenRouterCode("c", "v", fakeFetch(() => new Response("{}", { status: 403 })))).rejects.toThrow(/HTTP 403/);
  });
});

describe("Google OAuth for Gemini", () => {
  it("asks for offline access with PKCE on the person's own client", () => {
    const url = new URL(googleAuthUrl({ clientId: "id.apps.googleusercontent.com" }, "http://127.0.0.1:8799/api/oauth/google/callback", "st", "ch"));
    expect(url.searchParams.get("client_id")).toBe("id.apps.googleusercontent.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("generative-language");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
  });

  it("exchanges a code for a refresh token and caches renewed access tokens", async () => {
    const exchanged = await exchangeGoogleCode({ clientId: "id", clientSecret: "sec" }, "code", "ver", "http://cb",
      fakeFetch((_u, init) => {
        const form = new URLSearchParams(String(init.body));
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code_verifier")).toBe("ver");
        return new Response(JSON.stringify({ access_token: "ya29.a", refresh_token: "1//r", expires_in: 3600 }));
      }));
    expect(exchanged.refreshToken).toBe("1//r");
    let now = 0, refreshes = 0;
    const token = googleAccessToken({ clientId: "id" }, "1//r", fakeFetch(() => { refreshes++; return new Response(JSON.stringify({ access_token: `ya29.${refreshes}`, expires_in: 3600 })); }), () => now);
    expect(await token()).toBe("ya29.1");
    expect(await token()).toBe("ya29.1");
    now += 3_600_000;
    expect(await token()).toBe("ya29.2");
  });
});
