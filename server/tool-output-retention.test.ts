import { mkdirSync, mkdtempSync, existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepToolOutputs } from "./tool-output-retention.ts";

const NOW = Date.UTC(2026, 9, 31);
const DAY = 86_400_000;
let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function file(folder: string, name: string, bytes: number, ageDays: number) {
  mkdirSync(join(root, folder), { recursive: true });
  const path = join(root, folder, name);
  writeFileSync(path, "x".repeat(bytes));
  const at = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, at, at);
  return path;
}

describe("sweepToolOutputs", () => {
  it("is safe when roots are missing", () => {
    expect(sweepToolOutputs({ roots: [join(tmpdir(), "rootclaw-missing-xyz")], now: NOW })).toEqual({ deleted: 0, freedBytes: 0, keptBytes: 0, skippedProtected: 0 });
  });

  it("deletes files past the age limit and removes emptied folders, idempotently", () => {
    root = mkdtempSync(join(tmpdir(), "rc-ret-"));
    const old = file("a", "old.txt", 10, 8);
    const fresh = file("b", "new.txt", 10, 1);
    const first = sweepToolOutputs({ roots: [root], now: NOW });
    expect(first).toMatchObject({ deleted: 1, freedBytes: 10, keptBytes: 10 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(root, "a"))).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(sweepToolOutputs({ roots: [root], now: NOW }).deleted).toBe(0);
  });

  it("caps the total size, oldest first, honouring the configured limits", () => {
    root = mkdtempSync(join(tmpdir(), "rc-ret-"));
    const MB = 1024 * 1024;
    const oldest = file("a", "1.txt", MB, 3);
    const middle = file("b", "2.txt", MB, 2);
    const newest = file("b", "3.txt", MB, 1);
    const result = sweepToolOutputs({ roots: [root], retention: { maxAgeDays: 30, maxTotalMb: 2 }, now: NOW });
    expect(result.deleted).toBe(1);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle) && existsSync(newest)).toBe(true);
  });

  it("never deletes files in a running run's folder, even when old or over the cap", () => {
    root = mkdtempSync(join(tmpdir(), "rc-ret-"));
    const live = file("live", "big.txt", 2048, 30);
    const other = file("idle", "old.txt", 10, 30);
    const result = sweepToolOutputs({ roots: [root], retention: { maxTotalMb: 0.001 }, protectedFolders: [join(root, "live")], now: NOW });
    expect(existsSync(live)).toBe(true);
    expect(existsSync(other)).toBe(false);
    expect(result.skippedProtected).toBe(1);
  });
});
