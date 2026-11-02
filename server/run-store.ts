// A durable record of each native engine run (one turn on one engine): SQLite backend under the data dir,
// one row per run, updated in place. A run still "running" when the store loads was cut off by a restart,
// so it is marked interrupted and may be retried once. Falls back to in-memory-only if SQLite cannot open.
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { billableFor, type ModelPrice } from "./prices.ts";

export const RUNS_FILE = join("runs", "runs.jsonl");
const DB_FILE = "runs.db";
const MIGRATED_FILE = join("runs", "runs.jsonl.migrated");
const DEFAULT_CAP = 500;
/** A failed run this recent on the same thread and bot is the one the chain failed over from. */
const FAILOVER_WINDOW_MS = 120_000;

export type RunStatus = "running" | "completed" | "failed" | "interrupted";
export type RunToolStatus = "running" | "ok" | "failed" | "interrupted";

export interface RunTool { id: string; name: string; status: RunToolStatus; startedAt: number; endedAt?: number }

export interface RunRecord {
  id: string;
  threadId: string;
  botId?: string;
  instanceId?: string;
  driver?: string;
  model: string;
  /** Models this request went through, oldest first: a failover run carries the ones that failed before it. */
  chain: string[];
  failoverFrom?: string;
  status: RunStatus;
  rounds: number;
  tools: RunTool[];
  usage?: Record<string, number>;
  stopReason?: string | null;
  errors: string[];
  notices: number;
  retries: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  firstOutputMs?: number;
  /** Set when a failover-worthy error ended it (a rate limit, quota or sign-in hold). */
  failover?: boolean;
  retriedAt?: number;
  /** Whether `usage.costUsd` came from the provider or from a price RootClaw knows. */
  costSource?: "reported" | "estimated";
  /** The planner's latest plan for this run (engine.planVerify). */
  plan?: { steps: { id: string; title: string; status: string }[]; revisions: number; carried?: boolean };
  /** The verifier's self-checks of the final answer (engine.planVerify). */
  verify?: { attempts: number; verdict: "pass" | "fail" | "skipped"; missing?: string[] };
}

export interface RunBegin { runId: string; threadId: string; botId?: string; instanceId?: string; driver?: string; model: string }

type RuntimeEventLike = { type: string; turnId?: string } & Record<string, unknown>;

export interface RunStore {
  begin(input: RunBegin): void;
  observe(event: RuntimeEventLike): void;
  get(id: string): RunRecord | undefined;
  list(filter?: { botId?: string; threadId?: string; status?: RunStatus; limit?: number }): RunRecord[];
  retry(id: string, start: (run: RunRecord) => Promise<void>): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Runs this load found cut off by a restart. */
  readonly interruptedAtBoot: string[];
}

const numbers = (event: Record<string, unknown>) => {
  const out: Record<string, number> = {};
  for (const key of ["input", "output", "cachedInput", "cacheRead", "cacheWrite", "reasoning", "costUsd"]) {
    if (typeof event[key] === "number" && Number.isFinite(event[key])) out[key] = event[key] as number;
  }
  return out;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  bot_id TEXT,
  instance_id TEXT,
  driver TEXT,
  model TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT '[]',
  failover_from TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  rounds INTEGER NOT NULL DEFAULT 0,
  tools TEXT NOT NULL DEFAULT '[]',
  usage TEXT,
  stop_reason TEXT,
  errors TEXT NOT NULL DEFAULT '[]',
  notices INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  first_output_ms INTEGER,
  failover INTEGER NOT NULL DEFAULT 0,
  retried_at INTEGER,
  cost_source TEXT,
  plan TEXT,
  verify TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id);
