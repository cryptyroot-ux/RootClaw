// Warm summaries for direct conversations (server/warm-summary.ts decides when): what may delay one, and how one is
// written: RootClaw's own fold (the last two exchanges kept, the rest summarized), run now rather than at the next turn's
// start, once the conversation is close to where that turn would fold it. The person sees the summary note, as with
// compaction today.
import { wakeHoldOf } from "../routine-due.ts";
import type { Routine, RoutineRun } from "../routines.ts";
import type { Store } from "../store.ts";
import type { WaitRecord } from "../waits.ts";
import { createWarmSummary, WARM_SUMMARY_RETRY_MS, type WarmSummaryPlan, type WarmSummaryTarget } from "../warm-summary.ts";

/** RootClaw's fold runs while idle once a conversation is this close to where the next turn would fold it. */
export const HARNESS_IDLE_FRACTION = 0.85;
/** While the person has a conversation in front of them, its engine process is kept this long past their last activity. */
export const PRESENCE_HOLD_MS = 10 * 60_000;

export interface WarmSummaryHostDeps {
  store: Pick<Store, "taskByThread" | "botByThread" | "groupByThread">;
  instance(instanceId: string): { adapter: { cacheKeepWarm?: { hold(threadId: string, until: number | null): boolean } } } | null | undefined;
  /** RootClaw: opt-in with ROOTCLAW_WARM_SUMMARY=1 (compaction timing unchanged by default); off with `context.autoCompact: false`. */
  enabled(): boolean;
  /** A turn is running or being set up in this conversation, or the bot is busy elsewhere. */
  busy(botId: string, threadId: string): boolean;
  memoryShort(): boolean;
  /** What can wake a conversation without the person: a queued message, a teammate's answer, a wait, a routine. */
  queued(botId: string, threadId: string): boolean;
  coordinator: { activeDirect(threadId: string): boolean; awaitingTeammateThreads(): Set<string> };
  waits(): { all(): WaitRecord[] } | null;
  routines(): { listRoutines(): Routine[]; listRuns(): RoutineRun[] } | null;
  /** RootClaw's fold, now: true when it wrote a summary, false when the conversation does not need one yet. */
  fold(target: WarmSummaryTarget, signal: AbortSignal): Promise<boolean>;
  /** Until when keep-warm already holds this conversation's process. */
  keepWarmUntil(threadId: string): number | undefined;
  now?(): number;
  after?(ms: number, fn: () => void): { cancel(): void };
  log?(line: string): void;
}

export function createWarmSummaryHost(deps: WarmSummaryHostDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;

  const warm = createWarmSummary({
    now,
    timeScale: Number(process.env.ROOTCLAW_WARM_SUMMARY_TIME_SCALE) || 1,
    after: deps.after ?? ((ms, fn) => { const timer = setTimeout(fn, ms); timer.unref?.(); return { cancel: () => clearTimeout(timer) }; }),
    plan: (target): WarmSummaryPlan | null => {
      if (!deps.enabled() || store.groupByThread(target.threadId) || !store.taskByThread(target.botId, target.threadId)) return null;
      if (!deps.instance(target.instanceId)) return null;
      return { way: "harness", soon: false };
    },
    hold: ({ botId, threadId }) => {
      if (deps.busy(botId, threadId)) return { reason: "the bot is busy", retry: true };
      if (deps.memoryShort()) return { reason: "memory is short", retry: true };
      if (deps.queued(botId, threadId)) return { reason: "a message is waiting for this conversation", retry: false };
      if (deps.coordinator.activeDirect(threadId) || deps.coordinator.awaitingTeammateThreads().has(threadId)) {
        return { reason: "a teammate is working on this conversation's request", retry: false };
      }
      if (deps.waits()?.all().some((w) => w.botId === botId && w.threadId === threadId && w.followUp !== undefined && w.ending?.status === "fired")) {
        return { reason: "a wait has fired and will carry on here", retry: false };
      }
      const routines = deps.routines();
      if (routines && wakeHoldOf(routines.listRoutines().filter((r) => r.botId === botId), routines.listRuns().filter((r) => r.botId === botId), now(), WARM_SUMMARY_RETRY_MS).hold) {
        return { reason: "a routine of this bot is about to run", retry: true };
      }
      return null;
    },
    run: async (target, _plan, control) => {
      return await deps.fold(target, control.signal) ? { ok: true } : { ok: false, reason: "the conversation does not need a summary yet" };
    },
    log: deps.log,
  });

  return {
    ...warm,
    /** The person has the conversation in front of them (opened it, or is active in the app with it open). */
    sawThread(threadId: string): void {
      warm.seen(threadId);
      const bot = store.botByThread(threadId);
      const instanceId = bot ? store.taskByThread(bot.id, threadId)?.lastInstanceId : undefined;
      const hold = instanceId ? deps.instance(instanceId)?.adapter.cacheKeepWarm?.hold : undefined;
      if (hold) hold(threadId, Math.max(now() + PRESENCE_HOLD_MS, deps.keepWarmUntil(threadId) ?? 0));
    },
  };
}

export type WarmSummaryHost = ReturnType<typeof createWarmSummaryHost>;
