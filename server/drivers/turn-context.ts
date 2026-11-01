// Engine-level context management for native turns: request-size accounting, large tool-result offload
// with paging, and incremental mid-turn compaction. Provider-agnostic: every native driver shares it.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { prefixBytes } from "../context-rebuild.ts";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";
import { chatImageSize, type ImageSize } from "./chat-images.ts";
import { countTokens } from "./tokenizer.ts";

export interface TurnContextSettings {
  /** Fraction (<1) of the window, or absolute tokens, at which a turn compacts before the next model call. */
  compactAt?: number;
  /** Tool results larger than this (bytes) are offloaded to disk and paged with read_tool_output. */
  offloadBytes?: number;
  /** Folder for offloaded tool outputs; absent disables offload. */
  offloadDir?: string;
  /** Model that writes compaction summaries; absent uses the turn's model. */
  summaryModel?: string;
  /** Most recent assistant exchanges kept verbatim. */
  keepExchanges?: number;
  /** Provider requests one turn may make (2..64); the last may not call tools. Absent keeps the 64-step cap. */
  maxTurnRequests?: number;
}

export const DEFAULT_TURN_COMPACT_AT = 0.75;
export const DEFAULT_OFFLOAD_BYTES = 16_000;
export const DEFAULT_KEEP_EXCHANGES = 4;
const HEAD_BYTES = 2_000;
const TAIL_BYTES = 1_000;
const IMAGE_TOKENS = 1_100;
const MESSAGE_OVERHEAD_TOKENS = 4;

export const SUMMARY_TAG = "[Context summary of earlier steps in this turn — older messages were compacted]";

function textOf(content: OpenAIChatMessage["content"]): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  let text = "";
  let images = 0;
  for (const part of content) {
    if (part.type === "image_url") images++;
    else if ("text" in part && typeof part.text === "string") text += part.text;
  }
  return { text, images };
}

const tokensOfText = (text: string, model?: string) => countTokens(text, model);

/** What one image costs on a wire protocol, from its pixel size; IMAGE_TOKENS without either. */
export function imageTokens(size: ImageSize | undefined, protocol?: string): number {
  if (!size) return IMAGE_TOKENS;
  const { width, height } = size;
  switch (protocol) {
    case "anthropic-messages": return Math.min(1_600, Math.ceil((width * height) / 750));
    case "openai-chat":
    case "openai-responses": {
      // Fit in 2048 x 2048, shortest side down to 768, then 512 px tiles.
      const fit = Math.min(1, 2048 / Math.max(width, height));
      const scale = fit * Math.min(1, 768 / (Math.min(width, height) * fit));
      return 85 + 170 * Math.ceil((width * scale) / 512) * Math.ceil((height * scale) / 512);
    }
    case "gemini": return width <= 384 && height <= 384 ? 258 : 258 * Math.ceil(width / 768) * Math.ceil(height / 768);
    default: return IMAGE_TOKENS;
  }
}

/** Exact for models with a known (and loaded) encoding, see tokenizer.ts; a chars/3.5 over-count otherwise. */
export function estimateMessageTokens(message: OpenAIChatMessage, model?: string, protocol?: string): number {
  const { text } = textOf(message.content);
  let tokens = MESSAGE_OVERHEAD_TOKENS + tokensOfText(text, model);
  if (Array.isArray(message.content)) {
    for (const part of message.content) if (part.type === "image_url") tokens += imageTokens(chatImageSize(part), protocol);
  }
  if (message.tool_calls?.length) tokens += tokensOfText(JSON.stringify(message.tool_calls), model);
  for (const key of ["reasoning_content", "reasoning"] as const) if (message[key]) tokens += tokensOfText(message[key]!, model);
  if (message.reasoning_details?.length) tokens += tokensOfText(JSON.stringify(message.reasoning_details), model);
  return tokens;
}

/** Tokens a request will take: system + history + tool schemas + images, before calibration. */
export function estimateRequestTokens(messages: readonly OpenAIChatMessage[], tools: readonly ChatToolDefinition[] = [], model?: string, protocol?: string): number {
  let total = 3;
  for (const message of messages) total += estimateMessageTokens(message, model, protocol);
  if (tools.length) total += tokensOfText(JSON.stringify(tools), model);
  return total;
}

