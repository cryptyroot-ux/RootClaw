import { useEffect, useState } from "react";
import { ExternalLink, KeyRound, LogIn, RefreshCw } from "lucide-react";
import { openExternalLink } from "@/lib/app-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api } from "@/state/api";
import { useStore } from "@/state/store";
import type { KeyId } from "./keys/key-catalog";
import { KeyRow } from "./keys/KeyRow";

/** The native providers a person connects with their own API key. */
export const PROVIDER_KEYS = ["openai", "anthropic", "gemini", "openrouter", "ollama"] as const satisfies readonly KeyId[];

export type OAuthProvider = "openrouter" | "google";

/** Official OAuth only: the server starts the flow (PKCE / the person's own Google client) and the provider's page opens. */
export async function startOAuth(
  provider: OAuthProvider,
  deps: { post: (path: string) => Promise<{ url: string }>; open: (url: string) => Promise<void> } = {
    post: (path) => api<{ url: string }>(path, { method: "POST" }),
    open: openExternalLink,
  },
): Promise<void> {
  const { url } = await deps.post(`/api/oauth/${provider}/start`);
  await deps.open(url);
}

export interface GrokSignInPrompt { url: string; code: string; expiresIn: number }
export type GrokSignInState = "idle" | "pending" | "signed-in" | "failed";

/** Only xAI's own sign-in pages become a link. */
export const isGrokSignInPage = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "accounts.x.ai" || url.hostname === "auth.x.ai");
  } catch { return false; }
};

/** SuperGrok device sign-in on the server: it returns xAI's page and the code to approve there. */
export async function startGrokSignIn(
  post: () => Promise<GrokSignInPrompt> = () => api("/api/oauth/xai/start", { method: "POST" }),
): Promise<GrokSignInPrompt> {
  const started = await post();
  if (!isGrokSignInPage(started.url)) throw new Error(t("providerConnect.grokFailed"));
  return started;
}

export const disconnectGrokSignIn = (post: () => Promise<unknown> = () => api("/api/oauth/xai/disconnect", { method: "POST" })) => post();

export function GrokSignInCode({ prompt }: { prompt: GrokSignInPrompt }) {
  return (
    <p role="status" data-grok-code className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
      {t("providerConnect.grokOpen")}{" "}
      <a href={prompt.url} target="_blank" rel="noreferrer" className="text-accent underline"
        onClick={(event) => { event.preventDefault(); void openExternalLink(prompt.url); }}>{prompt.url}</a>
      {" "}{t("providerConnect.grokCode")} <code className="font-mono font-semibold text-ink">{prompt.code}</code>
      {" "}{t("providerConnect.grokExpires", { minutes: Math.max(1, Math.round(prompt.expiresIn / 60)) })}
    </p>
  );
}

