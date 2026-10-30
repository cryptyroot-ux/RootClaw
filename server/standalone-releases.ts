// Every AI build the app can install itself. Only these are put on PATH at start-up: a folder under tools/standalone
// that no release here names is never trusted. RootClaw installs no agent CLI, so none are named.
import type { StandaloneRelease } from "./contracts.ts";

export const STANDALONE_RELEASES: readonly StandaloneRelease[] = [];
