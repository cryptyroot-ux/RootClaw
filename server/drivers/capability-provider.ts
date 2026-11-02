// Capability provider interface for RootClaw Native Engine.
// Each capability (workspace tools, computer_exec, system_info, process, package,
// network, file_watch, MCP tools, etc.) implements this interface for a uniform
// mount → validate → view → execute → close lifecycle.
// Inspired by OMB-Claw's capability provider pattern, adapted for RootClaw's
// direct-dispatch native engine.
import type { ToolScope } from "../../shared/tool-scope.ts";
import type { ChatToolCallView, ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";

export interface CapabilityProvider {
  /** Unique ID for this provider (e.g., "native-workspace", "native-computer-exec") */
  readonly id: string;
  /** Tool names this provider handles */
  readonly toolNames: ReadonlySet<string>;
  /** Mount the provider: validate, set up, return available tool definitions filtered by scope */
  mount(scope: ToolScope | undefined): ChatToolDefinition[];
  /** Validate arguments against the tool's schema */
  validate(name: string, args: unknown): void;
  /** Show the approval card view for this tool call */
  view(name: string, args: Record<string, unknown>): ChatToolCallView;
  /** The exact command and folder for the approval card (for saved-command allowlist matching). Undefined if not applicable. */
  commandScope(name: string, args: Record<string, unknown>): { command: string; cwd: string } | undefined;
  /** Execute the tool call */
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ChatToolResult>;
  /** Close the provider (cleanup resources) */
  close(): Promise<void>;
}

/** Find the provider that handles a given tool name. */
export function findProvider(providers: CapabilityProvider[], name: string): CapabilityProvider | undefined {
  return providers.find((p) => p.toolNames.has(name));
}