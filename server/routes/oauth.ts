// Official provider sign-in (admin scope, behind the auth gate):
//   POST /api/oauth/openrouter/start   → { url }: OpenRouter PKCE; the callback saves an OpenRouter API key
//   GET  /api/oauth/openrouter/callback?state&code
//   POST /api/oauth/google/start       → { url }: Google OAuth for the Gemini API, with the client in gemini.oauth
//   GET  /api/oauth/google/callback?state&code
// Subscription logins (Claude Pro/Max, ChatGPT/Codex) are never offered: API-key mode is always available instead.
import type { AppConfig } from "../config.ts";
import { exchangeGoogleCode, exchangeOpenRouterCode, googleAuthUrl, openRouterAuthUrl, PendingOAuth, type GoogleClient, type OAuthProvider } from "../oauth/oauth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface OAuthRouteDeps {
  config(): AppConfig;
  /** Saves the patch, refreshes credentials and reloads the engines that use them. */
  save(patch: Partial<AppConfig>): Promise<void>;
  pending?: PendingOAuth;
  fetch?: typeof fetch;
}

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`;
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createOAuthRoutes(deps: OAuthRouteDeps): RouteHandler {
  const pending = deps.pending ?? new PendingOAuth();
  const googleClient = (): GoogleClient | null => {
    const oauth = deps.config().gemini?.oauth;
    return oauth?.clientId ? { clientId: oauth.clientId, ...(oauth.clientSecret ? { clientSecret: oauth.clientSecret } : {}) } : null;
  };
  return async ({ req, res, url, path, method, json }) => {
    const match = /^\/api\/oauth\/(openrouter|google)\/(start|callback)$/.exec(path);
    if (!match) return PASS;
    const provider = match[1] as OAuthProvider;
    const origin = `${url.protocol}//${req.headers.host ?? url.host}`;
    const callback = `${origin}/api/oauth/${provider}/callback`;
    if (match[2] === "start") {
      if (method !== "POST") return json(res, 405, { error: "POST only" });
      if (provider === "google") {
        const client = googleClient();
        if (!client) return json(res, 409, { error: "Google sign-in needs your own OAuth client: set gemini.oauth.clientId (and clientSecret) in Settings, or ROOTCLAW_GOOGLE_OAUTH_CLIENT_ID. See docs/api-providers.md. A Gemini API key works without it." });
        const { state, challenge } = pending.start("google", callback);
        return json(res, 200, { url: googleAuthUrl(client, callback, state, challenge) });
      }
      const started = pending.start("openrouter", (state) => `${callback}?state=${encodeURIComponent(state)}`);
      return json(res, 200, { url: openRouterAuthUrl(started.redirectUri, started.challenge) });
    }
    if (method !== "GET") return json(res, 405, { error: "GET only" });
    const done = (status: number, title: string, body: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(title, body));
    };
    const started = pending.take(provider, url.searchParams.get("state"));
    const code = url.searchParams.get("code");
    if (!started || !code) return done(400, "Sign-in expired", "This sign-in link was already used or is older than ten minutes. Start again from Settings.");
    try {
      if (provider === "openrouter") {
        const key = await exchangeOpenRouterCode(code, started.verifier, deps.fetch);
        await deps.save({ openrouter: { key } });
        return done(200, "OpenRouter connected", "RootClaw saved an OpenRouter key for you. You can close this tab.");
      }
      const client = googleClient();
      if (!client) return done(409, "Google sign-in not set up", "No OAuth client is configured.");
      const token = await exchangeGoogleCode(client, code, started.verifier, started.redirectUri, deps.fetch);
      await deps.save({ gemini: { ...deps.config().gemini, oauth: { ...deps.config().gemini?.oauth, refreshToken: token.refreshToken } } });
      return done(200, "Google connected", "Gemini now runs with your Google account. You can close this tab.");
    } catch (error) {
      return done(502, "Sign-in failed", escape(error instanceof Error ? error.message : String(error)));
    }
  };
}