CREATE INDEX IF NOT EXISTS idx_runs_bot ON runs(bot_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
`;

type DbRunRow = {
  id: string;
  thread_id: string;
  bot_id?: string;
  instance_id?: string;
  driver?: string;
  model: string;
  chain: string;
  failover_from?: string;
  status: string;
  rounds: number;
  tools: string;
  usage?: string;
  stop_reason?: string | null;
  errors: string;
  notices: number;
  retries: number;
  started_at: number;
  ended_at?: number;
  duration_ms?: number;
  first_output_ms?: number;
  failover?: number;
  retried_at?: number;
  cost_source?: string;
  plan?: string;
  verify?: string;
};

function rowToRecord(row: DbRunRow): RunRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    ...(row.bot_id != null ? { botId: row.bot_id } : {}),
    ...(row.instance_id != null ? { instanceId: row.instance_id } : {}),
    ...(row.driver != null ? { driver: row.driver } : {}),
    model: row.model,
    chain: (() => { try { return JSON.parse(row.chain) as string[]; } catch { return []; } })(),
    ...(row.failover_from != null ? { failoverFrom: row.failover_from } : {}),
    status: row.status as RunStatus,
    rounds: row.rounds,
    tools: (() => { try { return JSON.parse(row.tools) as RunTool[]; } catch { return []; } })(),
    ...(row.usage != null ? { usage: JSON.parse(row.usage) as Record<string, number> } : {}),
    ...(row.stop_reason != null ? { stopReason: row.stop_reason } : {}),
    errors: (() => { try { return JSON.parse(row.errors) as string[]; } catch { return []; } })(),
    notices: row.notices,
    retries: row.retries,
    startedAt: row.started_at,
    ...(row.ended_at != null ? { endedAt: row.ended_at } : {}),
    ...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
    ...(row.first_output_ms != null ? { firstOutputMs: row.first_output_ms } : {}),
    ...(row.failover === 1 ? { failover: true } : {}),
    ...(row.retried_at != null ? { retriedAt: row.retried_at } : {}),
    ...(row.cost_source != null ? { costSource: row.cost_source as "reported" | "estimated" } : {}),
    ...(row.plan != null ? { plan: JSON.parse(row.plan) } : {}),
    ...(row.verify != null ? { verify: JSON.parse(row.verify) } : {}),
  };
}

function recordToRow(run: RunRecord): Partial<DbRunRow> {
  return {
    id: run.id,
    thread_id: run.threadId,
    ...(run.botId !== undefined ? { bot_id: run.botId } : {}),
    ...(run.instanceId !== undefined ? { instance_id: run.instanceId } : {}),
    ...(run.driver !== undefined ? { driver: run.driver } : {}),
    model: run.model,
    chain: JSON.stringify(run.chain),
    ...(run.failoverFrom !== undefined ? { failover_from: run.failoverFrom } : {}),
    status: run.status,
    rounds: run.rounds,
    tools: JSON.stringify(run.tools),
    ...(run.usage !== undefined ? { usage: JSON.stringify(run.usage) } : {}),
    ...(run.stopReason !== undefined ? { stop_reason: run.stopReason } : {}),
    errors: JSON.stringify(run.errors),
    notices: run.notices,
    retries: run.retries,
    started_at: run.startedAt,
    ...(run.endedAt !== undefined ? { ended_at: run.endedAt } : {}),
    ...(run.durationMs !== undefined ? { duration_ms: run.durationMs } : {}),
    ...(run.firstOutputMs !== undefined ? { first_output_ms: run.firstOutputMs } : {}),
    ...(run.failover !== undefined ? { failover: run.failover ? 1 : 0 } : {}),
    ...(run.retriedAt !== undefined ? { retried_at: run.retriedAt } : {}),
    ...(run.costSource !== undefined ? { cost_source: run.costSource } : {}),
    ...(run.plan !== undefined ? { plan: JSON.stringify(run.plan) } : {}),
    ...(run.verify !== undefined ? { verify: JSON.stringify(run.verify) } : {}),
  };
}

export function createRunStore(options: { dataDir: string; cap?: number; now?: () => number; priceFor?: (driver: string, model: string) => ModelPrice | null }): RunStore {
  const cap = Math.max(1, options.cap ?? DEFAULT_CAP);
  const now = options.now ?? Date.now;
  const dbPath = join(options.dataDir, DB_FILE);
  const jsonlPath = join(options.dataDir, RUNS_FILE);

  let db: DatabaseSync | null = null;
  let inMemoryFallback = false;
  const runs = new Map<string, RunRecord>();

  // --- Open SQLite, migrate JSONL if present ---
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);

    // One-time migration: JSONL -> SQLite
    if (existsSync(jsonlPath)) {
      const migratedPath = join(options.dataDir, MIGRATED_FILE);
      const latestByRun = new Map<string, RunRecord>();
      try {
        for (const line of readFileSync(jsonlPath, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const row = JSON.parse(line) as { runId?: unknown; run?: RunRecord };
            if (typeof row.runId !== "string" || !row.run) continue;
            latestByRun.set(row.runId, row.run);
          } catch { /* skip corrupt JSONL line */ }
        }
      } catch { /* JSONL unreadable; proceed with empty migration */ }

      const insert = db.prepare(
        `INSERT OR REPLACE INTO runs (id, thread_id, bot_id, instance_id, driver, model, chain, failover_from, status, rounds, tools, usage, stop_reason, errors, notices, retries, started_at, ended_at, duration_ms, first_output_ms, failover, retried_at, cost_source, plan, verify)
         VALUES (@id, @thread_id, @bot_id, @instance_id, @driver, @model, @chain, @failover_from, @status, @rounds, @tools, @usage, @stop_reason, @errors, @notices, @retries, @started_at, @ended_at, @duration_ms, @first_output_ms, @failover, @retried_at, @cost_source, @plan, @verify)`
      );
      db.exec("BEGIN;");
      for (const run of latestByRun.values()) insert.run(recordToRow(run));
      db.exec("COMMIT;");

      try { renameSync(jsonlPath, migratedPath); } catch { /* backup rename best-effort */ }
    }

    // Load all runs from SQLite into memory cache
    const rows = db.prepare("SELECT * FROM runs").all() as DbRunRow[];
    for (const row of rows) runs.set(row.id, rowToRecord(row));
  } catch (error) {
    console.error(`[run-store] SQLite unavailable, falling back to in-memory: ${error instanceof Error ? error.message : String(error)}`);
    db = null;
    inMemoryFallback = true;
  }

  const save = (run: RunRecord) => {
    if (inMemoryFallback) { runs.set(run.id, run); return; }
    try {
      const insert = db!.prepare(
        `INSERT OR REPLACE INTO runs (id, thread_id, bot_id, instance_id, driver, model, chain, failover_from, status, rounds, tools, usage, stop_reason, errors, notices, retries, started_at, ended_at, duration_ms, first_output_ms, failover, retried_at, cost_source, plan, verify)
         VALUES (@id, @thread_id, @bot_id, @instance_id, @driver, @model, @chain, @failover_from, @status, @rounds, @tools, @usage, @stop_reason, @errors, @notices, @retries, @started_at, @ended_at, @duration_ms, @first_output_ms, @failover, @retried_at, @cost_source, @plan, @verify)`
      );
      insert.run(recordToRow(run));
      runs.set(run.id, run);
    } catch (error) {
      console.error(`[run-store] Write failed, keeping in memory only: ${error instanceof Error ? error.message : String(error)}`);
      runs.set(run.id, run);
    }
  };

  const compact = () => {
    if (inMemoryFallback) {
      while (runs.size > cap) runs.delete(runs.keys().next().value!);
      return;
    }
    try {
      const toDelete = [...runs.keys()].slice(0, Math.max(0, runs.size - cap));
      if (toDelete.length) {
        const del = db!.prepare("DELETE FROM runs WHERE id = ?");
        db!.exec("BEGIN;");
        for (const id of toDelete) del.run(id);
        db!.exec("COMMIT;");
        for (const id of toDelete) runs.delete(id);
      }
    } catch { try { db!.exec("ROLLBACK;"); } catch { /* ignore */ } /* kept in memory; next compaction tries again */ }
  };

  const priceRun = (run: RunRecord) => {
    if (!run.usage) return;
    if (typeof run.usage.costUsd === "number") { run.costSource = "reported"; return; }
    const driver = run.driver ?? "";
    let price: ModelPrice | null = null;
    try { price = options.priceFor?.(driver, run.model) ?? null; } catch { /* unpriced */ }
    if (!price) return;
    const cost = billableFor({ driverKind: driver, model: run.model, input: run.usage.input ?? 0, output: run.usage.output ?? 0,
      ...(run.usage.cachedInput ? { cachedInput: run.usage.cachedInput } : {}) }, { [run.model]: price });
    if (cost === null) return;
    run.usage.costUsd = cost;
    run.costSource = "estimated";
    save(run);
  };

  const interruptedAtBoot: string[] = [];
  for (const run of runs.values()) {
    if (run.status !== "running") continue;
    const at = now();
    run.status = "interrupted";
    run.stopReason = "restart";
    run.endedAt = at;
    run.durationMs = at - run.startedAt;
    for (const tool of run.tools) if (tool.status === "running") { tool.status = "interrupted"; tool.endedAt = at; }
    interruptedAtBoot.push(run.id);
    save(run);
  }
  if (runs.size > cap && !inMemoryFallback) compact();

  return {
    interruptedAtBoot,
    begin(input) {
      const at = now();
      const previous = [...runs.values()].reverse().find((run) => run.threadId === input.threadId && run.botId === input.botId && run.status !== "running");
      const from = previous?.failover && previous.endedAt !== undefined && at - previous.endedAt <= FAILOVER_WINDOW_MS ? previous : undefined;
      const run: RunRecord = {
        id: input.runId, threadId: input.threadId, model: input.model,
        ...(input.botId ? { botId: input.botId } : {}), ...(input.instanceId ? { instanceId: input.instanceId } : {}),
        ...(input.driver ? { driver: input.driver } : {}),
        chain: [...from?.chain ?? [], input.model], ...(from ? { failoverFrom: from.id } : {}),
        status: "running", rounds: 0, tools: [], errors: [], notices: 0, retries: 0, startedAt: at,
      };
      runs.delete(run.id);
      runs.set(run.id, run);
      if (runs.size > cap) compact();
      save(run);
    },
    observe(event) {
      const run = typeof event.turnId === "string" ? runs.get(event.turnId) : undefined;
      if (!run || run.status !== "running") return;
      const at = now();
      switch (event.type) {
        case "content.delta":
          if (run.firstOutputMs === undefined) { run.firstOutputMs = at - run.startedAt; save(run); }
          return;
        case "thread.token-usage.updated":
          run.rounds++;
          run.usage = numbers(event);
          break;
        case "item.started":
          if (event.itemType !== "tool" || typeof event.itemId !== "string") return;
          if (run.firstOutputMs === undefined) run.firstOutputMs = at - run.startedAt;
          run.tools.push({ id: event.itemId, name: typeof event.title === "string" ? event.title : "tool", status: "running", startedAt: at });
          break;
        case "item.completed": {
          if (event.itemType !== "tool") return;
          const tool = run.tools.findLast((entry) => entry.id === event.itemId);
          if (!tool) return;
          tool.status = event.ok === false ? "failed" : "ok";
          tool.endedAt = at;
          break;
        }
        case "plan.updated":
          if (!Array.isArray(event.steps)) return;
          run.plan = { steps: (event.steps as NonNullable<RunRecord["plan"]>["steps"]).slice(0, 8), revisions: typeof event.revision === "number" ? event.revision : (run.plan?.revisions ?? 0) + 1,
            ...(event.reason === "carried" || run.plan?.carried ? { carried: true } : {}) };
          break;
        case "verify.completed": {
          const verdict = event.verdict === "pass" || event.verdict === "fail" || event.verdict === "skipped" ? event.verdict : null;
          if (!verdict) return;
          const missing = Array.isArray(event.missing) ? (event.missing as unknown[]).filter((item): item is string => typeof item === "string").slice(0, 5) : [];
          run.verify = { attempts: (run.verify?.attempts ?? 0) + (verdict === "skipped" ? 0 : 1), verdict, ...(missing.length ? { missing } : {}) };
          break;
        }
        case "turn.retrying":
          run.retries++;
          break;
        case "runtime.notice":
          run.notices++;
          break;
        case "runtime.error":
          if (typeof event.message === "string") run.errors.push(event.message.slice(0, 2000));
          if (event.limit || event.limitResetsAt) run.failover = true;
          break;
        case "turn.completed":
          run.status = event.ok === true ? "completed" : event.stopReason === "interrupted" ? "interrupted" : "failed";
          run.stopReason = typeof event.stopReason === "string" ? event.stopReason : null;
          if (run.stopReason === "auth_required") run.failover = true;
          if (event.usage && typeof event.usage === "object") run.usage = numbers(event.usage as Record<string, unknown>);
          run.endedAt = at;
          run.durationMs = at - run.startedAt;
          for (const tool of run.tools) if (tool.status === "running") { tool.status = "interrupted"; tool.endedAt = at; }
          priceRun(run);
          break;
        default:
          return;
      }
      save(run);
    },
    get: (id) => runs.get(id),
    list(filter = {}) {
      const out: RunRecord[] = [];
      const limit = Math.max(1, Math.min(filter.limit ?? 100, cap));
      for (const run of [...runs.values()].reverse()) {
        if (filter.botId && run.botId !== filter.botId) continue;
        if (filter.threadId && run.threadId !== filter.threadId) continue;
        if (filter.status && run.status !== filter.status) continue;
        out.push(run);
        if (out.length >= limit) break;
      }
      return out;
    },
    async retry(id, start) {
      const run = runs.get(id);
      if (!run) return { ok: false, error: "no such run" };
      if (run.status === "running") return { ok: false, error: "run is still going" };
      if (run.status === "completed") return { ok: false, error: "run finished cleanly" };
      if (run.retriedAt !== undefined) return { ok: false, error: "already retried" };
      if (!run.botId) return { ok: false, error: "run has no bot to retry on" };
      try {
        await start(run);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      run.retriedAt = now();
      save(run);
      return { ok: true };
    },
  };
}