// Official OAuth only: OpenRouter's PKCE key exchange, and Google's OAuth for the Gemini API with a client the person
// registers themselves. No subscription sign-in (Claude Pro/Max, ChatGPT/Codex) is offered or accepted.
import { createHash, randomBytes } from "node:crypto";

export type OAuthProvider = "openrouter" | "google";
type Fetch = typeof fetch;

const base64url = (bytes: Buffer) => bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

const PENDING_MS = 10 * 60_000;

/** Started sign-ins by `state`, each usable once and for ten minutes. */
export class PendingOAuth {
  private readonly rows = new Map<string, { provider: OAuthProvider; verifier: string; redirectUri: string; at: number }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  /** `redirectUri` may name the state itself (OpenRouter returns only `code` to its callback URL). */
  start(provider: OAuthProvider, redirectUri: string | ((state: string) => string)): { state: string; challenge: string; redirectUri: string } {
    for (const [state, row] of this.rows) if (this.now() - row.at > PENDING_MS) this.rows.delete(state);
    const { verifier, challenge } = pkcePair();
    const state = base64url(randomBytes(24));
    const uri = typeof redirectUri === "string" ? redirectUri : redirectUri(state);
    this.rows.set(state, { provider, verifier, redirectUri: uri, at: this.now() });
    return { state, challenge, redirectUri: uri };
  }

  take(provider: OAuthProvider, state: string | null): { verifier: string; redirectUri: string } | null {
    if (!state) return null;
    const row = this.rows.get(state);
    this.rows.delete(state);
    if (!row || row.provider !== provider || this.now() - row.at > PENDING_MS) return null;
    return { verifier: row.verifier, redirectUri: row.redirectUri };
  }
}

// ---- OpenRouter: https://openrouter.ai/docs/use-cases/oauth-pkce
export function openRouterAuthUrl(callbackUrl: string, challenge: string): string {
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

export async function exchangeOpenRouterCode(code: string, verifier: string, fetchImpl: Fetch = fetch): Promise<string> {
  const response = await fetchImpl("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenRouter refused the sign-in code (HTTP ${response.status}). Start again.`);
  const body = await response.json() as { key?: unknown };
  if (typeof body.key !== "string" || !body.key) throw new Error("OpenRouter returned no key. Start again.");
  return body.key;
}

// ---- Google (Gemini API OAuth): https://ai.google.dev/gemini-api/docs/oauth
export const GOOGLE_GEMINI_SCOPES = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/generative-language.retriever"];

export interface GoogleClient { clientId: string; clientSecret?: string }

export function googleAuthUrl(client: GoogleClient, redirectUri: string, state: string, challenge: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [key, value] of Object.entries({
    client_id: client.clientId, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_GEMINI_SCOPES.join(" "),
    access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
  })) url.searchParams.set(key, value);
  return url.href;
}

async function googleToken(form: Record<string, string>, fetchImpl: Fetch): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    throw new Error(`Google sign-in failed (HTTP ${response.status}${typeof body.error === "string" ? `: ${body.error}` : ""}).`);
  }
  return body as { access_token: string; refresh_token?: string; expires_in?: number };
}

export async function exchangeGoogleCode(client: GoogleClient, code: string, verifier: string, redirectUri: string, fetchImpl: Fetch = fetch) {
  const token = await googleToken({ code, client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }, fetchImpl);
  if (!token.refresh_token) throw new Error("Google returned no refresh token. Remove RootClaw's access in your Google account and sign in again.");
  return { refreshToken: token.refresh_token, accessToken: token.access_token, expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000 };
}

/** A cached access token from a refresh token, renewed a minute before it expires. */
export function googleAccessToken(client: GoogleClient, refreshToken: string, fetchImpl: Fetch = fetch, now: () => number = Date.now): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  return async () => {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    pending ??= googleToken({ client_id: client.clientId, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
      refresh_token: refreshToken, grant_type: "refresh_token" }, fetchImpl).then((token) => {
      cached = { token: token.access_token, expiresAt: now() + (token.expires_in ?? 3600) * 1000 };
      return token.access_token;
    }).finally(() => { pending = null; });
    return pending;
  };
}
