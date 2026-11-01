// RootClaw's own SuperGrok sign-in (xAI device authorization), kept private in the data dir and renewed with one client id.
import { closeSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

/** xAI's public Grok CLI client: the only one xAI's auth server accepts for SuperGrok device sign-in. */
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "RootClaw" };
const RENEW_BEFORE_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 30_000;
const RENEW_RETRY_MS = 60_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
export const GROK_RENEW_FAILED = "The SuperGrok sign-in could not be renewed. Reconnect SuperGrok in Settings, or use an xAI API key.";

export interface GrokSignIn { token: string; refreshToken: string | null; expiresAt: number }
export interface GrokTokens { access_token: string; refresh_token?: string; expires_in: number }
type Stored = { signIn: GrokSignIn | null; reconnect: boolean };

export const grokStoreFile = () => join(DATA_DIR, "xai-subscription.json");
const text = (value: unknown) => typeof value === "string" && value ? value : null;

function readStore(file: string): Stored {
  let raw: Record<string, unknown> | null = null;
  try { raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return { signIn: null, reconnect: false }; }
  const token = text(raw?.access_token);
  const expiresAt = Date.parse(text(raw?.expires_at) ?? "");
  if (!token || !Number.isFinite(expiresAt)) return { signIn: null, reconnect: raw?.reconnect === true };
  return { signIn: { token, refreshToken: text(raw?.refresh_token), expiresAt }, reconnect: false };
}

const writeStore = (file: string, value: Record<string, unknown>) => writeFileAtomic(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
const signInJson = (tokens: GrokTokens, keepRefresh: string | null = null) => ({
  access_token: tokens.access_token, refresh_token: text(tokens.refresh_token) ?? keepRefresh, expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
});

let cached: { file: string; stamp: string; stored: Stored } | null = null;
function current(file: string): Stored {
  let stamp = "";
  try { const stat = statSync(file); stamp = `${stat.ino} ${stat.mtimeMs} ${stat.size}`; } catch { /* signed out */ }
  if (cached?.file !== file || cached.stamp !== stamp) cached = { file, stamp, stored: stamp ? readStore(file) : { signIn: null, reconnect: false } };
  return cached.stored;
}

export function readGrokSignIn(file = grokStoreFile()): GrokSignIn | null {
  return readStore(file).signIn;
}

export function saveGrokSignIn(file: string, tokens: GrokTokens): void {
  writeStore(file, signInJson(tokens));
  cached = null;
}

/** What the UI may know: never a token. */
export function grokSubscriptionStatus(file = grokStoreFile()): { signedIn: boolean; reconnect: boolean } {
  const { signIn, reconnect } = current(file);
  const usable = signIn !== null && (signIn.refreshToken !== null || signIn.expiresAt - Date.now() > EXPIRY_MARGIN_MS);
  return { signedIn: usable, reconnect: reconnect || (signIn !== null && !usable) };
}

export function disconnectGrok(file = grokStoreFile()): void {
  try { unlinkSync(file); } catch { /* already signed out */ }
  cached = null;
}

/** The subscription bearer for api.x.ai while it is still valid, else "". A token near its end renews in the background. */
const lastRenewal = new Map<string, number>();
export function grokSubscriptionToken(options: { file?: string; fetch?: typeof fetch; now?: number } = {}): string {
  const file = options.file ?? grokStoreFile();
  const { signIn } = current(file);
  if (!signIn) return "";
  const now = options.now ?? Date.now();
  if (signIn.refreshToken && signIn.expiresAt - now < RENEW_BEFORE_MS && now - (lastRenewal.get(file) ?? 0) > RENEW_RETRY_MS) {
    lastRenewal.set(file, now);
    void renewGrokSignIn(file, options.fetch).catch(() => {});
  }
  return signIn.expiresAt - now > EXPIRY_MARGIN_MS ? signIn.token : "";
}

/** Before a driver starts: renew a token that is about to end, so its first turn does not fall back. */
export async function ensureGrokSubscriptionFresh(options: { file?: string; fetch?: typeof fetch } = {}): Promise<string> {
  const file = options.file ?? grokStoreFile();
  const { signIn } = current(file);
  if (signIn?.refreshToken && signIn.expiresAt - Date.now() < RENEW_BEFORE_MS) await renewGrokSignIn(file, options.fetch).catch(() => null);
  return grokSubscriptionToken({ file, ...(options.fetch ? { fetch: options.fetch } : {}) });
}

const renewing = new Map<string, Promise<GrokSignIn | null>>();

/** The one renewal path: one call in flight per process, one per machine through the lock file.
 * A `refused` token renews even with time left, unless a newer sign-in already replaced it. */
export function renewGrokSignIn(file = grokStoreFile(), fetchImpl: typeof fetch = fetch, refused?: string): Promise<GrokSignIn | null> {
  const running = renewing.get(file);
  if (running) return running;
  const run = withLock(`${file}.lock`, () => renewLocked(file, fetchImpl, refused)).finally(() => renewing.delete(file));
  renewing.set(file, run);
  return run;
}

async function renewLocked(file: string, fetchImpl: typeof fetch, refused?: string): Promise<GrokSignIn | null> {
  const before = readGrokSignIn(file);
  if (!before || (before.token !== refused && before.expiresAt - Date.now() >= RENEW_BEFORE_MS)) return before;
  if (!before.refreshToken) return null;
  const response = await fetchImpl(XAI_TOKEN_URL, {
    method: "POST",
    headers: XAI_FORM_HEADERS,
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: before.refreshToken, client_id: XAI_CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  const body = response ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
  const after = readGrokSignIn(file);
  // Signed in again (or out) during the call: that newer state wins.
  if (after?.refreshToken !== before.refreshToken) return after;
  if (response && !response.ok && body?.error === "invalid_grant") {
    writeStore(file, { reconnect: true });
    cached = null;
    return null;
  }
  const token = text(body?.access_token);
  const lifetime = typeof body?.expires_in === "number" ? body.expires_in : NaN;
  if (!response?.ok || !token || !Number.isFinite(lifetime)) throw new Error(GROK_RENEW_FAILED);
  writeStore(file, signInJson({ access_token: token, refresh_token: text(body?.refresh_token) ?? undefined, expires_in: lifetime }, before.refreshToken));
  cached = null;
  return readGrokSignIn(file);
}

async function withLock<T>(lock: string, work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { closeSync(openSync(lock, "wx", 0o600)); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(GROK_RENEW_FAILED);
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(GROK_RENEW_FAILED);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try { return await work(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}
