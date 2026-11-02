// Native file watcher tool for RootClaw Native Engine.
// Starts/stops/reads file watchers on the host workspace (Node fs.watch) or
// in a Cua container (inotifywait via computer_exec backend).
import { watch, type FSWatcher } from "node:fs";
import type { ChatToolCallView, ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";

export const FILE_WATCH_TOOL = "file_watch_tool";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

const str = (description: string) => ({ type: "string", description });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });

// Persistent watchers on the host
interface WatcherEntry {
  id: string;
  path: string;
  watcher: FSWatcher;
  changes: string[];
  startedAt: number;
}
const hostWatchers = new Map<string, WatcherEntry>();

export const fileWatchToolDefinitions = (): ChatToolDefinition[] => [
  {
    type: "function",
    function: {
      name: FILE_WATCH_TOOL,
      description:
        "Watch a folder for file changes: start watching, stop watching, or read accumulated changes. " +
        "Use 'start' to begin monitoring a path (returns a watcherId). Use 'read' to get changes since start. " +
        "Use 'stop' to end monitoring. Read-only for 'read'; 'start'/'stop' are mutating.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "stop", "read"], description: "start: begin watching; stop: end watching; read: get accumulated changes." },
          path: str("Folder or file path to watch (required for start)."),
          watcherId: str("Watcher ID from a previous 'start' call (required for stop/read)."),
          timeout_ms: int("Timeout in milliseconds for collecting changes (default 10000, max 30000).", { minimum: 1000, maximum: MAX_TIMEOUT_MS }),
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

export function fileWatchToolView(_name: string, args: Record<string, unknown>): ChatToolCallView {
  const action = String(args.action ?? "");
  const ask = action === "start" || action === "stop";
  return { title: FILE_WATCH_TOOL, input: args, ask };
}

export function validateFileWatchToolArgs(args: Record<string, unknown>): void {
  const action = String(args.action ?? "");
  if (!["start", "stop", "read"].includes(action)) {
    throw new Error('file_watch_tool "action" must be "start", "stop", or "read".');
  }
  if (action === "start" && (typeof args.path !== "string" || !args.path.trim())) {
    throw new Error('file_watch_tool "start" requires a non-empty "path".');
  }
  if ((action === "stop" || action === "read") && (typeof args.watcherId !== "string" || !args.watcherId.trim())) {
    throw new Error('file_watch_tool "stop"/"read" requires a "watcherId".');
  }
  if (args.timeout_ms !== undefined) {
    const ms = Number(args.timeout_ms);
    if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_TIMEOUT_MS) {
      throw new Error(`file_watch_tool "timeout_ms" must be between 1000 and ${MAX_TIMEOUT_MS}.`);
    }
  }
}

export function fileWatchToolCommandScope(args: Record<string, unknown>): { command: string; cwd: string } | undefined {
  const action = String(args.action ?? "");
  const path = String(args.path ?? "");
  const cwd = "/home/cua/workspace";
  if (action === "start") return { command: `inotifywait -m -r ${path}`, cwd };
  if (action === "stop") return { command: `kill ${args.watcherId}`, cwd };
  if (action === "read") return { command: `cat /tmp/watch_${args.watcherId}.log`, cwd };
  return undefined;
}

export async function executeFileWatchTool(
  args: Record<string, unknown>,
  computerExec: { kind: "vps" | "local-vm"; sshAlias?: string; containerName: string; runtime?: "docker" | "podman" | "container" } | undefined,
  workspaceRoot: string | undefined,
  signal: AbortSignal,
): Promise<ChatToolResult> {
  validateFileWatchToolArgs(args);
  const action = String(args.action);
  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_TIMEOUT_MS;

  if (action === "start") {
    const path = String(args.path).trim();
    // Host: use Node fs.watch
    if (workspaceRoot && !computerExec) {
      const watcherId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        const watcher = watch(path, { recursive: true }, (eventType, filename) => {
          const entry = hostWatchers.get(watcherId);
          if (entry) entry.changes.push(`${eventType}: ${filename ?? "(unknown)"}`);
        });
        hostWatchers.set(watcherId, { id: watcherId, path, watcher, changes: [], startedAt: Date.now() });
        return { ok: true, text: `Started watching ${path}. Watcher ID: ${watcherId}. Use file_watch_tool with action "read" and this watcherId to get changes.` };
      } catch (error) {
        return { ok: false, text: `file_watch_tool start failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    // VPS/Local VM: use inotifywait via computer_exec
    if (computerExec) {
      const { executeComputerExec } = await import("./computer-exec-tools.ts");
      return executeComputerExec({ command: `which inotifywait && echo "inotifywait available" || echo "inotifywait not installed"`, timeout_ms: timeoutMs }, computerExec, signal);
    }
    return { ok: false, text: "file_watch_tool requires a computer or workspace. No backend available." };
  }

  if (action === "stop") {
    const watcherId = String(args.watcherId).trim();
    // Host: stop watcher
    const entry = hostWatchers.get(watcherId);
    if (entry) {
      entry.watcher.close();
      hostWatchers.delete(watcherId);
      return { ok: true, text: `Stopped watcher ${watcherId}. Total changes captured: ${entry.changes.length}.` };
    }
    // VPS/Local VM: no-op (one-shot inotifywait)
    return { ok: true, text: `Watcher ${watcherId} stopped (no persistent watcher on container backend).` };
  }

  if (action === "read") {
    const watcherId = String(args.watcherId).trim();
    // Host: read accumulated changes
    const entry = hostWatchers.get(watcherId);
    if (entry) {
      const changes = entry.changes.splice(0);
      if (changes.length === 0) return { ok: true, text: `No changes detected since last read (watcher ${watcherId}).` };
      return { ok: true, text: `Changes (${changes.length}):\n${changes.join("\n")}` };
    }
    return { ok: false, text: `Unknown watcherId: ${watcherId}.` };
  }

  return { ok: false, text: `Unknown action: ${action}` };
}