import { describe, expect, it } from "vitest";

import { APPLY_RECONNECT_MS, appliedAndRunning, applyActive, applyRow, type ServerApplyStatus } from "./server-update-apply";

const status = (patch: Partial<ServerApplyStatus>): ServerApplyStatus => ({ phase: "idle", from: "0.1.134", to: "0.1.135", current: "0.1.134", log: [], ...patch });

describe("one-click update progress", () => {
  it("names each step and shows the last log line under it", () => {
    expect(applyRow(status({ phase: "fetching", log: ["$ git fetch --tags"] }))).toEqual({ label: "Updating to v0.1.135: downloading…", subtitle: "$ git fetch --tags" });
    expect(applyRow(status({ phase: "installing" })).label).toBe("Updating to v0.1.135: installing packages…");
    expect(applyRow(status({ phase: "building" })).label).toBe("Updating to v0.1.135: building…");
    expect(applyRow(status({ phase: "restarting" })).label).toBe("Updating to v0.1.135: restarting…");
  });

  it("waits through the restart, then calls the update lost", () => {
    const now = 1_000_000;
    expect(applyRow(status({ phase: "restarting" }), now - 5_000, now).subtitle).toBe("Waiting for RootClaw to come back…");
    expect(applyRow(status({ phase: "restarting" }), now - APPLY_RECONNECT_MS - 1, now)).toMatchObject({ label: "RootClaw did not come back after the update", failed: true });
  });

  it("confirms the version that runs now, or says a restart is still needed", () => {
    expect(applyRow(status({ phase: "done", restart: "auto", current: "0.1.135" }))).toEqual({ label: "Updated to v0.1.135", subtitle: "Reloading this page…" });
    expect(applyRow(status({ phase: "done", restart: "manual" }))).toEqual({
      label: "v0.1.135 installed. Restart RootClaw to finish",
      subtitle: "Nothing restarts RootClaw by itself: stop it and start it again (for example pnpm start).",
    });
  });

  it("says a failed update was rolled back and which version still runs", () => {
    expect(applyRow(status({ phase: "failed", error: "pnpm build failed (exit 1).", rolledBack: true }))).toEqual({
      label: "Update failed",
      subtitle: "pnpm build failed (exit 1). Rolled back: RootClaw is still on v0.1.134.",
      failed: true,
    });
    expect(applyRow(status({ phase: "failed", error: "uncommitted changes" })).subtitle).toBe("uncommitted changes");
  });

  it("reloads only once the restarted server runs the new version", () => {
    expect(applyActive(status({ phase: "building" }))).toBe(true);
    expect(applyActive(status({ phase: "failed" }))).toBe(false);
    expect(applyActive(null)).toBe(false);
    expect(appliedAndRunning(status({ phase: "done", restart: "auto", current: "0.1.135" }))).toBe(true);
    expect(appliedAndRunning(status({ phase: "done", restart: "auto", current: "0.1.134" }))).toBe(false);
    expect(appliedAndRunning(status({ phase: "done", restart: "manual", current: "0.1.135" }))).toBe(false);
  });
});
