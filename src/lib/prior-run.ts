// Read before main.tsx's first-paint writes: applySkin stamps rootclaw-skin on every boot.
const PRIOR_RUN_KEYS = ["rootclaw-skin", "rootclaw-installed", "rootclaw-email-gate", "rootclaw-drafts", "rootclaw-show-threads"];

export function hasPriorRun(store: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return PRIOR_RUN_KEYS.some((key) => store?.getItem(key) != null);
  } catch {
    return false;
  }
}
