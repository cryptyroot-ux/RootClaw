import { errorTranscript } from "../shared/client-cancel.ts";
import { isOutboundTool, isOutwardCommandAction, isSharedComputerToolName, isShellCommandToolName, outwardCommandActionsFromText } from "../shared/outbound.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { buildTurnDigest, digestTools } from "./digest.ts";
import { stopCause } from "./drivers/engine-errors.ts";
import type { TurnEvidence } from "./runtime/types.ts";
import type { Message } from "./store.ts";

const REASON_CHARS = 600;

type RuntimeError = RuntimeEvent & { type: "runtime.error" };

export interface TurnStop {
  turnId?: string;
  cause?: string;
  error?: string;
  /** The engine's own flags on that error (a setup or credit refusal, a stall, a usage limit and its reset). */
  flags?: Pick<RuntimeError, "setup" | "stalled" | "trialCredit" | "limitResetsAt" | "limit">;
  handoffPath?: string;
}

export class TurnStops {
  readonly #byThread = new Map<string, TurnStop>();

  note(event: RuntimeEvent): void {
    if (event.type === "turn.started") {
      this.#byThread.delete(event.threadId);
      return;
    }
    const error = event.type === "runtime.error" ? event.message
      : event.type === "item.completed" && event.itemType === "assistant_text" && event.synthetic ? event.text : undefined;
    if (event.type !== "cap.exhausted" && (error === undefined || errorTranscript(error).kind !== "error")) return;
    const stop = this.#turn(event.threadId, event.turnId);
    if (event.type === "cap.exhausted") stop.handoffPath = event.handoffPath;
    else stop.error = error;
    if (event.type === "runtime.error") {
      const { setup, stalled, trialCredit, limitResetsAt, limit } = event;
      if (setup || stalled || trialCredit || limitResetsAt || limit) stop.flags = { setup, stalled, trialCredit, limitResetsAt, limit };
    }
  }

  stopping(threadId: string, turnId: string | undefined, cause: string): void {
    this.#turn(threadId, turnId).cause = cause;
  }

  #turn(threadId: string, turnId: string | undefined): TurnStop {
    const held = this.#byThread.get(threadId);
    const stop: TurnStop = held && held.turnId === turnId ? held : { turnId };
    this.#byThread.set(threadId, stop);
    return stop;
  }

  read(threadId: string, turnId?: string): TurnStop | undefined {
    const stop = this.#byThread.get(threadId);
    return stop && (!turnId || !stop.turnId || stop.turnId === turnId) ? stop : undefined;
  }

  /** The turn's own last error, else the provider's stop reason in words; undefined for a turn that did not fail. */
  failureCause(event: { threadId: string; turnId?: string; ok: boolean; stopReason?: string | null }): string | undefined {
    if (event.ok) return undefined;
    return this.read(event.threadId, event.turnId)?.error ?? stopCause(event.stopReason);
  }

  forget(threadId: string): void {
    this.#byThread.delete(threadId);
  }
}

/** Cause first (a chip shows only the start), then the last message quoted as data, so a teammate's words never pass for the harness's. */
export function stoppedTurnOutcome(input: {
  reason: string;
  activities: readonly Message[];
  turnId?: string;
  said?: string;
}): string {
  const parts = [sentence(clip(input.reason, REASON_CHARS))];
  if (input.turnId) {
    const digest = buildTurnDigest({
      turnId: input.turnId, botId: "", threadId: "", at: 0, durationMs: 0,
      activities: input.activities, memory: [], reply: "", hookCoverage: "preview",
    });
    parts.push(digest.toolCalls
      ? `Before it stopped it made ${digest.toolCalls} tool call${digest.toolCalls === 1 ? "" : "s"}: ${digestTools(digest)}.`
      : "No tool calls were seen before it stopped.");
  }
  const said = input.said?.trim();
  return said ? `${parts.join(" ")}\nIts last message, quoted: ${JSON.stringify(said)}` : parts.join(" ");
}

const ERROR_CHARS = 200;
const ERRORS_KEPT = 3;

