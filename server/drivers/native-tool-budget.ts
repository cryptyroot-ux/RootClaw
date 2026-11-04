import { ASK_USER_TOOL } from "../../shared/ask-question.ts";
import { allowsTool } from "../../shared/tool-scope.ts";
import { READ_TOOL_OUTPUT_TOOL } from "./turn-context.ts";
import { UPDATE_PLAN_TOOL } from "./plan-verify.ts";
import { WORKSPACE_TOOL_DEFINITIONS } from "./workspace-tools.ts";
import { computerExecDefinitions } from "./computer-exec-tools.ts";
import { systemInfoDefinitions } from "./system-info-tools.ts";
import { processToolDefinitions } from "./process-tools.ts";
import { packageToolDefinitions } from "./package-tools.ts";
import { networkToolDefinitions } from "./network-tools.ts";
import { fileWatchToolDefinitions } from "./file-watch-tools.ts";

interface NativeRuntimeToolBudgetOptions {
  toolsEnabled: boolean;
  workspaceEnabled: boolean;
  computerExecEnabled: boolean;
  offloadOutput: boolean;
  planVerifyOn: boolean;
}

type NamedToolDefinition = { function: { name: string } };

/** Reserve MCP slots for the native tools this turn can actually offer. */
export function nativeRuntimeToolBudget(scope: unknown, options: NativeRuntimeToolBudgetOptions): number {
  const names = new Set<string>();
  const reserve = (definitions: readonly NamedToolDefinition[]) => {
    for (const { function: tool } of definitions) {
      if (allowsTool(scope, { kind: "native", name: tool.name })) names.add(tool.name);
    }
  };
  if (options.toolsEnabled) {
    if (allowsTool(scope, { kind: "native", name: ASK_USER_TOOL })) names.add(ASK_USER_TOOL);
    if (options.workspaceEnabled) reserve(WORKSPACE_TOOL_DEFINITIONS);
    if (options.computerExecEnabled) reserve(computerExecDefinitions());
    reserve(systemInfoDefinitions());
    if (options.computerExecEnabled || options.workspaceEnabled) {
      reserve([...processToolDefinitions(), ...packageToolDefinitions(), ...networkToolDefinitions(), ...fileWatchToolDefinitions()]);
    }
    if (options.offloadOutput) names.add(READ_TOOL_OUTPUT_TOOL);
    if (options.planVerifyOn) names.add(UPDATE_PLAN_TOOL);
  }
  return Math.max(1, names.size);
}
