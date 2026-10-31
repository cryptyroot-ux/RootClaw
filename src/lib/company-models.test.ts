import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { companyInstanceFor, isCompanyInstance, planCompanySwitch, selectionCanRun } from "./company-models";

const managed = { organizationId: "fixture-org", organizationName: "Fixture Company" };
function instance(instanceId: string, driverKind: string, snapshot: InstanceInfo["snapshot"], extra: Partial<InstanceInfo> = {}): InstanceInfo {
  return { instanceId, driverKind, displayName: instanceId, snapshot, models: { default: `${instanceId}-default`, options: [{ id: `${instanceId}-default`, label: "Default" }] }, ...extra };
}
const companyAnthropic = instance("company.fixture.anthropic", "anthropic", { state: "available", authenticated: true }, { readOnly: true, managed, displayName: "Company · Fixture Company · Anthropic" });
const companyRouter = instance("company.fixture.openrouter", "openai-compat", { state: "available", authenticated: true }, { readOnly: true, managed, displayName: "Company · Fixture Company · OpenRouter" });
const signedOutAnthropic = instance("anthropicApi", "anthropic", { state: "available", authenticated: false }, {
  models: { default: "sonnet", options: [{ id: "sonnet", label: "Sonnet" }, { id: "local/qwen", label: "Qwen", custom: true }] },
});
const openaiResponses = instance("openaiResponses", "openai-responses", { state: "available", authenticated: true });
const missingXai = instance("xaiApi", "grok", { state: "unavailable", reason: "xAI API key not configured" });
function bot(id: string, instanceId: string, extra: Partial<Bot> = {}): Bot {
  return { id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true, color: "green", unread: false, messages: [],
    modelSelection: { instanceId, model: instanceId === "anthropicApi" ? "sonnet" : `${instanceId}-default` }, ...extra } as Bot;
}

describe("Company switch planning", () => {
  it("recognises only organisation-owned instances as Company", () => {
    expect(isCompanyInstance(companyAnthropic)).toBe(true);
    expect(isCompanyInstance({ ...companyAnthropic, managed: undefined })).toBe(false);
    expect(isCompanyInstance({ ...openaiResponses, instanceId: "company.personal.anthropic" })).toBe(false);
    expect(companyInstanceFor([openaiResponses, companyRouter, companyAnthropic], "anthropic")).toBe(companyAnthropic);
    expect(companyInstanceFor([openaiResponses], "anthropic")).toBeUndefined();
  });

  it("counts only bots whose engine is missing, unavailable, signed out or refused, never a working or archived one", () => {
    const instances = [signedOutAnthropic, openaiResponses, missingXai, companyRouter, companyAnthropic];
    const bots = [
      bot("signed-out", "anthropicApi"), bot("working", "openaiResponses"), bot("missing", "deleted-instance"), bot("setup", ""),
      bot("unavailable", "grok"), bot("custom-model", "anthropicApi", { modelSelection: { instanceId: "anthropicApi", model: "local/qwen" } }),
      bot("already-company", companyRouter.instanceId), bot("archived", "deleted-instance", { hidden: true }),
    ];
    const plan = planCompanySwitch(bots, instances);
    expect(plan.target).toBe(companyAnthropic);
    expect(plan.bots.map((row) => row.id)).toEqual(["signed-out", "missing", "setup", "unavailable"]);
    expect(plan.needsAsk).toEqual([]);
  });

  it("leaves a bot alone when its selected thread still runs, because the PATCH moves both", () => {
    const threaded = bot("threaded", "deleted-instance", { tasks: [{ threadId: "threaded-thread", title: "", modelSelection: { instanceId: "openaiResponses", model: "openaiResponses-default" } }] as Bot["tasks"] });
    expect(planCompanySwitch([threaded], [openaiResponses, companyAnthropic]).bots).toEqual([]);
  });

  it("treats a bot the organisation's policy refuses as unable to run, and never targets a refused Company engine", () => {
    const refused = { organizationName: "Fixture Company", reason: "Fixture Company allows only company models on this computer." };
    const plan = planCompanySwitch([bot("personal", "openaiResponses")], [{ ...openaiResponses, policy: refused }, { ...companyAnthropic, policy: refused }, companyRouter]);
    expect(plan.target).toBe(companyRouter);
    expect(plan.bots.map((row) => row.id)).toEqual(["personal"]);
    expect(planCompanySwitch([bot("personal", "openaiResponses")], [{ ...openaiResponses, policy: refused }, { ...companyRouter, policy: refused }]))
      .toEqual({ bots: [], needsAsk: [] });
  });

  it("offers nothing when no Company model can run yet", () => {
    const companyMissingProvider = { ...companyAnthropic, snapshot: { state: "unavailable" as const, reason: "Anthropic API key not configured" } };
    expect(planCompanySwitch([bot("signed-out", "anthropicApi")], [signedOutAnthropic, companyMissingProvider])).toEqual({ bots: [], needsAsk: [] });
  });

  it("carries Full access through the switch and keeps Custom bots out of it", () => {
    const full = bot("full", "deleted-instance", { approvalMode: "full" });
    const fullSameEngine = bot("full-anthropicApi", "anthropicApi", { approvalMode: "full" });
    const custom = bot("custom", "deleted-instance", { approvalMode: "custom" });
    const plan = planCompanySwitch([full, fullSameEngine, custom, bot("ask", "anthropicApi")], [signedOutAnthropic, companyAnthropic]);
    expect(plan.bots.map((row) => row.id)).toEqual(["full", "full-anthropicApi", "ask"]);
    expect(plan.needsAsk.map((row) => row.id)).toEqual(["custom"]);
  });

  it("treats a signed-out engine's custom models as still able to run", () => {
    expect(selectionCanRun({ instanceId: "anthropicApi", model: "local/qwen" }, [signedOutAnthropic])).toBe(true);
    expect(selectionCanRun({ instanceId: "anthropicApi", model: "sonnet" }, [signedOutAnthropic])).toBe(false);
  });
});
