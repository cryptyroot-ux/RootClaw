// Native process monitoring/management tool for RootClaw Native Engine.
// Lists, kills, and monitors processes on the host (via shell) or in a
// Cua container (via computer_exec backend). Mutating actions (kill) require
// approval; list is read-only.
import type { ChatToolCallView, ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";

export const PROCESS_TOOL = "process_tool";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const str = (description: string) => ({ type: "string", description });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });

export const processToolDefinitions = (): ChatToolDefinition[] => [
  {
    type: "function",
    function: {
      name: PROCESS_TOOL,
      description:
        "Manage processes on the bot's computer: list running processes or kill a process by PID. " +
        "Use 'list' to see what's running (optionally filter by name). Use 'kill' to terminate a process by PID. " +
        "List is read-only; kill requires approval. Only available on Local VM, VPS, or host with shell access.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "kill"], description: "list: show running processes; kill: terminate a process by PID." },
          pid: int("Process ID to kill (required for kill action).", { minimum: 1 }),
          filter: str("Filter processes by name (optional, for list action)."),
          timeout_ms: int("Timeout in milliseconds (default 30000, max 120000).", { minimum: 1000, maximum: MAX_TIMEOUT_MS }),
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

export function processToolView(_name: string, args: Record<string, unknown>): ChatToolCallView {
  const action = String(args.action ?? "");
  const ask = action === "kill";
  return { title: PROCESS_TOOL, input: args, ask };
}

export function validateProcessToolArgs(args: Record<string, unknown>): void {
  const action = String(args.action ?? "");
  if (action !== "list" && action !== "kill") {
    throw new Error('process_tool "action" must be "list" or "kill".');
  }
  if (action === "kill") {
    const pid = Number(args.pid);
    if (!Number.isFinite(pid) || pid < 1 || !Number.isInteger(pid)) {
      throw new Error('process_tool "kill" requires a valid positive integer "pid".');
    }
  }
  if (args.timeout_ms !== undefined) {
    const ms = Number(args.timeout_ms);
    if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_TIMEOUT_MS) {
      throw new Error(`process_tool "timeout_ms" must be between 1000 and ${MAX_TIMEOUT_MS}.`);
    }
  }
  if (args.filter !== undefined && typeof args.filter !== "string") {
    throw new Error('process_tool "filter" must be a string.');
  }
}

export function processToolCommandScope(args: Record<string, unknown>): { command: string; cwd: string } | undefined {
  const action = String(args.action ?? "");
  if (action === "list") {
    const filter = typeof args.filter === "string" ? args.filter : "";
    return { command: `ps aux${filter ? ` | grep ${filter}` : ""}`, cwd: "/home/cua/workspace" };
  }
  if (action === "kill") {
    return { command: `kill ${args.pid}`, cwd: "/home/cua/workspace" };
  }
  return undefined;
}

/** Capability provider for native process_tool. */
export function createProcessProvider(
  computerExec: { kind: "vps" | "local-vm"; sshAlias?: string; containerName: string; runtime?: "docker" | "podman" | "container" } | undefined,
  workspaceRoot: string | undefined,
): import("./capability-provider.ts").CapabilityProvider {
  const toolNameSet = new Set<string>([PROCESS_TOOL]);
  return {
    id: "native-process",
    toolNames: toolNameSet,
    mount(_scope) {
      return processToolDefinitions();
    },
    validate(_name, args) {
      validateProcessToolArgs(args as Record<string, unknown>);
    },
    view(_name, args) {
      return processToolView(_name, args as Record<string, unknown>);
    },
    commandScope(_name, args) {
      return processToolCommandScope(args as Record<string, unknown>);
    },
    execute(_name, args, signal) {
      return executeProcessTool(args as Record<string, unknown>, computerExec, workspaceRoot, signal);
    },
    async close() {
      // no cleanup needed
    },
  };
}

export async function executeProcessTool(
  args: Record<string, unknown>,
  computerExec: { kind: "vps" | "local-vm"; sshAlias?: string; containerName: string; runtime?: "docker" | "podman" | "container" } | undefined,
  workspaceRoot: string | undefined,
  signal: AbortSignal,
): Promise<ChatToolResult> {
  validateProcessToolArgs(args);
  const action = String(args.action);
  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_TIMEOUT_MS;

  let command: string;
  if (action === "list") {
    const filter = typeof args.filter === "string" && args.filter.trim() ? args.filter.trim() : "";
    command = filter ? `ps aux | grep -i ${JSON.stringify(filter)} | grep -v grep` : "ps aux";
  } else {
    command = `kill ${args.pid}`;
  }

  // Prefer computer_exec backend (VPS/Local VM) if available
  if (computerExec) {
    const { executeComputerExec } = await import("./computer-exec-tools.ts");
    return executeComputerExec({ command, timeout_ms: timeoutMs }, computerExec, signal);
  }

  // Fall back to host shell (workspace)
  if (workspaceRoot) {
    const { spawn: spawnFn } = await import("node:child_process");
    return new Promise<ChatToolResult>((resolve) => {
      const child = spawnFn("/bin/bash", ["-c", command], {
        cwd: workspaceRoot,
        env: { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      timer.unref?.();
      const onAbort = () => child.kill("SIGTERM");
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const lines = [`exit code ${code ?? "unknown"}`];
        if (stdout) lines.push("--- stdout ---", stdout.trimEnd());
        if (stderr) lines.push("--- stderr ---", stderr.trimEnd());
        if (!stdout && !stderr) lines.push("(no output)");
        resolve({ ok: code === 0, text: lines.join("\n") });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, text: `process_tool failed: ${err.message}` });
      });
    });
  }

  return { ok: false, text: "process_tool requires a computer or workspace. No backend available." };
}