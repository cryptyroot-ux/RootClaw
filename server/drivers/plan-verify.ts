// Planner / verifier for native turns (docs/design/planner-verifier.md). Behind `engine.planVerify`, off by default.
// Planning: a code-only heuristic decides whether a turn plans; the turn's own model writes the plan through the
// update_plan tool; the plan lives in a tagged section of the system message, which compaction never folds.
// Verifying: a final answer of a planned turn gets one cheap self-check call; a fail sends the gaps back, capped.
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";

export type PlanVerifyMode = "off" | "plan" | "plan+verify";
export interface PlanVerifySettings { mode: PlanVerifyMode; maxVerifyRetries: number; verifyMinSteps: number }
export type PlanStatus = "pending" | "doing" | "done" | "blocked";
export interface PlanStep { id: string; title: string; status: PlanStatus }
export interface TurnPlan { steps: PlanStep[]; revisions: number }

export const DEFAULT_MAX_VERIFY_RETRIES = 1;
/** Plans this long get a self-check even when no real tool ran. */
export const DEFAULT_VERIFY_MIN_STEPS = 4;
export const MAX_VERIFY_RETRIES = 3;
export const MAX_PLAN_STEPS = 8;
/** Rounds without a final answer after which an unplanned turn starts planning. */
export const REPLAN_AFTER_ROUNDS = 8;
const STEP_CHARS = 120;
const CARRY_MS = 120_000;

export function planVerifySettings(raw: unknown, retries?: unknown, minSteps?: unknown): PlanVerifySettings {
  const mode: PlanVerifyMode = raw === true ? "plan+verify" : raw === "plan" || raw === "plan+verify" ? raw : "off";
  const n = typeof retries === "number" && Number.isInteger(retries) ? retries : DEFAULT_MAX_VERIFY_RETRIES;
  const steps = typeof minSteps === "number" && Number.isInteger(minSteps) && minSteps >= 1 ? Math.min(minSteps, MAX_PLAN_STEPS + 1) : DEFAULT_VERIFY_MIN_STEPS;
  return { mode, maxVerifyRetries: Math.max(0, Math.min(MAX_VERIFY_RETRIES, n)), verifyMinSteps: steps };
}

