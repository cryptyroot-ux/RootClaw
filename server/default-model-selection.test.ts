import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import type { EngineAccess, ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { readyToRun, selectDefaultModelSelection, withInstanceConfig, withNewBotEffort, type SelectableInstance } from "./default-model-selection.ts";

const openaiResponses = {
  instanceId: "openaiResponses",
  driverKind: "openai-responses",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: {
    default: "gpt-default",
    options: [{ id: "gpt-default", label: "Default" }, { id: "selected-model", label: "Selected" }],
  } satisfies ModelCatalog,
  capabilities: { effortLevels: ["low", "high"] as const },
};
const anthropic = {
  instanceId: "anthropicApi",
  driverKind: "anthropic",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: { default: "anthropic-default", options: [{ id: "anthropic-default", label: "Anthropic" }] },
};

describe("new bot default model selection", () => {
  it("accepts a configured API-key provider", () => {
    const instance = { ...openaiResponses, instanceId: "mistral", driverKind: "mistral", access: "api" as const };
    const preferred = { instanceId: "mistral", model: "selected-model" };
    expect(selectDefaultModelSelection([instance], preferred)).toEqual(preferred);
  });
  it("keeps a saved custom endpoint even when its account sign-in is false", () => {
    const instance = { ...openaiResponses, access: "custom" as const, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
    const preferred = { instanceId: "openaiResponses", model: "selected-model" };
    expect(selectDefaultModelSelection([anthropic, instance], preferred)).toEqual(preferred);
  });
  it("preserves an intentional variant only when the provider advertises variant support", () => {
    const preferred = { instanceId: "openaiResponses", model: "selected-model", variant: "default" };
    expect(selectDefaultModelSelection([{ ...openaiResponses, capabilities: { modelVariants: true } }], preferred))
      .toEqual(preferred);
    expect(selectDefaultModelSelection([openaiResponses], preferred)).toEqual({ instanceId: "", model: "" });
    expect(preferred.variant).toBe("default");
  });
  it.each(["low", "high"] as const)("honors the configured provider, model, and supported %s effort ahead of list order", (effort) => {
    const preferred = { instanceId: "openaiResponses", model: "selected-model", effort };
    const selection = selectDefaultModelSelection([anthropic, openaiResponses], preferred);
    expect(selection).toEqual(preferred);
    expect(selection).not.toBe(preferred);
  });

  it.each([
    { label: "missing capabilities", capabilities: undefined },
    { label: "no effort control", capabilities: {} },
    { label: "empty effort list", capabilities: { effortLevels: [] } },
    { label: "changed effort support", capabilities: { effortLevels: ["low"] as const } },
  ])("omits stale effort for $label without changing the provider, model, or saved preference", ({ capabilities }) => {
    const preferred = { instanceId: "openaiResponses", model: "selected-model", effort: "high" as const };
    const selection = selectDefaultModelSelection([
      { ...anthropic, capabilities: { effortLevels: ["high"] } },
      { ...openaiResponses, capabilities },
    ], preferred);
    expect(selection).toEqual({ instanceId: "openaiResponses", model: "selected-model" });
    expect(selection).not.toHaveProperty("effort");
    expect(preferred.effort).toBe("high");
  });

  it("accepts the provider default even when it is not repeated in its options", () => {
    expect(selectDefaultModelSelection(
      [{ ...openaiResponses, models: { default: "gpt-default", options: [] } }],
      { instanceId: "openaiResponses", model: "gpt-default" },
    )).toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
  });

  it.each([
    { label: "missing provider", instances: [anthropic] },
    { label: "unavailable provider", instances: [anthropic, { ...openaiResponses, snapshot: { state: "unavailable" as const } }] },
    { label: "signed-out provider", instances: [anthropic, { ...openaiResponses, snapshot: { state: "available" as const, authenticated: false } }] },
    { label: "disabled provider", instances: [anthropic, { ...openaiResponses, enabled: false }] },
    { label: "removed model", instances: [anthropic, { ...openaiResponses, models: { default: "new-model", options: [] } }] },
  ])("returns setup for a saved $label without changing provider", ({ instances }) => {
    expect(selectDefaultModelSelection(instances, { instanceId: "openaiResponses", model: "selected-model" }))
      .toEqual({ instanceId: "", model: "" });
  });

  it("uses configured provider order when no default was saved", () => {
    expect(selectDefaultModelSelection([openaiResponses, anthropic])).toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    expect(selectDefaultModelSelection([anthropic, openaiResponses])).toEqual({ instanceId: "anthropicApi", model: "anthropic-default" });
    expect(selectDefaultModelSelection([openaiResponses])).toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    expect(selectDefaultModelSelection([])).toEqual({ instanceId: "", model: "" });
  });

  it("treats a fully empty saved default as unset, but keeps incomplete choices intentional", () => {
    expect(selectDefaultModelSelection([openaiResponses], { instanceId: "", model: "" }))
      .toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    for (const preferred of [{ instanceId: "openaiResponses", model: "" }, { instanceId: "", model: "selected-model" }]) {
      expect(selectDefaultModelSelection([anthropic, openaiResponses], preferred)).toEqual({ instanceId: "", model: "" });
    }
  });

  it("skips empty model catalogs instead of choosing an unusable preferred provider", () => {
    const empty = { ...anthropic, models: { default: "", options: [] } };
    expect(selectDefaultModelSelection([empty, openaiResponses])).toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    expect(selectDefaultModelSelection([empty])).toEqual({ instanceId: "", model: "" });
    expect(selectDefaultModelSelection([{ ...empty, models: { default: " ", options: [{ id: "", label: "Empty" }] } }]))
      .toEqual({ instanceId: "", model: "" });
  });

  it("uses the first nonempty model when a configured catalog has no default", () => {
    const models = { default: "", options: [{ id: "", label: "Empty" }, { id: " ", label: "Blank" }, { id: "usable-model", label: "Usable" }] };
    expect(selectDefaultModelSelection([{ ...anthropic, models }, openaiResponses]))
      .toEqual({ instanceId: "anthropicApi", model: "usable-model" });
    expect(selectDefaultModelSelection([{ ...openaiResponses, models: { default: "catalog-default", options: [] } }]))
      .toEqual({ instanceId: "openaiResponses", model: "catalog-default" });
  });

  it("never automatically chooses a disabled provider, even for signed-out setup", () => {
    const disabled = { ...anthropic, enabled: false };
    expect(readyToRun(disabled)).toBe(false);
    expect(selectDefaultModelSelection([disabled, openaiResponses])).toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    expect(selectDefaultModelSelection([disabled])).toEqual({ instanceId: "", model: "" });
    const signedOutOpenAI = { ...openaiResponses, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
    expect(selectDefaultModelSelection([disabled, signedOutOpenAI])).toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
  });

  it("prefers a provider that can run a turn now over a signed-out Anthropic provider", () => {
    const signedOut = { ...anthropic, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
    expect(selectDefaultModelSelection([signedOut, openaiResponses])).toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    expect(selectDefaultModelSelection([openaiResponses, signedOut])).toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    const openaiResponsesOut = { ...openaiResponses, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
    expect(selectDefaultModelSelection([openaiResponsesOut, signedOut])).toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    const custom = { ...openaiResponsesOut, instanceId: "router", access: "custom" as const };
    expect(selectDefaultModelSelection([signedOut, custom])).toEqual({ instanceId: "router", model: "gpt-default" });
  });
});

describe("new bot default: one ranking with the welcome, tested AIs first", () => {
  const ready = (instanceId: string, driverKind: string, model: string, snapshot: Partial<ProviderSnapshot> = {}): SelectableInstance => ({
    instanceId, driverKind, snapshot: { state: "available", authenticated: true, ...snapshot }, models: { default: model, options: [{ id: model, label: model }] },
  });
  const xai = ready("xaiApi", "grok", "grok-4.7");
  const customCompat = ready("custom", "openai-compat", "custom-model");
  const openaiResponses = ready("openaiResponses", "openai-responses", "gpt-default");
  const anthropicReady = ready("anthropicApi", "anthropic", "anthropic-default");
  const freeFallback = ready("freeApi", "openai-compat", "fixture/free-model", { freeFallback: true });
  const pick = (instances: SelectableInstance[], context = {}) => selectDefaultModelSelection(instances, undefined, context).instanceId;

  it("never gives a provider-specific preference over configured order", () => {
    expect(pick([xai, customCompat, anthropicReady])).toBe("xaiApi");
    expect(pick([anthropicReady, customCompat, xai])).toBe("anthropicApi");
  });

  it("keeps API provider order rather than subscription-engine precedence", () => {
    expect(pick([xai, customCompat, openaiResponses])).toBe("xaiApi");
    expect(pick([openaiResponses, customCompat, xai])).toBe("openaiResponses");
  });

  it("picks a free-only native provider after every other ready provider, and when it is the only one", () => {
    for (const other of [xai, customCompat, openaiResponses, anthropicReady]) expect(pick([freeFallback, other])).toBe(other.instanceId);
    expect(pick([freeFallback])).toBe("freeApi");
    expect(selectDefaultModelSelection([freeFallback])).toEqual({ instanceId: "freeApi", model: "fixture/free-model" });
  });

  it("always keeps a saved default, over the ranking and over any test", () => {
    const saved = { instanceId: "freeApi", model: "fixture/free-model" };
    expect(selectDefaultModelSelection([anthropicReady, freeFallback], saved, { answered: (instance) => instance.instanceId === "anthropicApi" }))
      .toEqual(saved);
    expect(selectDefaultModelSelection([anthropicReady, xai], { instanceId: "xaiApi", model: "grok-4.7" }, { answered: () => false }))
      .toEqual({ instanceId: "xaiApi", model: "grok-4.7" });
  });

  it("moves off an AI that failed its test to the best one that answered, and keeps the ranking until a test says otherwise", () => {
    const failed = (...ids: string[]) => (instance: SelectableInstance) => ids.includes(instance.instanceId) ? false : undefined;
    expect(pick([xai, anthropicReady, openaiResponses], { answered: failed("xaiApi", "anthropicApi") })).toBe("openaiResponses");
    expect(pick([xai, anthropicReady, openaiResponses], { answered: (instance: SelectableInstance) => instance.instanceId === "anthropicApi" ? false : instance.instanceId === "xaiApi" })).toBe("xaiApi");
    expect(pick([xai, anthropicReady], { answered: () => undefined })).toBe("xaiApi");
    // Nothing answered: the ranking still decides, so a new bot is never left without an AI.
    expect(pick([xai, anthropicReady], { answered: () => false })).toBe("xaiApi");
    // The free backup that answered beats a real AI that didn't.
    expect(pick([anthropicReady, freeFallback], { answered: (instance: SelectableInstance) => instance.instanceId === "freeApi" ? true : false })).toBe("freeApi");
  });

  it("never prefers the free backup to a real AI that hasn't been tested yet, or can't be", () => {
    const backupAnswered = (instance: SelectableInstance) => instance.instanceId === "freeApi" ? true : undefined;
    expect(pick([anthropicReady, freeFallback], { answered: backupAnswered })).toBe("anthropicApi");
    expect(pick([ready("local", "openai-compat", "local-model"), freeFallback], { answered: backupAnswered })).toBe("local");
  });
});

describe("new bot default model selection while enrolled in an organisation", () => {
  const signedOut = { ...anthropic, instanceId: "personal-anthropic", snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
  const companyAnthropic = { ...anthropic, instanceId: "company.fixture.anthropic", models: { default: "company-anthropic", options: [{ id: "company-anthropic", label: "Company" }] } };
  const companyRouter = {
    instanceId: "company.fixture.openrouter", driverKind: "openai-compat",
    snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
    models: { default: "company/router", options: [{ id: "company/router", label: "Router" }] },
  };
  const company = (instanceId: string) => instanceId.startsWith("company.");

  it("picks a Company model that can run over an installed but signed-out personal Anthropic", () => {
    expect(selectDefaultModelSelection([signedOut, companyAnthropic], undefined, { company }))
      .toEqual({ instanceId: "company.fixture.anthropic", model: "company-anthropic" });
    expect(selectDefaultModelSelection([signedOut, companyRouter, companyAnthropic], undefined, { company }))
      .toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
    expect(selectDefaultModelSelection([signedOut, companyRouter], undefined, { company }))
      .toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
  });

  it("keeps a signed-in personal provider, so billing stays the person's choice", () => {
    expect(selectDefaultModelSelection([companyAnthropic, anthropic], undefined, { company }))
      .toEqual({ instanceId: "anthropicApi", model: "anthropic-default" });
    expect(selectDefaultModelSelection([signedOut, companyAnthropic, openaiResponses], undefined, { company }))
      .toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
  });

  it("falls back to today's choice when nothing can run yet", () => {
    const companyMissingKey = { ...companyAnthropic, snapshot: { state: "unavailable", reason: "API key not configured" } satisfies ProviderSnapshot };
    expect(selectDefaultModelSelection([signedOut, companyMissingKey], undefined, { company }))
      .toEqual({ instanceId: "personal-anthropic", model: "anthropic-default" });
  });

  it("is the same choice as without an enrolment when no Company model exists", () => {
    for (const instances of [[signedOut, openaiResponses], [openaiResponses, signedOut], [openaiResponses], [signedOut], []]) {
      expect(selectDefaultModelSelection(instances, undefined, {})).toEqual(selectDefaultModelSelection(instances));
      expect(selectDefaultModelSelection(instances, undefined, { company, refusal: () => undefined })).toEqual(selectDefaultModelSelection(instances));
    }
    expect(selectDefaultModelSelection([openaiResponses, signedOut], undefined, { company })).toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
  });

  it("never picks an engine the organisation's policy refuses", () => {
    // companyModelsOnly: every personal instance is refused.
    const companyOnly = (instance: { instanceId: string }) => company(instance.instanceId) ? undefined : "Fixture Company allows only company models on this computer.";
    expect(selectDefaultModelSelection([anthropic, openaiResponses, companyRouter], undefined, { company, refusal: companyOnly }))
      .toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
    expect(selectDefaultModelSelection([anthropic, openaiResponses], undefined, { company, refusal: companyOnly }))
      .toEqual({ instanceId: "", model: "" });
    // An allow-list without Anthropic skips Anthropic, personal or Company.
    const noAnthropic = (instance: { driverKind: string }) => instance.driverKind === "anthropic" ? "Fixture Company does not allow this provider on this computer." : undefined;
    expect(selectDefaultModelSelection([anthropic, companyAnthropic, companyRouter], undefined, { company, refusal: noAnthropic }))
      .toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
    expect(selectDefaultModelSelection([anthropic, companyRouter], { instanceId: "anthropicApi", model: "anthropic-default" }, { company, refusal: companyOnly }))
      .toEqual({ instanceId: "", model: "" });
  });
});

// The server's own wiring, not a copy: run index.ts's actual defaultSelection
// and policyModelRefusal against a synthetic registry.
describe("new bot default model selection wiring in index.ts", () => {
  // Windows checkouts may use CRLF; match on normalised line endings.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const extract = (signature: string, close = "\n}\n") => {
    const start = source.indexOf(`\n${signature}`), end = source.indexOf(close, start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    return source.slice(start + 1, end + close.length - 1);
  };
  const code = ts.transpileModule(`${extract("function policyModelRefusal(")}\n${extract("function selectableInstances<")}\n${extract("async function defaultSelection(")}\n${extract("const selectionContext = {", "\n};\n")}`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  const companyAnthropic = { ...anthropic, instanceId: "company.fixture.anthropic", models: { default: "company-anthropic", options: [{ id: "company-anthropic", label: "Company" }] } };
  const signedOut = { ...anthropic, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
  function server(instances: unknown[], { saved, credit = null, configs = {}, answered }: { saved?: ModelSelection; credit?: string | null; configs?: Record<string, { enabled?: boolean; access?: EngineAccess }>; answered?: (instance: SelectableInstance) => boolean | undefined } = {}) {
    const cloudCredit = credit ? { owns: (instanceId: string) => instanceId === credit } : null;
    const describe = vi.fn(async () => instances);
    const defaultSelection = new Function("cfg", "registry", "selectDefaultModelSelection", "cloudCredit", "providerConfigs", "heldKeys", "withInstanceConfig", "testedAi",
      `${code}; return defaultSelection;`)({ defaultModelSelection: saved }, { describe }, selectDefaultModelSelection, cloudCredit, () => configs, null, withInstanceConfig,
      { answered: answered ?? (() => undefined) }) as (saved?: ModelSelection | null, instances?: readonly SelectableInstance[]) => Promise<ModelSelection>;
    return { defaultSelection, describe, close: () => {} };
  }

  it("honors a disabled configured provider in both automatic and saved selection", async () => {
    const fixture = server([anthropic, openaiResponses], { configs: { anthropicApi: { enabled: false } } });
    await expect(fixture.defaultSelection()).resolves.toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    await expect(fixture.defaultSelection({ instanceId: "anthropicApi", model: "anthropic-default" })).resolves.toEqual({ instanceId: "", model: "" });
    fixture.close();
  });

  it("uses configured custom credentials instead of an unrelated account's sign-in state", async () => {
    const fixture = server([signedOut], { configs: { anthropicApi: { access: "custom" } } });
    await expect(fixture.defaultSelection({ instanceId: "anthropicApi", model: "anthropic-default" })).resolves.toEqual({ instanceId: "anthropicApi", model: "anthropic-default" });
    fixture.close();
  });

  it("uses a supplied inventory without probing the provider a second time", async () => {
    const fixture = server([anthropic]);
    await expect(fixture.defaultSelection(null, [openaiResponses])).resolves.toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    expect(fixture.describe).not.toHaveBeenCalled();
    fixture.close();
  });

  it("on a Cloud home, the trial's Anthropic credit runs a new bot only while nothing of the person's own can", async () => {
    const credit = { instanceId: "trial-credit", driverKind: "openai-compat", snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
      models: { default: "claude-haiku-4-5", options: [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }] } };
    // Their Anthropic is signed out: the credit, not a sign-in screen.
    await expect(server([signedOut, credit], { credit: "trial-credit" }).defaultSelection()).resolves.toEqual({ instanceId: "trial-credit", model: "claude-haiku-4-5" });
    await expect(server([credit, anthropic], { credit: "trial-credit" }).defaultSelection()).resolves.toEqual({ instanceId: "anthropicApi", model: "anthropic-default" });
    await expect(server([credit, openaiResponses], { credit: "trial-credit" }).defaultSelection()).resolves.toMatchObject({ instanceId: "openaiResponses" });
  });

  it("treats an id named company like any other engine", async () => {
    const notEnrolled = server([signedOut, companyAnthropic]);
    await expect(notEnrolled.defaultSelection()).resolves.toEqual({ instanceId: "company.fixture.anthropic", model: "company-anthropic" });
    const nothingReady = server([signedOut]);
    await expect(nothingReady.defaultSelection()).resolves.toEqual({ instanceId: "anthropicApi", model: "anthropic-default" });
  });

  it("leaves the saved default out only when asked, for a bot moved off a removed engine", async () => {
    const saved = server([anthropic, openaiResponses], { saved: { instanceId: "computer", model: "claude-fable-5" } });
    await expect(saved.defaultSelection()).resolves.toEqual({ instanceId: "", model: "" });
    await expect(saved.defaultSelection(null)).resolves.toEqual({ instanceId: "anthropicApi", model: "anthropic-default" });
    saved.close();
  });

  it("passes what each AI's test message showed into the choice, and never past a saved default", async () => {
    const anthropicSilent = (instance: SelectableInstance) => instance.instanceId === "anthropicApi" ? false : undefined;
    await expect(server([anthropic, openaiResponses], { answered: anthropicSilent }).defaultSelection()).resolves.toEqual({ instanceId: "openaiResponses", model: "gpt-default" });
    await expect(server([anthropic, openaiResponses], { answered: anthropicSilent, saved: { instanceId: "anthropicApi", model: "anthropic-default" } }).defaultSelection())
      .resolves.toEqual({ instanceId: "anthropicApi", model: "anthropic-default" });
  });


});

describe("new bot effort default", () => {
  const selection: ModelSelection = { instanceId: "openaiResponses", model: "gpt-default" };

  it("adds the workspace effort when the engine offers it", () => {
    expect(withNewBotEffort(selection, "high", ["low", "high"])).toEqual({ ...selection, effort: "high" });
  });

  it("keeps the caller's explicit effort or model variant", () => {
    expect(withNewBotEffort({ ...selection, effort: "low" }, "high", ["low", "high"])).toEqual({ ...selection, effort: "low" });
    const variant = { instanceId: "openrouter", model: "provider/model", variant: "minimal" };
    expect(withNewBotEffort(variant, "high", ["high"])).toEqual(variant);
  });

  it("sends no level when none is configured or the engine does not offer it", () => {
    expect(withNewBotEffort(selection, undefined, ["high"])).toEqual(selection);
    expect(withNewBotEffort(selection, "max", ["low", "high"])).toEqual(selection);
    expect(withNewBotEffort(selection, "high", undefined)).toEqual(selection);
  });
});