/** Connect an AI: an API key for any native provider, or an official sign-in (OpenRouter, Google) where one exists. */
export function ProviderConnect({ className }: { className?: string }) {
  const { state, refreshInstances } = useStore();
  const [busy, setBusy] = useState<OAuthProvider | "check" | null>(null);
  const [grokBusy, setGrokBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<OAuthProvider | null>(null);
  const locked = busy !== null || grokBusy;
  const remote = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const googleClient = state.config?.gemini?.oauth?.client === true;
  const googleSignedIn = state.config?.gemini?.oauth?.signedIn === true;

  const signIn = async (provider: OAuthProvider) => {
    setBusy(provider);
    setError(null);
    try {
      await startOAuth(provider);
      setOpened(provider);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };
  const check = async () => {
    setBusy("check");
    try { await refreshInstances(); } finally { setBusy(null); }
  };
  const oauthButton = (provider: OAuthProvider, label: string, disabled: boolean, title?: string) => (
    <button
      type="button"
      data-oauth={provider}
      disabled={locked || disabled}
      title={title}
      onClick={() => void signIn(provider)}
      className="flex items-center justify-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
    >
      <LogIn size={14} aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <div data-provider-connect className={cn("flex flex-col gap-4", className)}>
      <section aria-label={t("providerConnect.oauthTitle")}>
        <div className="text-[13px] font-semibold text-ink">{t("providerConnect.oauthTitle")}</div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("providerConnect.oauthHint")}</p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {oauthButton("openrouter", t("providerConnect.openrouter"), false)}
          {googleClient && oauthButton("google", googleSignedIn ? t("providerConnect.googleSignedIn") : t("providerConnect.google"), false)}
        </div>
        {opened && <p role="status" className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-secondary">
          <ExternalLink size={12} aria-hidden="true" />{t("providerConnect.opened")}
        </p>}
        {error && <p role="alert" className="mt-1.5 text-[12px] leading-relaxed text-danger">{error}</p>}
      </section>

      <SuperGrokConnect locked={busy !== null} onBusy={setGrokBusy} />

      <section aria-label={t("providerConnect.keysTitle")}>
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <KeyRound size={13} aria-hidden="true" />{t("providerConnect.keysTitle")}
        </div>
        {remote
          ? <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("engineSetup.apiKey.remote")}</p>
          : <div className="mt-1 flex flex-col">
            {PROVIDER_KEYS.map((id) => <div key={id} data-provider-key={id}><KeyRow id={id} via="model_picker" /></div>)}
          </div>}
      </section>

      <button
        type="button"
        onClick={() => void check()}
        disabled={locked}
        className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-[13px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
      >
        <RefreshCw size={12} aria-hidden="true" className={busy === "check" ? "animate-spin" : ""} />
        {busy === "check" ? t("common.checking") : t("common.checkAgain")}
      </button>
    </div>
  );
}

/** The SuperGrok device sign-in card: first-run screens and Settings → Model providers. */
export function SuperGrokConnect({ className, locked = false, onBusy }: { className?: string; locked?: boolean; onBusy?: (busy: boolean) => void }) {
  const { state, refreshInstances } = useStore();
  const [busy, setBusyState] = useState(false);
  const setBusy = (next: boolean) => { setBusyState(next); onBusy?.(next); };
  const [grok, setGrok] = useState<{ state: GrokSignInState; prompt?: GrokSignInPrompt; error?: string }>({ state: "idle" });
  const grokStatus = state.config?.xai?.subscription;
  const grokSignedIn = grok.state === "signed-in" || (grok.state !== "pending" && grokStatus?.signedIn === true);
  const grokReconnect = grok.state !== "pending" && grok.state !== "signed-in" && grokStatus?.reconnect === true;
  const connectGrok = async () => {
    setBusy(true);
    try {
      setGrok({ state: "pending", prompt: await startGrokSignIn() });
    } catch (failure) {
      setGrok({ state: "failed", error: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setBusy(false);
    }
  };
  const disconnectGrok = async () => {
    setBusy(true);
    try {
      await disconnectGrokSignIn();
      setGrok({ state: "idle" });
      void refreshInstances();
    } catch (failure) {
      setGrok({ state: "failed", error: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (grok.state !== "pending") return;
    const timer = setInterval(() => {
      void api<{ state: GrokSignInState; error?: string }>("/api/oauth/xai/status").then((status) => {
        if (status.state === "pending") return;
        setGrok({ state: status.state, error: status.error });
        if (status.state === "signed-in") void refreshInstances();
      }).catch(() => {});
    }, 2_000);
    return () => clearInterval(timer);
  }, [grok.state, refreshInstances]);

  return (
    <section aria-label={t("providerConnect.grokTitle")} className={className}>
      <div className="text-[13px] font-semibold text-ink">{t("providerConnect.grokTitle")}</div>
      <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("providerConnect.grokHint")}</p>
      <button
        type="button"
        data-grok-connect
        disabled={locked || busy || grok.state === "pending"}
        onClick={() => void connectGrok()}
        className="mt-2 flex items-center justify-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
      >
        <LogIn size={14} aria-hidden="true" />
        {grokSignedIn ? t("providerConnect.grokSignedIn") : grokReconnect ? t("providerConnect.grokReconnect") : t("providerConnect.grok")}
      </button>
      {(grokSignedIn || grokReconnect) && (
        <button type="button" data-grok-disconnect disabled={locked || busy} onClick={() => void disconnectGrok()}
          className="mt-2 rounded-lg px-3 py-2 text-[13px] font-medium text-ink-secondary hover:bg-raised-hover disabled:opacity-50">
          {t("providerConnect.grokDisconnect")}
        </button>
      )}
      {grok.state === "pending" && grok.prompt && <GrokSignInCode prompt={grok.prompt} />}
      {grok.error && <p role="alert" className="mt-1.5 text-[12px] leading-relaxed text-danger">{grok.error}</p>}
    </section>
  );
}
