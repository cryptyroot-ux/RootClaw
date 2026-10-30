import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "@/state/store";
import { PROVIDER_KEYS, ProviderConnect, startOAuth } from "./ProviderConnect";

afterEach(() => vi.unstubAllGlobals());

describe("ProviderConnect", () => {
  it("offers an API key for every native provider and only the official OAuth sign-ins", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    expect(PROVIDER_KEYS).toEqual(["openai", "anthropic", "gemini", "openrouter", "ollama"]);
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(ProviderConnect)));
    expect(markup).toContain('data-provider-connect');
    expect(markup).toContain('data-oauth="openrouter"');
    expect(markup).toContain('data-oauth="google"');
    for (const id of PROVIDER_KEYS) expect(markup).toContain(`data-provider-key="${id}"`);
    expect(markup).not.toMatch(/Claude Pro|ChatGPT plan|Codex/);
  });

  it("starts a sign-in through the server and opens the provider's page", async () => {
    const post = vi.fn(async () => ({ url: "https://openrouter.ai/auth?callback_url=x" }));
    const open = vi.fn(async () => {});
    await startOAuth("openrouter", { post, open });
    expect(post).toHaveBeenCalledWith("/api/oauth/openrouter/start");
    expect(open).toHaveBeenCalledWith("https://openrouter.ai/auth?callback_url=x");
  });

  it("passes the server's refusal through (Google without the person's own client)", async () => {
    const post = vi.fn(async () => { throw new Error("Google sign-in needs your own OAuth client"); });
    await expect(startOAuth("google", { post, open: vi.fn() })).rejects.toThrow(/own OAuth client/);
  });
});
