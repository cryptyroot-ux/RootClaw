// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const f = vi.hoisted(() => ({
  instances: [] as InstanceInfo[], dispatch: vi.fn(),
  check: (): Promise<object> => Promise.resolve({ ok: true }), checks: [] as string[], fail: false,
}));
vi.mock("@/state/store", () => ({
  api: async (path: string) => {
    if (f.fail) { f.fail = false; throw new Error("503"); }
    if (!path.endsWith("/check")) return { instances: f.instances };
    f.checks.push(path);
    return f.check();
  },
  useStore: () => ({ state: { instances: f.instances }, dispatch: f.dispatch }),
}));
vi.mock("@/components/NoEngines", async () => {
  const { createElement: h } = await import("react");
  return { SelfHostedConnect: () => h("div", { "data-self-hosted-connect": "" }) };
});
vi.mock("@/components/EngineSetup", async () => {
  const { createElement: h } = await import("react");
  return { EngineSetup: ({ instance, intent, description }: { instance: InstanceInfo; intent: string; description?: string }) =>
    h("div", { "data-engine-setup": instance.instanceId, "data-intent": intent, "data-description": description }) };
});
const { ConnectAi, ConnectAiDialog } = await import("./ConnectAi");
const { useWelcomeAi } = await import("./welcome-ai");
const { useStore } = await import("@/state/store");

/** As the first screen has it: the AI it stands on, tested once, handed to the block. */
function FirstScreenAi({ hosted = false }: { hosted?: boolean }) {
  const { state } = useStore();
  return createElement(ConnectAi, { hosted, tested: useWelcomeAi(state.instances, !hosted) });
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const engine = (instanceId: string, driverKind: string, displayName: string, ready: boolean): InstanceInfo => ({
  instanceId, driverKind, displayName, install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] },
});
let host: HTMLDivElement, root: Root;
const text = () => host.textContent ?? "";
const show = async (extra: { hosted?: boolean } = {}) => {
  await act(async () => { root.render(createElement(FirstScreenAi, extra)); });
};
/** Every other way is listed under the recommended one, with nothing to unfold. */
const otherWays = async () => {
  await act(async () => {});
};

