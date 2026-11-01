import { describe, expect, it } from "vitest";

import { instanceConfigs } from "./config.ts";

describe("API providers in the fleet", () => {
  it("ships Anthropic, Gemini, OpenAI Responses and Ollama Cloud instances in API-key mode", () => {
    const fleet = instanceConfigs({});
    expect(fleet.anthropicApi).toMatchObject({ driver: "anthropic", access: "api" });
    expect(fleet.geminiApi).toMatchObject({ driver: "gemini", access: "api" });
    expect(fleet.openaiResponses).toMatchObject({ driver: "openai-responses", access: "api" });
    expect(fleet.ollamaCloud).toMatchObject({ driver: "ollama", access: "api", icon: { kind: "preset", preset: "ollama" } });
  });

  it("hands each saved key only to its own provider's driver", () => {
    const fleet = instanceConfigs({ anthropic: { key: "sk-ant" }, gemini: { key: "AIza" }, ollama: { key: "oll" }, openai: { key: "sk-proj" } });
    expect(fleet.anthropicApi!.environment).toEqual({ ANTHROPIC_API_KEY: "sk-ant" });
    expect(fleet.geminiApi!.environment).toEqual({ GEMINI_API_KEY: "AIza" });
    expect(fleet.ollamaCloud!.environment).toEqual({ OLLAMA_API_KEY: "oll" });
    expect(fleet.openaiResponses!.environment).toEqual({ OPENAI_API_KEY: "sk-proj" });
    expect(JSON.stringify(fleet.groq!.environment)).not.toMatch(/sk-ant|AIza|oll/);
  });

  it("never sends the workspace key to an instance with its own endpoint", () => {
    const fleet = instanceConfigs({ anthropic: { key: "sk-ant" }, instances: { proxy: { driver: "anthropic", config: { url: "https://proxy.example/v1" } } } });
    expect(fleet.proxy!.environment).toEqual({});
  });
});
