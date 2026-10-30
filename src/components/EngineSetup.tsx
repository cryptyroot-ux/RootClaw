import { useState } from "react";
import { AlertTriangle, Check, Copy, Download, ExternalLink, KeyRound, LogIn, TerminalSquare, X } from "lucide-react";
import { type EngineInstall, type InstanceInfo, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { RefreshEngines } from "./EngineLibrary";
import { keyEntry, keyForInstance, type KeyId } from "./keys/key-catalog";
import { openKeySettings } from "./keys/key-focus";
import { KeyRow, SavedKeyLine } from "./keys/KeyRow";

type Platform = "darwin" | "win32" | "linux";

function hostPlatform(): Platform {
  const platform = window.ogb?.platform;
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Mac")) return "darwin";
  if (userAgent.includes("Win")) return "win32";
  return "linux";
}

export function installCommandFor(install: EngineInstall | undefined): string | null {
  return install?.command?.[install.platform ?? hostPlatform()] ?? null;
}

export function needsSignIn(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state === "available" && instance.snapshot.authenticated === false;
}

export function offersSignIn(instance: InstanceInfo | undefined): boolean {
  return Boolean(instance && needsSignIn(instance) && instance.install
    && !instance.snapshot.authenticationUnavailableReason && !apiKeySetup(instance));
}

export function needsCli(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state !== "available";
}

export function serverTerminal(cloudHome: boolean): boolean {
  return Boolean(window.ogb?.openInstallTerminal) && window.ogb?.remoteClient?.active !== true && !cloudHome;
}

export function grokKeyInstead(instance: InstanceInfo, cloudHome: boolean): boolean {
  return instance.driverKind === "grokAgent" && needsCli(instance) && !serverTerminal(cloudHome);
}

export function CommandRow({
  command,
  actionLabel,
  compact = false,
  allowTerminal = true,
}: {
  command: string;
  actionLabel: string;
  compact?: boolean;
  allowTerminal?: boolean;
}) {
  const [status, setStatus] = useState<"copied" | "failed" | "opened" | null>(null);
  const canOpen = typeof window !== "undefined" && allowTerminal && serverTerminal(false);

  const settle = (next: "copied" | "failed" | "opened") => {
    setStatus(next);
    window.setTimeout(() => setStatus(null), 2200);
  };

  const copy = async () => {
    const result = await copyText(command);
    if (result !== "empty") settle(result);
  };
  const copyIcon = (size: number) => status === "copied" ? <Check size={size} className="text-success" />
    : status === "failed" ? <X size={size} className="text-danger" /> : <Copy size={size} />;

  const openTerminal = async () => {
    const opened = await window.ogb!.openInstallTerminal!(command);
    settle(opened ? "opened" : "copied");
  };

  if (compact) {
    return (
      <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-lg border border-hairline/50 bg-app px-2 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-secondary" title={command}>
          {command}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t("engineSetup.copyCommand")}
          title={t("engineSetup.copyCommand")}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
        >
          {copyIcon(12)}
          {t(status === "copied" ? "engineSetup.copied" : status === "failed" ? "common.copyFailed" : "engineSetup.copy")}
        </button>
        {canOpen && (
          <button
            type="button"
            onClick={() => void openTerminal()}
            aria-label={actionLabel}
            title={actionLabel}
            className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-semibold text-white hover:brightness-110"
          >
            {status === "opened" ? <Check size={12} /> : <TerminalSquare size={12} />}
            {status === "opened" ? t("engineSetup.opened") : t("engineSetup.terminal")}
          </button>
        )}
        <span aria-live="polite" className="sr-only">
          {status === "opened" ? t("engineSetup.openedHint") : ""}
        </span>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/50 bg-app px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-secondary" title={command}>
          {command}
        </code>
        {canOpen && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={t("engineSetup.copyCommand")}
            title={t("engineSetup.copyCommand")}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
          >
            {copyIcon(12)}
            {t(status === "copied" ? "engineSetup.copied" : status === "failed" ? "common.copyFailed" : "engineSetup.copy")}
          </button>
        )}
      </div>

      {canOpen ? (
        <>
          <button
            type="button"
            onClick={() => void openTerminal()}
            className="mt-2 flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-white hover:brightness-110"
          >
            {status === "opened" ? <Check size={14} /> : <TerminalSquare size={14} />}
            {status === "opened" ? t("engineSetup.terminalOpened") : actionLabel}
          </button>
          <p aria-live="polite" className="mt-1.5 text-center text-[11px] text-ink-tertiary">
            {status === "opened" ? t("engineSetup.pasteHint") : t("engineSetup.copyOnOpenHint")}
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] font-semibold text-ink hover:bg-raised-hover"
        >
          {copyIcon(14)}
          {t(status === "copied" ? "engineSetup.commandCopied" : status === "failed" ? "common.copyFailed" : "engineSetup.copyCommand")}
        </button>
      )}
    </div>
  );
}

