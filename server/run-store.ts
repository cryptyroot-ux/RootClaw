// A durable record of each native engine run (one turn on one engine): append-only JSONL under the data dir, one full
// snapshot per change, folded to the last snapshot per run on load. A run still "running" when the store loads was cut off
// by a restart, so it is marked interrupted and may be retried once.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { billableFor, type ModelPrice } from "./prices.ts";

export const RUNS_FILE = join("runs", "runs.jsonl");
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

export function createRunStore(options: { dataDir: string; cap?: number; now?: () => number; priceFor?: (driver: string, model: string) => ModelPrice | null }): RunStore {
  const file = join(options.dataDir, RUNS_FILE);
  const cap = Math.max(1, options.cap ?? DEFAULT_CAP);
  const now = options.now ?? Date.now;
  const runs = new Map<string, RunRecord>();
  let lines = 0;

  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { runId?: unknown; run?: RunRecord };
        if (typeof row.runId !== "string" || !row.run) continue;
        runs.delete(row.runId);
        runs.set(row.runId, row.run);
        lines++;
      } catch { /* a torn last line from a crash */ }
    }
  }

  const write = (run: RunRecord) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ runId: run.id, at: now(), run })}\n`);
      lines++;
    } catch { /* recording must never break a turn */ }
  };
  const compact = () => {
    while (runs.size > cap) runs.delete(runs.keys().next().value!);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, [...runs.values()].map((run) => `${JSON.stringify({ runId: run.id, at: now(), run })}\n`).join(""), { durable: false });
      lines = runs.size;
    } catch { /* kept in memory; the next compaction tries again */ }
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
  }
  if (interruptedAtBoot.length || runs.size > cap || lines > runs.size * 4) compact();

  const save = (run: RunRecord) => {
    write(run);
    if (lines > cap * 8) compact();
  };

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
      else save(run);
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
