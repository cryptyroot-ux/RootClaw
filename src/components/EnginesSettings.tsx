import { useState, type ReactNode } from "react";

import { useStore, type InstanceInfo } from "@/state/store";
import { EngineCard, EngineSections, RefreshEngines, engineReady } from "./EngineLibrary";
import { t } from "@/lib/i18n";
import { ApiKeyEngineManage, EngineSetup, EngineUpdateNotice, EngineWarningNotice, isApiKeyEngine } from "./EngineSetup";
import { CacheKeepWarmSettings } from "./CacheKeepWarmSettings";
import { SettingsDisclosureRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";
import { InstanceProviderMark } from "./ProviderIcons";




function EngineRow({ instance, bare = false }: { instance: InstanceInfo; bare?: boolean }) {
  const policyNote = instance.policy && <p className="mb-2 text-[12px] leading-relaxed text-ink-secondary">
    <span className="font-medium text-ink">{t("policy.managedBy", { organization: instance.policy.organizationName })}</span> · {instance.policy.reason}
  </p>;
  if (instance.trialCredit) return <EngineCard instance={instance} bare={bare}>
    <p data-trial-credit={instance.trialCredit} className="text-[13px] leading-relaxed text-ink-secondary">{t(instance.trialCredit === "used_up" ? "engines.trialCreditUsedUp"
      : instance.trialCredit === "ended" ? "engines.trialCreditEnded" : engineReady(instance) ? "engines.trialCredit" : "engines.trialCreditOwn")}</p>
  </EngineCard>;
  if (instance.readOnly) return <EngineCard instance={instance} bare={bare}>
    {policyNote}
    <p className="text-[13px] leading-relaxed text-ink-secondary">{t("organization.managedEngine")}</p>
    {!engineReady(instance) && <p className="mt-2 text-[12px] text-ink-secondary">{t("organization.engineUnavailable")}</p>}
  </EngineCard>;

  return (
    <EngineCard instance={instance} bare={bare}>
      {policyNote}
      {!engineReady(instance) && <EngineSetup instance={instance} intent={instance.access === "custom" ? "inject" : "cloud"} unframed />}
      {engineReady(instance) && <ApiKeyEngineManage instance={instance} className="mt-3" />}
      {/* The setup panel that first said so is gone once the engine is Ready. */}
      {instance.snapshot.update && <EngineUpdateNotice update={instance.snapshot.update} className="mt-3" />}
      {instance.snapshot.warning && <EngineWarningNotice warning={instance.snapshot.warning} className="mt-3" />}
    </EngineCard>
  );
}

function simpleStatus(instance: InstanceInfo, ready: boolean): string {
  if (ready) return instance.snapshot.authenticated === true && instance.snapshot.account?.email ? instance.snapshot.account.email : t("onboarding.engines.ready");
  return instance.snapshot.state === "available" && instance.snapshot.authenticated === false ? t("model.signInRequired") : t("onboarding.engines.needsSetup");
}

function SimpleEngines({ rows, isReady, renderEngine, more }: {
  rows: InstanceInfo[];
  isReady: (instance: InstanceInfo) => boolean;
  renderEngine: (instance: InstanceInfo, bare?: boolean) => ReactNode;
  more: { id: string; open: boolean; onToggle: () => void };
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const featured = rows.filter((instance) => isReady(instance) || instance.authentication !== undefined);
  const others = rows.filter((instance) => !featured.includes(instance));
  return (
    <>
      <SettingsGroup label={t("settings.simple.ai.yours")} actions={<RefreshEngines />}>
        <SettingsRows>
          {featured.map((instance) => {
            const ready = isReady(instance), open = opened === instance.instanceId;
            return (
              <div key={instance.instanceId} data-simple-engine={instance.instanceId} className="group">
                <div className="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
                  <span className="flex min-w-[min(100%,15rem)] flex-1 items-center gap-3">
                    <InstanceProviderMark instance={instance} size={14} subtle />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[14px] leading-5 text-ink">{instance.displayName}</span>
                      <span className="truncate text-[13px] leading-[18px] text-ink-secondary">{simpleStatus(instance, ready)}</span>
                    </span>
                  </span>
                  <button type="button" aria-expanded={open} className="ui-button ml-auto shrink-0" onClick={() => setOpened(open ? null : instance.instanceId)}>
                    {t(open ? "common.done" : ready ? "settings.simple.ai.manage" : "settings.simple.ai.setUp")}
                  </button>
                </div>
                {open && <div className="px-4 pb-3">{renderEngine(instance, true)}</div>}
              </div>
            );
          })}
        </SettingsRows>
      </SettingsGroup>
      {others.length > 0 && (
        <SettingsDisclosureRow
          title={t("settings.simple.ai.more", { count: String(others.length) })}
          trailing={<span aria-hidden="true" className="flex items-center -space-x-1">
            {others.slice(0, 4).map((instance) => (
              <span key={instance.instanceId} className="flex size-[18px] items-center justify-center rounded-full bg-menu"><InstanceProviderMark instance={instance} size={14} subtle /></span>
            ))}
          </span>}
          {...more}
        >
          <EngineSections instances={others} isReady={isReady} renderEngine={(instance) => renderEngine(instance)} />
        </SettingsDisclosureRow>
      )}
    </>
  );
}

export function EnginesSettings({ simple = false, more }: { simple?: boolean; more?: { id: string; open: boolean; onToggle: () => void } }) {
  const { state } = useStore();
  const listed = state.instances.filter((i) => i.readOnly || i.cli !== undefined || i.cliDefault !== undefined || i.snapshot.state === "unavailable" || isApiKeyEngine(i));
  const rows = listed;
  const isReady = engineReady;
  const renderEngine = (instance: InstanceInfo, bare = false) => <EngineRow instance={instance} bare={bare} />;

  if (simple && more) return <SimpleEngines rows={rows} isReady={isReady} renderEngine={renderEngine} more={more} />;

  return (
    <div className="flex min-w-0 flex-col gap-6 pb-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60 space-y-2 px-4">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{t("settings.engines.title")}</h1>
          <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-ink-secondary">{t("engines.library.intro")}</p>
        </div>
        <RefreshEngines />
      </div>
      <EngineSections instances={rows} isReady={isReady} renderEngine={renderEngine} />
      <CacheKeepWarmSettings />
    </div>
  );
}
