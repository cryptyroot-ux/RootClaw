// Context budget, compaction and offloading for a single turn's model requests.
// Extracted from server/drivers/openai-chat.ts to keep that file under the ratchet cap.
import type { ChatToolSession } from "./chat-mcp-tools.ts";
import type { ModelAdapter, OpenAIChatMessage } from "./model-adapter.ts";
import type { TokenCalibration, TurnContextSettings, TurnPlan } from "./turn-context.ts";
import {
  compactTurnMessages,
  DEFAULT_OUTPUT_TOKENS,
  estimateRequestTokens,
  estimateMessageTokens,
  minOutputTokens,
  offloadRequest,
  offloadTail,
  outputTokensFor,
  outputReserve,
  windowMargin,
} from "./turn-context.ts";
import { pinPlan, unpinPlan } from "./plan-verify.ts";
import { appendCompaction } from "./compaction-journal.ts";
import { syntheticToolCallId } from "./openai-chat-protocol.ts";
import { DATA_DIR } from "../config.ts";
import type { RuntimeOptions } from "./openai-chat.ts";

// Overflow recovery pays for at most two summaries a turn (one, then one retry); after that it only offloads or fails.
const MAX_OVERFLOW_COMPACTIONS = 2;

export interface ChatContextDeps {
  messages: OpenAIChatMessage[];
  request: OpenAIChatMessage;
  tools: ChatToolSession;
  adapter: ModelAdapter;
  model: string;
  abort: AbortController;
  native: (dir: "out" | "in", msg: unknown) => void;
  turnId: string;
  threadId: string;
  botId: string | undefined;
  ctx: TurnContextSettings;
  options: RuntimeOptions<unknown>;
  calibration: TokenCalibration;
  /** Context window in raw tokens; may be lowered by learned refusals. */
  window: number;
  /** Turn token budget; recomputed when the window changes. */
  budget: number;
  planning: boolean;
  plan: TurnPlan | null;
  planHint: string;
  requestsLeft: () => number;
  driverKind: string;
  currentRound?: number;
}

export class ChatContext {
  compactions = 0;
  overflowCompactions = 0;
  compactedAfter: number | undefined;
  readonly deps: ChatContextDeps;
  private pinnedOriginal: OpenAIChatMessage["content"] | undefined;

  constructor(deps: ChatContextDeps) {
    this.deps = deps;
  }

  get window(): number { return this.deps.window; }
  set window(v: number) { this.deps.window = v; }

  get budget(): number { return this.deps.budget; }
  set budget(v: number) { this.deps.budget = v; }

  get currentRound(): number { return this.deps.currentRound ?? 0; }
  set currentRound(v: number) { this.deps.currentRound = v; }

  private get messages() { return this.deps.messages; }
  private get request() { return this.deps.request; }
  private get tools() { return this.deps.tools; }
  private get adapter() { return this.deps.adapter; }
  private get model() { return this.deps.model; }
  private get abort() { return this.deps.abort; }
  private get native() { return this.deps.native; }
  private get turnId() { return this.deps.turnId; }
  private get threadId() { return this.deps.threadId; }
  private get botId() { return this.deps.botId; }
  private get ctx() { return this.deps.ctx; }
  private get options() { return this.deps.options; }
  private get calibration() { return this.deps.calibration; }
  private get planning() { return this.deps.planning; }
  private get plan() { return this.deps.plan; }
  private get planHint() { return this.deps.planHint; }
  private get requestsLeft() { return this.deps.requestsLeft; }

  sizeNow(): number {
    return this.calibration.apply(estimateRequestTokens(this.messages, this.tools.definitions, this.model, this.adapter.protocol));
  }

  ratioNow(): number {
    return Math.max(1, this.calibration.apply(1_000_000) / 1_000_000);
  }

  modelLabel(): string {
    return this.options.models().options.find((option) => option.id === this.model)?.label ?? this.model;
  }

