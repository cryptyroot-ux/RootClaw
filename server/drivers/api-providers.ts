// API-key providers on the native loop, each through its own wire adapter:
//   anthropic         Anthropic Messages API        https://api.anthropic.com/v1        ANTHROPIC_API_KEY
//   gemini            Gemini API (generateContent)  https://generativelanguage.googleapis.com/v1beta  GEMINI_API_KEY (or Google OAuth)
//   openai-responses  OpenAI Responses API          https://api.openai.com/v1           OPENAI_API_KEY
//   ollama            Ollama Cloud, through its OpenAI-compatible endpoint https://ollama.com/v1 (Bearer OLLAMA_API_KEY);
//                     the native /api/chat endpoint is not used, so Chat Completions tools and streaming apply.
// Custom OpenAI-compatible installs stay on the openai-compat driver (one instance per base URL + key).
import { z } from "zod";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createAnthropicAdapter, ANTHROPIC_VERSION } from "./adapters/anthropic.ts";
import { createGeminiAdapter } from "./adapters/gemini.ts";
import { createOpenAIResponsesAdapter } from "./adapters/openai-responses.ts";
import type { ModelAdapter } from "./model-adapter.ts";
import { googleAccessToken } from "../oauth/oauth.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const configSchema = z.object({
  url: z.string().trim().url().optional(),
  model: z.string().trim().min(1).optional(),
  key: z.string().trim().optional(),
  apiKeyEnv: z.string().trim().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  tools: z.boolean().optional(),
});
export type ApiProviderConfig = z.output<typeof configSchema> & { url: string };

interface Spec {
  driverKind: string;
  displayName: string;
  label: string;
  defaultUrl: string;
  keyEnv: string;
  docsUrl: string;
  models: ModelCatalog;
  adapter?: (url: string, key: string, environment: Record<string, string>) => ModelAdapter;
  /** GET the provider's catalog: [id, label] pairs, chat models only. */
  catalog: (url: string, key: string) => Promise<Array<{ id: string; label: string }>>;
  /** A sign-in token (OAuth) that stands in for the key; the key still wins when both are set. */
  token?: (environment: Record<string, string>) => string;
}

const json = async (url: string, headers: Record<string, string>) => {
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
};
const rows = (value: unknown) => (Array.isArray(value) ? value : []) as Array<Record<string, unknown>>;
const bearerCatalog = async (url: string, key: string) => rows((await json(`${url}/models`, { authorization: `Bearer ${key}` })).data)
  .filter((row) => typeof row.id === "string").map((row) => ({ id: String(row.id), label: typeof row.name === "string" ? row.name : String(row.id) }));

function decode(defaultUrl: string, label: string) {
  return (raw: unknown): ApiProviderConfig => {
    const config = configSchema.parse(raw ?? {});
    const url = (config.url ?? defaultUrl).replace(/\/+$/, "");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
      throw new Error(`${label} requires HTTPS, except for a local test endpoint.`);
    }
    return { ...config, url };
  };
}

function apiProvider(spec: Spec): ProviderDriver<ApiProviderConfig> {
  const decodeConfig = decode(spec.defaultUrl, spec.label);
  return {
    driverKind: spec.driverKind,
    metadata: { displayName: spec.displayName, supportsMultipleInstances: true, access: "api" },
    models: spec.models,
    install: { docsUrl: spec.docsUrl, settings: "connections", signInCommand: `Save a ${spec.label} API key in Settings → API keys, or set ${spec.keyEnv} on the server.` },
    decodeConfig,
    defaultConfig: () => decodeConfig({}),
    async create(input) {
      const { config } = input;
      const env = input.environment;
      // The server's own variable goes only to the provider's own host.
      const apiKey = (config.key || env[config.apiKeyEnv ?? spec.keyEnv] || (config.url === spec.defaultUrl ? process.env[config.apiKeyEnv ?? spec.keyEnv] : "") || "").trim()
        || (spec.token?.(env) ?? "");
      const withConfigured = (options: ModelCatalog["options"]): ModelCatalog => {
        const list = config.model && !options.some((o) => o.id === config.model) ? [{ id: config.model, label: config.model }, ...options] : options;
        const preferred = config.model ?? spec.models.default;
        return { default: list.some((o) => o.id === preferred) ? preferred : list[0]!.id, options: list };
      };
      let catalog = withConfigured(spec.models.options);
      const known = new Map(spec.models.options.map((o) => [o.id, o]));
      const refreshModels = async () => {
        if (!apiKey) return;
        try {
          const listed = await spec.catalog(config.url, apiKey);
          if (listed.length) catalog = withConfigured(listed.map((row) => known.get(row.id) ?? row));
        } catch { /* keep the built-in list */ }
      };
      if (apiKey) void refreshModels();
      return createOpenAIChatRuntime({
        input, driverKind: spec.driverKind, apiKey, apiUrl: config.url, tools: config.tools,
        ...(spec.adapter ? { adapter: spec.adapter(config.url, apiKey, env) } : {}),
        models: () => catalog, refreshModels, reasoning: true, computerUse: true,
        requestBody: (model, messages, stream) => ({ model, messages, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }),
        httpErrorLabel: spec.label,
        missingKeyError: `Save a ${spec.label} API key in Settings → API keys, or set ${spec.keyEnv}.`,
        unavailableReason: `No ${spec.label} API key — open Settings → API keys.`,
        timeoutMs: 180_000, billing: "metered", includeUsageInCompleted: true,
        nativeLog: {
          source: `${spec.driverKind}.${spec.adapter ? "adapter" : "chat.completions"}`,
          outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
          incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
        },
      });
    },
  };
}

