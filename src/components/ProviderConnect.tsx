import { useState } from "react";
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

/** Connect an AI: an API key for any native provider, or an official sign-in (OpenRouter, Google) where one exists. */
export function ProviderConnect({ className }: { className?: string }) {
  const { state, refreshInstances } = useStore();
  const [busy, setBusy] = useState<OAuthProvider | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<OAuthProvider | null>(null);
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
      disabled={busy !== null || disabled}
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
          {oauthButton("google", googleSignedIn ? t("providerConnect.googleSignedIn") : t("providerConnect.google"), !googleClient,
            googleClient ? undefined : t("providerConnect.googleNeedsClient"))}
        </div>
        {!googleClient && <p className="mt-1.5 text-[11px] leading-relaxed text-ink-tertiary">{t("providerConnect.googleNeedsClient")}</p>}
        {opened && <p role="status" className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-secondary">
          <ExternalLink size={12} aria-hidden="true" />{t("providerConnect.opened")}
        </p>}
        {error && <p role="alert" className="mt-1.5 text-[12px] leading-relaxed text-danger">{error}</p>}
      </section>

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
        disabled={busy !== null}
        className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-[13px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
      >
        <RefreshCw size={12} aria-hidden="true" className={busy === "check" ? "animate-spin" : ""} />
        {busy === "check" ? t("common.checking") : t("common.checkAgain")}
      </button>
    </div>
  );
}