export function turnCompactBudget(window: number, compactAt?: number): number {
  const at = typeof compactAt === "number" && Number.isFinite(compactAt) && compactAt > 0 ? compactAt : DEFAULT_TURN_COMPACT_AT;
  return Math.max(1, Math.floor(Math.min(at < 1 ? window * at : at, window * 0.9)));
}

/** The reply ceiling adapters send when the window has room for it (Anthropic requires one on every call). */
export const DEFAULT_OUTPUT_TOKENS = 8_192;

/** Output tokens kept free of input in every request: the default reply, or an eighth of a small window. */
export function outputReserve(window: number): number {
  return Math.min(DEFAULT_OUTPUT_TOKENS, Math.floor(window / 8));
}

/** Slack for the gap between the estimate and the provider's own count. */
export function windowMargin(window: number): number {
  return Math.max(64, Math.ceil(window * 0.01));
}

/** The input budget of a round: the compaction threshold, never above what leaves the output reserve free. */
export function turnInputBudget(window: number, compactAt?: number): number {
  return Math.max(1, Math.min(turnCompactBudget(window, compactAt), window - outputReserve(window) - windowMargin(window)));
}

/** The smallest reply ceiling worth sending a request for. */
export function minOutputTokens(window: number): number {
  return Math.max(256, Math.floor(outputReserve(window) / 4));
}

/** A reply ceiling for a request of `inputTokens` (0 when none is left), or undefined when the adapter default already fits beside it. */
export function outputTokensFor(window: number, inputTokens: number): number | undefined {
  const room = Math.max(0, Math.floor(window - inputTokens - windowMargin(window)));
  return room < DEFAULT_OUTPUT_TOKENS ? room : undefined;
}

/** What each instance's model has said about the estimate, kept across turns (and threads) so a turn's first
 * request is already calibrated: for Claude, Gemini and other models without a local tokenizer the character estimate
 * can be off by 2-3x on code or non-Latin text, and only the provider's prompt_tokens knows by how much. Keyed by
 * instance and model: two providers serving the same model id count differently. */
const learnedRatios = new Map<string, number>();
const MAX_LEARNED_MODELS = 64;
/** Weight of the newest observation; one odd usage figure (a cached or prefixed prompt) moves the ratio only this far. */
const CALIBRATION_ALPHA = 0.3;
const clampRatio = (ratio: number) => Math.min(3, Math.max(1, ratio));

/** Learns how far the cheap estimate is from the provider's own prompt_tokens, never scaling it below 1 (an
 * over-count only compacts early; an under-count overflows the window). Costs nothing: no extra request. */
export class TokenCalibration {
  private ratio: number;
  private readonly key: string | undefined;
  constructor(model?: string, instanceId?: string) {
    this.key = model ? (instanceId ? `${instanceId}:${model}` : model) : undefined;
    this.ratio = (this.key && learnedRatios.get(this.key)) || 1;
  }
  private observed: number | undefined;
  observe(estimated: number, reported: number | undefined) {
    if (!reported || reported <= 0 || estimated <= 0) return;
    const first = this.observed === undefined && !(this.key && learnedRatios.has(this.key));
    this.observed = reported / estimated;
    this.ratio = first ? clampRatio(this.observed) : clampRatio(CALIBRATION_ALPHA * clampRatio(this.observed) + (1 - CALIBRATION_ALPHA) * this.ratio);
    if (!this.key) return;
    learnedRatios.delete(this.key);
    learnedRatios.set(this.key, this.ratio);
    if (learnedRatios.size > MAX_LEARNED_MODELS) learnedRatios.delete(learnedRatios.keys().next().value!);
  }
  apply(estimated: number) { return Math.ceil(estimated * this.ratio); }
  /** The provider's own count for `estimated`, by the last ratio it reported (unclamped, so it may be below the estimate). */
  provider(estimated: number) { return Math.ceil(estimated * (this.observed ?? this.ratio)); }
}

// ---------- tool-output offload ----------

