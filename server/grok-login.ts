// SuperGrok sign-in as an RFC 8628 device authorization grant against auth.x.ai: the owner approves on xAI's page,
// the server polls for the tokens and keeps them in RootClaw's own store. Nothing here is logged or returned but the code.
import { disconnectGrok, grokStoreFile, saveGrokSignIn, XAI_CLIENT_ID, XAI_DEVICE_URL, XAI_FORM_HEADERS, XAI_SCOPE, XAI_TOKEN_URL } from "./grok-subscription.ts";

export interface GrokLoginPrompt { url: string; code: string; expiresIn: number }
export type GrokLoginStatus = { state: "idle" | "pending" | "signed-in" | "failed"; error?: string };
export interface GrokLoginOptions { fetch?: typeof fetch; file?: string; onChange?: () => void; sleep?: (ms: number) => Promise<void> }

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SIGN_IN_HOSTS = new Set(["accounts.x.ai", "auth.x.ai"]);
const CANCELLED = "SuperGrok sign-in cancelled.";
const EXPIRED = "The SuperGrok code expired before it was approved. Try again.";
const DECLINED = "SuperGrok sign-in was declined on xAI's page.";
const FAILED = "xAI refused the SuperGrok sign-in. Try again, or use an xAI API key.";
const NOT_XAI_PAGE = "xAI did not return its own sign-in page. Try again.";

function signInPage(value: unknown): URL | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && SIGN_IN_HOSTS.has(url.hostname) && !url.port && !url.username && !url.password ? url : null;
  } catch { return null; }
}

const post = (fetchImpl: typeof fetch, url: string, form: Record<string, string>, signal: AbortSignal) =>
  fetchImpl(url, { method: "POST", headers: XAI_FORM_HEADERS, body: new URLSearchParams(form).toString(), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });

export class GrokLogin {
  private readonly fetch: typeof fetch;
  private readonly file: string;
  private readonly onChange: () => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private current: GrokLoginStatus = { state: "idle" };
  private prompt: Promise<GrokLoginPrompt> | null = null;
  private abort: AbortController | null = null;

  constructor(options: GrokLoginOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.file = options.file ?? grokStoreFile();
    this.onChange = options.onChange ?? (() => {});
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  status(): GrokLoginStatus { return { ...this.current }; }

  /** One flow at a time: a second start while one is pending gets the same page and code. */
  start(): Promise<GrokLoginPrompt> {
    if (this.prompt && this.current.state === "pending") return this.prompt;
    const abort = new AbortController();
    this.abort?.abort();
    this.abort = abort;
    this.current = { state: "pending" };
    this.prompt = this.begin(abort).catch((error: unknown) => {
      if (this.abort === abort) { this.current = { state: "failed", error: error instanceof Error ? error.message : FAILED }; this.prompt = null; }
      throw error;
    });
    return this.prompt;
  }

  async cancel(): Promise<void> {
    if (this.current.state !== "pending") return;
    this.abort?.abort();
    this.abort = null;
    this.prompt = null;
    this.current = { state: "failed", error: CANCELLED };
  }

  async disconnect(): Promise<void> {
    this.abort?.abort();
    this.abort = null;
    this.prompt = null;
    this.current = { state: "idle" };
    disconnectGrok(this.file);
    this.onChange();
  }

  private async begin(abort: AbortController): Promise<GrokLoginPrompt> {
    const response = await post(this.fetch, XAI_DEVICE_URL, { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }, abort.signal).catch(() => null);
    const body = response?.ok ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
    const deviceCode = typeof body?.device_code === "string" ? body.device_code : "";
    const code = typeof body?.user_code === "string" ? body.user_code : "";
    const expiresIn = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 0;
    if (!deviceCode || !code || !expiresIn) throw new Error(FAILED);
    const page = signInPage(body?.verification_uri);
    if (!page) throw new Error(NOT_XAI_PAGE);
    const complete = signInPage(body?.verification_uri_complete);
    const url = complete && complete.searchParams.get("user_code") === code ? complete.href : page.href;
    const interval = typeof body?.interval === "number" && body.interval > 0 ? body.interval * 1000 : 5_000;
    void this.poll(abort, deviceCode, interval, Date.now() + expiresIn * 1000);
    return { url, code, expiresIn };
  }

  private async poll(abort: AbortController, deviceCode: string, interval: number, deadline: number): Promise<void> {
    const finish = (status: GrokLoginStatus) => {
      if (abort.signal.aborted) return;
      this.abort = null;
      this.prompt = null;
      this.current = status;
    };
    for (;;) {
      await this.sleep(interval);
      if (abort.signal.aborted) return;
      if (Date.now() > deadline) return finish({ state: "failed", error: EXPIRED });
      const response = await post(this.fetch, XAI_TOKEN_URL, { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: XAI_CLIENT_ID }, abort.signal).catch(() => null);
      if (abort.signal.aborted) return;
      const body = response ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
      if (response?.ok && typeof body?.access_token === "string" && body.access_token && typeof body.expires_in === "number") {
        saveGrokSignIn(this.file, { access_token: body.access_token, expires_in: body.expires_in, ...(typeof body.refresh_token === "string" ? { refresh_token: body.refresh_token } : {}) });
        finish({ state: "signed-in" });
        this.onChange();
        return;
      }
      const error = body?.error;
      if (!response || response.status >= 500 || error === "authorization_pending") continue;
      if (error === "slow_down") { interval += 5_000; continue; }
      if (error === "access_denied") return finish({ state: "failed", error: DECLINED });
      if (error === "expired_token") return finish({ state: "failed", error: EXPIRED });
      return finish({ state: "failed", error: FAILED });
    }
  }
}
