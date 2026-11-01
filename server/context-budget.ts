import type { ModelCatalog } from "./contracts.ts";
import { modelContextWindow } from "./model-context-window.ts";
import { estimateRequestTokens, TokenCalibration } from "./drivers/turn-context.ts";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
const positive = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export interface ContextWindow {
  window: number;
  /** True when nothing knew the model and the window is the default guess. */
  estimated: boolean;
}

const learnedWindows = new Map<string, number>();
const MAX_LEARNED_WINDOWS = 256;
const learnedKey = (instanceId: string, model: string) => `${instanceId}:${model}`;

export function learnContextWindow(instanceId: string, model: string, limit: number): void {
  if (!positive(limit)) return;
  const key = learnedKey(instanceId, model);
  const known = learnedWindows.get(key);
  learnedWindows.delete(key);
  learnedWindows.set(key, Math.floor(known ? Math.min(known, limit) : limit));
  if (learnedWindows.size > MAX_LEARNED_WINDOWS) learnedWindows.delete(learnedWindows.keys().next().value!);
}

const acceptedTotals = new Map<string, number>();

/** Records a request the provider took: its input plus the reply ceiling sent with it. A learned window below it was
 * learned too low, so it rises to what the provider just proved it takes. */
export function noteAcceptedRequest(instanceId: string, model: string, tokens: number): void {
  if (!positive(tokens)) return;
  const key = learnedKey(instanceId, model);
  const learned = learnedWindows.get(key);
  if (learned !== undefined && tokens > learned) learnedWindows.set(key, Math.floor(tokens));
  const known = acceptedTotals.get(key) ?? 0;
  acceptedTotals.delete(key);
  acceptedTotals.set(key, Math.max(known, Math.floor(tokens)));
  if (acceptedTotals.size > MAX_LEARNED_WINDOWS) acceptedTotals.delete(acceptedTotals.keys().next().value!);
}

/** A window under a refused request of `refused` tokens when the refusal names no limit: below the refusal, never
 * below what the same model already took, and at most a quarter under the refusal otherwise. */
export function windowBelowRefusal(instanceId: string, model: string, refused: number): number {
  const accepted = acceptedTotals.get(learnedKey(instanceId, model)) ?? 0;
  return Math.floor(Math.min(refused * 0.9, Math.max(accepted, refused * 0.75)));
}

function declaredWindow(model: string | undefined, catalog?: ModelCatalog, reported?: number): ContextWindow {
  if (positive(reported)) return { window: reported, estimated: false };
  const declared = catalog?.options.find((option) => option.id === model)?.contextWindow;
  if (positive(declared)) return { window: declared, estimated: false };
  const inferred = model ? modelContextWindow(model) : undefined;
  return positive(inferred) ? { window: inferred, estimated: false } : { window: DEFAULT_CONTEXT_WINDOW, estimated: true };
}

export function contextWindowInfo(model: string | undefined, catalog?: ModelCatalog, reported?: number, instanceId?: string): ContextWindow {
  const declared = declaredWindow(model, catalog, reported);
  const learned = instanceId && model ? learnedWindows.get(learnedKey(instanceId, model)) : undefined;
  return learned && learned < declared.window ? { window: learned, estimated: false } : declared;
}

export function contextWindowFor(model: string | undefined, catalog?: ModelCatalog, reported?: number, instanceId?: string): number {
  return contextWindowInfo(model, catalog, reported, instanceId).window;
}

/** A "meter" reading (an ACP agent's own usage_update) is shown only; it never times RootClaw's compaction. */
export function compactionReading<T>(capabilities: { contextReading?: "meter" } | undefined, reading: T | undefined): T | undefined {
  return capabilities?.contextReading === "meter" ? undefined : reading;
}

/** Leave headroom even for a small local model: an 8k floor would make compaction unreachable on an 8k window. */
export function compactBudget(window: number, compactAt?: number, nativeCompactAt?: number): number {
  if (!positive(window)) throw new Error("invalid model context window");
  const configured = positive(compactAt) ? (compactAt < 1 ? window * compactAt : compactAt) : window * 0.8;
  return Math.max(1, Math.floor(Math.min(configured, window * 0.9, positive(nativeCompactAt) ? nativeCompactAt * 0.9 : Infinity)));
}

/** A thread's history in tokens: the model's tokenizer (or the char-class estimate), times the calibration its
 * instance learned in native turns. */
export function threadTokens(texts: readonly string[], model: string | undefined, instanceId?: string): number {
  return new TokenCalibration(model, instanceId).apply(estimateRequestTokens(texts.map((content) => ({ role: "user" as const, content })), [], model));
}

export function shouldCompact(input: { contextTokens?: number; estimatedTokens?: number; estimatedBytes?: number; budget: number; floor?: number; window: number; nativeCompactAt?: number }): boolean {
  // Summed input across tool rounds is NOT a context-window measurement.
  const size = positive(input.contextTokens) ? input.contextTokens
    : positive(input.estimatedTokens) ? input.estimatedTokens : Math.ceil((input.estimatedBytes ?? 0) / 4);
  // Regrowth avoids refolding an irreducible prompt but never passes a known provider-native compaction boundary.
  const ceiling = compactBudget(input.window, input.window, input.nativeCompactAt);
  const threshold = Math.min(ceiling, positive(input.floor) ? Math.max(input.budget, input.floor * 1.25) : input.budget);
  return size >= threshold;
}
