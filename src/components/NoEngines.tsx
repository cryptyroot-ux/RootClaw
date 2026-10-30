import { useState } from "react";
import { useStore } from "@/state/store";
import { EngineGroupLabel } from "@/components/EngineGroupLabel";
import { EngineSetup } from "@/components/EngineSetup";
import { ProviderConnect } from "@/components/ProviderConnect";
import { KeyRow } from "@/components/keys/KeyRow";
import { OpenAiCompatUrl } from "@/components/keys/KeyPanels";
import { LmStudioServer, OtherOpenAiCompatServers } from "@/components/OpenAiCompatServers";
import { InstanceProviderMark } from "@/components/ProviderIcons";
import { WindowDragStrip } from "@/components/DesktopCapabilities";
import { splitEngineRail } from "@/lib/engine-rail";
import { t } from "@/lib/i18n";
import { productName } from "../lib/brand";

export function NoEngines() {
  const { state, refreshInstances } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const [rechecking, setRechecking] = useState(false);
  const recheck = async () => {
    setRechecking(true);
    try {
      await refreshInstances();
    } finally {
      setRechecking(false);
    }
  };

  if (remoteClient) {
    return (
      <main className="relative flex h-full min-w-0 flex-1 items-center justify-center bg-app px-6">
        <WindowDragStrip />
        <div className="max-w-[520px] rounded-2xl border border-hairline/40 bg-card p-6 text-center">
          <h1 className="text-[20px] font-semibold text-ink">The host needs an AI</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-secondary">
            Set up Claude or another supported AI in {productName()} on the host computer, then come back here.
          </p>
          <button onClick={() => void recheck()} disabled={rechecking} className="mt-5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60">
            {rechecking ? "Checking…" : "Check again"}
          </button>
        </div>
      </main>
    );
  }

  // Local servers (Ollama, LM Studio) the app probes on this computer.
  const local = splitEngineRail(state.instances.filter((i) => i.install)).custom;

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <WindowDragStrip />
      <div className="mx-auto w-full max-w-[560px] px-6 py-12">
        <h1 className="text-[20px] font-semibold text-ink">{t("noEngines.title", { app: productName() })}</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink-secondary">
          {t("noEngines.intro", { app: productName() })}
        </p>

        <ProviderConnect className="mt-6" />

        <section data-custom-provider aria-label={t("noEngines.customTitle")} className="mt-6 flex flex-col gap-2.5">
          <EngineGroupLabel className="px-1">{t("noEngines.customTitle")}</EngineGroupLabel>
          <p className="px-1 text-[12px] leading-relaxed text-ink-secondary">{t("noEngines.customHint")}</p>
          <div className="flex flex-col">
            <div data-provider-key="openaiCompat"><KeyRow id="openaiCompat" via="model_picker"><OpenAiCompatUrl /><OtherOpenAiCompatServers /></KeyRow></div>
            <div data-provider-key="lmStudio" className="px-1 py-2"><LmStudioServer /></div>
          </div>
          {local.map((instance) => (
            <div key={instance.instanceId} className="rounded-xl border border-hairline/40 bg-card p-3.5">
              <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                <InstanceProviderMark instance={instance} size={16} />
                {instance.displayName}
              </div>
              <EngineSetup instance={instance} intent="inject" className="mt-0.5" />
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