export function EngineUpdateNotice({
  update,
  className,
}: {
  update: NonNullable<InstanceInfo["snapshot"]["update"]>;
  className?: string;
}) {
  return (
    <div
      data-engine-update-notice
      className={cn("rounded-xl border border-warning/25 bg-warning/5 p-2.5", className)}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{update.title}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{update.message}</p>
        </div>
      </div>
      <CommandRow command={update.command} actionLabel={t("engineSetup.openUpdate")} compact />
    </div>
  );
}

export function EngineWarningNotice({
  warning,
  className,
}: {
  warning: NonNullable<InstanceInfo["snapshot"]["warning"]>;
  className?: string;
}) {
  return (
    <div
      data-engine-warning-notice
      className={cn("rounded-xl border border-warning/25 bg-warning/5 p-2.5", className)}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{warning.title}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{warning.message}</p>
        </div>
      </div>
    </div>
  );
}

export function isApiKeyEngine(instance: InstanceInfo | undefined): boolean {
  if (!instance || instance.access !== "api" || instance.managed) return false;
  return instance.driverKind !== "claudeAgent" || Boolean(instance.snapshot.version);
}

export function hasSavedApiKey(instance: InstanceInfo): boolean {
  return isApiKeyEngine(instance) && instance.snapshot.authenticated === true;
}

function apiKeySetup(instance: InstanceInfo): boolean {
  if (!(isApiKeyEngine(instance) || instance.install?.settings === "connections") || instance.snapshot.authenticationUnavailableReason) return false;
  // A key engine with its own CLI (DeepSeek Harness) is installed first, then given the key.
  if (instance.snapshot.state !== "available") return !installCommandFor(instance.install);
  return instance.snapshot.authenticated === false;
}

function inlineKey(instance: InstanceInfo): KeyId | undefined {
  const key = keyForInstance(instance.instanceId);
  return key && keyEntry(key).kind === "key" && key !== "openaiCompat" ? key : undefined;
}

export const openKeysFor = (instance?: InstanceInfo) =>
  openKeySettings(instance ? keyForInstance(instance.instanceId) ?? (instance.driverKind === "openai-compat" ? "openaiCompat" : undefined) : undefined);

export function ApiKeyHint({ instance }: { instance: InstanceInfo }) {
  const key = window.ogb?.remoteClient?.active === true ? undefined : inlineKey(instance);
  return (
    <>
      <div className="mt-0.5 text-[12px] leading-4 text-ink-tertiary">{t("model.apiKeyHint")}</div>
      {key && <SavedKeyLine id={key} />}
    </>
  );
}

function GrokKeyInstead({ className, unframed }: { className?: string; unframed: boolean }) {
  const remote = window.ogb?.remoteClient?.active === true;
  return (
    <div data-engine-setup-key-instead className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          <KeyRound size={14} />
        </span>
        <p className="min-w-0 text-[13px] leading-relaxed text-ink">{t("engineSetup.grok.notInstalled")}</p>
      </div>
      {!remote && <KeyRow id="xai" bare via="model_picker" className="mt-2 px-0 pb-0" />}
    </div>
  );
}

function ApiKeyEngineSetup({ instance, className, unframed, configured = false }: { instance: InstanceInfo; className?: string; unframed: boolean; configured?: boolean }) {
  const { dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  const inline = remote ? undefined : inlineKey(instance);
  const copy = configured
    ? { title: "engineSetup.apiKey.configuredTitle", description: remote ? "engineSetup.apiKey.configuredRemote" : inline ? null : "engineSetup.apiKey.configuredDescription", action: "engineSetup.apiKey.change" } as const
    : { title: "engineSetup.apiKey.title", description: remote ? "engineSetup.apiKey.remote" : inline ? "engineSetup.apiKey.inline" : "engineSetup.apiKey.description", action: "engineSetup.apiKey.open" } as const;
  return (
    <div data-engine-setup-api-key={configured ? "configured" : ""} className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          <KeyRound size={14} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{t(copy.title, { name: instance.displayName })}</div>
          {copy.description && <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t(copy.description)}</p>}
        </div>
      </div>
      {/* An API-only engine is available only with a saved key, so unauthenticated means rejected.
          A key engine with its own CLI (DeepSeek Harness) is unauthenticated simply when no key is saved yet. */}
      {!inline && isApiKeyEngine(instance) && needsSignIn(instance) && (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">{t("engineSetup.apiKey.rejected")}</p>
      )}
      {inline ? <KeyRow id={inline} bare via="model_picker" rejected={isApiKeyEngine(instance) && needsSignIn(instance)} className="mt-2 px-0 pb-0" /> : !remote && (
        <button
          type="button"
          onClick={() => dispatch(openKeysFor(instance))}
          className="mt-3 flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover"
        >
          <KeyRound size={13} aria-hidden="true" />
          {t(copy.action)}
        </button>
      )}
    </div>
  );
}