export const AnthropicDriver = apiProvider({
  driverKind: "anthropic", displayName: "Anthropic (API)", label: "Anthropic", keyEnv: "ANTHROPIC_API_KEY",
  defaultUrl: "https://api.anthropic.com/v1", docsUrl: "https://docs.anthropic.com/en/api/messages",
  models: { default: "claude-sonnet-5", options: [
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" }, { id: "claude-opus-5", label: "Claude Opus 5" }, { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  ] },
  adapter: (url, key) => createAnthropicAdapter({ url, apiKey: key }),
  catalog: async (url, key) => rows((await json(`${url}/models?limit=100`, { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION })).data)
    .map((row) => ({ id: String(row.id), label: typeof row.display_name === "string" ? row.display_name : String(row.id) })),
});

export const GeminiDriver = apiProvider({
  driverKind: "gemini", displayName: "Google Gemini (API)", label: "Gemini", keyEnv: "GEMINI_API_KEY",
  defaultUrl: "https://generativelanguage.googleapis.com/v1beta", docsUrl: "https://ai.google.dev/gemini-api/docs",
  models: { default: "gemini-3.8-flash", options: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }, { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" }, { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ] },
  // Google sign-in (OAuth, the person's own client) stands in when no API key is saved; the key always works too.
  token: (env) => env.GOOGLE_OAUTH_REFRESH_TOKEN ?? "",
  adapter: (url, key, env) => env.GOOGLE_OAUTH_REFRESH_TOKEN && key === env.GOOGLE_OAUTH_REFRESH_TOKEN && env.GOOGLE_OAUTH_CLIENT_ID
    ? createGeminiAdapter({ url, projectId: env.GOOGLE_CLOUD_PROJECT,
      accessToken: googleAccessToken({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, ...(env.GOOGLE_OAUTH_CLIENT_SECRET ? { clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET } : {}) }, key) })
    : createGeminiAdapter({ url, apiKey: key }),
  catalog: async (url, key) => rows((await json(`${url}/models?pageSize=200`, { "x-goog-api-key": key })).models)
    .filter((row) => rows(row.supportedGenerationMethods).length === 0 || (row.supportedGenerationMethods as string[]).includes("generateContent"))
    .map((row) => ({ id: String(row.name).replace(/^models\//, ""), label: typeof row.displayName === "string" ? row.displayName : String(row.name) })),
});

export const OpenAIResponsesDriver = apiProvider({
  driverKind: "openai-responses", displayName: "OpenAI Responses (API)", label: "OpenAI", keyEnv: "OPENAI_API_KEY",
  defaultUrl: "https://api.openai.com/v1", docsUrl: "https://platform.openai.com/docs/api-reference/responses",
  models: { default: "gpt-5.5", options: [{ id: "gpt-5.5", label: "GPT-5.5" }, { id: "gpt-5.4-mini", label: "GPT-5.4 mini" }] },
  adapter: (url, key) => createOpenAIResponsesAdapter({ url, apiKey: key }),
  catalog: bearerCatalog,
});

export const OllamaCloudDriver = apiProvider({
  driverKind: "ollama", displayName: "Ollama Cloud (API)", label: "Ollama", keyEnv: "OLLAMA_API_KEY",
  defaultUrl: "https://ollama.com/v1", docsUrl: "https://docs.ollama.com/cloud",
  models: { default: "gpt-oss:120b", options: [{ id: "gpt-oss:120b", label: "gpt-oss 120B" }, { id: "gpt-oss:20b", label: "gpt-oss 20B" }] },
  catalog: bearerCatalog,
});
