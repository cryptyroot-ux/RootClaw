import { describe, expect, it, vi } from "vitest";

import { WARM_SUMMARY_IDLE_MS, WARM_SUMMARY_RETRY_MS } from "../warm-summary.ts";
import { createWarmSummaryHost, PRESENCE_HOLD_MS, type WarmSummaryHostDeps } from "./warm-summary-host.ts";

/** A host over one direct conversation, written with RootClaw's own fold. */
function setup(overrides: Partial<WarmSummaryHostDeps> = {}, options: { room?: boolean } = {}) {
  let now = 5_000_000;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const task = { threadId: "t1", lastInstanceId: "claude" };
  const store = {
    taskByThread: (botId: string, threadId: string) => (botId === "b1" && threadId === "t1" ? task : undefined),
    botByThread: (threadId: string) => (threadId === "t1" ? { id: "b1" } : undefined),
    groupByThread: () => (options.room ? { id: "room" } : undefined),
  };
  const holds: Array<{ threadId: string; until: number | null }> = [];
  const adapter = { cacheKeepWarm: { hold: (threadId: string, until: number | null) => { holds.push({ threadId, until }); return true; } } };
  const fold = vi.fn(async () => true);
  const deps: WarmSummaryHostDeps = {
    store: store as unknown as WarmSummaryHostDeps["store"],
    instance: (id) => (id === "claude" ? { adapter } : undefined),
    enabled: () => true,
    busy: () => false,
    memoryShort: () => false,
    queued: () => false,
    coordinator: { activeDirect: () => false, awaitingTeammateThreads: () => new Set() },
    waits: () => ({ all: () => [] }),
    routines: () => ({ listRoutines: () => [], listRuns: () => [] }),
    fold,
    keepWarmUntil: () => undefined,
    now: () => now,
    after: (ms, fn) => {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    ...overrides,
  };
  const host = createWarmSummaryHost(deps);
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.cancelled = true;
      next.fn();
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    }
    now = until;
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const finishTurn = (instanceId = "claude") => host.turnCompleted({ threadId: "t1", botId: "b1", instanceId }, { ok: true, contextTokens: 150_000 });
  return { host, holds, fold, advance, finishTurn, now: () => now };
}

/** Whether the bot is busy or memory is short, for the test that waits on them. */
let busyNow = false;

describe("warm summaries for a direct conversation", () => {
  it("runs RootClaw's own fold once the conversation has been idle", async () => {
    const f = setup();
    f.finishTurn();
    await f.advance(WARM_SUMMARY_IDLE_MS - 1);
    expect(f.fold).not.toHaveBeenCalled();
    await f.advance(1);
    expect(f.fold).toHaveBeenCalledTimes(1);
    expect(f.fold).toHaveBeenCalledWith({ threadId: "t1", botId: "b1", instanceId: "claude" }, expect.any(AbortSignal));
  });

  it("never summarizes a room, with automatic compaction off, or on an engine that is gone", async () => {
    const room = setup({}, { room: true });
    room.finishTurn();
    await room.advance(WARM_SUMMARY_IDLE_MS * 3);
    expect(room.fold).not.toHaveBeenCalled();
    const off = setup({ enabled: () => false });
    off.finishTurn();
    await off.advance(WARM_SUMMARY_IDLE_MS * 3);
    expect(off.fold).not.toHaveBeenCalled();
    const gone = setup();
    gone.finishTurn("removed-engine");
    await gone.advance(WARM_SUMMARY_IDLE_MS * 3);
    expect(gone.fold).not.toHaveBeenCalled();
  });

  it.each([
    ["a queued message", { queued: () => true }],
    ["a teammate working on this conversation's request", { coordinator: { activeDirect: () => true, awaitingTeammateThreads: () => new Set<string>() } }],
    ["a teammate whose answer this conversation awaits", { coordinator: { activeDirect: () => false, awaitingTeammateThreads: () => new Set(["t1"]) } }],
    ["a wait that fired and will carry on here", { waits: () => ({ all: () => [{ id: "w", botId: "b1", threadId: "t1", label: "", condition: {} as never, followUp: "check CI", createdAt: 0, expiresAt: 0, nextCheckAt: 0, errors: 0, ending: { status: "fired" as const, text: "" } }] }) }],
  ] as Array<[string, Partial<WarmSummaryHostDeps>]>)("skips while work is due: %s", async (_name, overrides) => {
    const f = setup(overrides);
    f.finishTurn();
    await f.advance(WARM_SUMMARY_IDLE_MS * 10);
    expect(f.fold).not.toHaveBeenCalled();
  });

  it("waits for a routine due soon, a busy bot or short memory, then summarizes", async () => {
    let due = true;
    const routine = { id: "r", botId: "b1", enabled: true, nextRunAt: 0 } as never;
    const f = setup({ routines: () => ({ listRoutines: () => (due ? [{ ...(routine as object), nextRunAt: f.now() + 60_000 }] : []) as never, listRuns: () => [] }) });
    f.finishTurn();
    await f.advance(WARM_SUMMARY_IDLE_MS);
    expect(f.fold).not.toHaveBeenCalled();
    due = false;
    await f.advance(WARM_SUMMARY_RETRY_MS);
    expect(f.fold).toHaveBeenCalledTimes(1);
    for (const overrides of [{ busy: () => busyNow }, { memoryShort: () => busyNow }] as Array<Partial<WarmSummaryHostDeps>>) {
      busyNow = true;
      const g = setup(overrides);
      g.finishTurn();
      await g.advance(WARM_SUMMARY_IDLE_MS);
      expect(g.fold).not.toHaveBeenCalled();
      busyNow = false;
      await g.advance(WARM_SUMMARY_RETRY_MS);
      expect(g.fold).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps the conversation's process alive while the person has it open", async () => {
    const f = setup({ keepWarmUntil: () => 5_000_000 + 3 * 60 * 60_000 });
    f.host.sawThread("t1");
    expect(f.holds).toEqual([{ threadId: "t1", until: 5_000_000 + 3 * 60 * 60_000 }]);
    const g = setup();
    g.host.sawThread("t1");
    expect(g.holds).toEqual([{ threadId: "t1", until: g.now() + PRESENCE_HOLD_MS }]);
  });
});
