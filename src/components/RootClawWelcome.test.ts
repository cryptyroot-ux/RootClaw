import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/i18n";
import { StoreProvider, type Bot } from "@/state/store";
import { draftOf, RootClawWelcomeCard, rootClawWelcomeDue, welcomeName, welcomePatch } from "./RootClawWelcome";

const rootclaw = { id: "rootclaw", threadId: "t1", name: "RootClaw", title: "", description: "", notifications: true, color: "chrome", mascotBody: null,
  avatarUrl: null, unread: false, modelSelection: { instanceId: "claude", model: "sonnet" }, createdAt: 1, defaultBot: {} } as unknown as Bot;

describe("RootClaw's first-launch welcome", () => {
  it("shows once, after onboarding and its tour, and never again after either choice", () => {
    const due = (bot: Pick<Bot, "welcomed" | "hidden"> | undefined, more: Partial<Parameters<typeof rootClawWelcomeDue>[0]> = {}) =>
      rootClawWelcomeDue({ bot, onboardingDue: false, welcomeOpen: false, tourOpen: false, ...more });
    expect(due({})).toBe(true);
    expect(due({ welcomed: true })).toBe(false);
    expect(due({}, { onboardingDue: true })).toBe(false);
    expect(due({}, { welcomeOpen: true })).toBe(false);
    expect(due({}, { tourOpen: true })).toBe(false);
    expect(due(undefined)).toBe(false);
    expect(due({ hidden: true })).toBe(false);
  });

  it("Add saves the person's changes, pins RootClaw and keeps it in the sidebar", () => {
    expect(welcomePatch(rootclaw, { ...draftOf(rootclaw), name: " Jarvis ", color: "blue", mascotBody: "blob" }, true))
      .toEqual({ name: "Jarvis", color: "blue", mascotBody: "blob", welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("Add with the panel never opened keeps the chrome-steel defaults", () => {
    expect(welcomePatch(rootclaw, draftOf(rootclaw), true)).toEqual({ welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("Not now turns Show RootClaw in the sidebar off, keeping what was changed, and nothing unchanged is sent", () => {
    expect(welcomePatch(rootclaw, draftOf(rootclaw), false)).toEqual({ welcomed: true, sidebarHidden: true });
    expect(welcomePatch(rootclaw, { ...draftOf(rootclaw), mascotBody: "star" }, false)).toEqual({ mascotBody: "star", welcomed: true, sidebarHidden: true });
  });

  it("saves an empty name as RootClaw and caps a long one at the bot-name limit", () => {
    const jarvis = { ...rootclaw, name: "Jarvis" };
    expect(welcomePatch(jarvis, { ...draftOf(jarvis), name: "   " }, true).name).toBe("RootClaw");
    expect(welcomeName("x".repeat(300))).toHaveLength(100);
    expect(welcomeName("  Ada ")).toBe("Ada");
  });

  it("saves an uploaded picture as the bot's own edit screen would, and a colour picked after it goes back to the shape", () => {
    const uploaded = { ...draftOf(rootclaw), avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle" as const };
    expect(welcomePatch(rootclaw, uploaded, true)).toEqual({ avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle", welcomed: true, sidebarHidden: false, pinned: true });
    expect(welcomePatch(rootclaw, { ...uploaded, color: "blue", avatarCrop: "mascot" }, true))
      .toEqual({ avatarUrl: "/api/attachments/abc.png", color: "blue", welcomed: true, sidebarHidden: false, pinned: true });
    const pictured = { ...rootclaw, avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle" } as Bot;
    expect(welcomePatch(pictured, { ...draftOf(pictured), avatarUrl: null, avatarCrop: "mascot" }, true))
      .toEqual({ avatarUrl: null, avatarCrop: "mascot", welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("opens on RootClaw's picture alone: the customise panel stays closed until the picture is clicked", () => {
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(RootClawWelcomeCard, { bot: rootclaw, onClose: () => {} })));
    expect(html).toContain(`aria-label="${t("rootclawWelcome.customize", { name: "RootClaw" })}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-rootclaw-welcome-panel="closed"');
    expect(html).toMatch(/data-rootclaw-welcome-panel="closed"[^>]*|inert=""[^>]*data-rootclaw-welcome-panel="closed"/);
    expect(html).toContain(t("rootclawWelcome.title", { name: "RootClaw" }));
    expect(html).toContain(t("rootclawWelcome.add", { name: "RootClaw" }));
  });
});
