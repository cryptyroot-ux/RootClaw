import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerUpdateCheck } from "@/lib/server-update";
import type { ServerApplyStatus } from "@/lib/server-update-apply";

// React's hooks are replayed by hand, as in SidebarProfileMenu.server-update.test.ts.
const f = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as EffectCallback[], calls: [] as Array<[string, unknown]>,
  answers: {} as Record<string, unknown>, copied: [] as string[],
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = initial; return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (v: unknown) => unknown)(f.values[index]) : next; }]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
  useRef: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = { current: initial }; return f.values[index]; },
}));
vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string, init?: unknown) => {
    f.calls.push([path, init]);
    const answer = f.answers[path];
    if (answer instanceof Error) throw answer;
    return answer;
  }),
  useStore: () => ({ state: { config: {} }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/copy-text", () => ({ copyText: vi.fn(async (text: string) => { f.copied.push(text); return "copied"; }) }));
import { simpleUpdateTop, useServerUpdateItem } from "./SidebarProfileMenu";
import { serverUpdateAction } from "./SettingsSimplePages";

const clone: ServerUpdateCheck = {
  current: "0.1.134", install: "git", latest: "0.1.135", available: true, canApply: true, restart: true,
  command: "git pull && pnpm install && pnpm build && pnpm build:server", releaseUrl: "https://github.com/cryptyroot-ux/RootClaw/releases/tag/v0.1.135",
};
let entry: ReturnType<typeof useServerUpdateItem>;
function render() {
  f.index = 0; f.effects = [];
  renderToStaticMarkup(createElement(() => { entry = useServerUpdateItem(true); return null; }));
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function checked(check: ServerUpdateCheck) {
  f.answers["/api/updates/check"] = check;
  render();
  entry!.item.onSelect?.();
  await flush();
  render();
  return entry!;
}

beforeEach(() => {
  f.values = []; f.calls = []; f.answers = {}; f.copied = [];
  vi.stubGlobal("window", { location: { host: "bots.example.test", reload: vi.fn() } });
  vi.stubGlobal("sessionStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

it("installs the update from the row on a clone the owner runs, and shows each step", async () => {
  const row = await checked(clone);
  expect(row.item.label).toBe("Update now to v0.1.135");
  expect(row.canApply).toBe(true);
  expect(simpleUpdateTop(row)).toEqual({ label: "Update ready", action: "Update now" });
  expect(serverUpdateAction(row)).toBe("Update now");

  const fetching: ServerApplyStatus = { phase: "fetching", from: "0.1.134", to: "0.1.135", current: "0.1.134", log: ["$ git fetch --tags --no-recurse-submodules origin"] };
  f.answers["/api/updates/apply"] = fetching;
  row.item.onSelect?.();
  await flush();
  render();
  expect(f.calls.at(-1)).toEqual(["/api/updates/apply", { method: "POST", body: "{}", timeoutMs: 20_000 }]);
  expect(sessionStorage.setItem).toHaveBeenCalledWith("rootclaw.update.applying", "1");
  expect(entry!.item).toMatchObject({ label: "Updating to v0.1.135: downloading…", subtitle: "$ git fetch --tags --no-recurse-submodules origin", disabled: true });
  expect(entry!.applyState).toBe("busy");
  expect(simpleUpdateTop(entry!)).toBeNull();
  expect(serverUpdateAction(entry!)).toBeNull();
});

it("says why the server refused, instead of pretending to update", async () => {
  const row = await checked(clone);
  f.answers["/api/updates/apply"] = new Error("This RootClaw folder has uncommitted changes to tracked files");
  row.item.onSelect?.();
  await flush();
  render();
  expect(entry!.item).toMatchObject({ label: "Update failed", subtitle: "This RootClaw folder has uncommitted changes to tracked files", disabled: false });
  expect(entry!.applyState).toBe("failed");
  expect(serverUpdateAction(entry!)).toBe("Check for updates");
});

it("copies the command where the server cannot install it, and says it copied", async () => {
  const row = await checked({ ...clone, install: "docker", canApply: false, command: "git pull && docker compose up -d --build" });
  expect(row.item.label).toBe("Version 0.1.135 available (click to copy the command)");
  expect(simpleUpdateTop(row)).toEqual({ label: "Update ready", action: "Copy command" });
  expect(serverUpdateAction(row)).toBe("Copy command");
  row.item.onSelect?.();
  await flush();
  render();
  expect(f.copied).toEqual(["git pull && docker compose up -d --build"]);
  expect(entry!.item.subtitle).toBe("Update command copied");
  expect(f.calls.some(([path]) => path === "/api/updates/apply")).toBe(false);
});

it("picks the progress back up after a reload mid-update, and reloads once the new version answers", async () => {
  vi.stubGlobal("sessionStorage", { getItem: vi.fn(() => "1"), setItem: vi.fn(), removeItem: vi.fn() });
  f.answers["/api/updates/status"] = { phase: "done", restart: "auto", from: "0.1.134", to: "0.1.135", current: "0.1.135", log: [] } satisfies ServerApplyStatus;
  vi.useFakeTimers();
  try {
    render();
    for (const effect of f.effects) effect();
    await flush();
    render();
    expect(entry!.item.label).toBe("Updated to v0.1.135");
    for (const effect of f.effects) effect();
    vi.advanceTimersByTime(1_500);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.removeItem).toHaveBeenCalledWith("rootclaw.update.applying");
  } finally {
    vi.useRealTimers();
  }
});

it("never asks for progress from a tab that did not start an update", async () => {
  render();
  for (const effect of f.effects) effect();
  await flush();
  expect(f.calls).toEqual([]);
});