export const READ_TOOL_OUTPUT_TOOL = "read_tool_output";
export const READ_TOOL_OUTPUT_DEFINITION: ChatToolDefinition = {
  type: "function",
  function: {
    name: READ_TOOL_OUTPUT_TOOL,
    description: "Read part of a large tool output or message that was saved to disk instead of being shown in full. Pass the handle from the shortened text; offset and limit are in characters.",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "The handle printed in the shortened tool result, e.g. out_ab12cd34ef." },
        offset: { type: "integer", minimum: 0, description: "Character offset to start reading at (default 0)." },
        limit: { type: "integer", minimum: 1, maximum: 20000, description: "Characters to read (default 8000, max 20000)." },
      },
      required: ["handle"],
      additionalProperties: false,
    },
  },
};

const HANDLE = /^out_[A-Za-z0-9_-]{6,64}$/;
/** The per-thread folder offloaded outputs live in; retention protects it while the thread runs. */
export const threadFolder = (dir: string, threadId: string) => join(dir, createHash("sha256").update(threadId).digest("hex").slice(0, 24));

export interface Offloaded { text: string; handle: string; bytes: number }

/** Saves `text` in full and returns head + tail + a note naming the handle; null when it is small enough. */
export function offloadToolOutput(text: string, input: { dir?: string; threadId: string; callId: string; thresholdBytes?: number; what?: string; headBytes?: number; tailBytes?: number }): Offloaded | null {
  const threshold = input.thresholdBytes ?? DEFAULT_OFFLOAD_BYTES;
  const bytes = Buffer.byteLength(text);
  if (!input.dir || bytes <= threshold) return null;
  const handle = `out_${createHash("sha256").update(`${input.threadId}\0${input.callId}\0${bytes}`).digest("base64url").slice(0, 16)}`;
  const folder = threadFolder(input.dir, input.threadId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, `${handle}.txt`), text, { mode: 0o600 });
  const head = prefixBytes(text, input.headBytes ?? HEAD_BYTES);
  const tailStart = Math.max(head.length, text.length - (input.tailBytes ?? TAIL_BYTES));
  const tail = text.slice(tailStart);
  const what = input.what ?? "output";
  const note = `\n\n[… ${what} shortened: ${text.length} characters in total, ${text.length - head.length - tail.length} omitted. ` +
    `Full ${what} saved with handle ${handle}; call ${READ_TOOL_OUTPUT_TOOL} {"handle":"${handle}","offset":${head.length},"limit":8000} to read more.]\n\n`;
  return { text: `${head}${note}${tail}`, handle, bytes };
}

const OFFLOAD_NOTE_TOKENS = 120;

/** Saves the middle of a pinned message over `maxTokens` the same way, in place, keeping as much head and tail as
 * `maxTokens` allows; the handles made. */
export function offloadRequest(message: OpenAIChatMessage, input: { dir?: string; threadId: string; turnId: string; maxTokens: number; model?: string; protocol?: string }): Offloaded[] {
  const tokens = estimateMessageTokens(message, input.model, input.protocol);
  if (!input.dir || tokens <= input.maxTokens) return [];
  const { text: all } = textOf(message.content);
  const parts = Array.isArray(message.content) ? Math.max(1, message.content.filter((part) => part.type === "text").length) : 1;
  const bytesPerToken = Buffer.byteLength(all) / Math.max(1, tokens);
  const keep = Math.max(HEAD_BYTES + TAIL_BYTES, Math.floor((input.maxTokens - OFFLOAD_NOTE_TOKENS * parts) * bytesPerToken * 0.95 / parts));
  const save = (text: string, index: number) => offloadToolOutput(text, { dir: input.dir, threadId: input.threadId, callId: `request:${input.turnId}:${index}`,
    thresholdBytes: keep + 1_000, what: "message", headBytes: Math.floor(keep * 2 / 3), tailBytes: keep - Math.floor(keep * 2 / 3) });
  if (typeof message.content === "string") {
    const offloaded = save(message.content, 0);
    if (offloaded) message.content = offloaded.text;
    return offloaded ? [offloaded] : [];
  }
  if (!Array.isArray(message.content)) return [];
  const made: Offloaded[] = [];
  message.content = message.content.map((part, index) => {
    if (part.type !== "text") return part;
    const offloaded = save(part.text, index);
    if (!offloaded) return part;
    made.push(offloaded);
    return { ...part, text: offloaded.text };
  });
  return made;
}

