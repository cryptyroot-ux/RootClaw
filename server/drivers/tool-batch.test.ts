import { describe, expect, it } from "vitest";
import { runToolBatch } from "./tool-batch.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runToolBatch", () => {
  it("runs read-only calls concurrently with a bound and commits in order", async () => {
    let running = 0; let peak = 0;
    const order: string[] = [];
    const calls = ["r1", "r2", "r3", "r4", "r5", "r6"];
    const started = Date.now();
    await runToolBatch(calls, {
      readOnly: () => true, concurrency: 4, signal: new AbortController().signal,
      run: async (call) => { running++; peak = Math.max(peak, running); await sleep(call === "r1" ? 120 : 40); running--; return call; },
      commit: (result) => order.push(result),
    });
    expect(order).toEqual(calls);
    expect(peak).toBe(4);
    expect(Date.now() - started).toBeLessThan(220);
  });
  it("keeps mutating calls sequential and in place between read-only groups", async () => {
    const log: string[] = [];
    let running = 0;
    await runToolBatch(["r1", "r2", "w1", "r3", "w2", "w3"], {
      readOnly: (call) => call.startsWith("r"), signal: new AbortController().signal,
      run: async (call) => {
        if (call.startsWith("w")) expect(running).toBe(0);
        running++; log.push(`start ${call}`); await sleep(10); running--; return call;
      },
      commit: (result) => log.push(`commit ${result}`),
    });
    const commits = log.filter((line) => line.startsWith("commit")).map((line) => line.slice(7));
    expect(commits).toEqual(["r1", "r2", "w1", "r3", "w2", "w3"]);
    expect(log.indexOf("start w1")).toBeGreaterThan(log.indexOf("commit r2"));
    expect(log.indexOf("start r3")).toBeGreaterThan(log.indexOf("commit w1"));
  });
  it("stops on abort and on a commit that throws", async () => {
    const abort = new AbortController();
    const ran: string[] = [];
    const pending = runToolBatch(["a", "b", "c", "d", "e"], {
      readOnly: () => true, concurrency: 2, signal: abort.signal,
      run: async (call) => { ran.push(call); await sleep(50); return call; },
      commit: () => {},
    });
    setTimeout(() => abort.abort(), 10);
    await expect(pending).rejects.toThrow();
    expect(ran).toEqual(["a", "b"]);
    const committed: string[] = [];
    await expect(runToolBatch(["w1", "w2"], { readOnly: () => false, signal: new AbortController().signal,
      run: async (call) => call, commit: (result) => { committed.push(result); throw new Error("fatal"); } })).rejects.toThrow("fatal");
    expect(committed).toEqual(["w1"]);
  });
});
