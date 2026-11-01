// A self-hosted server cannot replace itself, so this only says whether a newer release exists and how this install is updated.
import { existsSync } from "node:fs";
import { join, sep } from "node:path";

export const LATEST_RELEASE_URL = "https://api.github.com/repos/cryptyroot-ux/RootClaw/releases/latest";
const CACHE_MS = 60 * 60_000;

/** "managed" is a hosted or Cloud server that is updated for its owner. */
export type InstallKind = "desktop" | "managed" | "docker" | "podman" | "npm" | "git" | "unknown";

/** A clone is updated in place: pull, then rebuild the web app and the server it serves. */
export const CLONE_UPGRADE = "git pull && pnpm install && pnpm build && pnpm build:server";

/** The rootclaw npm package is private and unpublished, so an install that is not a clone has nothing to update from. */
export const NOT_A_CLONE = `This RootClaw install is not a git clone, so it cannot update itself: the rootclaw npm package is not published. Clone https://github.com/cryptyroot-ux/RootClaw, build it (pnpm install && pnpm build && pnpm build:server) and run it from there; later updates are \`${CLONE_UPGRADE}\` in that clone.`;

/** As docs/self-hosting.md and deploy/podman/README.md give them. A non-clone install gets NOT_A_CLONE instead of a command. */
export const UPDATE_COMMANDS: Partial<Record<InstallKind, { command: string; restart: boolean }>> = {
  docker: { command: "docker compose pull rootclaw && docker compose up -d", restart: false },
  podman: { command: "git pull && cd deploy/podman && PODMAN_COMPOSE_PROVIDER=podman-compose podman compose --env-file .env -f compose.yaml up -d --build", restart: false },
  git: { command: CLONE_UPGRADE, restart: true },
};

/** The git clone a server runs from: the folder above its own (server/ or dist-server/) when that holds .git; null otherwise. */
export function cloneRoot(serverRoot: string, exists: (path: string) => boolean = existsSync): string | null {
  const root = join(serverRoot, "..");
  return exists(join(root, ".git")) ? root : null;
}

export function installKind(input: {
  desktopManaged: boolean;
  managed: boolean;
  serverRoot: string;
  exists?: (path: string) => boolean;
}): InstallKind {
  const exists = input.exists ?? existsSync;
  if (input.desktopManaged) return "desktop";
  if (input.managed) return "managed";
  if (exists("/.dockerenv")) return "docker";
  if (exists("/run/.containerenv")) return "podman";
  if (input.serverRoot.split(sep).includes("node_modules")) return "npm";
  if (cloneRoot(input.serverRoot, exists)) return "git";
  return "unknown";
}

/** Semver order on tags such as "v0.1.92"; a prerelease sorts before its release, and anything unparseable is never an update. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (version: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
    return match ? { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? [] } : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i]! !== b.core[i]!) return a.core[i]! > b.core[i]!;
  }
  if (!a.pre.length || !b.pre.length) return !a.pre.length && b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return y === undefined;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y);
    if (xn !== yn) return yn;
    return x > y;
  }
  return false;
}

export interface UpdateCheck {
  current: string;
  install: InstallKind;
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  command?: string;
  restart?: boolean;
  /** Why there is no command: this install is not a clone (NOT_A_CLONE). */
  note?: string;
}

/** One cached GitHub lookup an hour, shared by every caller. */
export function createUpdateChecker(options: {
  current: string;
  install: InstallKind;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const fetchRelease = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { at: number; result: UpdateCheck } | undefined;
  let inflight: Promise<UpdateCheck> | undefined;
  const base = (): UpdateCheck => ({
    current: options.current,
    install: options.install,
    available: false,
    ...UPDATE_COMMANDS[options.install],
    ...(options.install === "npm" || options.install === "unknown" ? { note: NOT_A_CLONE } : {}),
  });

  return async function check(): Promise<UpdateCheck> {
    if (options.install === "desktop" || options.install === "managed") return base();
    if (cached && now() - cached.at < CACHE_MS) return cached.result;
    inflight ??= (async () => {
      try {
        const response = await fetchRelease(LATEST_RELEASE_URL, {
          headers: { accept: "application/vnd.github+json", "user-agent": "rootclaw-update-check" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
        const release = await response.json() as { tag_name?: unknown; html_url?: unknown };
        if (typeof release.tag_name !== "string") throw new Error("GitHub sent no release tag");
        const latest = release.tag_name.replace(/^v/, "");
        const result: UpdateCheck = {
          ...base(),
          latest,
          available: isNewerVersion(latest, options.current),
          ...(typeof release.html_url === "string" ? { releaseUrl: release.html_url } : {}),
        };
        cached = { at: now(), result };
        return result;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };
}