export function readToolOutput(args: Record<string, unknown>, input: { dir?: string; threadId: string }): { ok: boolean; text: string } {
  const handle = typeof args.handle === "string" ? args.handle.trim() : "";
  if (!input.dir) return { ok: false, text: "Tool output offload is not enabled for this turn." };
  if (!HANDLE.test(handle)) return { ok: false, text: "Unknown handle: pass the out_… handle from a shortened tool result." };
  const folder = threadFolder(input.dir, input.threadId);
  const file = resolve(folder, `${handle}.txt`);
  if (!file.startsWith(resolve(folder) + sep) || !existsSync(file)) return { ok: false, text: `No saved output for handle ${handle} in this conversation.` };
  const full = readFileSync(file, "utf8");
  const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
  const limit = Math.min(20_000, Math.max(1, Math.floor(Number(args.limit ?? 8_000)) || 8_000));
  const slice = full.slice(offset, offset + limit);
  const end = offset + slice.length;
  return { ok: true, text: `[${handle}: characters ${offset}–${end} of ${full.length}${end < full.length ? `; next offset ${end}` : "; end of output"}]\n${slice}` };
}

// ---------- compaction ----------

export interface CompactionPlan {
  /** Messages folded into the summary (may include an earlier summary). */
  folded: OpenAIChatMessage[];
  previousSummary: string | null;
  build(summary: string): OpenAIChatMessage[];
}

const isSummary = (message: OpenAIChatMessage) => message.role === "user" && typeof message.content === "string" && message.content.startsWith(SUMMARY_TAG);

/** Splits messages into pinned (system, request), a foldable middle, and a verbatim tail that starts on an
 * assistant message so every tool result stays with its call. Null when nothing can be folded. */
export function planCompaction(messages: readonly OpenAIChatMessage[], request: OpenAIChatMessage, keepExchanges = DEFAULT_KEEP_EXCHANGES): CompactionPlan | null {
  const head = messages[0]?.role === "system" ? 1 : 0;
  const requestAt = messages.indexOf(request);
  const assistants: number[] = [];
  for (let index = head; index < messages.length; index++) if (messages[index]!.role === "assistant") assistants.push(index);
  // The tail never begins before the request, which is pinned on its own.
  const eligible = assistants.filter((index) => index > requestAt);
  const keep = Math.max(1, keepExchanges);
  let cut: number;
  if (eligible.length > keep) cut = eligible[eligible.length - keep]!;
  else {
    // Few rounds this turn: fold transcript history before the request instead.
    cut = requestAt;
  }
  const folded: OpenAIChatMessage[] = [];
  let previousSummary: string | null = null;
  for (let index = head; index < cut; index++) {
    const message = messages[index]!;
    if (message === request) continue;
    if (isSummary(message)) { previousSummary = (message.content as string).slice(SUMMARY_TAG.length).trim(); continue; }
    folded.push(message);
  }
  if (!folded.length) return null;
  const system = messages.slice(0, head);
  const tail = messages.slice(cut).filter((message) => message !== request);
  const requestBeforeTail = requestAt >= 0 && requestAt <= cut;
  return {
    folded,
    previousSummary,
    build: (summary) => [
      ...system,
      { role: "user", content: `${SUMMARY_TAG}\n${summary.trim()}` },
      ...(requestBeforeTail ? [request] : []),
      ...tail,
    ],
  };
}

const RENDER_MESSAGE_BYTES = 3_000;

/** Folded messages as plain text for the summarizer, each bounded. */
const SALIENT = /\b(error|errors|fail(?:ed|ure|s)?|exception|fatal|panic|traceback|warn(?:ing)?|denied|refused|timeout|todo|fixme)\b/i;
const SALIENT_BYTES = 2_000;

/** Head and tail of a long text, plus the lines from the cut middle that look like findings (errors, failures,
 * warnings), so what the agent was looking for survives even when it sat in the middle. */
export function elide(text: string, maxBytes: number): string {
  const tailBytes = Math.min(1_000, Math.floor(maxBytes / 6));
  const headBytes = Math.max(200, maxBytes - tailBytes - SALIENT_BYTES - 200);
  const head = prefixBytes(text, headBytes);
  const tail = text.slice(-tailBytes);
  const middle = text.slice(head.length, Math.max(head.length, text.length - tail.length));
  const picked: string[] = [];
  let size = 0;
  // Tool results arrive as JSON ({"ok":…,"result":"…"}), where line breaks are the two characters \ and n.
  for (const line of middle.split(/\n|\\n/)) {
    if (!SALIENT.test(line)) continue;
    const kept = line.length > 300 ? `${line.slice(0, 300)}…` : line;
    if (size + kept.length > SALIENT_BYTES) break;
    picked.push(kept);
    size += kept.length + 1;
  }
  return `${head} …${picked.length ? `\n[matching lines from the omitted middle]\n${picked.join("\n")}\n…` : ""} ${tail}`;
}

