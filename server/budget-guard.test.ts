import { describe, expect, it } from "vitest";
import { assertTurnBudget, BudgetMeter, turnBudget } from "./budget-guard.ts";

const none = () => ({ tokens: 0, usd: 0 });

describe("turnBudget: what one turn may still spend", () => {
  it("is null without caps", () => {
    expect(turnBudget({}, "/x", "bot", new Date(), none)).toBeNull();
    expect(turnBudget({ budgets: { monthlyUsd: 5 } }, "/x", "bot", new Date(), none)).toBeNull();
  });

  it("takes the tightest of the global and per-bot turn caps and what is left of each day's cap", () => {
    const used = (_dir: string, botId: string | undefined) => (botId ? { tokens: 900, usd: 0.5 } : { tokens: 4_000, usd: 1 });
    const budget = turnBudget({ budgets: {
      turn: { tokens: 5_000 }, daily: { tokens: 6_000, usd: 3 }, warnAtPercent: 50,
      bots: { bot: { turn: { usd: 0.4 }, daily: { tokens: 1_000 } } },
    } }, "/x", "bot", new Date(), used)!;
    expect(budget).toMatchObject({ tokens: 100, usd: 0.4, warnAtPercent: 50 });
    expect(budget.why).toMatch(/daily token cap/);
  });

  it("refuses a turn once a daily cap is used up, with a clear message", () => {
    const budget = turnBudget({ budgets: { daily: { usd: 1 } } }, "/x", "bot", new Date(), () => ({ tokens: 0, usd: 1.2 }))!;
    expect(() => assertTurnBudget(budget)).toThrow(/daily spend cap of \$1\.00/);
    expect(() => assertTurnBudget(turnBudget({ budgets: { turn: { tokens: 10 } } }, "/x", "bot", new Date(), none))).not.toThrow();
  });
});

describe("BudgetMeter: provider-reported usage against the turn's allowance", () => {
  it("warns once at the warn line and stops at the cap", () => {
    const meter = new BudgetMeter({ tokens: 1_000, warnAtPercent: 80, why: "turn token cap of 1,000 tokens" }, null);
    expect(meter.add({ input: 500, output: 100 })).toBe("ok");
    expect(meter.add({ input: 150, output: 50 })).toBe("warn");
    expect(meter.add({ input: 10, output: 0 })).toBe("ok");
    expect(meter.add({ input: 200, output: 0 })).toBe("stop");
    expect(meter.stopMessage()).toMatch(/turn token cap of 1,000 tokens/);
  });

  it("prices usage with the model's price for a USD cap, and ignores USD without a price", () => {
    const priced = new BudgetMeter({ usd: 0.01, warnAtPercent: 80, why: "x" }, { inputPerMillion: 1_000, outputPerMillion: 1_000 });
    expect(priced.add({ input: 5, output: 4 })).toBe("warn");
    expect(priced.add({ input: 2, output: 0 })).toBe("stop");
    const unpriced = new BudgetMeter({ usd: 0.01, warnAtPercent: 80, why: "x" }, null);
    expect(unpriced.add({ input: 1e9, output: 1e9 })).toBe("ok");
  });
});
