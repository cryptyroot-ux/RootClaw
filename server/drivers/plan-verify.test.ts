import { describe, expect, it } from "vitest";
import { applyPlanUpdate, carryPlan, parseVerdict, pinPlan, PLAN_TAG, planVerifySettings, shouldPlan, shouldVerify, takeCarriedPlan, unpinPlan, verifierPrompt } from "./plan-verify.ts";
import { compactTurnMessages } from "./turn-context.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";

const tools = { toolsEnabled: true, workspaceTools: false };

describe("plan-verify", () => {
  it("reads the flag: off by default, true is plan+verify, retries capped at 3", () => {
    expect(planVerifySettings(undefined)).toEqual({ mode: "off", maxVerifyRetries: 1 });
    expect(planVerifySettings(true).mode).toBe("plan+verify");
    expect(planVerifySettings("plan", 9)).toEqual({ mode: "plan", maxVerifyRetries: 3 });
    expect(planVerifySettings("bogus").mode).toBe("off");
  });

  it("gates planning with code-only heuristics", () => {
    expect(shouldPlan("hi there, how are you doing today my friend?", tools)).toBe(false);
    expect(shouldPlan("What is the capital of France?", tools)).toBe(false);
    expect(shouldPlan("What is 2 + 2?", tools)).toBe(false);
    expect(shouldPlan("Then again, what do you think about the weather today?", tools)).toBe(false);
    expect(shouldPlan("First list the three smallest primes above 100, then compute their sum, and finally check it.", tools)).toBe(true);
    expect(shouldPlan("First investigate why the build fails, then fix the config and run the tests.", tools)).toBe(true);
    expect(shouldPlan("1. add a route\n2. write a test for it\n3. update the docs", tools)).toBe(true);
    expect(shouldPlan("Cek dulu log servernya, lalu perbaiki error dan jalankan tes ulang ya", tools)).toBe(true);
    expect(shouldPlan("First investigate why the build fails, then fix the config and run the tests.", { ...tools, toolsEnabled: false })).toBe(false);
  });

  it("validates update_plan arguments and counts revisions", () => {
    expect(applyPlanUpdate(null, {}).ok).toBe(false);
    expect(applyPlanUpdate(null, { steps: [{ title: "" }] }).ok).toBe(false);
    const first = applyPlanUpdate(null, { steps: [{ title: "a", status: "done" }, { title: "b", status: "weird" }] });
    if (!first.ok) throw new Error("expected a plan");
    expect(first.plan.steps.map((step) => step.status)).toEqual(["done", "pending"]);
    const second = applyPlanUpdate(first.plan, { steps: Array.from({ length: 12 }, (_, i) => ({ title: `s${i}`, status: "pending" })) });
    expect(second.ok && second.plan.revisions).toBe(2);
    expect(second.ok && second.plan.steps).toHaveLength(8);
  });

  it("keeps the plan in one trailing message, replaced in place, outside compaction", async () => {
    const request: OpenAIChatMessage = { role: "user", content: "do the work" };
    const messages: OpenAIChatMessage[] = [{ role: "system", content: "sys" }, request];
    for (let i = 0; i < 6; i++) messages.push({ role: "assistant", content: `step ${i} ${"x".repeat(200)}` }, { role: "user", content: "go on" });
    const made = applyPlanUpdate(null, { steps: [{ title: "one", status: "doing" }] });
    if (!made.ok) throw new Error("expected a plan");
    pinPlan(messages, made.plan, "HINT");
    messages.push({ role: "assistant", content: "more" });
    pinPlan(messages, { ...made.plan, steps: [{ id: "1", title: "one", status: "done" }] }, "HINT");
    expect(messages[0]!.content).toBe("sys");
    expect(messages.filter((message) => String(message.content).startsWith(PLAN_TAG))).toHaveLength(1);
    expect(messages.at(-1)!.content).toBe(`${PLAN_TAG}\nHINT\n1. [x] one`);
    expect(messages.at(-2)!.content).toBe("more");
    unpinPlan(messages);
    const compacted = await compactTurnMessages(messages, request, { keepExchanges: 1, summarize: async () => "summary", summaryBudgetBytes: 4_000 });
    expect(compacted?.folded).toBeGreaterThan(0);
    pinPlan(compacted!.messages, made.plan, "HINT");
    expect(String(compacted!.messages.at(-1)!.content)).toContain("1. [~] one");
  });

  it("verifies only when it is worth it, with a tight prompt", () => {
    const two = { steps: [{ id: "1", title: "a", status: "done" as const }, { id: "2", title: "b", status: "done" as const }], revisions: 1 };
    const three = { ...two, steps: [...two.steps, { id: "3", title: "c", status: "done" as const }] };
    expect(shouldVerify({ answer: "short", realToolCalls: 0, plan: two })).toBe(false);
    expect(shouldVerify({ answer: "short", realToolCalls: 1, plan: two })).toBe(true);
    expect(shouldVerify({ answer: "x".repeat(900), realToolCalls: 0, plan: two })).toBe(true);
    expect(shouldVerify({ answer: "short", realToolCalls: 0, plan: three })).toBe(true);
    const prompt = verifierPrompt({ request: "t".repeat(5_000), plan: two, answer: "a".repeat(5_000) });
    expect(prompt.length).toBeLessThan(4_400);
  });

  it("carries a plan to the next model for a short while only", () => {
    const plan = { steps: [{ id: "1", title: "x", status: "pending" as const }], revisions: 1 };
    carryPlan("t1", plan, 1_000);
    expect(takeCarriedPlan("t1", 2_000)).toEqual(plan);
    expect(takeCarriedPlan("t1", 2_000)).toBeNull();
    carryPlan("t2", plan, 0);
    expect(takeCarriedPlan("t2", 200_000)).toBeNull();
  });

  it("parses verdicts; anything unclear passes", () => {
    expect(parseVerdict('ok {"verdict":"fail","missing":["run tests"]}')).toEqual({ verdict: "fail", missing: ["run tests"] });
    expect(parseVerdict('{"verdict":"fail","missing":[]}').verdict).toBe("pass");
    expect(parseVerdict("looks fine").verdict).toBe("pass");
  });
});
