import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, StoreContext, type AppState } from "@/state/store";
import { EnginesSettings } from "./EnginesSettings";

afterEach(() => vi.unstubAllGlobals());

const render = (config: AppState["config"], props: Parameters<typeof EnginesSettings>[0] = {}) => {
  vi.stubGlobal("window", { ogb: { platform: "linux" } });
  const value = { state: { ...initialState, config } as AppState, dispatch: vi.fn(), refreshInstances: vi.fn() } as never;
  return renderToStaticMarkup(createElement(StoreContext.Provider, { value }, createElement(EnginesSettings, props)));
};
const more = { id: "ai-more", open: false, onToggle: vi.fn() };

describe("EnginesSettings SuperGrok", () => {
  it("offers Connect SuperGrok in Settings → Model providers", () => {
    for (const markup of [render({} as AppState["config"]), render({} as AppState["config"], { simple: true, more })]) {
      expect(markup).toContain("SuperGrok subscription");
      expect(markup).toMatch(/<button type="button" data-grok-connect="true" class="[^"]*">.*Connect SuperGrok<\/button>/);
      expect(markup).not.toContain("data-grok-disconnect");
    }
  });

  it("shows the connected state with Disconnect", () => {
    const markup = render({ xai: { configured: false, subscription: { signedIn: true, reconnect: false } } } as AppState["config"]);
    expect(markup).toContain("SuperGrok connected");
    expect(markup).toMatch(/data-grok-disconnect="true"[^>]*>.*Disconnect<\/button>/);
  });
});