export function ApiKeyEngineManage({ instance, className }: { instance: InstanceInfo; className?: string }) {
  if (!hasSavedApiKey(instance)) return null;
  return <ApiKeyEngineSetup instance={instance} className={className} unframed={false} configured />;
}

export function EngineSetup({
  instance,
  className,
  intent = "cloud",
  unframed = false,
  description: descriptionOverride,
  quiet = false,
}: {
  instance: InstanceInfo;
  className?: string;
  intent?: "cloud" | "inject";
  unframed?: boolean;
  description?: string;
  quiet?: boolean;
}) {
  const { state } = useStore();
  const cloudHome = state.config?.cloudHome === true;
  const install = instance.install;
  const installCommand = installCommandFor(install);
  const signInCommand = install?.signInCommand;
  const signInOnly = intent === "cloud" && needsSignIn(instance);
  const command = signInOnly ? signInCommand : installCommand;
  const title = signInOnly
    ? t("engineSetup.signInTitle", { name: instance.displayName })
    : t("engineSetup.setupTitle", { name: instance.displayName });
  const description = descriptionOverride ?? (signInOnly
    ? t("engineSetup.terminalSignInCheck")
    : intent === "inject"
      ? t("engineSetup.injectDesc")
      : signInCommand
        ? t("engineSetup.installDescSignIn")
        : t("engineSetup.installDesc"));

  if (apiKeySetup(instance)) {
    return <ApiKeyEngineSetup instance={instance} className={className} unframed={unframed} />;
  }

  if (intent === "cloud" && grokKeyInstead(instance, cloudHome)) {
    return <GrokKeyInstead className={className} unframed={unframed} />;
  }

  if (!install || instance.snapshot.authenticationUnavailableReason) {
    return (
      <div className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
        <div className="text-[13px] font-semibold text-ink">{t("engineSetup.notReady", { name: instance.displayName })}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {instance.snapshot.authenticationUnavailableReason ?? instance.snapshot.reason ?? t("engineSetup.noReason")}
        </p>
      </div>
    );
  }

  return (
    <div className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          {signInOnly ? <LogIn size={14} /> : <Download size={14} />}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{description}</p>
        </div>
      </div>

      {instance.snapshot.state === "unavailable" && instance.snapshot.reason && (quiet ? (
        <details data-engine-setup-reason className="mt-2 text-[12px] leading-4 text-ink-tertiary">
          <summary className="cursor-pointer select-none hover:text-ink-secondary">{t("engineSetup.details")}</summary>
          <p className="mt-1 whitespace-pre-wrap">{instance.snapshot.reason}</p>
        </details>
      ) : (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">
          {instance.snapshot.reason}
        </p>
      ))}

      {command ? (
        <CommandRow
          command={command}
          actionLabel={signInOnly ? t("engineSetup.openSignIn") : t("engineSetup.openInstall")}
          allowTerminal={!cloudHome}
        />
      ) : (
        <p className="mt-3 rounded-lg bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
          {t("engineSetup.noInstaller")}
        </p>
      )}

      {!signInOnly && install.needsNode && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-tertiary">
          {t("engineSetup.needsNode").split("{npm}").flatMap((part, index) =>
            index === 0
              ? [part]
              : [<code key="npm" className="font-mono">npm</code>, part],
          )}
        </p>
      )}

      {(install.command || signInCommand) && (
        <div className="mt-3 border-t border-hairline/40 pt-2">
          <p className="mb-1 text-[12px] leading-relaxed text-ink-secondary">{t("engineSetup.sameMachine")}</p>
          {needsCli(instance) && <p className="mb-1 text-[12px] leading-relaxed text-ink-secondary">{t("engineSetup.pathHint")}</p>}
          <RefreshEngines key={instance.instanceId} />
        </div>
      )}

      {install.docsUrl && (
        <a
          href={install.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
        >
          <ExternalLink size={12} /> {t("engineSetup.viewGuide")}
        </a>
      )}
    </div>
  );
}
