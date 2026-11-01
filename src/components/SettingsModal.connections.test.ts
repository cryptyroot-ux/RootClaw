import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ config: undefined as import("@/state/store").ConfigStatus | undefined }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(),
  useStore: () => ({ state: { appSettingsSection: "connections", instances: [], config: fixture.config }, dispatch: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));

beforeEach(() => {
  fixture.config = undefined;
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  setLocale("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

describe("Settings → Connections", () => {
  it.each(["router", "OpenRouter", "base URL", "API key", "OpenAI", "Anthropic", "Groq"])("is found by searching for %s", async (typed) => {
    const { SECTIONS, sectionMatches } = await import("./SettingsModal");
    const connections = SECTIONS.find((entry) => entry.id === "connections")!;
    // The modal lowercases and trims what was typed before matching.
    expect(sectionMatches(connections, typed.trim().toLowerCase())).toBe(true);
  });

  it("lists native provider keys, not a removed engine's login command", async () => {
    const { SettingsModal } = await import("./SettingsModal");
    const html = renderToStaticMarkup(createElement(SettingsModal));
    expect(html).toContain("OpenAI API key");
    expect(html).toContain("Anthropic API key");
    expect(html).toContain('data-api-key-row="openai"');
    expect(html).toContain('data-api-key-row="anthropic"');
    expect(html).not.toContain("opencode auth login");
    expect(html).not.toContain('data-api-key-row="opencodeGo"');
  });

  it("keeps those keys on a Cloud, with no terminal login", async () => {
    const { configStatusFromFrame } = await import("@/state/store");
    fixture.config = configStatusFromFrame({
      composio: { configured: false },
      box: { configured: false },
      vps: { configured: false, sshAlias: "" },
      rooms: { turnTimeoutMinutes: 10 },
      mcp: { callTimeoutMinutes: 10 },
      localVm: { mode: "shared", maxInstances: 1 },
      cloudHome: true,
    });
    const { SettingsModal } = await import("./SettingsModal");
    const html = renderToStaticMarkup(createElement(SettingsModal));
    expect(html).toContain("OpenAI API key");
    expect(html).toContain('data-api-key-row="xai"');
    expect(html).not.toContain("opencode auth login");
  });
});
