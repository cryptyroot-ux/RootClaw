// GET /api/updates/check: whether a newer release exists, and how this install is updated. Read-only, so client sessions may ask.
// POST /api/updates/apply and GET /api/updates/status: the owner's one-click update of a git clone (server/update-apply.ts).
import { join } from "node:path";
import { serverVersion } from "../environment.ts";
import { SERVER_ROOT } from "../proxy-paths.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { ApplyRefused, createUpdateApplier, RELEASE_VERSION, restartMode, STATUS_FILE, type UpdateApplier } from "../update-apply.ts";
import { cloneRoot, createUpdateChecker, installKind, type UpdateCheck } from "../update-check.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface UpdateCheckRouteDeps {
  check(): Promise<UpdateCheck>;
  /** Present only where this server can update itself: a git clone, not Windows, not switched off. */
  applier?: UpdateApplier | null;
}

/** Why this server will not update itself, or null when it may. */
export function selfUpdateRefusal(check: Pick<UpdateCheck, "install">, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (check.install !== "git") return "Only a git clone of RootClaw can update itself.";
  if (platform === "win32") return "One-click update is not available on Windows; run the update command instead.";
  if (env.ROOTCLAW_DISABLE_SELF_UPDATE === "1") return "One-click update is switched off on this server (ROOTCLAW_DISABLE_SELF_UPDATE).";
  return null;
}

export function createUpdateCheckRoutes(deps: UpdateCheckRouteDeps): RouteHandler {
  return async ({ res, path, method, json, auth }) => {
    if (path === "/api/updates/check" && method === "GET") {
      try {
        const check = await deps.check();
        return json(res, 200, { ...check, canApply: Boolean(deps.applier) && ownerOrAdmin(auth) });
      } catch (error) {
        return json(res, 502, { error: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (path === "/api/updates/status" && method === "GET") {
      if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin can see update progress." });
      if (!deps.applier) return json(res, 404, { error: "This server cannot update itself." });
      return json(res, 200, deps.applier.status());
    }
    if (path === "/api/updates/apply" && method === "POST") {
      if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin can update RootClaw." });
      const applier = deps.applier;
      if (!applier) return json(res, 409, { error: "This server cannot update itself. Use the update command shown in the menu." });
      if (applier.busy()) return json(res, 409, { error: "An update is already running.", status: applier.status() });
      let check: UpdateCheck;
      try {
        check = await deps.check();
      } catch (error) {
        return json(res, 502, { error: `Could not check for updates: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (!check.available || !check.latest) return json(res, 409, { error: "RootClaw is already up to date.", status: applier.status() });
      const last = applier.status();
      if (last.phase === "done" && last.restart === "manual" && last.to === check.latest) {
        return json(res, 409, { error: `v${check.latest} is already installed. Restart RootClaw to run it.`, status: last });
      }
      if (!RELEASE_VERSION.test(check.latest)) {
        return json(res, 502, { error: `The newest release (${check.latest}) is not a version number RootClaw can install. Update by hand from the release page.` });
      }
      // A second click that raced past busy() above still gets one run: start() is the lock.
      let started: boolean;
      try {
        started = applier.start(check.latest);
      } catch (error) {
        if (error instanceof ApplyRefused) return json(res, 409, { error: error.message, status: applier.status() });
        throw error;
      }
      if (!started) return json(res, 409, { error: "An update is already running.", status: applier.status() });
      return json(res, 202, applier.status());
    }
    return PASS;
  };
}

/** index.ts wiring: the checker, and an applier only where selfUpdateRefusal allows one. */
export function serverUpdateRouteDeps(where: { desktopManaged: boolean; managed: boolean; dataDir: string; restart: () => void }): UpdateCheckRouteDeps {
  const install = installKind({ ...where, serverRoot: SERVER_ROOT });
  const root = cloneRoot(SERVER_ROOT);
  const check = createUpdateChecker({ current: serverVersion(), install });
  if (selfUpdateRefusal({ install }) || !root) return { check, applier: null };
  return {
    check,
    applier: createUpdateApplier({ root, current: serverVersion(), statusFile: join(where.dataDir, STATUS_FILE), restartMode: restartMode(), restart: where.restart }),
  };
}
