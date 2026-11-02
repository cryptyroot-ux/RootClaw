// Native package management tool for RootClaw Native Engine.
// Install/list/remove packages via npm, pip, or apt. Runs on host (shell) or
// in a Cua container (computer_exec backend). Install requires approval + network.
import type { ChatToolCallView, ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";

export const PACKAGE_TOOL = "package_tool";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });

export const packageToolDefinitions = (): ChatToolDefinition[] => [
  {
    type: "function",
    function: {
      name: PACKAGE_TOOL,
      description:
        "Manage packages on the bot's computer: install, list, or remove packages using npm, pip, or apt. " +
        "Install requires network access and approval. Only available on Local VM, VPS, or host with shell access.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["install", "list", "remove"], description: "install: install packages; list: list installed packages; remove: uninstall packages." },
          manager: { type: "string", enum: ["npm", "pip", "apt"], description: "Package manager to use (default: npm)." },
          packages: { type: "array", items: { type: "string" }, description: "Package names to install/remove (required for install/remove)." },
          network: { type: "boolean", description: "Network access for install (default: true for install)." },
          timeout_ms: int("Timeout in milliseconds (default 120000, max 300000).", { minimum: 1000, maximum: MAX_TIMEOUT_MS }),
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
];

export function packageToolView(_name: string, args: Record<string, unknown>): ChatToolCallView {
  const action = String(args.action ?? "");
  const ask = action === "install" || action === "remove";
  return { title: PACKAGE_TOOL, input: args, ask };
}

export function validatePackageToolArgs(args: Record<string, unknown>): void {
  const action = String(args.action ?? "");
  if (!["install", "list", "remove"].includes(action)) {
    throw new Error('package_tool "action" must be "install", "list", or "remove".');
  }
  const manager = args.manager !== undefined ? String(args.manager) : "npm";
  if (!["npm", "pip", "apt"].includes(manager)) {
    throw new Error('package_tool "manager" must be "npm", "pip", or "apt".');
  }
  if ((action === "install" || action === "remove") && (!Array.isArray(args.packages) || args.packages.length === 0)) {
    throw new Error('package_tool "install"/"remove" requires a non-empty "packages" array.');
  }
  if (args.timeout_ms !== undefined) {
    const ms = Number(args.timeout_ms);
    if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_TIMEOUT_MS) {
      throw new Error(`package_tool "timeout_ms" must be between 1000 and ${MAX_TIMEOUT_MS}.`);
    }
  }
}

export function packageToolCommandScope(args: Record<string, unknown>): { command: string; cwd: string } | undefined {
  const action = String(args.action ?? "");
  const manager = String(args.manager ?? "npm");
  const packages = Array.isArray(args.packages) ? args.packages.map(String).join(" ") : "";
  const cwd = "/home/cua/workspace";
  if (action === "install") return { command: `${manager} install ${packages}`, cwd };
  if (action === "remove") return { command: `${manager} uninstall ${packages}`, cwd };
  if (action === "list") return { command: `${manager} list`, cwd };
  return undefined;
}

/** Capability provider for native package_tool. */
export function createPackageProvider(
  computerExec: { kind: "vps" | "local-vm"; sshAlias?: string; containerName: string; runtime?: "docker" | "podman" | "container" } | undefined,
  workspaceRoot: string | undefined,
): import("./capability-provider.ts").CapabilityProvider {
  const toolNameSet = new Set<string>([PACKAGE_TOOL]);
  return {
    id: "native-package",
    toolNames: toolNameSet,
    mount(_scope) {
      return packageToolDefinitions();
    },
    validate(_name, args) {
      validatePackageToolArgs(args as Record<string, unknown>);
    },
    view(_name, args) {
      return packageToolView(_name, args as Record<string, unknown>);
    },
    commandScope(_name, args) {
      return packageToolCommandScope(args as Record<string, unknown>);
    },
    execute(_name, args, signal) {
      return executePackageTool(args as Record<string, unknown>, computerExec, workspaceRoot, signal);
    },
    async close() {
      // no cleanup needed
    },
  };
}

export async function executePackageTool(
  args: Record<string, unknown>,
  computerExec: { kind: "vps" | "local-vm"; sshAlias?: string; containerName: string; runtime?: "docker" | "podman" | "container" } | undefined,
  workspaceRoot: string | undefined,
  signal: AbortSignal,
): Promise<ChatToolResult> {
  validatePackageToolArgs(args);
  const action = String(args.action);
  const manager = String(args.manager ?? "npm");
  const packages = Array.isArray(args.packages) ? args.packages.map(String).join(" ") : "";
  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
  const network = args.network !== false; // default true for install

  let command: string;
  if (action === "install") {
    const netFlag = network ? "" : " --offline";
    if (manager === "npm") command = `npm install ${packages}${netFlag}`;
    else if (manager === "pip") command = `pip install ${packages}`;
    else command = `apt-get install -y ${packages}`;
  } else if (action === "remove") {
    if (manager === "npm") command = `npm uninstall ${packages}`;
    else if (manager === "pip") command = `pip uninstall -y ${packages}`;
    else command = `apt-get remove -y ${packages}`;
  } else {
    if (manager === "npm") command = "npm list --depth=0";
    else if (manager === "pip") command = "pip list";
    else command = "dpkg -l | head -50";
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
        resolve({ ok: false, text: `package_tool failed: ${err.message}` });
      });
    });
  }

  return { ok: false, text: "package_tool requires a computer or workspace. No backend available." };
}