const VERBS = /\b(add|build|create|write|fix|debug|refactor|implement|update|change|rename|move|delete|remove|install|deploy|test|run|check|compare|research|analy[sz]e|find|investigate|migrate|convert|generate|summari[sz]e|review|edit|list|compute|calculate|explain|verify|draft|design|configure|measure|count|set up|buat|tambah|perbaiki|ubah|hapus|cek|tes|jalankan|analisa|cari|bandingkan|tulis)\b/gi;
const SEQUENCE = /\b(and then|then|after that|afterwards|finally|next|first|second|lalu|kemudian|setelah itu|terakhir|pertama)\b|(^|\n)\s*(\d+[.)]|[-*•])\s+\S/i;
const SEQUENCE_MARKERS = /\b(and then|then|after that|afterwards|finally|next|first|lalu|kemudian|setelah itu|terakhir|pertama)\b/gi;
const FILEISH = /[\w.-]+\.(ts|tsx|js|py|go|rs|json|md|ya?ml|sh|sql|css|html)\b|`[^`]+`|\/[\w.-]+\/[\w.-]+/;

/** Code-only gate (no model call): does this request look like multi-step work worth a plan? */
export function shouldPlan(text: string, context: { toolsEnabled: boolean; workspaceTools: boolean }): boolean {
  if (!context.toolsEnabled) return false;
  const trimmed = text.trim();
  if (trimmed.length < 40) return false;
  const verbs = new Set((trimmed.match(VERBS) ?? []).map((verb) => verb.toLowerCase())).size;
  if (verbs >= 2 && SEQUENCE.test(trimmed)) return true;
  // "first … then … finally": an explicit sequence of two or more markers is multi-step on its face.
  if ((trimmed.match(SEQUENCE_MARKERS) ?? []).length >= 2) return true;
  if (verbs >= 3) return true;
  if (trimmed.length > 600 && verbs >= 1) return true;
  return context.workspaceTools && verbs >= 2 && FILEISH.test(trimmed);
}

export const UPDATE_PLAN_TOOL = "update_plan";
export const UPDATE_PLAN_DEFINITION: ChatToolDefinition = {
  type: "function",
  function: {
    name: UPDATE_PLAN_TOOL,
    description: `Write or update the plan for this task: the full list of steps (at most ${MAX_PLAN_STEPS}) with their status. Call it first on multi-step work and again whenever a step finishes or the plan changes.`,
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array", minItems: 1, maxItems: MAX_PLAN_STEPS,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "The step number from the current plan, to change only its status." },
              title: { type: "string", description: "One short step." },
              status: { type: "string", enum: ["pending", "doing", "done", "blocked"] },
            },
            required: ["status"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
};

export const PLAN_HINT = `This request looks like multi-step work. Call update_plan once with a short plan (at most ${MAX_PLAN_STEPS} steps), then work. ` +
  "After that never call update_plan on its own: put status changes in the same batch as your next real tool call, and skip it before the final answer (the final answer completes the plan).";
export const PLAN_KEEP_HINT = "Update statuses only together with a real tool call; the final answer completes the plan.";
export const REPLAN_HINT = "This turn has taken many steps. With your next real tool call, also call update_plan with the remaining steps and their status.";
/** Validates update_plan arguments into a plan; an error text for the model when they are unusable. */
export function applyPlanUpdate(previous: TurnPlan | null, args: Record<string, unknown>): { ok: true; plan: TurnPlan } | { ok: false; text: string } {
  const raw = Array.isArray(args.steps) ? args.steps : null;
  if (!raw?.length) return { ok: false, text: "update_plan needs a non-empty steps list." };
  // Status-only updates may name just some steps: merge them into the earlier plan by id.
  if (previous && raw.every((entry) => entry && typeof entry === "object" && "id" in entry && !(entry as { title?: unknown }).title)) {
    const byId = new Map(raw.map((entry) => [String((entry as { id: unknown }).id).trim(), entry as Record<string, unknown>]));
    const steps = previous.steps.map((step) => {
      const change = byId.get(step.id);
      const status = change && (change.status === "pending" || change.status === "doing" || change.status === "done" || change.status === "blocked") ? change.status : step.status;
      return { ...step, status };
    });
    return { ok: true, plan: { steps, revisions: previous.revisions + 1 } };
  }
  const steps: PlanStep[] = [];
  for (const [index, entry] of raw.slice(0, MAX_PLAN_STEPS).entries()) {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    // A status-only update names the step by id (or position) and keeps its earlier title.
    const earlier = previous?.steps.find((step) => step.id === String(item.id ?? "").trim()) ?? (item.id === undefined ? previous?.steps[index] : undefined);
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, STEP_CHARS) : earlier?.title ?? "";
    if (!title) return { ok: false, text: `Step ${index + 1} has no title.` };
    const status: PlanStatus = item.status === "doing" || item.status === "done" || item.status === "blocked" ? item.status : "pending";
    steps.push({ id: String(index + 1), title, status });
  }
  return { ok: true, plan: { steps, revisions: (previous?.revisions ?? 0) + 1 } };
}

const MARK: Record<PlanStatus, string> = { pending: "[ ]", doing: "[~]", done: "[x]", blocked: "[!]" };
export const PLAN_TAG = "[Plan context, pinned by the engine; not a message from the person]";

export function renderPlan(plan: TurnPlan): string {
  return plan.steps.map((step) => `${step.id}. ${MARK[step.status]} ${step.title}`).join("\n");
}

const isPlanMessage = (message: OpenAIChatMessage) => message.role === "user" && typeof message.content === "string" && message.content.startsWith(PLAN_TAG);

/** Removes the trailing plan message, so compaction and the next round never see a stale copy. */
export function unpinPlan(messages: OpenAIChatMessage[]): void {
  for (let index = messages.length - 1; index >= 0; index--) if (isPlanMessage(messages[index]!)) messages.splice(index, 1);
}

/** Puts the plan (and its hint) in one compact message at the end, replacing any earlier copy. The system
 * message and the history before it stay byte-identical, so the provider's prefix cache survives updates. */
export function pinPlan(messages: OpenAIChatMessage[], plan: TurnPlan | null, hint: string): void {
  unpinPlan(messages);
  if (!plan && !hint) return;
  messages.push({ role: "user", content: [PLAN_TAG, hint, plan ? renderPlan(plan) : ""].filter(Boolean).join("\n") });
}

/** Whether a final answer is worth a self-check: a real (non-update_plan) tool ran, or the plan is long enough. */
export function shouldVerify(input: { realToolCalls: number; plan: TurnPlan; minSteps?: number }): boolean {
  return input.realToolCalls > 0 || input.plan.steps.length >= (input.minSteps ?? DEFAULT_VERIFY_MIN_STEPS);
}

/** The plan as the turn ended with an accepted final answer: open steps done, as the next revision; null if none open. */
export function completePlan(plan: TurnPlan): TurnPlan | null {
  if (!plan.steps.some((step) => step.status === "pending" || step.status === "doing")) return null;
  return { steps: plan.steps.map((step) => step.status === "pending" || step.status === "doing" ? { ...step, status: "done" } : step), revisions: plan.revisions + 1 };
}

export const unfinishedSteps = (plan: TurnPlan | null) => plan?.steps.filter((step) => step.status === "pending" || step.status === "doing") ?? [];

// ---------- plan carried across failover ----------

const carried = new Map<string, { plan: TurnPlan; at: number }>();
/** Keeps a turn's plan for the next model in the chain when this one fails over before producing anything. */
export function carryPlan(threadId: string, plan: TurnPlan | null, now = Date.now()): void {
  if (plan) carried.set(threadId, { plan, at: now });
}
export function takeCarriedPlan(threadId: string, now = Date.now()): TurnPlan | null {
  const entry = carried.get(threadId);
  carried.delete(threadId);
  return entry && now - entry.at <= CARRY_MS ? entry.plan : null;
}

// ---------- verifier ----------

export interface Verdict { verdict: "pass" | "fail"; missing: string[] }

export const VERIFY_MAX_TOKENS = 200;

/** The self-check prompt: task, plan and final answer only, truncated; no history, so it stays a few hundred tokens. */
export function verifierPrompt(input: { request: string; plan: TurnPlan | null; answer: string }): string {
  const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
  return [
    "Check whether the answer completes the task. Plan statuses may lag; judge the answer.",
    `Task: ${cut(input.request, 1_500)}`,
    input.plan ? `Plan:\n${renderPlan(input.plan)}` : "",
    `Answer: ${cut(input.answer, 2_500)}`,
    'Reply only JSON: {"verdict":"pass"|"fail","missing":["gap"]}. fail only for a concrete unmet part.',
  ].filter(Boolean).join("\n");
}

/** Parses the checker's reply; anything unreadable counts as a pass so a confused checker never blocks an answer. */
export function parseVerdict(text: string): Verdict {
  const match = text.match(/\{[\s\S]*\}/);
  try {
    const value = JSON.parse(match?.[0] ?? "") as { verdict?: unknown; missing?: unknown };
    const missing = Array.isArray(value.missing) ? value.missing.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 5).map((item) => item.slice(0, 200)) : [];
    return value.verdict === "fail" && missing.length ? { verdict: "fail", missing } : { verdict: "pass", missing: [] };
  } catch {
    return { verdict: "pass", missing: [] };
  }
}

export const verifyRetryMessage = (missing: string[]) =>
  `[Self-check] Your answer looks incomplete. Still missing:\n${missing.map((item) => `- ${item}`).join("\n")}\nFinish these (use tools if needed), keep update_plan current, then give the final answer.`;
export const unverifiedNote = (missing: string[]) =>
  `Unverified: a self-check still found gaps after the allowed retries — ${missing.join("; ")}`;