export function renderForSummary(messages: readonly OpenAIChatMessage[], budgetBytes: number): string {
  const lines: string[] = [];
  let used = 0;
  // Each message may use its share of the whole budget (never less than RENDER_MESSAGE_BYTES): a fixed 3 KB head+tail
  // dropped the middle of every long tool result, so a finding there (one ERROR line in a 20 KB log) never reached
  // the summarizer and the agent re-read the file after every compaction.
  const share = Math.max(RENDER_MESSAGE_BYTES, Math.floor(budgetBytes / Math.max(1, messages.length)) - 200);
  for (const message of messages) {
    const { text, images } = textOf(message.content);
    const calls = message.tool_calls?.map((call) => `${call.function.name}(${call.function.arguments.slice(0, 400)})`).join("; ");
    let body = text;
    if (Buffer.byteLength(body) > share) body = elide(body, share);
    const line = `[${message.role}${message.tool_call_id ? ` result ${message.tool_call_id}` : ""}] ${calls ? `calls: ${calls} ` : ""}${body}${images ? ` [${images} image(s)]` : ""}`;
    const size = Buffer.byteLength(line);
    if (used + size > budgetBytes) { lines.push(`[… ${messages.length - lines.length} more message(s) not shown]`); break; }
    lines.push(line);
    used += size;
  }
  return lines.join("\n");
}

export function summaryPrompt(previousSummary: string | null, rendered: string, maxBytes?: number): string {
  return [
    "You compact an AI agent's working context. Write a dense, structured note that lets the agent continue the SAME task without the original messages.",
    ...(maxBytes ? [`Keep the note under ${Math.floor(maxBytes / 6)} words; findings, errors and exact identifiers first.`] : []),
    "Use exactly these sections, as bullet lists (write 'none' when empty):",
    "## Goal", "## Decisions", "## Facts and constraints (keep every exact identifier, number, path, URL, name, and value verbatim)",
    "## Files and resources touched", "## Open todos / next steps",
    "Merge the previous summary with the new messages; drop nothing from the previous summary that is still true. Do not invent facts. Output only the note.",
    "",
    "### Previous summary", previousSummary ?? "none",
    "", "### New messages to fold in", rendered,
  ].join("\n");
}

/** Used when the summarizer call fails: keeps the previous note and the start of every folded text message. */
export function deterministicTurnSummary(previousSummary: string | null, folded: readonly OpenAIChatMessage[]): string {
  const facts = folded.flatMap((message) => {
    const { text } = textOf(message.content);
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return [];
    return [`- (${message.role}) ${trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed}`];
  });
  return [previousSummary ?? "", "## Folded messages (automatic fallback summary)", ...facts.slice(-60)].filter(Boolean).join("\n");
}

export interface CompactResult { messages: OpenAIChatMessage[]; folded: number; beforeTokens: number; afterTokens: number; summarizer: "model" | "fallback" }

/** One incremental compaction: folds older steps (plus any earlier summary) into a new summary message.
 * With `targetTokens`, it folds enough in ONE pass to land at or under the target (keeping as many recent exchanges as
 * fit, at least one), and bounds the summary itself; without it, it keeps `keepExchanges` as before. Folding a fixed
 * small batch per pass barely shrank a history far over budget, and an unbounded summary could be as large as what it
 * replaced. `minSavedTokens` skips a fold that would free less than that, `fitWithinTokens` one whose best plan
 * still lands above that size (summary at its cap), and `tailWithinTokens` one whose kept tail alone (no summary) is
 * above it; all return null without calling `summarize`. */
