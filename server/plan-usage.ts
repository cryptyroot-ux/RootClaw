// Subscription plan usage (five-hour and weekly windows) came from agent CLIs signed in to a plan. RootClaw runs only
// API-key engines, which have no such plan, so no account is ever read; the shapes stay for the limit clock and Settings.
import type { InstanceConfigMap } from "./contracts.ts";

export type PlanDriver = never;

export interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
}

export interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

export interface PlanProviderRow {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProviderRow[];
}

export interface PlanAccount {
  id: string;
  name: string;
  driver: PlanDriver;
  environment: Record<string, string | undefined>;
  configDir?: string;
}

export function planAccountsFromInstances(_instances: InstanceConfigMap): PlanAccount[] {
  return [];
}

export async function loadPlanUsage(_input: { accounts: PlanAccount[]; refresh?: boolean; [key: string]: unknown }): Promise<PlanUsageReport> {
  return { fetchedAt: new Date().toISOString(), providers: [] };
}
