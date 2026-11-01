import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { OllamaCloudDriver } from "./api-providers.ts";

// A fixture, never a real key.
const fixtureKey = "ollama-fixture-key-0123456789";

describe("Ollama Cloud provider", () => {
  let instances: ProviderInstance[];
  let requests: Array<{ url: string; authorization: string | null }>;

  beforeEach(() => {
    vi.stubEnv("OLLAMA_API_KEY", "");
    instances = [];
    requests = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input instanceof Request ? input.url : input), authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ data: [{ id: "gemma4:31b" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(async () => {
    await Promise.all(instances.map(instance => instance.dispose()));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const create = async (config: unknown = {}, environment: Record<string, string> = {}) => {
    const instance = await OllamaCloudDriver.create({ instanceId: "ollamaCloud", displayName: "Ollama Cloud", enabled: true,
      config: OllamaCloudDriver.decodeConfig(config), environment });
    instances.push(instance);
    return instance;
  };

  // `rootclaw doctor` reads readiness from this snapshot, so an unprefixed OLLAMA_API_KEY on the server is enough.
  it("is ready from the server's own OLLAMA_API_KEY at its default URL, and sends it only to ollama.com", async () => {
    vi.stubEnv("OLLAMA_API_KEY", fixtureKey);
    const instance = await create();
    expect(await instance.snapshot()).toMatchObject({ state: "available" });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests).toEqual([{ url: "https://ollama.com/v1/models", authorization: `Bearer ${fixtureKey}` }]);
  });

  it("keeps the server's own key from a custom URL, and is not ready without a key", async () => {
    vi.stubEnv("OLLAMA_API_KEY", fixtureKey);
    expect(await (await create({ url: "https://proxy.example/v1" })).snapshot()).toMatchObject({ state: "unavailable" });
    vi.stubEnv("OLLAMA_API_KEY", "");
    expect(await (await create()).snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("Ollama API key") });
    expect(requests).toEqual([]);
  });

  it("prefers the workspace's saved key, which it may send to a custom URL", async () => {
    const instance = await create({ url: "https://proxy.example/v1" }, { OLLAMA_API_KEY: fixtureKey });
    expect(await instance.snapshot()).toMatchObject({ state: "available" });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests).toEqual([{ url: "https://proxy.example/v1/models", authorization: `Bearer ${fixtureKey}` }]);
  });
});
