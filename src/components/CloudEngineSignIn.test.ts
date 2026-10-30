import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { instances: [], config: {} }, dispatch: vi.fn(), refreshInstances: vi.fn() }),
}));
vi.mock("@/components/ProviderConnect", () => ({ ProviderConnect: () => createElement("div", { "data-provider-connect-stub": true }) }));
vi.mock("@/components/Avatar", () => ({ RootClawAvatar: () => null }));
vi.mock("@/lib/cloud-intent", () => ({ useCloudIntent: () => ({ pending: null }), reopenCloudIntent: vi.fn(), setPendingIntent: vi.fn() }));
import { CloudEngineSignIn } from "./CloudEngineSignIn";

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("requestAnimationFrame", () => 0);
  setLocale("en");
});

it("connects an AI through the generic provider form, with no subscription sign-in", () => {
  const html = renderToStaticMarkup(createElement(CloudEngineSignIn));
  expect(html).toContain("data-provider-connect-stub");
  expect(html).not.toMatch(/data-cloud-choice="(claude|codex|grok)"/);
});