beforeEach(() => {
  setLocale("en");
  f.check = () => Promise.resolve({ ok: true });
  f.checks = [];
  f.instances = [engine("xaiApi", "grok", "xAI", false), engine("anthropicApi", "anthropic", "Anthropic (API)", false), engine("openaiResponses", "openai-responses", "OpenAI Responses (API)", false)];
  f.dispatch.mockReset();
  f.fail = false;
  vi.stubGlobal("ogb", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("connecting an AI on the first screen", () => {
  it("says when it could not check the AIs, keeps what it already lists, and checks again", async () => {
    // Was a step of scripts/verify-onboarding-ui.ts, whose fixture no longer reaches this step (its AI already works).
    await show();
    await otherWays();
    const listed = () => [...host.querySelectorAll("[aria-expanded]")].map((node) => node.textContent);
    const before = listed();
    const checkAgain = async () => {
      const button = [...host.querySelectorAll("button")].find((node) => node.textContent === "Check again")!;
      await act(async () => { button.click(); });
    };
    f.fail = true;
    await checkAgain();
    expect(text()).toContain("Couldn't check your AI connections");
    expect(listed()).toEqual(before);
    await checkAgain();
    expect(text()).not.toContain("Couldn't check your AI connections");
  });

  it("leads with one recommended way, then lists every other way, with no status list and no engine talk", async () => {
    await show();
    expect([...host.querySelectorAll("[data-engine-setup]")].map((node) => node.getAttribute("data-engine-setup"))).toEqual(["xaiApi"]);
    expect(host.querySelector("[data-ai-recommended]")?.getAttribute("data-ai-recommended")).toBe("xaiApi");
    const rows = [...host.querySelectorAll("button[aria-expanded]")].map((node) => node.textContent);
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row?.includes("Anthropic"))).toBe(true);
    expect(text()).not.toContain("Other ways");
    for (const word of [/\bengines?\b/i, /\bReady\b/, /Needs setup/i, /to set up/i, /provider/i]) expect(text()).not.toMatch(word);
  });

  it("says one plain line on a provider sign-in, and leaves API-key and local-model setup to their own instructions", async () => {
    const signsIn = (instance: InstanceInfo, method?: "paste-code" | "device-code"): InstanceInfo =>
      ({ ...instance, snapshot: { state: "available", authenticated: false }, ...(method ? { authentication: { method } } : {}) });
    f.instances = [
      signsIn(engine("geminiApi", "gemini", "Google Gemini", false), "device-code"),
      engine("anthropicApi", "anthropic", "Anthropic API", false),
      engine("openaiResponses", "openai-responses", "OpenAI Responses API", false),
      { ...engine("local", "openai-compat", "Local models", false), access: "custom" },
    ];
    const setup = (id: string) => host.querySelector(`[data-engine-setup="${id}"]`);
    const plain = (name: string) => `Use the ${name} account you already have. You sign in on their own website, so your password stays with them.`;
    await show();
    expect(setup("geminiApi")?.getAttribute("data-description")).toBe(plain("Google Gemini"));
    await otherWays();
    const openRow = async (name: string) => {
      const row = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) => button.textContent?.includes(name))!;
      await act(async () => { row.click(); });
    };
    for (const [id, name] of [["anthropicApi", "Anthropic API"], ["openaiResponses", "OpenAI Responses API"]]) {
      await openRow(name);
      expect(setup(id)?.hasAttribute("data-description"), `${name} uses API-key setup`).toBe(false);
    }
    await openRow("Local models");
    expect(setup("local")?.getAttribute("data-intent")).toBe("inject");
    expect(setup("local")?.hasAttribute("data-description")).toBe(false);
  });

  it("says which AI is connected once one is, and recommends nothing more", async () => {
    f.instances = [engine("anthropicApi", "anthropic", "Anthropic", true), engine("openaiResponses", "openai-responses", "OpenAI Responses", false)];
    await show();
    expect(host.querySelector("[data-ai-connected]")?.textContent).toContain("Anthropic");
    expect(host.querySelector("[data-ai-recommended]")).toBeNull();
    expect(text()).not.toContain("Other ways");
  });

  it("says Connected only after the AI answered a test message, and plainly while it checks", async () => {
    let answer!: (value: object) => void;
    f.check = () => new Promise((resolve) => { answer = resolve; });
    f.instances = [engine("anthropicApi", "anthropic", "Anthropic", true), engine("xaiApi", "grok", "xAI", true)];
    await show();
    expect(f.checks).toEqual(["/api/instances/anthropicApi/check"]);
    expect(host.querySelector("[data-ai-connected]")).toBeNull();
    expect(host.querySelector("[data-ai-checking]")?.textContent).toBe("Checking that Anthropic answers…");
    await act(async () => { answer({ ok: true }); });
    expect(host.querySelector("[data-ai-connected]")?.textContent).toBe("Connected · Anthropic");
    expect(host.querySelector("[data-ai-checking]")).toBeNull();
  });

  it("says a signed-in AI didn't answer, tries the next one, and keeps every other way open", async () => {
    f.check = () => Promise.resolve({ ok: false, error: "Anthropic didn't answer within 90 seconds." });
    f.instances = [engine("anthropicApi", "anthropic", "Anthropic", true), engine("openaiResponses", "openai-responses", "OpenAI Responses", false), engine("customCompat", "openai-compat", "Custom API endpoint", false)];
    await show();
    expect(host.querySelector("[data-ai-silent] [data-ai-reason]")?.textContent).toBe("Anthropic didn't answer within 90 seconds.");
    expect(host.querySelector("[data-ai-silent]")?.textContent).toContain("Or connect another AI below.");
    expect(host.querySelector("[data-ai-connected]")).toBeNull();
    expect(host.querySelector("[data-ai-recommended]")?.getAttribute("data-ai-recommended")).toBe("openaiResponses");
    await otherWays();
    expect(text()).toContain("Custom API endpoint");
    // The next ready AI gets its own test.
    f.instances = [...f.instances, engine("xaiApi", "grok", "xAI", true)];
    f.check = () => Promise.resolve({ ok: true });
    await show();
    expect(f.checks).toEqual(["/api/instances/anthropicApi/check", "/api/instances/xaiApi/check"]);
    expect(host.querySelector("[data-ai-connected]")?.textContent).toBe("Connected · xAI");
  });

  it("says the plain reason a check gave, and Check again sends a new test message", async () => {
    f.check = () => Promise.resolve({ ok: false, error: "Anthropic isn't signed in on this computer anymore. Sign in again, then check again." });
    f.instances = [engine("anthropicApi", "anthropic", "Anthropic", true), engine("openaiResponses", "openai-responses", "OpenAI Responses", false)];
    await show();
    expect(host.querySelector("[data-ai-reason]")?.textContent).toBe("Anthropic isn't signed in on this computer anymore. Sign in again, then check again.");
    expect(text()).not.toContain("is signed in but didn't answer");
    let answer!: (value: object) => void;
    f.check = () => new Promise((resolve) => { answer = resolve; });
    const again = [...host.querySelectorAll<HTMLButtonElement>("[data-ai-silent] button")].find((button) => button.textContent === "Check again")!;
    await act(async () => { again.click(); });
    expect(f.checks).toEqual(["/api/instances/anthropicApi/check", "/api/instances/anthropicApi/check"]);
    expect(host.querySelector("[data-ai-checking]")?.textContent).toBe("Checking that Anthropic answers…");
    await act(async () => { answer({ ok: true }); });
    expect(host.querySelector("[data-ai-connected]")?.textContent).toBe("Connected · Anthropic");
  });

  it("shows what the server's own test found, without sending another", async () => {
    f.instances = [{ ...engine("anthropicApi", "anthropic", "Anthropic", true), aiTest: "failed", aiTestError: "Your Anthropic provider usage limit has been reached." },
      engine("openaiResponses", "openai-responses", "OpenAI Responses", false)];
    await show();
    expect(f.checks).toEqual([]);
    expect(host.querySelector("[data-ai-reason]")?.textContent).toBe("Your Anthropic provider usage limit has been reached.");
    // With no reason given, the plain line.
    f.instances = [{ ...engine("anthropicApi", "anthropic", "Anthropic", true), aiTest: "failed" }];
    await show();
    expect(host.querySelector("[data-ai-reason]")?.textContent).toBe("Anthropic is signed in but didn't answer. Try another way.");
  });

  it("asks for the person's own AI when only a free provider model works, and says the free model is a backup", async () => {
    const backup: InstanceInfo = { ...engine("freeApi", "openai-compat", "OpenRouter", true), snapshot: { state: "available", authenticated: true, freeFallback: true } };
    f.instances = [backup, engine("anthropicApi", "anthropic", "Anthropic", false)];
    await show();
    expect(f.checks).toEqual([]);
    expect(host.querySelector("[data-ai-connected]")).toBeNull();
    expect(host.querySelector("[data-ai-backup]")?.textContent).toBe("OpenRouter's free model is ready as a backup. For the best answers, connect an AI you already use.");
    expect(host.querySelector("[data-ai-recommended]")?.getAttribute("data-ai-recommended")).toBe("anthropicApi");
  });

  it("opens as the Connect an AI dialog, which Escape and a click outside close", async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(createElement(ConnectAiDialog, { hosted: true, tested: null, onClose })); });
    const dialog = host.querySelector<HTMLElement>("[data-connect-ai]")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.querySelector("h2")?.textContent).toBe("Connect an AI");
    expect(dialog.querySelector("[data-ai-recommended]")).not.toBeNull();
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { dialog.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => { dialog.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose, "a click inside stays").toHaveBeenCalledTimes(2);
  });

  it("on a self-hosted RootClaw, offers the provider sign-ins, keys and your own server instead of the engine list", async () => {
    f.instances = [engine("anthropicApi", "anthropic", "Anthropic", false)];
    await act(async () => { root.render(createElement(ConnectAiDialog, { tested: null, onClose: vi.fn() })); });
    const dialog = host.querySelector<HTMLElement>("[data-connect-ai]")!;
    expect(dialog.querySelector("[data-self-hosted-connect]")).not.toBeNull();
    expect(dialog.querySelector("[data-ai-recommended]")).toBeNull();
  });
});
