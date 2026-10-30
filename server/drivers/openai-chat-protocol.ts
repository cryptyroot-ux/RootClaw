// Structured chat-completions calls. Assistant content is never parsed as a tool.
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Calls one model reply may carry (its index bound). */
const MAX_REPLY_TOOL_CALLS = 32;
const MAX_ARGUMENT_CHARS = 256_000;

export class ChatProtocolError extends Error {}

/** A reply whose tool calls cannot be repaired (truncated or malformed): nothing ran, so the round may be asked once more. */
export class MalformedToolCallError extends ChatProtocolError {}

/** Stand-in name for a call whose name is empty or not a valid tool name: the call is answered with a tool error. */
export const INVALID_TOOL_NAME = "invalid_tool_name";
const VALID_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

let syntheticIds = 0;
/** A fresh tool-call ID for a call whose provider omitted or reused one. */
export function syntheticToolCallId(): string {
  return `call_rc${Date.now().toString(36)}${(++syntheticIds).toString(36)}`;
}

export interface ToolCallRepair { kind: "id_missing" | "id_duplicate" | "invalid_name"; id: string; name?: string }

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Opaque provider reasoning blocks must keep their original order/signatures.
 * OpenRouter streams the sequence as arrays of blocks, not tool-call deltas. */
export class ChatReasoningDetails {
  readonly blocks: Record<string, unknown>[] = [];
  private chars = 0;

  add(value: unknown): void {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value) || value.some((block) => !object(block))) {
      throw new ChatProtocolError("provider returned invalid reasoning details");
    }
    this.chars += JSON.stringify(value).length;
    if (this.chars > 256_000) throw new ChatProtocolError("provider reasoning details exceeded the size limit");
    this.blocks.push(...value);
  }
}

/** One accumulator per completion: indexes identify deltas; IDs correlate results. */
export class ChatToolCalls {
  /** What finish() repaired, for logging. */
  readonly repairs: ToolCallRepair[] = [];
  private calls = new Map<number, ChatToolCall>();
  private argumentChars = 0;

  add(value: unknown, streaming: boolean): void {
    if (value === undefined || value === null) return;
    if (!Array.isArray(value)) throw new ChatProtocolError("provider returned invalid tool_calls");
    const omitted = (field: unknown) => field === undefined || (streaming && field === null);
    for (const [position, raw] of value.entries()) {
      const delta = object(raw);
      const index = !streaming ? position : delta?.index ?? this.slotOf(delta?.id);
      if (!delta || !Number.isInteger(index) || Number(index) < 0 || Number(index) >= MAX_REPLY_TOOL_CALLS) {
        throw new ChatProtocolError("provider returned an invalid tool-call index");
      }
      const call = this.calls.get(Number(index)) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
      if (!omitted(delta.type) && delta.type !== "function") throw new ChatProtocolError("unsupported tool-call type");
      if (!omitted(delta.id)) {
        if (typeof delta.id !== "string" || !delta.id || delta.id.length > 256 || (call.id && call.id !== delta.id)) {
          throw new ChatProtocolError("provider changed or omitted a tool-call ID");
        }
        call.id = delta.id;
      }
      if (delta.function !== undefined) {
        const fn = object(delta.function);
        if (!fn) throw new ChatProtocolError("provider returned an invalid tool-call function");
        for (const field of ["name", "arguments"] as const) {
          if (omitted(fn[field])) continue;
          if (typeof fn[field] !== "string") throw new ChatProtocolError("provider returned invalid tool-call arguments or name");
          call.function[field] += fn[field];
          if (field === "arguments") this.argumentChars += fn[field].length;
        }
      }
      if (call.function.name.length > 64 || this.argumentChars > MAX_ARGUMENT_CHARS) {
        throw new ChatProtocolError("provider tool calls exceeded the size limit");
      }
      this.calls.set(Number(index), call);
    }
  }

  /** Gemini's OpenAI-compatible endpoint streams each call whole, with an id and no index: the slot of the call with
   * that id, else the one after the last. */
  private slotOf(id: unknown): number | undefined {
    if (typeof id !== "string" || !id) return undefined;
    for (const [slot, call] of this.calls) if (call.id === id) return slot;
    return this.calls.size ? Math.max(...this.calls.keys()) + 1 : 0;
  }

  finish(reason: string | null, malformedFrame: boolean): ChatToolCall[] {
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (malformedFrame) throw new MalformedToolCallError("provider stream contained a malformed completion frame");
    if (reason === "function_call") throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
    if (reason === "tool_calls" && !calls.length) throw new MalformedToolCallError("provider ended for tool calls without a complete call");
    if (!calls.length) return calls;
    if (reason !== null && reason !== "tool_calls" && reason !== "stop") {
      throw new MalformedToolCallError("provider tool calls were truncated or malformed");
    }
    // Repairable defects: an ID only correlates a result, so a missing or reused one gets a fresh one; a bad name
    // becomes a stand-in the turn answers with a tool error, so the model can call again by a valid name.
    const ids = new Set<string>();
    for (const call of calls) {
      if (!call.id || ids.has(call.id)) {
        const kind = call.id ? "id_duplicate" : "id_missing";
        call.id = syntheticToolCallId();
        this.repairs.push({ kind, id: call.id });
      }
      if (!VALID_TOOL_NAME.test(call.function.name)) {
        this.repairs.push({ kind: "invalid_name", id: call.id, name: call.function.name.slice(0, 64) });
        call.function.name = INVALID_TOOL_NAME;
      }
      ids.add(call.id);
    }
    if (this.repairs.length) console.warn(`chat: repaired provider tool calls: ${this.repairs.map((r) => r.kind).join(", ")}`);
    return calls;
  }
}
