import type { BudgetMeter } from "../budget-guard.ts";
import type { Usage } from "./model-adapter.ts";

export class TurnUsage {
  readonly usage: Usage = { input: 0, output: 0 };
  hasUsage = false;
  costUsd: number | undefined;
  private readonly meter: BudgetMeter | null;
  private readonly notice: (message: string) => void;

  constructor(meter: BudgetMeter | null, notice: (message: string) => void) {
    this.meter = meter;
    this.notice = notice;
  }

  add(reported: Usage): "ok" | "warn" | "stop" {
    this.usage.input += reported.input;
    this.usage.output += reported.output;
    if (reported.costUsd !== undefined) this.costUsd = (this.costUsd ?? 0) + reported.costUsd;
    this.hasUsage = true;
    const spend = this.meter?.add(reported) ?? "ok";
    if (spend === "warn") this.notice(this.meter!.warnMessage());
    return spend;
  }
}
