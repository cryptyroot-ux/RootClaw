import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider } from "@/state/store";
import { NoEngines } from "./NoEngines";

afterEach(() => vi.unstubAllGlobals());

describe("the self-hosted first run with no AI yet", () => {
  it("connects a provider, and keeps your own OpenAI-compatible server and local servers in reach, with no Cloud wording", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(NoEngines)));
    expect(markup).toContain("Connect an AI to RootClaw");
    expect(markup).toContain("data-provider-connect");
    expect(markup).toContain("data-custom-provider");
    expect(markup).toContain('data-provider-key="openaiCompat"');
    expect(markup).toContain('data-provider-key="lmStudio"');
    // "Ollama Cloud" is that provider's own name, not a RootClaw Cloud path.
    expect(markup.replaceAll("Ollama Cloud", "")).not.toMatch(/\bCloud\b/);
  });
});
