import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiDriver } from "./api-providers.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Gemini model catalog authentication", () => {
  it("does not send an OAuth refresh token as the catalog API key", async () => {
    const fetch = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ models: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const instance = await GeminiDriver.create({
      instanceId: "gemini-oauth", displayName: "Gemini", enabled: true,
      config: GeminiDriver.decodeConfig({}),
      environment: { GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-secret-fixture", GOOGLE_OAUTH_CLIENT_ID: "client-fixture" },
    });

    await instance.refreshModels?.();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses an explicitly configured API key for catalog discovery", async () => {
    const fetch = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ models: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const instance = await GeminiDriver.create({
      instanceId: "gemini-key", displayName: "Gemini", enabled: true,
      config: GeminiDriver.decodeConfig({ key: "api-key-fixture" }), environment: {},
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    fetch.mockClear();

    await instance.refreshModels?.();

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ "x-goog-api-key": "api-key-fixture" });
  });
});
