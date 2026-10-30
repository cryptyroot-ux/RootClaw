// The engine instances a fresh install starts with, and the ones an existing product fleet gains.
// instanceConfigs (config.ts) copies every entry before it changes one.
// RootClaw runs only in-process API engines (the OpenAI-compatible chat runtime and its presets).
import type { InstanceConfigMap } from "./contracts.ts";

export const OPENAI_API_INSTANCE = "openai";
export const OPENROUTER_API_INSTANCE = "openrouter";
export const XAI_API_INSTANCE = "xaiApi";
/** The native engine every new bot starts on, and the one a bot on a removed engine moves to. */
export const NATIVE_DEFAULT_INSTANCE = "openaiCompat";
export const API_KEY_FLEET: InstanceConfigMap = {
  [OPENAI_API_INSTANCE]: {
    driver: "openai-compat", displayName: "OpenAI", access: "api", icon: { kind: "preset", preset: "openai" },
    config: { url: "https://api.openai.com/v1", apiKeyEnv: "ROOTCLAW_OPENAI_API_KEY", catalog: "openai" },
  },
  [XAI_API_INSTANCE]: { driver: "grok", displayName: "xAI", access: "api", icon: { kind: "preset", preset: "xai" } },
  anthropicApi: { driver: "anthropic", displayName: "Anthropic", access: "api", icon: { kind: "preset", preset: "anthropic" } },
  geminiApi: { driver: "gemini", displayName: "Google Gemini", access: "api", icon: { kind: "preset", preset: "google" } },
  openaiResponses: { driver: "openai-responses", displayName: "OpenAI (Responses)", access: "api", icon: { kind: "preset", preset: "openai" } },
  ollamaCloud: { driver: "ollama", displayName: "Ollama Cloud", access: "api" },
  [OPENROUTER_API_INSTANCE]: {
    driver: "openai-compat", displayName: "OpenRouter", access: "api", icon: { kind: "preset", preset: "openrouter" },
    config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "ROOTCLAW_OPENROUTER_API_KEY" },
  },
};

export const DEFAULT_FLEET: InstanceConfigMap = {
  [NATIVE_DEFAULT_INSTANCE]: { driver: "openai-compat" },
  mistral: { driver: "mistral" },
  cerebras: { driver: "cerebras" },
  groq: { driver: "groq" },
  meta: { driver: "meta" },
  ...API_KEY_FLEET,
};

/** Added to a saved fleet when it lacks them. */
export const PRODUCT_FLEET_ADDITIONS = {
  [NATIVE_DEFAULT_INSTANCE]: { driver: "openai-compat" },
  mistral: { driver: "mistral" },
  cerebras: { driver: "cerebras" },
  groq: { driver: "groq" },
  meta: { driver: "meta" },
  ...API_KEY_FLEET,
} as const;

export { REMOVED_DRIVER_KINDS } from "./legacy-engines.ts";
