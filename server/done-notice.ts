export type DoneVerdict = "notify" | "hold" | "quiet";

export interface DoneNoticeDeps {
  awaitingTeammates(threadId: string): boolean;
  queuedFollowUp(botId: string, threadId: string): boolean;
}

export function createDoneNotice(deps: DoneNoticeDeps) {
  const owed = new Set<string>();
  return {
    atTurnEnd(turn: { botId: string; threadId: string; review: boolean; ok: boolean; routine: boolean }): DoneVerdict {
      if (turn.review && !owed.has(turn.threadId)) return "quiet";
      if (turn.routine) return "notify";
      if (turn.ok && deps.awaitingTeammates(turn.threadId)) {
        owed.add(turn.threadId);
        return "hold";
      }
      if (turn.review) return owed.delete(turn.threadId) && turn.ok ? "notify" : "quiet";
      return deps.queuedFollowUp(turn.botId, turn.threadId) ? "hold" : "notify";
    },
    personTurnStarted(threadId: string): void {
      owed.delete(threadId);
    },
    owes: (threadId: string): boolean => owed.has(threadId),
  };
}

export type DoneNotice = ReturnType<typeof createDoneNotice>;
