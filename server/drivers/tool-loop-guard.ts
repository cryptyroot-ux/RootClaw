// Cross-round loop guard for one native turn: an identical read-only call with nothing changed since is answered
// from the earlier result, and the third identical call of any kind turns tools off so the model has to answer.
import { ASK_USER_TOOL } from "../../shared/ask-question.ts";
import { UPDATE_PLAN_TOOL } from "./plan-verify.ts";

const LOOP_LIMIT = 3;
export const TOOL_LOOP_NOTICE = "Stopped the model repeating the same tool call (3 identical calls this turn); it answers without tools now.";
export const TOOL_LOOP_NOTE = "[RootClaw] You made the same tool call 3 times in this turn, so tools are off now. Answer from what you already have, and say plainly what is still undone.";

const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]))
  : value;

/** The tool name plus its arguments as JSON with keys sorted, so key order never makes two calls differ. */
export function toolCallSignature(name: string, rawArgs: string): string {
  let args: unknown;
  try { args = JSON.parse(rawArgs); } catch { return `${name}\u0000${rawArgs}`; }
  return `${name}\u0000${JSON.stringify(sorted(args))}`;
}

interface GuardedCall { id: string; function: { name: string; arguments: string } }

export class ToolLoopGuard {
  /** Bumped by every successful mutating call: reads from an older epoch may be stale. */
  #epoch = 0;
  #counts = new Map<string, number>();
  #reads = new Map<string, { round: number; epoch: number; result: string }>();
  #denied = new Set<string>();
  #reused = new Set<string>();
  /** Set once a signature reaches the limit: the next request goes without tools and the turn ends. */
  closing = false;

  deny(callId: string): void { this.#denied.add(callId); }

  /** The tool message for a read-only call identical to an earlier one in the same epoch, or undefined to run it. */
  reuse(call: GuardedCall, readOnly: boolean): string | undefined {
    const earlier = readOnly && call.function.name !== UPDATE_PLAN_TOOL ? this.#reads.get(toolCallSignature(call.function.name, call.function.arguments)) : undefined;
    if (!earlier || earlier.epoch !== this.#epoch) return undefined;
    this.#reused.add(call.id);
    return JSON.stringify({ ok: true, result: `Identical to the call in round ${earlier.round}; nothing has changed since, so it was not run again. Its result:\n${earlier.result}` });
  }

  /** Records a committed call (round is 1-based); true only for the call that first reaches the limit. */
  commit(call: GuardedCall, readOnly: boolean, content: string, round: number): boolean {
    if (this.#denied.has(call.id) || call.function.name === ASK_USER_TOOL) return false;
    const signature = toolCallSignature(call.function.name, call.function.arguments);
    const { ok, result } = JSON.parse(content) as { ok: boolean; result: string };
    if (ok && !readOnly) this.#epoch++;
    if (ok && readOnly && !this.#reused.has(call.id)) this.#reads.set(signature, { round, epoch: this.#epoch, result });
    const count = (this.#counts.get(signature) ?? 0) + 1;
    this.#counts.set(signature, count);
    if (count < LOOP_LIMIT || this.closing) return false;
    this.closing = true;
    return true;
  }
}