export async function compactTurnMessages(
  messages: readonly OpenAIChatMessage[],
  request: OpenAIChatMessage,
  input: { tools?: readonly ChatToolDefinition[]; model?: string; protocol?: string; keepExchanges?: number; summarize: (prompt: string) => Promise<string>; summaryBudgetBytes: number;
    targetTokens?: number; minSavedTokens?: number; fitWithinTokens?: number; tailWithinTokens?: number; signal?: AbortSignal },
): Promise<CompactResult | null> {
  const target = input.targetTokens;
  const summaryCapBytes = target ? Math.max(1_200, Math.floor(target * 0.25 * 3.5)) : undefined;
  const plan = target ? planToFit(messages, request, input, target, summaryCapBytes!) : planCompaction(messages, request, input.keepExchanges);
  if (!plan) return null;
  const beforeTokens = estimateRequestTokens(messages, input.tools, input.model, input.protocol);
  if (input.fitWithinTokens && estimateRequestTokens(plan.build("x".repeat(summaryCapBytes ?? input.summaryBudgetBytes)), input.tools, input.model, input.protocol) > input.fitWithinTokens) return null;
  if (input.tailWithinTokens && estimateRequestTokens(plan.build(""), input.tools, input.model, input.protocol) > input.tailWithinTokens) return null;
  if (input.minSavedTokens) {
    const foldedBytes = Buffer.byteLength(renderForSummary(plan.folded, input.summaryBudgetBytes)) + Buffer.byteLength(plan.previousSummary ?? "");
    const projected = estimateRequestTokens(plan.build("x".repeat(Math.min(summaryCapBytes ?? input.summaryBudgetBytes, foldedBytes))), input.tools, input.model, input.protocol);
    if (beforeTokens - projected < input.minSavedTokens) return null;
  }
  let summary: string;
  let summarizer: CompactResult["summarizer"] = "model";
  try {
    summary = (await input.summarize(summaryPrompt(plan.previousSummary, renderForSummary(plan.folded, input.summaryBudgetBytes), summaryCapBytes))).trim();
    if (!summary) throw new Error("empty summary");
  } catch (error) {
    // An aborted turn stops here; only a failed summary call falls back to the deterministic note.
    if (input.signal?.aborted || (error as Error | undefined)?.name === "AbortError") throw error;
    summary = deterministicTurnSummary(plan.previousSummary, plan.folded);
    summarizer = "fallback";
  }
  // A summary over its cap is cut like a long tool result: head, tail, and the finding lines in between.
  if (summaryCapBytes && Buffer.byteLength(summary) > summaryCapBytes) summary = elide(summary, summaryCapBytes);
  // The plan reserved the cap as plain prose (bytes / 3.5 tokens); dense text (digits, punctuation) costs more tokens
  // per byte, so cut it further until it fits that token reservation.
  const capTokens = summaryCapBytes ? Math.ceil(summaryCapBytes / 3.5) : 0;
  for (let i = 0; summaryCapBytes && i < 4; i++) {
    const tokens = countTokens(summary, input.model);
    if (tokens <= capTokens) break;
    summary = elide(summary, Math.floor(Buffer.byteLength(summary) * capTokens / tokens * 0.95));
  }
  const next = plan.build(summary);
  return { messages: next, folded: plan.folded.length, beforeTokens, afterTokens: estimateRequestTokens(next, input.tools, input.model, input.protocol), summarizer };
}

/** The plan that keeps the most recent exchanges while the projected request (summary at its cap) fits the target;
 * when none fits, the smallest tail (one exchange). */
function planToFit(messages: readonly OpenAIChatMessage[], request: OpenAIChatMessage,
  input: { tools?: readonly ChatToolDefinition[]; model?: string; protocol?: string; keepExchanges?: number }, target: number, summaryCapBytes: number): CompactionPlan | null {
  const placeholder = "x".repeat(summaryCapBytes);
  let fallback: CompactionPlan | null = null;
  for (let keep = Math.max(1, input.keepExchanges ?? DEFAULT_KEEP_EXCHANGES); keep >= 1; keep--) {
    const plan = planCompaction(messages, request, keep);
    if (!plan) continue;
    fallback = plan;
    if (estimateRequestTokens(plan.build(placeholder), input.tools, input.model, input.protocol) <= target) return plan;
  }
  return fallback;
}

/** Without a summary call: when even the smallest compaction (one kept exchange, summary at its cap) would still be
 * over `fitWithinTokens`, the tool results in that kept tail are saved to disk like a large tool output, the biggest
 * first, each cut to an equal share so the projected request lands at `targetTokens`. The handles made. */
