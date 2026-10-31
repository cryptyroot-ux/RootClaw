export interface RankableAi {
  driverKind: string;
  snapshot?: { freeFallback?: boolean };
}

/** What a test message through an AI showed: `untestable` is an AI with no one-off call to send one, trusted as before. */
export type AiTestState = "testing" | "passed" | "failed" | "untestable";

/** Ready only through free models: no login, no subscription, no key of the person's own. */
export function freeFallback(instance: RankableAi): boolean {
  return instance.snapshot?.freeFallback === true;
}

function tier(instance: RankableAi): number {
  return freeFallback(instance) ? 1 : 0;
}

/** A new list, best first; AIs of one kind keep the order they came in. */
export function rankAis<T extends RankableAi>(instances: readonly T[]): T[] {
  return instances.map((instance, index) => ({ instance, index, tier: tier(instance) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ instance }) => instance);
}

interface SignInSnapshot {
  state: string;
  authenticated?: boolean;
  account?: { email?: string; organization?: string; method?: string };
  freeFallback?: boolean;
}

/** Who an AI is signed in as: a test result holds until this changes. */
export function aiSignInKey(snapshot: SignInSnapshot): string {
  return JSON.stringify([
    snapshot.state, snapshot.authenticated ?? null, snapshot.account?.email ?? null, snapshot.account?.organization ?? null,
    snapshot.account?.method ?? null, snapshot.freeFallback === true,
  ]);
}
