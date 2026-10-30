import type { RequestAuth } from "../request-auth.ts";
import type { RunRecord, RunStatus, RunStore } from "../run-store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface RunRouteDeps {
  runs: Pick<RunStore, "list" | "get" | "retry">;
  /** Whether this session may see the thread a run belongs to. */
  threadVisible(auth: RequestAuth, threadId: string): boolean;
  /** Starts the thread again on its bot; throws why it could not. */
  resume(run: RunRecord): Promise<void>;
}

const STATUSES = new Set<RunStatus>(["running", "completed", "failed", "interrupted"]);

/** GET /api/runs[?botId&threadId&status&limit]: native engine runs, newest first. GET /api/runs/<id>: one run.
 * POST /api/runs/<id>/retry: run an interrupted or failed run's thread again, once. */
export function createRunRoutes(deps: RunRouteDeps): RouteHandler {
  return async ({ res, url, path, method, auth, json }) => {
    if (path === "/api/runs") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const status = url.searchParams.get("status") as RunStatus | null;
      const limit = Number(url.searchParams.get("limit") ?? "") || undefined;
      const runs = deps.runs.list({
        ...(url.searchParams.get("botId") ? { botId: url.searchParams.get("botId")! } : {}),
        ...(url.searchParams.get("threadId") ? { threadId: url.searchParams.get("threadId")! } : {}),
        ...(status && STATUSES.has(status) ? { status } : {}),
        ...(limit ? { limit } : {}),
      }).filter((run) => deps.threadVisible(auth, run.threadId));
      return json(res, 200, { runs });
    }
    const m = /^\/api\/runs\/([\w.:-]+)(\/retry)?$/.exec(path);
    if (!m) return PASS;
    const run = deps.runs.get(m[1]!);
    if (!run || !deps.threadVisible(auth, run.threadId)) return json(res, 404, { error: "no such run" });
    if (!m[2]) return method === "GET" ? json(res, 200, { run }) : json(res, 405, { error: "method not allowed" });
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const out = await deps.runs.retry(run.id, deps.resume);
    return out.ok ? json(res, 200, { started: true }) : json(res, 409, { error: out.error });
  };
}
