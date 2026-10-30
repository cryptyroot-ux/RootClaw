/** The approval levels exposed by the app. Each one is a provider's own
 * permission mode, passed through: RootClaw never decides a permission
 * itself (Full access aside, which answers residual prompts because that is
 * what the person granted). The order is the order the selector shows. */
export const APPROVAL_MODES = ["ask", "edits", "auto", "full", "custom"] as const;

export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Only levels the native engine implements may be exposed. Native engines
 * have no auto-accept-edits mode and no provider-specific Custom grant, so
 * those two levels are unavailable; Full access runs with the harness
 * answering the permission requests it leaves. */
export function supportsApprovalMode(_driverKind: string | undefined, mode: ApprovalMode): boolean {
  return mode !== "custom" && mode !== "edits";
}

/** Whether switching engines must first drop this level to Ask. A Custom
 * grant's rules belong to one provider's tool semantics, so it never crosses
 * engines; Full carries silently to any engine; Auto-accept edits stops at an
 * engine without it.
 * Adapted from tahodev's provider-switch guard. */
export function modelSwitchNeedsAsk(
  mode: ApprovalMode,
  fromDriver: string | undefined,
  toDriver: string | undefined,
): boolean {
  return !supportsApprovalMode(toDriver, mode) || (mode === "custom" && fromDriver !== toDriver);
}

/** No native engine ships its own approval reviewer. */
export function hasNativeAutoReview(_driverKind: string | undefined): boolean {
  return false;
}

const APPROVAL_RANK: Record<ApprovalMode, number> = { ask: 0, edits: 1, auto: 2, full: 3, custom: 4 };

export interface ApprovalFields {
  approvalMode?: ApprovalMode;
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

export function threadApproval(thread: ApprovalFields, bot: ApprovalFields): ApprovalFields {
  return {
    approvalMode: thread.approvalMode ?? (thread.autoApprove === undefined ? bot.approvalMode : undefined),
    autoApprove: thread.autoApprove ?? bot.autoApprove,
    alwaysAllow: structuredClone(thread.alwaysAllow ?? bot.alwaysAllow),
  };
}

export function approvalModeWidens(from: ApprovalMode, to: ApprovalMode): boolean {
  return APPROVAL_RANK[to] > APPROVAL_RANK[from];
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

/** The level a bot or conversation runs at until a person picks one: Full
 * access, as in t3code (its DEFAULT_RUNTIME_MODE). Each provider maps it to
 * its own most permissive mode; a real question or a missing credential
 * still reaches a person. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "full";

let defaultApprovalMode: ApprovalMode = DEFAULT_APPROVAL_MODE;

/** On a shared company workspace Full access comes only from the operator's
 * own policy, so its server makes Ask the default once, at startup. */
export function setDefaultApprovalMode(mode: ApprovalMode): void {
  defaultApprovalMode = mode;
}

/** An unset level runs at the default, the pre-approvalMode Auto bit reads as
 * safe Auto, and an unknown persisted value fails closed to Ask. */
export function approvalModeFor(bot: {
  approvalMode?: unknown;
  autoApprove?: unknown;
  /** Server-only two-phase grant marker. Until Electron confirms it, the
   * stored elevated selection is deliberately executable only as Ask. */
  approvalGrant?: unknown;
  threadId?: string;
}): ApprovalMode {
  const grant = bot.approvalGrant;
  const otherThread = grant && typeof grant === "object" && "threadOnly" in grant && grant.threadOnly === true &&
    "threadId" in grant && typeof grant.threadId === "string" && typeof bot.threadId === "string" && grant.threadId !== bot.threadId;
  if (grant && !otherThread) return "ask";
  if (isApprovalMode(bot.approvalMode)) return bot.approvalMode;
  if (bot.autoApprove === true) return "auto";
  return bot.approvalMode === undefined ? defaultApprovalMode : "ask";
}

/** A private late-grant recovery may revoke an elevated mode even after a
 * turn began. It can only move to the fail-closed Ask mode, and it also stops
 * the running turn, which a native engine would otherwise finish elevated. */
export function isEmergencyApprovalDowngrade(
  current: ApprovalMode,
  next: ApprovalMode,
): boolean {
  return next === "ask" && (current === "full" || current === "custom");
}