function parsedToolInput(input: unknown): Record<string, unknown> | undefined {
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.arguments;
  return nested && typeof nested === "object" && !Array.isArray(nested) ? { ...nested as Record<string, unknown>, ...record } : record;
}

/** Recover a complete top-level string field from a JSON preview cut before its closing brace. */
function partialTopLevelStringField(input: unknown, field: string): string | undefined {
  if (typeof input !== "string") return undefined;
  const source = input.trimStart();
  if (!source.startsWith("{")) return undefined;
  let index = 1;
  const whitespace = () => { while (/\s/u.test(source[index] ?? "")) index++; };
  const readString = (): string | undefined => {
    if (source[index] !== "\"") return undefined;
    const start = index++;
    let escaped = false;
    while (index < source.length) {
      const ch = source[index]!;
      index++;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") {
        try { return JSON.parse(source.slice(start, index)) as string; } catch { return undefined; }
      }
    }
    return undefined;
  };
  const skipValue = (): boolean => {
    whitespace();
    if (source[index] === "\"") return readString() !== undefined;
    let depth = 0, inString = false, escaped = false;
    for (; index < source.length; index++) {
      const ch = source[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        if (depth === 0) return true;
        depth--;
        if (depth === 0) { index++; return true; }
      } else if (ch === "," && depth === 0) return true;
    }
    return depth === 0 && !inString;
  };
  for (;;) {
    whitespace();
    if (source[index] === "}" || index >= source.length) return undefined;
    const name = readString();
    if (name === undefined) return undefined;
    whitespace();
    if (source[index] !== ":") return undefined;
    index++;
    whitespace();
    if (name === field) return readString();
    if (!skipValue()) return undefined;
    whitespace();
    if (source[index] !== ",") return undefined;
    index++;
  }
}

const toolRows = (rows: readonly Message[]) =>
  rows.filter((row) => row.role === "bot" && row.kind === "activity" && row.tool !== undefined);

/** The one outward-action classifier: the restart policy uses it so a cut turn that already acted never reruns. */
export function outwardActions(rows: readonly Message[]): string[] {
  const labels: string[] = [];
  const add = (label: string) => { if (!labels.includes(label)) labels.push(label); };
  for (const row of toolRows(rows)) {
    const tool = row.tool!;
    if (tool.ok === false) continue;
    if (isOutboundTool(tool.name)) { add(tool.name); continue; }
    for (const action of tool.outwardActions ?? []) if (isOutwardCommandAction(action)) add(action);
    let command: string;
    if (isShellCommandToolName(tool.name)) {
      command = [tool.input, tool.summary].filter((text): text is string => typeof text === "string").join("\n");
    } else if (isSharedComputerToolName(tool.name)) {
      const input = parsedToolInput(tool.input);
      const action = input?.action ?? partialTopLevelStringField(tool.input, "action");
      if (action !== "run_command") continue;
      command = [typeof input?.command === "string" ? input.command : undefined, tool.summary]
        .filter((text): text is string => typeof text === "string").join("\n");
    } else continue;
    for (const action of outwardCommandActionsFromText(command)) add(action);
  }
  return labels;
}

export function turnEvidence(rows: readonly Message[]): TurnEvidence {
  const tools = toolRows(rows);
  const errors = tools.filter((row) => row.tool!.ok === false).map((row) => {
    const tool = row.tool!;
    const output = tool.itemId && typeof tool.output === "string" ? tool.output.split("\n").find((line) => line.trim()) : undefined;
    return clip(output ? `${tool.name}: ${output}` : tool.name, ERROR_CHARS);
  }).slice(-ERRORS_KEPT);
  const okToolCalls = tools.filter((row) => row.tool!.ok !== false && row.tool!.itemId !== undefined).length;
  const outward = outwardActions(rows);
  return { toolCalls: tools.filter((row) => row.tool!.itemId !== undefined).length, okToolCalls, errors, ...(outward.length ? { outward } : {}) };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sentence(text: string): string {
  const capital = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?…"]$/.test(capital) ? capital : `${capital}.`;
}
