import { mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunStore, RUNS_FILE } from "./run-store.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "runs-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ev = (turnId: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ eventId: "e", provider: "openai-compat", threadId: "t1", turnId, createdAt: new Date().toISOString(), type, ...extra }) as never;

function clock(start = 1_000) { let t = start; return { now: () => t, tick: (ms: number) => { t += ms; } }; }

describe("run store", () => {
  it("records a native run: model, rounds, tool calls with status, usage, stop reason and timings", () => {
    const d = dir(); const c = clock();
    const runs = createRunStore({ dataDir: d, now: c.now });
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
    // Durable: a fresh store reads the same run back.
    expect(createRunStore({ dataDir: d, now: c.now }).get("r1")).toEqual(run);
  });

  it("marks a budget stop as completed, not failed", () => {
    const runs = createRunStore({ dataDir: dir() });
    runs.begin({ runId: "r", threadId: "t1", model: "m" });
    runs.observe(ev("r", "turn.completed", { ok: true, stopReason: "budget" }));
    expect(runs.get("r")).toMatchObject({ status: "completed", stopReason: "budget" });
  });

  it("marks runs that were still going at a restart as interrupted, and they can be retried once", async () => {
    const d = dir();
    const first = createRunStore({ dataDir: d });
    first.begin({ runId: "r", threadId: "t1", botId: "b1", model: "m" });
    first.observe(ev("r", "item.started", { itemType: "tool", itemId: "c", title: "shell" }));
    const second = createRunStore({ dataDir: d });
    expect(second.interruptedAtBoot).toEqual(["r"]);
    expect(second.get("r")).toMatchObject({ status: "interrupted", stopReason: "restart" });
    expect(second.get("r")!.tools[0].status).toBe("interrupted");
    const started: unknown[] = [];
    const out = await second.retry("r", async (run) => { started.push([run.botId, run.threadId]); });
    expect(out).toEqual({ ok: true });
    expect(started).toEqual([["b1", "t1"]]);
    expect(second.get("r")!.retriedAt).toBeTypeOf("number");
    expect(await second.retry("r", async () => {})).toEqual({ ok: false, error: "already retried" });
    expect(createRunStore({ dataDir: d }).interruptedAtBoot).toEqual([]);
  });

  it("will not retry a run that is still going or that succeeded", async () => {
    const runs = createRunStore({ dataDir: dir() });
    runs.begin({ runId: "r", threadId: "t1", botId: "b", model: "m" });
    expect(await runs.retry("r", async () => {})).toEqual({ ok: false, error: "run is still going" });
    runs.observe(ev("r", "turn.completed", { ok: true, stopReason: "end_turn" }));
    expect(await runs.retry("r", async () => {})).toEqual({ ok: false, error: "run finished cleanly" });
    expect(await runs.retry("nope", async () => {})).toEqual({ ok: false, error: "no such run" });
  });

  it("chains a failover run onto the model that failed before it on the same thread", () => {
    const c = clock();
    const runs = createRunStore({ dataDir: dir(), now: c.now });
    runs.begin({ runId: "a", threadId: "t1", botId: "b", model: "m1" });
    runs.observe(ev("a", "runtime.error", { message: "rate limited", limit: "engine" }));
    runs.observe(ev("a", "turn.completed", { ok: false, stopReason: "error" }));
    c.tick(1000);
    runs.begin({ runId: "b", threadId: "t1", botId: "b", model: "m2" });
    expect(runs.get("b")).toMatchObject({ chain: ["m1", "m2"], failoverFrom: "a" });
  });

  it("lists newest first with filters, and keeps only the newest runs past the cap", () => {
    const d = dir(); const c = clock();
    const runs = createRunStore({ dataDir: d, cap: 3, now: c.now });
    for (const id of ["1", "2", "3", "4", "5"]) {
      c.tick(1);
      runs.begin({ runId: id, threadId: id === "5" ? "t2" : "t1", botId: "b", model: "m" });
      runs.observe(ev(id, "turn.completed", { ok: true, stopReason: "end_turn" }));
    }
    expect(runs.list().map(r => r.id)).toEqual(["5", "4", "3"]);
    expect(runs.list({ threadId: "t1" }).map(r => r.id)).toEqual(["4", "3"]);
    expect(runs.list({ limit: 1 }).map(r => r.id)).toEqual(["5"]);
    const reopened = createRunStore({ dataDir: d, cap: 3 });
    expect(reopened.list().map(r => r.id)).toEqual(["5", "4", "3"]);
    const lines = readFileSync(join(d, RUNS_FILE), "utf8").trim().split("\n");
    expect(lines.every(line => ["3", "4", "5"].includes(JSON.parse(line).runId))).toBe(true);
  });

  it("skips a torn last line and ignores events for runs it never began", () => {
    const d = dir();
    const runs = createRunStore({ dataDir: d });
    runs.begin({ runId: "r", threadId: "t1", model: "m" });
    runs.observe(ev("other", "turn.completed", { ok: true }));
    appendFileSync(join(d, RUNS_FILE), "{\"op\":\"end\",\"run");
    expect(createRunStore({ dataDir: d }).list().map(r => r.id)).toEqual(["r"]);
  });
});
