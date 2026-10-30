import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineSetup, installCommandFor, needsCli, needsSignIn } from "./EngineSetup";
import { StoreProvider, type InstanceInfo } from "@/state/store";

afterEach(() => vi.unstubAllGlobals());

it("chooses the server installer even when the client has a different OS", () => {
  vi.stubGlobal("window", { ogb: { platform: "win32" } });
  expect(installCommandFor({ platform: "linux", command: { linux: "linux-install", win32: "windows-install" } })).toBe("linux-install");
  expect(installCommandFor({ platform: "linux", command: { win32: "windows-only" } })).toBeNull();
});

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("engines set up with a key in Settings", () => {
  it("opens Settings → API keys instead of offering a terminal command", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    const engine: InstanceInfo = {
      ...instance({ state: "unavailable", reason: "No API key — open Settings → API keys." }),
      instanceId: "openaiCompat",
      driverKind: "openai-compat",
      displayName: "Other (OpenAI-compatible)",
      install: { docsUrl: "https://openrouter.ai/keys", settings: "connections" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Other (OpenAI-compatible) needs an API key");
    expect(markup).toContain("Open API keys");
    expect(markup).not.toContain("Open install in Terminal");
    expect(markup).not.toContain("config.json");
  });

  it("still offers the install when a key engine's own CLI is missing, and the key once it is installed", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    const dsh = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
      ...instance(snapshot),
      instanceId: "deepseek",
      driverKind: "deepseekAgent",
      displayName: "DeepSeek Harness",
      install: {
        command: { linux: "npm install -g @deepseek-ai/dsh", darwin: "npm install -g @deepseek-ai/dsh", win32: "npm install -g @deepseek-ai/dsh" },
        docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
        needsNode: true,
        settings: "connections",
      },
    });
    const missing = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: dsh({ state: "unavailable", reason: "dsh not found" }) })));
    expect(missing).toContain("npm install -g @deepseek-ai/dsh");
    expect(missing).not.toContain("needs an API key");
    const keyless = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: dsh({ state: "available", authenticated: false, version: "0.2.1" }) })));
    expect(keyless).toContain("DeepSeek Harness needs an API key");
    expect(keyless).toContain('data-key-row="deepseek"');
    expect(keyless).not.toContain("Terminal");
    // No key is saved, so nothing was rejected.
    expect(keyless).not.toContain("rejected the saved key");
  });
});

describe("API-key engine setup", () => {
  function keyEngine(driverKind: string, snapshot: InstanceInfo["snapshot"]): InstanceInfo {
    return { ...instance(snapshot), instanceId: driverKind, driverKind, displayName: "Grok (API)", access: "api", install: { docsUrl: "https://console.x.ai" } };
  }
  const render = (engine: InstanceInfo, ogb: Record<string, unknown> = { platform: "darwin" }) => {
    vi.stubGlobal("window", { ogb });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  };

  it("takes a missing key in place, in the same key row as Settings, not in a config file", () => {
    const html = render(keyEngine("grok", { state: "unavailable", reason: "No xAI API key — open Settings → API keys." }));
    expect(html).toContain("data-engine-setup-api-key");
    expect(html).toContain("Grok (API) needs an API key");
    expect(html).toContain("Paste it here. It saves and checks itself");
    expect(html).toContain('data-key-row="xai"');
    expect(html).not.toContain("Open API keys");
    expect(html).not.toContain("config.json");
  });

  it("says so in the key row when the provider rejected the saved key", () => {
    const html = render(keyEngine("grok", { state: "available", authenticated: false, reason: "The provider rejected this key." }));
    expect(html).toContain("data-engine-setup-api-key");
    expect(html).toContain("Didn&#x27;t work: The provider rejected this key.");
    expect(render(keyEngine("grok", { state: "unavailable" }))).not.toContain("rejected");
  });

  it("still sends an engine with no key row of its own to Settings → API keys", () => {
    const html = render(keyEngine("openai-compat", { state: "unavailable" }));
    expect(html).toContain("Open API keys");
    expect(html).not.toContain("data-key-row");
  });

  it("has no button on a remote client, whose settings hide the keys", () => {
    const html = render(keyEngine("openai-compat", { state: "unavailable" }), { platform: "darwin", remoteClient: { active: true } });
    expect(html).toContain("on the computer running RootClaw");
    expect(html).not.toContain("Open API keys");
  });

  it("leaves CLI engines on their install card", () => {
    expect(render(instance({ state: "unavailable", reason: "`kimi` CLI not found" }))).not.toContain("data-engine-setup-api-key");
  });
});
