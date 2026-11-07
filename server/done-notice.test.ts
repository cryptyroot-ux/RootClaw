import { describe, expect, it } from "vitest";

import { createDoneNotice } from "./done-notice.ts";

const notice = (state: { awaiting?: Set<string>; queued?: Set<string> } = {}) => createDoneNotice({
  awaitingTeammates: (threadId) => state.awaiting?.has(threadId) ?? false,
  queuedFollowUp: (_botId, threadId) => state.queued?.has(threadId) ?? false,
});
const turn = (patch: Partial<Parameters<ReturnType<typeof notice>["atTurnEnd"]>[0]> = {}) =>
  ({ botId: "bot", threadId: "thread", review: false, ok: true, routine: false, ...patch });

describe("done notices", () => {
  it("notifies when an ordinary turn finishes", () => {
    expect(notice().atTurnEnd(turn())).toBe("notify");
  });

  it("holds a handoff notice until the reviewed answer arrives", () => {
    const awaiting = new Set(["thread"]);
    const done = notice({ awaiting });
    expect(done.atTurnEnd(turn())).toBe("hold");
    awaiting.clear();
    expect(done.atTurnEnd(turn({ review: true }))).toBe("notify");
    expect(done.atTurnEnd(turn({ review: true }))).toBe("quiet");
  });

  it("holds through another handoff and notifies only after the final review", () => {
    const awaiting = new Set(["thread"]);
    const done = notice({ awaiting });
    expect(done.atTurnEnd(turn())).toBe("hold");
    expect(done.atTurnEnd(turn({ review: true }))).toBe("hold");
    awaiting.clear();
    expect(done.atTurnEnd(turn({ review: true }))).toBe("notify");
  });

  it("keeps a review without an owed notice quiet", () => {
    expect(notice().atTurnEnd(turn({ review: true }))).toBe("quiet");
  });

  it("clears an owed notice quietly when the review fails", () => {
    const done = notice({ awaiting: new Set(["thread"]) });
    done.atTurnEnd(turn());
    expect(done.atTurnEnd(turn({ review: true, ok: false }))).toBe("quiet");
    expect(done.owes("thread")).toBe(false);
  });

  it("holds when a person has queued a follow-up", () => {
    expect(notice({ queued: new Set(["thread"]) }).atTurnEnd(turn())).toBe("hold");
  });

  it("drops an owed notice when a new person turn starts", () => {
    const done = notice({ awaiting: new Set(["thread"]) });
    done.atTurnEnd(turn());
    done.personTurnStarted("thread");
    expect(done.atTurnEnd(turn({ review: true }))).toBe("quiet");
  });

  it("leaves routine completions to their existing notice rules", () => {
    expect(notice({ awaiting: new Set(["thread"]), queued: new Set(["thread"]) }).atTurnEnd(turn({ routine: true }))).toBe("notify");
  });
});
