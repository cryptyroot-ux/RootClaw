import { t } from "./i18n";

/** GET /api/updates/status (server/update-apply.ts ApplyStatus). */
export type ServerApplyPhase = "idle" | "fetching" | "installing" | "building" | "restarting" | "done" | "failed";
export interface ServerApplyStatus {
  phase: ServerApplyPhase;
  from?: string;
  to?: string;
  current: string;
  error?: string;
  rolledBack?: boolean;
  restart?: "auto" | "manual";
  log: string[];
}

const ACTIVE: readonly ServerApplyPhase[] = ["fetching", "installing", "building", "restarting"];
export const applyActive = (status: ServerApplyStatus | null) => Boolean(status && ACTIVE.includes(status.phase));

/** How long the page keeps asking while the server restarts before it calls the update lost. */
export const APPLY_RECONNECT_MS = 10 * 60_000;
export const APPLY_POLL_MS = 1_500;
/** Marks a tab that started an update, so a reload mid-update picks the progress back up. */
export const APPLY_MARK = "rootclaw.update.applying";

/** Finished and now running the new version: the page reloads to load the matching web app. */
export function appliedAndRunning(status: ServerApplyStatus | null): boolean {
  return Boolean(status && status.phase === "done" && status.restart === "auto" && status.to && status.current === status.to);
}

/** The menu row while an update runs or after it ends. `lostSince`: when the server stopped answering, if it has. */
export function applyRow(status: ServerApplyStatus, lostSince: number | null = null, now = Date.now()): { label: string; subtitle?: string; failed?: boolean } {
  const version = status.to ?? "";
  const last = status.log.at(-1);
  switch (status.phase) {
    case "fetching": return { label: t("sidebar.update.applyFetching", { version }), subtitle: last };
    case "installing": return { label: t("sidebar.update.applyInstalling", { version }), subtitle: last };
    case "building": return { label: t("sidebar.update.applyBuilding", { version }), subtitle: last };
    case "restarting":
      if (lostSince !== null && now - lostSince > APPLY_RECONNECT_MS) return { label: t("sidebar.update.applyLost"), subtitle: t("sidebar.update.applyLostHint"), failed: true };
      return { label: t("sidebar.update.applyRestarting", { version }), subtitle: lostSince !== null ? t("sidebar.update.applyWaiting") : last };
    case "done":
      if (status.restart === "manual") return { label: t("sidebar.update.applyManual", { version }), subtitle: t("sidebar.update.applyManualHint") };
      return { label: t("sidebar.update.applyDone", { version: status.current }), subtitle: t("sidebar.update.applyReloading") };
    case "failed": {
      const error = status.error ?? "";
      return {
        label: t("sidebar.update.applyFailed"),
        subtitle: status.rolledBack ? t("sidebar.update.applyRolledBack", { error, version: status.current }) : error,
        failed: true,
      };
    }
    default: return { label: t("sidebar.update.check") };
  }
}
