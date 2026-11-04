import type { ChatToolCallView, ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";
import { formatNativeCommandResult, runNativeCommand } from "./native-command.ts";
import { commandForPosixShell } from "./shell-args.ts";

export const NETWORK_TOOL = "network_tool";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const COMPUTER_WORKSPACE = "/home/cua/workspace";

const str = (description: string) => ({ type: "string", description });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });

export const networkToolDefinitions = (): ChatToolDefinition[] => [
  {
    type: "function",
    function: {
      name: NETWORK_TOOL,
      description:
        "Network diagnostics: ping a host, curl a URL (GET), or look up DNS records. " +
        "Use 'ping' to check connectivity, 'curl' to fetch a URL, 'dns' to resolve a hostname. " +
        "Ping and DNS are read-only; curl requires approval (it can send data). " +
        "Only available on Local VM, VPS, or a host workspace.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["ping", "curl", "dns"], description: "ping: check connectivity; curl: fetch URL (GET); dns: resolve hostname." },
          target: str("Hostname, IP address, or URL to test."),
          timeout_ms: int("Timeout in milliseconds (default 30000, max 120000).", { minimum: 1000, maximum: MAX_TIMEOUT_MS }),
          count: int("Number of ping packets (default 3, max 10).", { minimum: 1, maximum: 10 }),
        },
        required: ["action", "target"],
        additionalProperties: false,
      },
    },
  },
];

export function networkToolView(_name: string, args: Record<string, unknown>): ChatToolCallView {
  const action = String(args.action ?? "");
  const ask = action === "curl";
  return { title: NETWORK_TOOL, input: args, ask };
}

export function validateNetworkToolArgs(args: Record<string, unknown>): void {
  const action = String(args.action ?? "");
  if (!["ping", "curl", "dns"].includes(action)) {
    throw new Error('network_tool "action" must be "ping", "curl", or "dns".');
  }
  if (typeof args.target !== "string" || !args.target.trim()) {
    throw new Error('network_tool requires a non-empty "target".');
  }
  if (args.timeout_ms !== undefined) {
    const ms = Number(args.timeout_ms);
    if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_TIMEOUT_MS) {
      throw new Error(`network_tool "timeout_ms" must be between 1000 and ${MAX_TIMEOUT_MS}.`);
    }
  }
  if (args.count !== undefined) {
    const c = Number(args.count);
    if (!Number.isFinite(c) || c < 1 || c > 10 || !Number.isInteger(c)) {
      throw new Error('network_tool "count" must be an integer between 1 and 10.');
    }
  }
}

export function networkToolCommandScope(
  args: Record<string, unknown>,
  options: { platform?: NodeJS.Platform; cwd?: string } = {},
): { command: string; cwd: string } | undefined {
  const action = String(args.action ?? "");
  const target = String(args.target ?? "").trim();
  const count = typeof args.count === "number" ? args.count : 3;
  const platform = options.platform ?? "linux";
  const invocation = networkInvocation(action, target, count, platform);
  if (!invocation) return undefined;
  const command = platform === "win32"
    ? [invocation.executable, ...invocation.args].join(" ")
    : commandForPosixShell(invocation.executable, invocation.args);
  return { command, cwd: options.cwd ?? COMPUTER_WORKSPACE };
}

function networkInvocation(action: string, target: string, count: number, platform: NodeJS.Platform): { executable: string; args: string[] } | undefined {
  if (action === "ping") {
    return { executable: "ping", args: platform === "win32"
      ? ["-n", String(count), "-w", "5000", target]
      : ["-c", String(count), "-W", "5", target] };
  }
  if (action === "curl") return { executable: "curl", args: ["-sS", "-L", "--max-time", "30", target] };
  if (action === "dns") return { executable: "nslookup", args: [target] };
  return undefined;
}

/** Capability provider for native network_tool. */
export function createNetworkProvider(
  computerExec: { kind: "vps" | "local-vm"; sshAlias?: string; containerName: string; runtime?: "docker" | "podman" | "container" } | undefined,
  workspaceRoot: string | undefined,
): import("./capability-provider.ts").CapabilityProvider {
  const toolNameSet = new Set<string>([NETWORK_TOOL]);
  return {
    id: "native-network",
    toolNames: toolNameSet,
    mount(_scope) {
      return networkToolDefinitions();
    },
    validate(_name, args) {
      validateNetworkToolArgs(args as Record<string, unknown>);
    },
    view(_name, args) {
      return networkToolView(_name, args as Record<string, unknown>);
    },
    commandScope(_name, args) {
      return networkToolCommandScope(args as Record<string, unknown>, {
        platform: computerExec ? "linux" : process.platform,
        cwd: computerExec ? COMPUTER_WORKSPACE : workspaceRoot ?? COMPUTER_WORKSPACE,
      });
    },
    execute(_name, args, signal) {
      return executeNetworkTool(args as Record<string, unknown>, computerExec, workspaceRoot, signal);
    },
    async close() {
      // no cleanup needed
    },
  };
}

export async function executeNetworkTool(
  args: Record<string, unknown>,
  computerExec: { kind: "vps" | "local-vm"; sshAlias?: string; containerName: string; runtime?: "docker" | "podman" | "container" } | undefined,
  workspaceRoot: string | undefined,
  signal: AbortSignal,
): Promise<ChatToolResult> {
  validateNetworkToolArgs(args);
  const action = String(args.action);
  const target = String(args.target).trim();
  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
  const count = typeof args.count === "number" ? args.count : 3;

  if (computerExec) {
    const invocation = networkInvocation(action, target, count, "linux")!;
    const { executeComputerExec } = await import("./computer-exec-tools.ts");
    const command = commandForPosixShell(invocation.executable, invocation.args);
    return executeComputerExec({ command, timeout_ms: timeoutMs }, computerExec, signal);
  }

  if (workspaceRoot) {
    const invocation = networkInvocation(action, target, count, process.platform)!;
    const output = await runNativeCommand(invocation.executable, invocation.args, workspaceRoot, timeoutMs, signal);
    return formatNativeCommandResult(output, "network_tool");
  }

  return { ok: false, text: "network_tool requires a computer or workspace. No backend available." };
}
