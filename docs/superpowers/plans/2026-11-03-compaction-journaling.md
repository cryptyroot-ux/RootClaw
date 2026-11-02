# Compaction Journaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent compaction journaling to RootClaw Native Engine so every compaction decision (overflow recovery, turn context fold) is recorded as NDJSON for audit and replay.

**Architecture:** Create `server/drivers/compaction-journal.ts` with `CompactionEntry` type, `appendCompaction`, `readCompactions`, `foldCompactions`. Wire `appendCompaction` calls into the two compaction points in `openai-chat.ts` (overflow recovery and turn context fold). Non-blocking writes with try/catch. Recovery from corrupt lines.

**Tech Stack:** TypeScript, Node.js v24, RootClaw v0.1.137, vitest.

**Spec:** `docs/superpowers/specs/2026-11-03-compaction-journaling-design.md`

## Global Constraints

- Format: NDJSON (one JSON line per event), consistent with `runs.jsonl`
- Location: `/root/.rootclaw/compactions/compactions.jsonl`
- Append-only: never overwrite existing entries
- Non-blocking: journal write must not block the turn (try/catch)
- Recovery: skip corrupt lines, don't crash
- Backward compatible: don't change existing compaction behavior
- Compact the journal: fold to last entry per runId (like runs.jsonl)

## Review Focus

1. **Corrupt journal file** — if a line is invalid JSON, skip it and return valid entries; don't crash the read
2. **Non-blocking write** — if appendFileSync fails (disk full, permission), log error but don't throw; turn continues
3. **Empty journal** — readCompactions on missing file returns empty array, not error
4. **Concurrent writes** — appendFileSync is atomic for small writes (<4KB) on most filesystems; no lock needed
5. **Run ID uniqueness** — each compaction entry gets a unique ID; fold by runId keeps last entry per run

---

### Task 1: Create compaction-journal.ts

**Files:**
- Create: `server/drivers/compaction-journal.ts`
- Test: `server/drivers/compaction-journal.test.ts`

**Interfaces:**
- Produces:
  - `CompactionEntry` interface: `{ id, runId, threadId, botId?, round, reason, messagesBefore, messagesAfter, tokensBefore, tokensAfter, tokensSaved, summary?, timestamp }`
  - `COMPACTIONS_FILE = "compactions/compactions.jsonl"`
  - `appendCompaction(dataDir: string, entry: CompactionEntry): void`
  - `readCompactions(dataDir: string, filter?: { runId?: string; threadId?: string; botId?: string }): CompactionEntry[]`
  - `foldCompactions(entries: CompactionEntry[]): Map<string, CompactionEntry>`

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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

  it("skips corrupt lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "cj-")); dirs.push(dir);
    const { writeFileSync, mkdirSync } = require("node:fs");
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/drivers/compaction-journal.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement compaction-journal.ts**

Implement `CompactionEntry`, `appendCompaction`, `readCompactions`, `foldCompactions` as specified in the design doc. Use NDJSON format, appendFileSync with try/catch, skip corrupt lines on read.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/drivers/compaction-journal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/drivers/compaction-journal.ts server/drivers/compaction-journal.test.ts
git commit -m "feat: add compaction journaling (NDJSON, append-only, corrupt-line recovery)"
```

---

### Task 2: Wire compaction journaling into openai-chat.ts

**Files:**
- Modify: `server/drivers/openai-chat.ts` (2 compaction points)

**Interfaces:**
- Consumes: `appendCompaction`, `CompactionEntry` from `compaction-journal.ts`
- Produces: compaction events journaled at overflow recovery and turn context fold points

- [ ] **Step 1: Write the failing test**

Add to `openai-chat.test.ts` or create a focused test that verifies compaction entries are written when overflow occurs.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/drivers/openai-chat.test.ts`
Expected: FAIL — compaction not journaled

- [ ] **Step 3: Wire appendCompaction into openai-chat.ts**

Import `appendCompaction` and `CompactionEntry`. At the two compaction points, after compaction completes, call `appendCompaction(DATA_DIR, { ... })`. Wrap in try/catch (non-blocking).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/drivers/openai-chat.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/drivers/openai-chat.ts
git commit -m "feat: wire compaction journaling into native engine turn loop"
```

---

### Task 3: Build, test, verify, push

**Files:** None (build + verify only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm vitest run`
Expected: All tests pass

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 3: Build**

Run: `pnpm build:server`
Expected: PASS

- [ ] **Step 4: Restart service + health check**

Run: `systemctl restart rootclaw && curl -s http://127.0.0.1:8799/api/health`
Expected: `{"app":"rootclaw"}`

- [ ] **Step 5: Bot-level E2E test**

Create bot with Nemotron VL, send message asking to use system_info + computer_exec, verify turn succeeds.

- [ ] **Step 6: Commit + push**

```bash
git add -A && git commit -m "feat: add compaction journaling to native engine" && git push origin main
```

Expected: pre-push CI (lint, typecheck, i18n) all pass, push succeeds.

---

## Self-Review

1. **Spec coverage**: Compaction journaling covered. Non-blocking write, recovery from corrupt lines, backward compatible.
2. **Step scan**: Setiap step menghasilkan satu hal yang bisa dicek.
3. **Type consistency**: `CompactionEntry` type konsisten. `appendCompaction` dan `readCompactions` signatures jelas.
4. **Review focus**: Journal write tidak memblokir turn (try/catch), corrupt lines di-skip, format NDJSON konsisten.
5. **Proportion**: Plan sesuai ukuran project.

**Execution method:** Native (single session). Tasks depend sequentially.

Please review the plan. Does it capture what you want, and which approach should we use?