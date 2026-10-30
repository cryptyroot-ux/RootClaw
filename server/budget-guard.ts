// Per-turn and per-day spend caps, global and per bot, in tokens and/or USD, over provider-reported usage.
import type { AppConfig } from "./config.ts";
import type { ModelPrice } from "./prices.ts";
import { readUsage } from "./usage-ledger.ts";

export interface BudgetCap { tokens?: number; usd?: number }
/** What one turn may still spend: the tightest cap, and which one that is. */
export interface TurnBudget { tokens?: number; usd?: number; warnAtPercent: number; why: string; price?: ModelPrice | null }
type Spent = { tokens: number; usd: number };
type DailyUsage = (dataDir: string, botId: string | undefined, now: Date) => Spent;

const DEFAULT_WARN_AT_PERCENT = 80;
const tokens = (n: number) => `${Math.round(n).toLocaleString("en-US")} tokens`;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** Today's (host-local day) usage from the ledger, for one bot or everyone. */
export function dailyUsage(dataDir: string, botId: string | undefined, now: Date): Spent {
  const from = new Date(now); from.setHours(0, 0, 0, 0);
  let spent = { tokens: 0, usd: 0 };
  for (const row of readUsage(dataDir, { from, to: now })) {
    if (botId && row.botId !== botId) continue;
    spent = { tokens: spent.tokens + (row.input || 0) + (row.output || 0), usd: spent.usd + (row.costUsd && row.costUsd > 0 ? row.costUsd : 0) };
  }
  return spent;
}

export function turnBudget(cfg: Pick<AppConfig, "budgets">, dataDir: string, botId: string, now = new Date(), used: DailyUsage = dailyUsage): TurnBudget | null {
  const b = cfg.budgets;
  if (!b) return null;
  const bot = b.bots?.[botId];
  const out: TurnBudget = { warnAtPercent: b.warnAtPercent ?? DEFAULT_WARN_AT_PERCENT, why: "" };
  const limits: Partial<Record<"tokens" | "usd", string>> = {};
  const take = (kind: "tokens" | "usd", left: number | undefined, why: string) => {
    if (left === undefined) return;
    if (out[kind] === undefined || left < out[kind]!) { out[kind] = Math.max(0, left); limits[kind] = why; }
  };
  const show = (kind: "tokens" | "usd", n: number) => (kind === "tokens" ? tokens(n) : usd(n));
  const label = (kind: "tokens" | "usd") => (kind === "tokens" ? "token" : "spend");
  for (const [scope, cap] of [["", b.turn], ["this bot's ", bot?.turn]] as const) {
    for (const kind of ["tokens", "usd"] as const) if (cap?.[kind] !== undefined) take(kind, cap[kind], `${scope}per-turn ${label(kind)} cap of ${show(kind, cap[kind]!)}`);
  }
  for (const [scope, cap, who] of [["", b.daily, undefined], ["this bot's ", bot?.daily, botId]] as const) {
    if (!cap || (cap.tokens === undefined && cap.usd === undefined)) continue;
    const spent = used(dataDir, who, now);
    for (const kind of ["tokens", "usd"] as const) if (cap[kind] !== undefined) take(kind, cap[kind]! - spent[kind], `${scope}daily ${label(kind)} cap of ${show(kind, cap[kind]!)}`);
  }
  if (out.tokens === undefined && out.usd === undefined) return null;
  out.why = [limits.tokens, limits.usd].filter(Boolean).join("; ");
  if (out.tokens === 0) out.why = limits.tokens!;
  else if (out.usd === 0) out.why = limits.usd!;
  return out;
}

/** A turn whose allowance is already spent never starts. */
export function assertTurnBudget(budget: TurnBudget | null): void {
  if (!budget) return;
  const spent = budget.tokens === 0 ? "tokens" : budget.usd === 0 ? "usd" : null;
  if (!spent) return;
  throw Object.assign(new Error(`this bot has reached its ${budget.why} — raise it under Settings → Usage (budgets)`), { status: 409, code: "budget_cap" });
}

/** Counts a turn's provider-reported usage round by round against its allowance. */
export class BudgetMeter {
  private spent: Spent = { tokens: 0, usd: 0 };
  private warned = false;
  private readonly budget: TurnBudget;
  private readonly price: ModelPrice | null;
  constructor(budget: TurnBudget, price: ModelPrice | null) { this.budget = budget; this.price = price; }

  add(usage: { input: number; output: number }): "ok" | "warn" | "stop" {
    this.spent.tokens += usage.input + usage.output;
    if (this.price) this.spent.usd += (usage.input * this.price.inputPerMillion + usage.output * this.price.outputPerMillion) / 1_000_000;
    const share = Math.max(
      this.budget.tokens !== undefined ? this.spent.tokens / Math.max(this.budget.tokens, 1e-9) : 0,
      this.budget.usd !== undefined && this.price ? this.spent.usd / Math.max(this.budget.usd, 1e-12) : 0,
    );
    if (share >= 1) return "stop";
    if (!this.warned && share * 100 >= this.budget.warnAtPercent) { this.warned = true; return "warn"; }
    return "ok";
  }

  /** True when sending `inputTokens` more prompt tokens would by itself pass the turn's token or USD cap. */
  wouldExceed(inputTokens: number): boolean {
    if (!(inputTokens > 0)) return false;
    if (this.budget.tokens !== undefined && this.spent.tokens + inputTokens > this.budget.tokens) return true;
    if (this.budget.usd !== undefined && this.price && this.spent.usd + (inputTokens * this.price.inputPerMillion) / 1_000_000 > this.budget.usd) return true;
    return false;
  }

  warnMessage(): string {
    return `This turn has used ${this.budget.warnAtPercent}% of its budget (${this.budget.why}).`;
  }

  stopMessage(): string {
    return `Stopped: this turn reached its budget (${this.budget.why}). Raise it under Settings → Usage (budgets) or send a new message to continue.`;
  }
}
