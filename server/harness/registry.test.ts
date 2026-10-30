// A config written by a newer or differently built app must load as an unavailable shadow, never crash the fleet.
import { describe, expect, it, vi } from "vitest";

import type { ModelCatalog } from "../contracts.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
import { ProviderRegistry, SNAPSHOT_DEADLINE_MS, SNAPSHOT_REUSE_MS } from "./registry.ts";

describe("ProviderRegistry", () => {
  it("creates live instances for known drivers", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake", displayName: "Bot A" } });

    const live = registry.get("a");
    expect(live).not.toBeNull();
    expect(live!.driverKind).toBe("fake");
    expect(live!.displayName).toBe("Bot A");
    expect(registry.instances()).toHaveLength(1);
  });

  it("uses defaultConfig when the entry has no config", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    expect(fake.decodedConfigs).toHaveLength(0);
    expect(registry.get("a")).not.toBeNull();
  });

  it("reports cli as overridden only when the raw config sets it", async () => {
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      untouched: { driver: "fake", config: { other: true } },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
      bare: { driver: "fake" },
    });

    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(described.untouched.cli).toBeUndefined();
    expect(described.bare.cli).toBeUndefined();
    expect(described.overridden.cli).toBe("/opt/fake/custom-bin");
    expect(described.untouched.cliDefault).toBe("fakebin");
    expect(described.untouched.access).toBe("subscription");
  });

  it("resolves maintenance commands to the configured CLI or driver default", async () => {
    const fake = makeFakeDriver();
    fake.driver.defaultConfig = () => ({ cli: "fakebin" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({
      defaulted: { driver: "fake" },
      overridden: { driver: "fake", config: { cli: "/opt/fake/custom-bin" } },
    });

    expect(registry.cliTarget("defaulted")).toEqual({ driverKind: "fake", cli: "fakebin" });
    expect(registry.cliTarget("overridden")).toEqual({ driverKind: "fake", cli: "/opt/fake/custom-bin" });
    expect(registry.cliTarget("missing")).toBeNull();
  });

  it("publishes custom-only access from driver metadata", async () => {
    const fake = makeFakeDriver();
    Object.assign(fake.driver.metadata, { access: "custom" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ local: { driver: "fake" } });
    const [described] = await registry.describe();
    expect(described.access).toBe("custom");
  });

  it("keeps an unknown driver as an unavailable shadow instead of failing", async () => {
    const registry = new ProviderRegistry([makeFakeDriver().driver]);
    await registry.load({ mystery: { driver: "from-the-future", displayName: "Tomorrow" } });

    expect(registry.get("mystery")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot.state).toBe("unavailable");
    expect(described.snapshot.reason).toContain("from-the-future");
    expect(described.displayName).toBe("Tomorrow");
    expect(described.models.options).toHaveLength(0);
    expect(registry.cliTarget("mystery")).toEqual({ driverKind: "from-the-future", cli: null });
  });

  it("downgrades a config-decode failure to a shadow with the error as reason", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ broken: { driver: "fake", config: { bad: true } } });

    expect(registry.get("broken")).toBeNull();
    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "fake: bad config" });
  });

  it("downgrades a create() rejection to a shadow without touching siblings", async () => {
    const good = makeFakeDriver({ kind: "good" });
    const flaky = makeFakeDriver({ kind: "flaky", failCreate: "boom at create" });
    const registry = new ProviderRegistry([good.driver, flaky.driver]);
    await registry.load({
      g: { driver: "good" },
      f: { driver: "flaky" },
    });

    expect(registry.get("g")).not.toBeNull();
    expect(registry.get("f")).toBeNull();
    const described = await registry.describe();
    const f = described.find((d) => d.instanceId === "f")!;
    expect(f.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("creates instances concurrently while keeping config order and failure isolation", async () => {
    const first = makeFakeDriver({ kind: "first" });
    const second = makeFakeDriver({ kind: "second" });
    const broken = makeFakeDriver({ kind: "broken", failCreate: "boom at create" });
    // "second" is released before "first", so completion order is the reverse of config order.
    const started: string[] = [];
    const release = [first, second, broken].map((handle) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const create = handle.driver.create.bind(handle.driver);
      handle.driver.create = async (input) => {
        started.push(input.instanceId);
        await gate;
        return create(input);
      };
      return open;
    });
    const registry = new ProviderRegistry([first.driver, second.driver, broken.driver]);
    const loading = registry.load({
      first: { driver: "first" },
      second: { driver: "second" },
      broken: { driver: "broken" },
    });
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    let done = false;
    void loading.then(() => (done = true));
    await settle();
    expect(started).toEqual(["first", "second", "broken"]);
    expect(done).toBe(false);
    release[1]();
    await settle();
    expect(registry.get("second")).not.toBeNull();
    expect(registry.get("first")).toBeNull();
    release[0]();
    release[2]();
    await loading;

    expect(registry.instances().map((i) => i.instanceId)).toEqual(["first", "second"]);
    expect(registry.entries().map((e) => e.instanceId)).toEqual(["first", "second", "broken"]);
    expect(registry.get("broken")).toBeNull();
    const described = Object.fromEntries((await registry.describe()).map((d) => [d.instanceId, d]));
    expect(Object.keys(described)).toEqual(["first", "second", "broken"]);
    expect(described.broken.snapshot).toMatchObject({ state: "unavailable", reason: "boom at create" });
  });

  it("does not bring back an instance disposed while a slower one is still loading", async () => {
    const fast = makeFakeDriver({ kind: "fast" });
    const slow = makeFakeDriver({ kind: "slow" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const create = slow.driver.create.bind(slow.driver);
    slow.driver.create = async (input) => {
      await gate;
      return create(input);
    };
    const registry = new ProviderRegistry([fast.driver, slow.driver]);
    const loading = registry.load({ fast: { driver: "fast" }, slow: { driver: "slow" } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(registry.get("fast")).not.toBeNull();
    await registry.disposeAll();
    release();
    await loading;
    expect(registry.get("fast")).toBeNull();
    expect(registry.entries().map((e) => e.instanceId)).toEqual(["slow"]);
  });

  it("keeps a replaced instance in its place and adds a new one at the end", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" }, c: { driver: "fake" } });
    const before = registry.get("b");
    await registry.load({ b: { driver: "fake", displayName: "Rebuilt" }, d: { driver: "fake" } });
    expect(registry.entries().map((e) => e.instanceId)).toEqual(["a", "b", "c", "d"]);
    expect(registry.get("b")).not.toBe(before);
    expect(registry.get("b")?.displayName).toBe("Rebuilt");
  });

  it("describe() reports a snapshot() failure as unavailable rather than throwing", async () => {
    const fake = makeFakeDriver({ failSnapshot: "provider probe exploded" });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.snapshot).toMatchObject({ state: "unavailable", reason: "provider probe exploded" });
  });

  it("describe() reports a snapshot() that never settles as unavailable, so the other engines are still read", async () => {
    vi.useFakeTimers();
    try {
      const stuck = makeFakeDriver({ kind: "stuck", hangSnapshot: true });
      const fine = makeFakeDriver({ kind: "fine" });
      const registry = new ProviderRegistry([stuck.driver, fine.driver]);
      await registry.load({ a: { driver: "stuck" }, b: { driver: "fine" } });

      const read = registry.describe();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);
      const described = Object.fromEntries((await read).map((d) => [d.instanceId, d.snapshot.state]));
      expect(described).toEqual({ a: "unavailable", b: "available" });

      const direct = registry.get("a")!.snapshot();
      const settled = expect(direct).rejects.toThrow("did not report its status within a minute");
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards a live instance's declared effort levels in describe()", async () => {
    const fake = makeFakeDriver({ effortLevels: ["low", "high"] });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toEqual(["low", "high"]);
  });

  it("omits effortLevels from describe() when the driver declares none", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    const [described] = await registry.describe();
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("exposes model-variant support without manufacturing an effort list", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    registry.get("a")!.adapter.capabilities.modelVariants = true;
    const [described] = await registry.describe();
    expect(described.capabilities.modelVariants).toBe(true);
    expect(described.capabilities.effortLevels).toBeUndefined();
  });

  it("reports whether an instance supports isolated approval review", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    expect((await registry.describe())[0].capabilities.approvalReview).toBe(false);
    Object.assign(registry.get("a")!, { reviewPermission: async () => "ok" });
    expect((await registry.describe())[0].capabilities.approvalReview).toBe(true);
  });

  it("reports whether an instance can make the background steps' one-shot call", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    expect((await registry.describe()).map((item) => item.capabilities.backgroundText)).toEqual([false, false]);
    Object.assign(registry.get("a")!, { generateText: async () => "ok" });
    Object.assign(registry.get("b")!, { generateMemoryText: async () => "ok" });
    expect((await registry.describe()).map((item) => item.capabilities.backgroundText)).toEqual([true, true]);
  });

  it("refreshes a live model catalog only on an explicit provider action", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });
    const refreshes = { a: 0, b: 0 };
    for (const instanceId of ["a", "b"] as const) {
      const instance = registry.get(instanceId)!;
      const models: ModelCatalog = { default: "", options: [] };
      Object.assign(instance, {
        models,
        refreshModels: async () => {
          refreshes[instanceId] += 1;
          const id = `${instanceId}-${refreshes[instanceId]}`;
          models.default = id;
          models.options = [{ id, label: `Dynamic ${id}` }];
        },
      });
    }

    await registry.refreshModels("a");
    await registry.refreshModels("b");
    const first = Object.fromEntries((await registry.describe()).map((row) => [row.instanceId, row.models]));
    expect(first.a.default).toBe("a-1");
    expect(first.b.default).toBe("b-1");

    await registry.refreshModels("a");
    await registry.refreshModels("b");
    const second = Object.fromEntries((await registry.describe()).map((row) => [row.instanceId, row.models]));
    expect(second.a.default).toBe("a-2");
    expect(second.b.default).toBe("b-2");
    expect(refreshes).toEqual({ a: 2, b: 2 });
  });

  it("probes each engine once for concurrent reads, and every reader gets that probe's answer", async () => {
    let release!: () => void;
    const fake = makeFakeDriver({ holdSnapshot: new Promise<void>((resolve) => (release = resolve)) });
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    const described = Promise.all([registry.describe(), registry.describe(), registry.describe()]);
    const direct = registry.get("a")!.snapshot();
    expect(fake.probes.sort()).toEqual(["a", "b"]);
    release();
    for (const rows of await described) {
      expect(rows.map((row) => [row.instanceId, row.snapshot])).toEqual([["a", { state: "available", version: "0.0.0-fake" }], ["b", { state: "available", version: "0.0.0-fake" }]]);
    }
    expect(await direct).toEqual({ state: "available", version: "0.0.0-fake" });
    expect(fake.probes).toHaveLength(2);
  });

  it("answers a read within the reuse window from the probe that just finished, then probes again", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeDriver();
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ a: { driver: "fake" } });

      await registry.describe();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_REUSE_MS - 1);
      await registry.describe();
      expect(fake.probes).toEqual(["a"]);
      await vi.advanceTimersByTimeAsync(1);
      await registry.describe();
      expect(fake.probes).toEqual(["a", "a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a model list that arrived while the status read is reused", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });
    const models: ModelCatalog = { default: "old", options: [{ id: "old", label: "Old" }] };
    Object.defineProperty(registry.get("a")!, "models", { get: () => models });

    expect((await registry.describe())[0].models.default).toBe("old");
    models.default = "new";
    models.options = [{ id: "new", label: "New" }];
    expect((await registry.describe())[0].models).toEqual({ default: "new", options: [{ id: "new", label: "New" }] });
    expect(fake.probes).toEqual(["a"]);
  });

  it("probes again after a failed or timed-out read instead of reusing it", async () => {
    vi.useFakeTimers();
    try {
      const options: Parameters<typeof makeFakeDriver>[0] = { failSnapshot: "probe exploded" };
      const fake = makeFakeDriver(options);
      const registry = new ProviderRegistry([fake.driver]);
      await registry.load({ a: { driver: "fake" } });

      expect((await registry.describe())[0].snapshot).toMatchObject({ state: "unavailable", reason: "probe exploded" });
      delete options.failSnapshot;
      options.hangSnapshot = true;
      const stuck = registry.describe();
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);
      expect((await stuck)[0].snapshot).toMatchObject({ state: "unavailable", reason: expect.stringContaining("within a minute") });
      delete options.hangSnapshot;
      expect((await registry.describe())[0].snapshot).toMatchObject({ state: "available" });
      expect(fake.probes).toEqual(["a", "a", "a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes again after forgetSnapshots(), and never hands a later read the probe that was in flight", async () => {
    let release!: () => void;
    const options: Parameters<typeof makeFakeDriver>[0] = {};
    const fake = makeFakeDriver(options);
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" } });

    await registry.describe();
    registry.forgetSnapshots();
    await registry.describe();
    expect(fake.probes).toEqual(["a", "a"]);

    options.holdSnapshot = new Promise<void>((resolve) => (release = resolve));
    registry.forgetSnapshots();
    const before = registry.describe();
    registry.forgetSnapshots();
    const after = registry.describe();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fake.probes).toEqual(["a", "a", "a", "a"]);
    release();
    await Promise.all([before, after]);
    await registry.describe();
    expect(fake.probes).toHaveLength(4);
  });

  it("runs a decorator's own check on every read, and probes again after a model refresh or a reload", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    let refused = false;
    await registry.load({ a: { driver: "fake" } }, (instance) => ({
      ...instance,
      snapshot: async () => refused ? { state: "unavailable", reason: "credit used up" } : instance.snapshot(),
    }));

    expect((await registry.describe())[0].snapshot.state).toBe("available");
    refused = true;
    expect((await registry.describe())[0].snapshot).toMatchObject({ state: "unavailable", reason: "credit used up" });
    refused = false;
    expect((await registry.describe())[0].snapshot.state).toBe("available");
    expect(fake.probes).toEqual(["a"]);

    expect(await registry.refreshModels("a")).toBe(true);
    await registry.describe();
    expect(fake.probes).toEqual(["a", "a"]);

    await registry.load({ a: { driver: "fake", displayName: "Reloaded" } });
    await registry.describe();
    expect(fake.probes).toEqual(["a", "a", "a"]);
  });

  it("disposeAll disposes every live instance and empties the registry", async () => {
    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ a: { driver: "fake" }, b: { driver: "fake" } });

    await registry.disposeAll();
    expect(fake.disposed.sort()).toEqual(["a", "b"]);
    expect(registry.entries()).toHaveLength(0);
    expect(registry.get("a")).toBeNull();
  });
});