  /** Overflow recovery pays for at most two summaries a turn (one, then one retry); after that it only offloads or fails. */
  async compact(
    reason: "budget" | "overflow",
    keepExchanges: number,
    targetTokens?: number,
    minSavedTokens?: number,
    fitWithinTokens?: number,
    tailWithinTokens?: number,
  ): Promise<boolean> {
    if (reason === "overflow" && this.overflowCompactions >= MAX_OVERFLOW_COMPACTIONS) return false;
    const summaryModel = this.ctx.summaryModel || this.model;
    const rawNow = () => estimateRequestTokens(this.messages, this.tools.definitions, this.model, this.adapter.protocol);
    const withPlan = this.planning ? rawNow() : 0;
    if (this.planning) { unpinPlan(this.messages); }
    const planTokens = this.planning ? withPlan - rawNow() : 0;
    const less = (limit?: number) => (limit ? Math.max(1, limit - planTokens) : undefined);
    [targetTokens, fitWithinTokens, tailWithinTokens] = [less(targetTokens), less(fitWithinTokens), less(tailWithinTokens)];
    let result: Awaited<ReturnType<typeof compactTurnMessages>>;
    try {
      result = await compactTurnMessages(this.messages, this.request, {
        tools: this.tools.definitions, model: this.model, protocol: this.adapter.protocol, keepExchanges,
        ...(targetTokens ? { targetTokens } : {}),
        ...(minSavedTokens ? { minSavedTokens } : {}),
        ...(fitWithinTokens ? { fitWithinTokens } : {}),
        ...(tailWithinTokens ? { tailWithinTokens } : {}),
        summaryBudgetBytes: Math.max(4_000, Math.floor(this.window * 0.4 * 3.5)),
        summarize: async (prompt) => {
          const room = outputTokensFor(this.window, this.calibration.apply(estimateRequestTokens([{ role: "user", content: prompt }], [], summaryModel)));
          const maxTokens = Math.min(outputReserve(this.window), room ?? DEFAULT_OUTPUT_TOKENS);
          if (maxTokens < minOutputTokens(this.window)) throw new Error("no room left for a summary");
          if (this.requestsLeft() <= 1) throw new Error("no request left for a summary");
          const { text, reasoning } = await this.adapter.complete({
            messages: [{ role: "user", content: prompt }],
            model: summaryModel,
            stream: false,
            signal: this.abort.signal,
            tools: [],
            maxTokens,
          });
          return text.trim() ? text : reasoning;
        },
        signal: this.abort.signal,
      });
      if (result) this.messages.splice(0, this.messages.length, ...result.messages);
    } finally { if (this.planning) pinPlan(this.messages, this.plan, this.planHint); }
    if (!result) return false;
    this.compactions++;
    if (reason === "overflow") this.overflowCompactions++;
    this.compactedAfter = this.sizeNow();
    const line = {
      compacted: reason,
      n: this.compactions,
      folded: result.folded,
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      window: this.window,
      budget: this.budget,
      summarizer: result.summarizer,
    };
    this.native("out", line);
    console.info(`${this.options.driverKind}: [context] compaction #${this.compactions} (${reason}) folded ${result.folded} messages, ~${result.beforeTokens} → ~${result.afterTokens} tokens (window ${this.window}, budget ${this.budget}, ${result.summarizer})`);
    try {
      appendCompaction(DATA_DIR, {
        id: syntheticToolCallId(),
        runId: this.turnId,
        threadId: this.threadId,
        botId: this.botId,
        round: this.currentRound,
        reason: reason === "overflow" ? "overflow" : "budget",
        messagesBefore: result.folded + this.messages.length,
        messagesAfter: this.messages.length,
        tokensBefore: result.beforeTokens,
        tokensAfter: result.afterTokens,
        tokensSaved: result.beforeTokens - result.afterTokens,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error(`[compaction-journal] Failed to journal: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  /** The smallest request the window can still answer, in raw (uncalibrated) tokens. */
  sendable(): number {
    return Math.floor((this.window - windowMargin(this.window) - minOutputTokens(this.window)) / this.ratioNow());
  }

  /** When even one kept exchange cannot be sent, its tool results are saved to disk (preview + handle) with no summary call. */
  offloadKeptTail(offloadOn: boolean): boolean {
    if (!offloadOn) return false;
    const made = offloadTail(this.messages, this.request, {
      dir: this.ctx.offloadDir,
      threadId: this.threadId,
      tools: this.tools.definitions,
      model: this.model,
      protocol: this.adapter.protocol,
      fitWithinTokens: this.sendable(),
      targetTokens: Math.floor((this.budget * 0.6) / this.ratioNow()),
    });
    for (const saved of made) {
      this.native("out", { offloaded: "tail", handle: saved.handle, bytes: saved.bytes });
      console.info(`${this.options.driverKind}: [context] offloaded ${saved.bytes}-byte kept tool result as ${saved.handle}`);
    }
    return made.length > 0;
  }

  /** Shortens a pasted request message by saving its content to disk when the turn cannot make room for it. */
  offloadPinned(limit: number, offloadOn: boolean): boolean {
    if (!offloadOn) return false;
    const ratio = this.ratioNow();
    const rest = this.sizeNow() - this.calibration.apply(estimateMessageTokens(this.request, this.model, this.adapter.protocol));
    const shortened = this.request.content;
    if (this.pinnedOriginal !== undefined) this.request.content = this.pinnedOriginal;
    const original = this.request.content;
    const offloaded = offloadRequest(this.request, {
      dir: this.ctx.offloadDir,
      threadId: this.threadId,
      turnId: this.turnId,
      maxTokens: Math.max(0, Math.floor((limit - rest) / ratio)),
      model: this.model,
      protocol: this.adapter.protocol,
    });
    if (!offloaded.length) { this.request.content = shortened; return false; }
    this.pinnedOriginal = original;
    for (const saved of offloaded) {
      this.native("out", { offloaded: "request", handle: saved.handle, bytes: saved.bytes });
      console.info(`${this.options.driverKind}: [context] offloaded ${saved.bytes}-byte request message as ${saved.handle}`);
    }
    return offloaded.length > 0;
  }
}
