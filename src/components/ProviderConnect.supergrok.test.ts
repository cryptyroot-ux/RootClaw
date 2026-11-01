import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, StoreContext, type AppState } from "@/state/store";
import { disconnectGrokSignIn, GrokSignInCode, isGrokSignInPage, ProviderConnect, startGrokSignIn } from "./ProviderConnect";

afterEach(() => vi.unstubAllGlobals());

const render = (config: AppState["config"]) => {
  vi.stubGlobal("window", { ogb: { platform: "linux" } });
  const value = { state: { ...initialState, config } as AppState, dispatch: vi.fn(), refreshInstances: vi.fn() } as never;
  return renderToStaticMarkup(createElement(StoreContext.Provider, { value }, createElement(ProviderConnect)));
};
const subscription = (signedIn: boolean, reconnect: boolean) => ({ xai: { configured: false, subscription: { signedIn, reconnect } } }) as AppState["config"];

describe("ProviderConnect SuperGrok", () => {
  it("offers Connect SuperGrok with no Disconnect while signed out", () => {
    const markup = render({} as AppState["config"]);
    expect(markup).toMatch(/<button type="button" data-grok-connect="true" class="[^"]*">.*Connect SuperGrok<\/button>/);
    expect(markup).not.toContain("data-grok-disconnect");
  });

  it("says when the server is signed in and offers Disconnect", () => {
    const markup = render(subscription(true, false));
    expect(markup).toContain("SuperGrok connected");
    expect(markup).toMatch(/data-grok-disconnect="true"[^>]*>.*Disconnect<\/button>/);
  });

  it("asks to reconnect once xAI refused the sign-in", () => {
    const markup = render(subscription(false, true));
    expect(markup).toMatch(/data-grok-connect="true"[^>]*>.*Reconnect SuperGrok<\/button>/);
    expect(markup).toContain("data-grok-disconnect");
  });

  it("starts through the server and shows only xAI's page, its code and when it expires", async () => {
    const post = vi.fn(async () => ({ url: "https://accounts.x.ai/device", code: "WDJB-MJHT", expiresIn: 900 }));
    const prompt = await startGrokSignIn(post);
    expect(prompt).toEqual({ url: "https://accounts.x.ai/device", code: "WDJB-MJHT", expiresIn: 900 });
    const markup = renderToStaticMarkup(createElement(GrokSignInCode, { prompt }));
    expect(markup).toContain('href="https://accounts.x.ai/device"');
    expect(markup).toContain("WDJB-MJHT");
    expect(markup).toContain("15 min");
    await expect(startGrokSignIn(async () => ({ url: "https://evil.test/device", code: "WDJB-MJHT", expiresIn: 900 }))).rejects.toThrow(/xAI page/);
    expect(isGrokSignInPage("http://accounts.x.ai/device")).toBe(false);
    expect(isGrokSignInPage("https://auth.x.ai/device")).toBe(true);
  });

  it("disconnects through the server", async () => {
    const post = vi.fn(async () => ({}));
    await disconnectGrokSignIn(post);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
