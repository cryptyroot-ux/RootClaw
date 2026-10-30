// Retention for large tool outputs spilled under the data dir (tool-outputs/ from native offload, tool-results/ from
// hook spills). Each root holds one folder per thread with files inside. A sweep deletes files older than the age
// limit, then the oldest files until the total fits the size cap. Folders of threads with a running run are never
// touched. Idempotent and safe when a root is missing or a file vanishes mid-sweep.
import { readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export const DEFAULT_TOOL_OUTPUT_MAX_AGE_DAYS = 7;
export const DEFAULT_TOOL_OUTPUT_MAX_TOTAL_MB = 500;
export const TOOL_OUTPUT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface ToolOutputRetention { maxAgeDays?: number; maxTotalMb?: number }
export interface SweepResult { deleted: number; freedBytes: number; keptBytes: number; skippedProtected: number }

interface Entry { path: string; folder: string; size: number; mtimeMs: number; protected: boolean }

const positive = (n: unknown, fallback: number) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback);

function list(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export function sweepToolOutputs(input: {
  roots: readonly string[];
  retention?: ToolOutputRetention;
  /** Absolute thread folders that belong to a running run. */
  protectedFolders?: Iterable<string>;
  now?: number;
}): SweepResult {
  const now = input.now ?? Date.now();
  const maxAgeMs = positive(input.retention?.maxAgeDays, DEFAULT_TOOL_OUTPUT_MAX_AGE_DAYS) * 86_400_000;
  const maxBytes = positive(input.retention?.maxTotalMb, DEFAULT_TOOL_OUTPUT_MAX_TOTAL_MB) * 1024 * 1024;
  const guarded = new Set([...(input.protectedFolders ?? [])].map((folder) => resolve(folder)));
  const entries: Entry[] = [];
  const folders = new Set<string>();
  for (const root of input.roots) {
    for (const name of list(root)) {
      const folder = resolve(root, name);
      let info;
      try { info = statSync(folder); } catch { continue; }
      if (!info.isDirectory()) {
        if (info.isFile()) entries.push({ path: folder, folder: resolve(root), size: info.size, mtimeMs: info.mtimeMs, protected: false });
        continue;
      }
      folders.add(folder);
      for (const file of list(folder)) {
        const path = join(folder, file);
        try {
          const stat = statSync(path);
          if (stat.isFile()) entries.push({ path, folder, size: stat.size, mtimeMs: stat.mtimeMs, protected: guarded.has(folder) });
        } catch { /* vanished */ }
      }
    }
  }
  const result: SweepResult = { deleted: 0, freedBytes: 0, keptBytes: 0, skippedProtected: 0 };
  const remove = (entry: Entry) => {
    try { unlinkSync(entry.path); } catch { return false; }
    result.deleted++;
    result.freedBytes += entry.size;
    return true;
  };
  let total = 0;
  const kept: Entry[] = [];
  for (const entry of entries) {
    if (!entry.protected && now - entry.mtimeMs > maxAgeMs && remove(entry)) continue;
    kept.push(entry);
    total += entry.size;
  }
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of kept) {
    if (total <= maxBytes) break;
    if (entry.protected) { result.skippedProtected++; continue; }
    if (remove(entry)) total -= entry.size;
  }
  result.keptBytes = total;
  for (const folder of folders) {
    if (guarded.has(folder)) continue;
    if (!list(folder).length) try { rmdirSync(folder); } catch { /* raced with a new write */ }
  }
  return result;
}
