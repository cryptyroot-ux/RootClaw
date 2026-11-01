import { narrowsNativeTools, parseToolScope, type ToolScope } from "./tool-scope.ts";

/** Native contracts and app-supplied MCP gates are separate capabilities. */
export const TOOL_SCOPE_SUPPORT = {
  grok: "native-and-mcp", "openai-compat": "native-and-mcp", mistral: "native-and-mcp", minimax: "native-and-mcp",
  cerebras: "native-and-mcp", groq: "native-and-mcp", greenference: "native-and-mcp", meta: "native-and-mcp",
  anthropic: "native-and-mcp", gemini: "native-and-mcp", "openai-responses": "native-and-mcp", ollama: "native-and-mcp",
} as const;

export function assertToolScopeSupported(engine: string, value: unknown): ToolScope | undefined {
  const parsed = parseToolScope(value);
  if (!parsed.ok) throw new Error(parsed.error);
  const support: (typeof TOOL_SCOPE_SUPPORT)[keyof typeof TOOL_SCOPE_SUPPORT] | undefined =
    TOOL_SCOPE_SUPPORT[engine as keyof typeof TOOL_SCOPE_SUPPORT];
  if (parsed.scope !== undefined && support !== "native-and-mcp") {
    if (support === undefined) {
      if (parsed.scope.allow !== undefined || parsed.scope.deny?.length) throw new Error(`${engine}: tool selection is not supported by this engine. Choose a supported engine.`);
    } else if (narrowsNativeTools(parsed.scope)) {
      throw new Error(`${engine}: native tool selection is not supported by this engine. Keep native:* in the selection or choose a supported engine.`);
    }
  }
  return parsed.scope;
}
