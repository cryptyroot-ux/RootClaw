import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunStore, RUNS_FILE } from "./run-store.ts";

const dirs: string[] = [];
const stores: ReturnType<typeof createRunStore>[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "runs-")); dirs.push(d); return d; };
const openStore: typeof createRunStore = (options) => { const runs = createRunStore(options); stores.push(runs); return runs; };
afterEach(() => {
  vi.restoreAllMocks();
  for (const runs of stores.splice(0)) runs.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ev = (turnId: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ eventId: "e", provider: "openai-compat", threadId: "t1", turnId, createdAt: new Date().toISOString(), type, ...extra }) as never;

function clock(start = 1_000) { let t = start; return { now: () => t, tick: (ms: number) => { t += ms; } }; }

describe("run store", () => {
  it("releases its SQLite connection before its data directory is removed", () => {
    const d = dir();
    const runs = openStore({ dataDir: d });
    runs.close();
    expect(() => rmSync(d, { recursive: true, force: true })).not.toThrow();
    dirs.splice(dirs.indexOf(d), 1);
  });

  it("records a native run: model, rounds, tool calls with status, usage, stop reason and timings", () => {
    const d = dir(); const c = clock();
    const runs = openStore({ dataDir: d, now: c.now });
    runs.begin({ runId: "r1", threadId: "t1", botId: "b1", instanceId: "i1", driver: "openai-compat", model: "m1" });
    c.tick(100); runs.observe(ev("r1", "content.delta", { delta: "hi" }));
    runs.observe(ev("r1", "thread.token-usage.updated", { input: 10, output: 2 }));
    runs.observe(ev("r1", "item.started", { itemType: "tool", itemId: "c1", title: "read_file" }));
    c.tick(50); runs.observe(ev("r1", "item.completed", { itemType: "tool", itemId: "c1", ok: false }));
    runs.observe(ev("r1", "thread.token-usage.updated", { input: 30, output: 9, costUsd: 0.01 }));
    runs.observe(ev("r1", "runtime.error", { message: "boom" }));
    c.tick(10); runs.observe(ev("r1", "turn.completed", { ok: false, stopReason: "error" }));
    const run = runs.get("r1")!;
    expect(run).toMatchObject({ id: "r1", botId: "b1", threadId: "t1", chain: ["m1"], status: "failed", rounds: 2,
      usage: { input: 30, output: 9, costUsd: 0.01 }, stopReason: "error", errors: ["boom"], startedAt: 1000, endedAt: 1160,
      firstOutputMs: 100, durationMs: 160 });
    expect(run.tools).toEqual([{ id: "c1", name: "read_file", status: "failed", startedAt: 1100, endedAt: 1150 }]);
    // Durable: a fresh store reads the same run back from SQLite.
    expect(openStore({ dataDir: d, now: c.now }).get("r1")).toEqual(run);
  });

  it("estimates a run's cost from the price it is given when the provider reports none", () => {
    const runs = openStore({ dataDir: dir(), priceFor: (driver, model) => driver === "openai-compat" && model === "MyCombo" ? { inputPerMillion: 1, outputPerMillion: 2 } : null });
    runs.begin({ runId: "r", threadId: "t1", driver: "openai-compat", model: "MyCombo" });
    runs.observe(ev("r", "thread.token-usage.updated", { input: 1_000_000, output: 500_000 }));
    runs.observe(ev("r", "turn.completed", { ok: true, stopReason: "end_turn" }));
    expect(runs.get("r")).toMatchObject({ stopReason: "end_turn", usage: { costUsd: 2 }, costSource: "estimated" });
    runs.begin({ runId: "s", threadId: "t2", driver: "openai-compat", model: "MyCombo" });
    runs.observe(ev("s", "thread.token-usage.updated", { input: 10, output: 1, costUsd: 0.5 }));
    runs.observe(ev("s", "turn.completed", { ok: true, stopReason: "end_turn" }));
    expect(runs.get("s")).toMatchObject({ usage: { costUsd: 0.5 }, costSource: "reported" });
  });

  it("records the plan and the verifier's checks, and persists them", () => {
    const d = dir();
    const runs = openStore({ dataDir: d });
    runs.begin({ runId: "r", threadId: "t1", model: "m" });
    runs.observe(ev("r", "plan.updated", { steps: [{ id: "1", title: "a", status: "doing" }], revision: 1, reason: "initial" }));
    runs.observe(ev("r", "plan.updated", { steps: [{ id: "1", title: "a", status: "done" }], revision: 2, reason: "replan" }));
    runs.observe(ev("r", "verify.completed", { verdict: "fail", attempt: 1, missing: ["tests"] }));
    runs.observe(ev("r", "verify.completed", { verdict: "pass", attempt: 2 }));
    runs.observe(ev("r", "turn.completed", { ok: true, stopReason: "end_turn" }));
    const expected = { plan: { steps: [{ id: "1", title: "a", status: "done" }], revisions: 2 }, verify: { attempts: 2, verdict: "pass" } };
    expect(runs.get("r")).toMatchObject(expected);
    expect(openStore({ dataDir: d }).get("r")).toMatchObject(expected);
  });

  it("marks a budget stop as completed, not failed", () => {
    const runs = openStore({ dataDir: dir() });
    runs.begin({ runId: "r", threadId: "t1", model: "m" });
    runs.observe(ev("r", "turn.completed", { ok: true, stopReason: "budget" }));
    expect(runs.get("r")).toMatchObject({ status: "completed", stopReason: "budget" });
  });

  it("marks runs that were still going at a restart as interrupted, and they can be retried once", async () => {
    const d = dir();
    const first = openStore({ dataDir: d });
    first.begin({ runId: "r", threadId: "t1", botId: "b1", model: "m" });
    first.observe(ev("r", "item.started", { itemType: "tool", itemId: "c", title: "shell" }));
    const second = openStore({ dataDir: d });
    expect(second.interruptedAtBoot).toEqual(["r"]);
    expect(second.get("r")).toMatchObject({ status: "interrupted", stopReason: "restart" });
    expect(second.get("r")!.tools[0].status).toBe("interrupted");
    const started: unknown[] = [];
    const out = await second.retry("r", async (run) => { started.push([run.botId, run.threadId]); });
    expect(out).toEqual({ ok: true });
    expect(started).toEqual([["b1", "t1"]]);
    expect(second.get("r")!.retriedAt).toBeTypeOf("number");
    expect(await second.retry("r", async () => {})).toEqual({ ok: false, error: "already retried" });
    expect(openStore({ dataDir: d }).interruptedAtBoot).toEqual([]);
  });

  it("will not retry a run that is still going or that succeeded", async () => {
    const runs = openStore({ dataDir: dir() });
    runs.begin({ runId: "r", threadId: "t1", botId: "b", model: "m" });
    expect(await runs.retry("r", async () => {})).toEqual({ ok: false, error: "run is still going" });
    runs.observe(ev("r", "turn.completed", { ok: true, stopReason: "end_turn" }));
    expect(await runs.retry("r", async () => {})).toEqual({ ok: false, error: "run finished cleanly" });
    expect(await runs.retry("nope", async () => {})).toEqual({ ok: false, error: "no such run" });
  });

  it("chains a failover run onto the model that failed before it on the same thread", () => {
    const c = clock();
    const runs = openStore({ dataDir: dir(), now: c.now });
    runs.begin({ runId: "a", threadId: "t1", botId: "b", model: "m1" });
    runs.observe(ev("a", "runtime.error", { message: "rate limited", limit: "engine" }));
    runs.observe(ev("a", "turn.completed", { ok: false, stopReason: "error" }));
    c.tick(1000);
    runs.begin({ runId: "b", threadId: "t1", botId: "b", model: "m2" });
    expect(runs.get("b")).toMatchObject({ chain: ["m1", "m2"], failoverFrom: "a" });
  });

  it("lists newest first with filters, and keeps only the newest runs past the cap", () => {
    const d = dir(); const c = clock();
    const runs = openStore({ dataDir: d, cap: 3, now: c.now });
    for (const id of ["1", "2", "3", "4", "5"]) {
      c.tick(1);
      runs.begin({ runId: id, threadId: id === "5" ? "t2" : "t1", botId: "b", model: "m" });
      runs.observe(ev(id, "turn.completed", { ok: true, stopReason: "end_turn" }));
    }
    expect(runs.list().map(r => r.id)).toEqual(["5", "4", "3"]);
    expect(runs.list({ threadId: "t1" }).map(r => r.id)).toEqual(["4", "3"]);
    expect(runs.list({ limit: 1 }).map(r => r.id)).toEqual(["5"]);
    const reopened = openStore({ dataDir: d, cap: 3 });
    expect(reopened.list().map(r => r.id)).toEqual(["5", "4", "3"]);
  });

  it("ignores events for runs it never began", () => {
    const d = dir();
    const runs = openStore({ dataDir: d });
    runs.begin({ runId: "r", threadId: "t1", model: "m" });
    runs.observe(ev("other", "turn.completed", { ok: true }));
    expect(openStore({ dataDir: d }).list().map(r => r.id)).toEqual(["r"]);
  });

  it("migrates JSONL runs to SQLite on first boot, then stops writing JSONL", () => {
    const d = dir();
    const { mkdirSync, appendFileSync } = require("node:fs");
    mkdirSync(join(d, "runs"), { recursive: true });
    const oldRun = {
      id: "old-1", threadId: "t1", botId: "b1", model: "m1", chain: ["m1"], status: "completed",
      rounds: 1, tools: [], errors: [], notices: 0, retries: 0, startedAt: 1000, endedAt: 1100, durationMs: 100,
    };
    appendFileSync(join(d, RUNS_FILE), `${JSON.stringify({ runId: "old-1", at: 1000, run: oldRun })}\n`);
    appendFileSync(join(d, RUNS_FILE), "not valid json\n");
    appendFileSync(join(d, RUNS_FILE), `${JSON.stringify({ runId: "old-2", at: 2000, run: { ...oldRun, id: "old-2", threadId: "t2", status: "running" } })}\n`);

    const runs = openStore({ dataDir: d });
    expect(runs.get("old-1")).toMatchObject({ id: "old-1", status: "completed" });
    expect(runs.get("old-2")).toMatchObject({ id: "old-2", status: "interrupted", stopReason: "restart" });
    // JSONL should have been renamed to .migrated
    const migratedExists = (() => { try { require("node:fs").statSync(join(d, "runs", "runs.jsonl.migrated")); return true; } catch { return false; } })();
    expect(migratedExists).toBe(true);
  });

  it("falls back to in-memory when SQLite database is corrupt", () => {
    const d = dir();
    // Create a corrupt SQLite file
    writeFileSync(join(d, "runs.db"), "not a sqlite database");
    const runs = openStore({ dataDir: d });
    runs.begin({ runId: "r", threadId: "t1", model: "m" });
    expect(runs.get("r")).toMatchObject({ id: "r", status: "running" });
    // Turn still works despite corrupt DB
    runs.observe(ev("r", "turn.completed", { ok: true, stopReason: "end_turn" }));
    expect(runs.get("r")).toMatchObject({ status: "completed" });
  });

  it("closes SQLite when schema initialization fails after opening the database", () => {
    const d = dir();
    const database = new DatabaseSync(join(d, "runs.db"));
    database.exec("CREATE TABLE runs (id TEXT)");
    database.close();
    const close = vi.spyOn(DatabaseSync.prototype, "close");

    const runs = openStore({ dataDir: d });
    runs.begin({ runId: "r", threadId: "t1", model: "m" });

    expect(runs.get("r")).toMatchObject({ id: "r", status: "running" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
