// Search utilities for workspace tools: glob pattern matching, directory walking, ripgrep.
// Extracted from server/drivers/workspace-tools.ts to keep that file under 1,000 lines.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "dist", "build", ".next", ".cache"]);

export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) { out += "\\{"; continue; }
      out += `(?:${pattern.slice(i + 1, end).split(",").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
      i = end;
    } else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function* walk(dir: string, signal?: AbortSignal): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (signal?.aborted) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) yield* walk(full, signal); }
    else if (entry.isFile()) yield full;
  }
}

let rgPath: string | null | undefined;
export function ripgrep(): string | null {
  if (process.env.ROOTCLAW_NO_RG === "1") return null;
  if (rgPath !== undefined) return rgPath;
  const probe = spawnSync("rg", ["--version"], { encoding: "utf8" });
  return (rgPath = probe.status === 0 ? "rg" : null);
}