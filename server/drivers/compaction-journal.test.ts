import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompaction, readCompactions, foldCompactions, type CompactionEntry } from "./compaction-journal.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("compaction journal", () => {
  it("appends and reads a compaction entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "cj-")); dirs.push(dir);
    const entry: CompactionEntry = {
      id: "c1", runId: "run-1", threadId: "t-1", botId: "b-1", round: 2,
      reason: "overflow", messagesBefore: 50, messagesAfter: 20,
      tokensBefore: 10000, tokensAfter: 4000, tokensSaved: 6000,
      summary: "Summarized older messages", timestamp: Date.now(),
    };
    appendCompaction(dir, entry);
    const read = readCompactions(dir);
    expect(read).toHaveLength(1);
    expect(read[0].runId).toBe("run-1");
    expect(read[0].tokensSaved).toBe(6000);
  });

  it("filters by runId", () => {
    const dir = mkdtempSync(join(tmpdir(), "cj-")); dirs.push(dir);
    appendCompaction(dir, { id: "c1", runId: "run-1", threadId: "t-1", round: 1, reason: "overflow", messagesBefore: 10, messagesAfter: 5, tokensBefore: 1000, tokensAfter: 500, tokensSaved: 500, timestamp: Date.now() });
    appendCompaction(dir, { id: "c2", runId: "run-2", threadId: "t-2", round: 1, reason: "budget", messagesBefore: 20, messagesAfter: 10, tokensBefore: 2000, tokensAfter: 1000, tokensSaved: 1000, timestamp: Date.now() });
    expect(readCompactions(dir, { runId: "run-1" })).toHaveLength(1);
    expect(readCompactions(dir, { runId: "run-2" })).toHaveLength(1);
    expect(readCompactions(dir, { runId: "nonexistent" })).toHaveLength(0);
  });

  it("filters by threadId and botId", () => {
    const dir = mkdtempSync(join(tmpdir(), "cj-")); dirs.push(dir);
    appendCompaction(dir, { id: "c1", runId: "run-1", threadId: "t-1", botId: "b-1", round: 1, reason: "overflow", messagesBefore: 10, messagesAfter: 5, tokensBefore: 1000, tokensAfter: 500, tokensSaved: 500, timestamp: Date.now() });
    appendCompaction(dir, { id: "c2", runId: "run-2", threadId: "t-2", botId: "b-2", round: 1, reason: "budget", messagesBefore: 20, messagesAfter: 10, tokensBefore: 2000, tokensAfter: 1000, tokensSaved: 1000, timestamp: Date.now() });
    expect(readCompactions(dir, { threadId: "t-1" })).toHaveLength(1);
    expect(readCompactions(dir, { botId: "b-2" })).toHaveLength(1);
  });

  it("skips corrupt lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "cj-")); dirs.push(dir);
    mkdirSync(join(dir, "compactions"), { recursive: true });
    writeFileSync(join(dir, "compactions", "compactions.jsonl"), "not json\n{\"id\":\"c1\",\"runId\":\"r1\",\"threadId\":\"t1\",\"round\":1,\"reason\":\"overflow\",\"messagesBefore\":10,\"messagesAfter\":5,\"tokensBefore\":1000,\"tokensAfter\":500,\"tokensSaved\":500,\"timestamp\":123}\n");
    const read = readCompactions(dir);
    expect(read).toHaveLength(1);
    expect(read[0].id).toBe("c1");
  });

  it("returns empty array for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cj-")); dirs.push(dir);
    expect(readCompactions(dir)).toEqual([]);
  });

  it("folds to last entry per runId", () => {
    const entries: CompactionEntry[] = [
      { id: "c1", runId: "run-1", threadId: "t-1", round: 1, reason: "overflow", messagesBefore: 10, messagesAfter: 5, tokensBefore: 1000, tokensAfter: 500, tokensSaved: 500, timestamp: 1 },
      { id: "c2", runId: "run-1", threadId: "t-1", round: 2, reason: "budget", messagesBefore: 5, messagesAfter: 3, tokensBefore: 500, tokensAfter: 300, tokensSaved: 200, timestamp: 2 },
      { id: "c3", runId: "run-2", threadId: "t-2", round: 1, reason: "overflow", messagesBefore: 20, messagesAfter: 10, tokensBefore: 2000, tokensAfter: 1000, tokensSaved: 1000, timestamp: 3 },
    ];
    const folded = foldCompactions(entries);
    expect(folded.size).toBe(2);
    expect(folded.get("run-1")?.id).toBe("c2");
    expect(folded.get("run-2")?.id).toBe("c3");
  });

  it("does not throw on write failure (non-blocking)", () => {
    // Write to a path that doesn't exist and can't be created (file as dir)
    const dir = mkdtempSync(join(tmpdir(), "cj-")); dirs.push(dir);
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(dir, "compactions"), "blocker");
    // This should not throw
    expect(() => appendCompaction(dir, { id: "c1", runId: "r1", threadId: "t1", round: 1, reason: "overflow", messagesBefore: 10, messagesAfter: 5, tokensBefore: 1000, tokensAfter: 500, tokensSaved: 500, timestamp: Date.now() })).not.toThrow();
  });
});