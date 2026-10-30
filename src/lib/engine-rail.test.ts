import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { configuredModelInstances, splitEngineRail } from "./engine-rail";

describe("splitEngineRail", () => {
  it("groups built-in engines, pasted provider keys and Local engines", () => {
    const { native, api, custom } = splitEngineRail<{ instanceId: string; access?: string }>([
      { instanceId: "openaiCompat" },
      { access: "custom", instanceId: "hermes" },
      { instanceId: "grok" },
      { access: "api", instanceId: "mistral" },
      { access: "custom", instanceId: "qwen" },
    ]);
    expect(native.map((row) => row.instanceId)).toEqual(["openaiCompat", "grok"]);
    expect(api.map((row) => row.instanceId)).toEqual(["mistral"]);
    expect(custom.map((row) => row.instanceId)).toEqual(["hermes", "qwen"]);
  });

  it("hides the second group when nothing is custom-only", () => {
    const rows = [{ instanceId: "openaiCompat" }];
    expect(splitEngineRail(rows).custom).toEqual([]);
  });
});

describe("configuredModelInstances", () => {
  const cloud = { id: "cloud-model", label: "Cloud model" };
  const local = { id: "local-model", label: "Local model", custom: true, loaded: true, provider: "Local host" };
  const instance = (overrides: Partial<InstanceInfo> = {}): InstanceInfo => ({
    instanceId: "openaiCompat",
    driverKind: "openai-compat",
    displayName: "OpenAI-compatible",
    snapshot: { state: "available", authenticated: true },
    models: { default: cloud.id, options: [cloud, local] },
    ...overrides,
  });

  it("hides engines that are not installed, and engines without selectable models, when the bot is not on them", () => {
    const ready = instance();
    const unavailable = instance({ instanceId: "unavailable", snapshot: { state: "unavailable", authenticated: true } });
    const unavailableLocal = instance({ instanceId: "unavailable-local", access: "custom", snapshot: { state: "unavailable" } });
    const empty = instance({ instanceId: "empty", models: { default: cloud.id, options: [] } });
    const emptyLocal = instance({ instanceId: "empty-local", access: "custom", models: { default: local.id, options: [] } });

    expect(configuredModelInstances([unavailable, empty, ready, unavailableLocal, emptyLocal])).toEqual([ready]);
    expect(configuredModelInstances([unavailable, empty, ready, unavailableLocal, emptyLocal], "openaiCompat")).toEqual([ready]);
  });

  it.each([true, false, undefined])("keeps cloud and custom models when authentication is %s", (authenticated) => {
    const explicitSubscription = instance({ snapshot: { state: "available", authenticated } });
    const legacy = instance({ instanceId: "legacy", access: undefined, snapshot: { state: "available", authenticated } });

    expect(configuredModelInstances([explicitSubscription, legacy])).toEqual([explicitSubscription, legacy]);
  });

  it("keeps a signed-out engine with its whole catalog so the picker can show its sign-in card", () => {
    const cloudOnly = instance({ instanceId: "cloud-only", snapshot: { state: "available", authenticated: false }, models: { default: cloud.id, options: [cloud] } });
    const mixed = instance({ snapshot: { state: "available", authenticated: false } });
    const legacy = instance({ instanceId: "legacy", access: undefined, snapshot: { state: "available", authenticated: false } });

    const configured = configuredModelInstances([cloudOnly, mixed, legacy]);

    expect(configured.map((engine) => engine.instanceId)).toEqual(["cloud-only", "openaiCompat", "legacy"]);
    expect(configured.map((engine) => engine.models.options)).toEqual([[cloud], [cloud, local], [cloud, local]]);
  });

  it.each([true, false, undefined])("keeps custom engines when authentication is %s", (authenticated) => {
    const custom = instance({ access: "custom", snapshot: { state: "available", authenticated } });

    expect(configuredModelInstances([custom])).toEqual([custom]);
  });

  it("always keeps the engine the bot runs on, even when its CLI is missing or it lists nothing", () => {
    const missing = instance({ instanceId: "missing", snapshot: { state: "unavailable", reason: "endpoint unreachable" } });
    const empty = instance({ instanceId: "empty", access: "custom", snapshot: { state: "unavailable" }, models: { default: local.id, options: [] } });
    const ready = instance({ instanceId: "ready" });

    expect(configuredModelInstances([missing, ready, empty], "missing")).toEqual([missing, ready]);
    expect(configuredModelInstances([missing, ready, empty], "empty")).toEqual([ready, empty]);
    expect(configuredModelInstances([missing, ready, empty], "")).toEqual([ready]);
  });

  it("returns the catalog's own entries and leaves them intact so saved models keep their labels", () => {
    const signedOut = instance({ snapshot: { state: "available", authenticated: false } });
    const unavailable = instance({ instanceId: "unavailable", snapshot: { state: "unavailable" } });
    const catalog = [signedOut, unavailable];
    const before = structuredClone(catalog);
    for (const engine of catalog) {
      for (const option of engine.models.options) Object.freeze(option);
      Object.freeze(engine.models.options);
      Object.freeze(engine.models);
      Object.freeze(engine.snapshot);
      Object.freeze(engine);
    }
    Object.freeze(catalog);

    const configured = configuredModelInstances(catalog);

    expect(configured).toEqual([signedOut]);
    expect(configured[0]).toBe(signedOut);
    expect(catalog).toEqual(before);
  });
});
