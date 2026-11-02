// Native system info tool for RootClaw Native Engine.
// Returns version, platform, runtime, and configuration status without exposing
// host filesystem or credentials. Read-only, no approval needed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import type { ChatToolCallView, ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";

export const SYSTEM_INFO_TOOL = "system_info";

export const systemInfoDefinitions = (): ChatToolDefinition[] => [
  {
    type: "function",
    function: {
      name: SYSTEM_INFO_TOOL,
      description:
        "Get information about this RootClaw server: version, platform, runtime, and configuration status. " +
        "Use this to answer questions about what version is installed, whether it is up to date, or what capabilities are available. " +
        "Read-only; does not access the filesystem or credentials.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
];

export function systemInfoToolView(_name: string, _args: Record<string, unknown>): ChatToolCallView {
  return { title: SYSTEM_INFO_TOOL, input: {}, ask: false };
}

export function validateSystemInfoArgs(_args: Record<string, unknown>): void {
  // No arguments needed
}

/** Capability provider for native system_info tool. */
export function createSystemInfoProvider(): import("./capability-provider.ts").CapabilityProvider {
  const toolNameSet = new Set<string>([SYSTEM_INFO_TOOL]);
  return {
    id: "native-system-info",
    toolNames: toolNameSet,
    mount(_scope) {
      return systemInfoDefinitions();
    },
    validate(_name, args) {
      validateSystemInfoArgs(args as Record<string, unknown>);
    },
    view(_name, args) {
      return systemInfoToolView(_name, args as Record<string, unknown>);
    },
    commandScope(_name, _args) {
      return undefined;
    },
    execute(_name, args, signal) {
      return executeSystemInfo(args as Record<string, unknown>, signal);
    },
    async close() {
      // no cleanup needed
    },
  };
}

export async function executeSystemInfo(
  _args: Record<string, unknown>,
  _signal: AbortSignal,
): Promise<ChatToolResult> {
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    version = pkg.version ?? "unknown";
  } catch {
    // Fall back to unknown if package.json can't be read
  }

  const info = {
    version,
    platform: process.platform,
    nodeVersion: process.version,
    arch: process.arch,
    uptime: Math.round(process.uptime()),
    dataDir: DATA_DIR,
    pid: process.pid,
  };

  const lines: string[] = [];
  lines.push(`RootClaw version: ${info.version}`);
  lines.push(`Platform: ${info.platform} (${info.arch})`);
  lines.push(`Node.js: ${info.nodeVersion}`);
  lines.push(`Uptime: ${info.uptime} seconds`);
  lines.push(`Data dir: ${info.dataDir}`);
  lines.push(`PID: ${info.pid}`);

  return { ok: true, text: lines.join("\n") };
}