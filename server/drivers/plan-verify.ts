// Planner / verifier for native turns (docs/design/planner-verifier.md). Behind `engine.planVerify`, off by default.
// Planning: a code-only heuristic decides whether a turn plans; the turn's own model writes the plan through the
// update_plan tool; the plan lives in a tagged section of the system message, which compaction never folds.
// Verifying: a final answer of a planned turn gets one cheap self-check call; a fail sends the gaps back, capped.
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";

export type PlanVerifyMode = "off" | "plan" | "plan+verify";
export interface PlanVerifySettings { mode: PlanVerifyMode; maxVerifyRetries: number }
export type PlanStatus = "pending" | "doing" | "done" | "blocked";
export interface PlanStep { id: string; title: string; status: PlanStatus }
export interface TurnPlan { steps: PlanStep[]; revisions: number }

export const DEFAULT_MAX_VERIFY_RETRIES = 1;
export const MAX_VERIFY_RETRIES = 3;
export const MAX_PLAN_STEPS = 8;
/** Rounds without a final answer after which an unplanned turn starts planning. */
export const REPLAN_AFTER_ROUNDS = 8;
const STEP_CHARS = 120;
const CARRY_MS = 120_000;

export function planVerifySettings(raw: unknown, retries?: unknown): PlanVerifySettings {
  const mode: PlanVerifyMode = raw === true ? "plan+verify" : raw === "plan" || raw === "plan+verify" ? raw : "off";
  const n = typeof retries === "number" && Number.isInteger(retries) ? retries : DEFAULT_MAX_VERIFY_RETRIES;
  return { mode, maxVerifyRetries: Math.max(0, Math.min(MAX_VERIFY_RETRIES, n)) };
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
              title: { type: "string", description: "One short step." },
              status: { type: "string", enum: ["pending", "doing", "done", "blocked"] },
            },
            required: ["title", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
};

export const PLAN_HINT = "\n\n[Planning] This request looks like multi-step work. Before acting, call update_plan with a short plan " +
  `(at most ${MAX_PLAN_STEPS} steps). Keep it current: mark steps doing/done/blocked with update_plan as you go, and finish only when every step is done or blocked with a reason.`;
export const REPLAN_HINT = "\n\n[Planning] This turn has taken many steps. Call update_plan now with the remaining steps and their status, then continue.";

/** Validates update_plan arguments into a plan; an error text for the model when they are unusable. */
export function applyPlanUpdate(previous: TurnPlan | null, args: Record<string, unknown>): { ok: true; plan: TurnPlan } | { ok: false; text: string } {
  const raw = Array.isArray(args.steps) ? args.steps : null;
  if (!raw?.length) return { ok: false, text: "update_plan needs a non-empty steps list." };
  const steps: PlanStep[] = [];
  for (const [index, entry] of raw.slice(0, MAX_PLAN_STEPS).entries()) {
    const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const title = typeof item.title === "string" ? item.title.trim().slice(0, STEP_CHARS) : "";
    if (!title) return { ok: false, text: `Step ${index + 1} has no title.` };
    const status: PlanStatus = item.status === "doing" || item.status === "done" || item.status === "blocked" ? item.status : "pending";
    steps.push({ id: String(index + 1), title, status });
  }
  return { ok: true, plan: { steps, revisions: (previous?.revisions ?? 0) + 1 } };
}

const MARK: Record<PlanStatus, string> = { pending: "[ ]", doing: "[~]", done: "[x]", blocked: "[!]" };
export const PLAN_TAG = "[Current plan for this turn — kept up to date with update_plan]";
const PLAN_END = "[End of plan]";

export function renderPlan(plan: TurnPlan): string {
  return `${PLAN_TAG}\n${plan.steps.map((step) => `${step.id}. ${MARK[step.status]} ${step.title}`).join("\n")}\n${PLAN_END}`;
}

/** Writes (or replaces) the plan section at the end of the system message, so it is pinned through compaction. */
export function pinPlan(messages: OpenAIChatMessage[], plan: TurnPlan | null, extraHint = ""): void {
  const section = plan ? `\n\n${renderPlan(plan)}` : "";
  const head = messages[0];
  if (head?.role === "system" && typeof head.content === "string") {
    const start = head.content.indexOf(`\n\n${PLAN_TAG}`);
    const base = start >= 0 ? head.content.slice(0, start) : head.content;
    head.content = `${base}${extraHint}${section}`;
  } else if (section || extraHint) {
    messages.unshift({ role: "system", content: `${extraHint}${section}`.trimStart() });
  }
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

const TOOL_RESULT_CHARS = 6_000;

/** The self-check prompt: the request, the plan, the draft answer and the most recent tool results (bounded). */
export function verifierPrompt(input: { request: string; plan: TurnPlan | null; answer: string; messages: readonly OpenAIChatMessage[] }): string {
  let results = "";
  for (let index = input.messages.length - 1; index >= 0 && results.length < TOOL_RESULT_CHARS; index--) {
    const message = input.messages[index]!;
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    results = `- ${message.content.slice(0, 1_500)}\n${results}`;
  }
  return [
    "You are checking whether an assistant finished a task. Judge only from what is shown.",
    `Task:\n${input.request.slice(0, 4_000)}`,
    input.plan ? `Plan:\n${renderPlan(input.plan)}` : "",
    results ? `Latest tool results (truncated):\n${results.slice(-TOOL_RESULT_CHARS)}` : "",
    `Final answer:\n${input.answer.slice(0, 4_000)}`,
    'Reply with JSON only: {"verdict":"pass"|"fail","missing":["short gap", ...]}. Use "fail" only for a concrete unmet part of the task.',
  ].filter(Boolean).join("\n\n");
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
