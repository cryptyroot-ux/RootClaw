// Optional Chat Completions `parallel_tool_calls`, and the loop guard's reused read.
// Kept beside openai-chat.ts so that file stays under its line ratchet.
import type { ChatToolResult } from "./chat-mcp-tools.ts";
import { TOOL_LOOP_NOTE, TOOL_LOOP_NOTICE, ToolLoopGuard } from "./tool-loop-guard.ts";

export { TOOL_LOOP_NOTE, TOOL_LOOP_NOTICE, ToolLoopGuard };

export class UnsupportedParallelToolCallsError extends Error {}

/** `parallel_tool_calls` is optional in Chat Completions; a provider that does not know it may refuse the request over it. */
export function rejectsParallelToolCalls(status: number, body: string): boolean {
  return (status === 400 || status === 422) && /\bparallel_tool_calls\b/.test(body);
}

const reasoningModel = (model: string) => /^(o\d|gpt-5|gpt-6)/i.test(model.split("/").pop() ?? "");

export function chatCompletionRequest(
  base: Record<string, unknown>,
  options: { tools: readonly unknown[]; toolChoice?: "none"; maxTokens?: number; model: string; allowParallel: boolean },
): { payload: string; parallel: boolean } {
  const request: Record<string, unknown> = {
    ...base,
    ...(options.tools.length ? { tools: options.tools, ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}) } : {}),
    // OpenAI's reasoning families only take max_completion_tokens; everything else the classic field.
    ...(options.maxTokens ? (reasoningModel(options.model) ? { max_completion_tokens: options.maxTokens } : { max_tokens: options.maxTokens }) : {}),
  };
  const parallel = options.allowParallel && options.tools.length > 0 && request.tool_choice !== "none";
  if (parallel) request.parallel_tool_calls = true;
  return { payload: JSON.stringify(request), parallel };
}

/** Disables the flag for later requests and throws, after a provider refused `parallel_tool_calls`. */
export function refusedParallelToolCalls(driverKind: string, model: string, message: string, disable: () => void): never {
  disable();
  console.warn(`${driverKind}: ${model} refused parallel_tool_calls; resending without it from now on`);
  throw new UnsupportedParallelToolCallsError(message);
}

/** Runs `call`, or answers a repeated read from the guard and tells `note` so the turn can show that. */
export function reuseOrRun<C extends { id: string; function: { name: string; arguments: string } }, R>(
  guard: ToolLoopGuard,
  call: C,
  readOnly: boolean,
  run: (call: C) => Promise<R>,
  note: (parsed: unknown) => void,
): Promise<R | { call: C; result: ChatToolResult; content: string; fatal: undefined }> {
  const reused = guard.reuse(call, readOnly);
  if (reused === undefined) return run(call);
  note(JSON.parse(reused) as unknown);
  const result: ChatToolResult = { ok: true, text: "" };
  return Promise.resolve({ call, result, content: reused, fatal: undefined });
}
