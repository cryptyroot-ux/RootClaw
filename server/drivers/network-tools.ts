// Native network diagnostics tool for RootClaw Native Engine.
// Ping, curl, and DNS lookup. Runs on host (shell) or in a Cua container
// (computer_exec backend). Mutating actions (curl POST) require approval.
import type { ChatToolCallView, ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";

export const NETWORK_TOOL = "network_tool";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

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
        "Only available on Local VM, VPS, or host with shell access.",
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

export function networkToolCommandScope(args: Record<string, unknown>): { command: string; cwd: string } | undefined {
  const action = String(args.action ?? "");
  const target = String(args.target ?? "");
  const cwd = "/home/cua/workspace";
  if (action === "ping") return { command: `ping -c 3 ${target}`, cwd };
  if (action === "curl") return { command: `curl -sS -L --max-time 30 ${target}`, cwd };
  if (action === "dns") return { command: `nslookup ${target}`, cwd };
  return undefined;
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

  let command: string;
  if (action === "ping") {
    command = `ping -c ${count} -W 5 ${target}`;
  } else if (action === "curl") {
    command = `curl -sS -L --max-time 30 ${JSON.stringify(target)}`;
  } else {
    command = `nslookup ${target}`;
  }

  if (computerExec) {
    const { executeComputerExec } = await import("./computer-exec-tools.ts");
    return executeComputerExec({ command, timeout_ms: timeoutMs }, computerExec, signal);
  }

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
        resolve({ ok: false, text: `network_tool failed: ${err.message}` });
      });
    });
  }

  return { ok: false, text: "network_tool requires a computer or workspace. No backend available." };
}