export function offloadTail(messages: OpenAIChatMessage[], request: OpenAIChatMessage, input: { dir?: string; threadId: string; tools?: readonly ChatToolDefinition[];
  model?: string; protocol?: string; fitWithinTokens: number; targetTokens: number }): Offloaded[] {
  if (!input.dir) return [];
  const capBytes = Math.max(1_200, Math.floor(input.targetTokens * 0.25 * 3.5));
  const plan = planCompaction(messages, request, 1);
  const projected = () => estimateRequestTokens(plan ? plan.build("x".repeat(capBytes)) : messages, input.tools, input.model, input.protocol);
  const before = projected();
  if (before <= input.fitWithinTokens) return [];
  let start = messages.length - 1;
  while (start >= 0 && messages[start]!.role !== "assistant") start--;
  start = Math.max(start, messages.indexOf(request));
  const results = messages.slice(start + 1).filter((message) => message.role === "tool" && typeof message.content === "string");
  const sizes = results.map((message) => estimateMessageTokens(message, input.model, input.protocol));
  let room = input.targetTokens - (before - sizes.reduce((sum, size) => sum + size, 0));
  // The equal share: results under it stay whole and leave their unused share to the larger ones.
  const order = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
  let share = 0;
  for (let i = 0; i < order.length; i++) {
    share = Math.floor(room / (order.length - i));
    if (order[i]!.size > share) break;
    room -= order[i]!.size;
  }
  const made: Offloaded[] = [];
  for (const { size, index } of order) {
    if (size <= share) continue;
    const message = results[index]!;
    const content = message.content as string;
    let parsed: { ok?: unknown; result?: unknown } | null = null;
    try { parsed = JSON.parse(content) as { ok?: unknown; result?: unknown }; } catch { /* plain text result */ }
    const text = parsed && typeof parsed.result === "string" ? parsed.result : content;
    const keep = Math.max(HEAD_BYTES + TAIL_BYTES, Math.floor((share - OFFLOAD_NOTE_TOKENS) * Buffer.byteLength(text) / size * 0.9));
    const offloaded = offloadToolOutput(text, { dir: input.dir, threadId: input.threadId, callId: `tail:${message.tool_call_id ?? index}`,
      thresholdBytes: keep + 1_000, headBytes: Math.floor(keep * 2 / 3), tailBytes: keep - Math.floor(keep * 2 / 3) });
    if (!offloaded) continue;
    message.content = parsed && typeof parsed.result === "string" ? JSON.stringify({ ...parsed, result: offloaded.text }) : offloaded.text;
    made.push(offloaded);
  }
  return made;
}

/** A provider's refusal of a prompt over its context window (OpenAI, Groq, Mistral, OpenRouter, vLLM, llama.cpp, LM Studio …). */
const CONTEXT_OVERFLOW = /context[_ ]length[_ ]exceeded|maximum context length|context (?:window|length) (?:of|is|exceeded)|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|prompt is too long|too many (?:input )?tokens|reduce the length of the messages|input (?:is )?too long|exceeds (?:the )?available context(?: size)?|request exceeds the maximum|tokens? (?:limit|budget) exceeded/i;

const OVERFLOW_LIMITS = [
  /maximum context length is (\d[\d,]*)/i,
  /\d[\d,]* tokens? > (\d[\d,]*) maximum/i,
  /exceed context limit: \d[\d,]* \+ \d[\d,]* > (\d[\d,]*)/i,
  /maximum number of tokens allowed \(?(\d[\d,]*)/i,
  /available context size \((\d[\d,]*) tokens?\)/i,
  /context (?:window|length|size) (?:limit )?(?:of|is) (\d[\d,]*) tokens?/i,
];

/** The context limit a provider names in its overflow refusal, when it names one. */
export function overflowLimit(message: string): number | undefined {
  for (const pattern of OVERFLOW_LIMITS) {
    const found = pattern.exec(message)?.[1];
    const limit = found ? Number(found.replace(/,/g, "")) : NaN;
    if (Number.isSafeInteger(limit) && limit >= 256) return limit;
  }
  return undefined;
}

export function refusesContextLength(status: number, body: string): boolean {
  return (status === 400 || status === 413 || status === 422 || status === 500) && CONTEXT_OVERFLOW.test(body);
}
