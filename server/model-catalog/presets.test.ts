import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeApiUrl } from "../cli-api-setup.ts";
import { PROVIDER_PRESETS, providerPreset } from "./presets.ts";
import { containsBrace, trimModelsDevCatalog, unpackCatalog } from "./trim.ts";

const snapshot = JSON.parse(readFileSync(join(import.meta.dirname, "models-dev.snapshot.json"), "utf8"));
const catalog = trimModelsDevCatalog(unpackCatalog(snapshot.providers));

describe("provider presets table", () => {
  it("lists the recommended providers in the agreed order", () => {
    const recommended = PROVIDER_PRESETS.filter((preset) => preset.recommended !== undefined)
      .sort((a, b) => a.recommended! - b.recommended!);
    expect(recommended.map((preset) => preset.label)).toEqual([
      "OpenRouter", "Fireworks AI", "DeepSeek", "Cline (ClinePass)", "Cline (credits)", "Groq", "Together AI",
      "Mistral", "xAI", "Moonshot (Kimi)", "Z.ai", "MiniMax", "Cerebras",
    ]);
    expect(recommended.map((preset) => preset.recommended)).toEqual(recommended.map((_, index) => index + 1));
  });

  it("has unique ids and only safe, pinned https addresses", () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.id).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(containsBrace(preset), preset.id).toBe(false);
      expect(normalizeApiUrl(preset.api)).toBe(preset.api);
      expect(preset.api.startsWith("https://")).toBe(true);
      if (preset.anthropic) expect(normalizeApiUrl(preset.anthropic.baseUrl)).toBe(preset.anthropic.baseUrl);
      for (const link of [preset.doc, preset.anthropic?.doc]) {
        if (link) expect(new URL(link).protocol).toBe("https:");
      }
      expect(preset.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (preset.keyCheck) expect(preset.keyCheck).toMatch(/^\/[a-z/]+$/);
    }
  });

  it("points every catalog-backed preset at a provider in the bundled snapshot", () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.catalogId) expect(catalog[preset.catalogId], preset.id).toBeDefined();
      else expect(preset.env, preset.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
    expect(providerPreset("cline-credits")?.catalogId).toBeUndefined();
    expect(catalog["cline-credits"]).toBeUndefined();
  });

  it("gives Claude Code the documented Anthropic-compatible endpoints", () => {
    const endpoints = Object.fromEntries(PROVIDER_PRESETS.filter((preset) => preset.anthropic).map((preset) => [preset.id, preset.anthropic!.baseUrl]));
    expect(endpoints).toEqual({
      openrouter: "https://openrouter.ai/api",
      "fireworks-ai": "https://api.fireworks.ai/inference",
      deepseek: "https://api.deepseek.com/anthropic",
      moonshotai: "https://api.moonshot.ai/anthropic",
      zai: "https://api.z.ai/api/anthropic",
      minimax: "https://api.minimax.io/anthropic",
      opencode: "https://opencode.ai/zen",
    });
    expect(providerPreset("openrouter")?.anthropic?.auth).toBe("bearer");
    expect(providerPreset("deepseek")?.anthropic?.auth).toBeUndefined();
  });

  it("proves OpenRouter keys through /key because its model list is public", () => {
    expect(providerPreset("openrouter")).toMatchObject({ keyCheck: "/key", publicModels: true });
    expect(providerPreset("cline-credits")).toMatchObject({ publicModels: true });
    expect(providerPreset("cline-credits")?.keyCheck).toBeUndefined();
  });
});
