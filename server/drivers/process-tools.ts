import type { ChatToolCallView, ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";
import { formatNativeCommandResult, runNativeCommand } from "./native-command.ts";
import { commandForPosixShell, quotePosixShellArg } from "./shell-args.ts";

export const PROCESS_TOOL = "process_tool";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const COMPUTER_WORKSPACE = "/home/cua/workspace";

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
        "List is read-only; kill requires approval. Only available on Local VM, VPS, or a host workspace.",
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

export function processToolCommandScope(
  args: Record<string, unknown>,
  options: { platform?: NodeJS.Platform; cwd?: string } = {},
): { command: string; cwd: string } | undefined {
  const action = String(args.action ?? "");
  const platform = options.platform ?? "linux";
  const invocation = processInvocation(action, args, platform);
  if (!invocation) return undefined;
  const filter = action === "list" && typeof args.filter === "string" ? args.filter.trim() : "";
  const command = platform === "win32"
    ? [invocation.executable, ...invocation.args].join(" ")
    : action === "list" && filter
      ? `ps aux | grep -F -i -- ${quotePosixShellArg(filter)} | grep -v grep`
      : commandForPosixShell(invocation.executable, invocation.args);
  return { command, cwd: options.cwd ?? COMPUTER_WORKSPACE };
}

function processInvocation(action: string, args: Record<string, unknown>, platform: NodeJS.Platform): { executable: string; args: string[] } | undefined {
  if (action === "list") {
    return platform === "win32"
      ? { executable: "tasklist", args: ["/FO", "CSV", "/NH"] }
      : { executable: "ps", args: ["aux"] };
  }
  if (action === "kill") {
    return platform === "win32"
      ? { executable: "taskkill", args: ["/PID", String(args.pid), "/T"] }
      : { executable: "kill", args: [String(args.pid)] };
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
      return processToolCommandScope(args as Record<string, unknown>, {
        platform: computerExec ? "linux" : process.platform,
        cwd: computerExec ? COMPUTER_WORKSPACE : workspaceRoot ?? COMPUTER_WORKSPACE,
      });
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
  const filter = action === "list" && typeof args.filter === "string" ? args.filter.trim() : "";

  // Prefer computer_exec backend (VPS/Local VM) if available
  if (computerExec) {
    const { executeComputerExec } = await import("./computer-exec-tools.ts");
    const scope = processToolCommandScope(args, { platform: "linux" })!;
    return executeComputerExec({ ...scope, timeout_ms: timeoutMs }, computerExec, signal);
  }

  // Run host processes directly; filtering captured output avoids a shell pipeline.
  if (workspaceRoot) {
    const invocation = processInvocation(action, args, process.platform)!;
    const output = await runNativeCommand(invocation.executable, invocation.args, workspaceRoot, timeoutMs, signal);
    if (filter) output.stdout = output.stdout.split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(filter.toLowerCase())).join("\n");
    return formatNativeCommandResult(output, "process_tool");
  }

  return { ok: false, text: "process_tool requires a computer or workspace. No backend available." };
}
