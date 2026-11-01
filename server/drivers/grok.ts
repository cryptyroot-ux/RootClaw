// xAI API driver over the OpenAI chat-completions contract, with the shared retry policy.
import type { ProviderDriver } from "../contracts.ts";
import { ensureGrokSubscriptionFresh, grokStoreFile, grokSubscriptionToken, renewGrokSignIn } from "../grok-subscription.ts";
import { keyRejected, noteKeyRejected } from "../key-rejections.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DRIVER_KIND = "grok";
const DEFAULT_URL = "https://api.x.ai/v1";
const MODELS = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-4-fast", label: "Grok 4 Fast" },
    { id: "grok-3-mini", label: "Grok 3 Mini" },
  ],
};

export interface GrokConfig {
  tools?: boolean;
  url: string;
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): GrokConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  return {
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
    url: typeof config.url === "string" ? config.url : DEFAULT_URL,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "XAI_API_KEY",
  };
}

export const GrokDriver: ProviderDriver<GrokConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Grok (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    // The server's own XAI_API_KEY goes only to xAI itself; a custom URL gets the workspace key or a variable it names.
    const serverKey = config.url === DEFAULT_URL || config.apiKeyEnv !== "XAI_API_KEY" ? process.env[config.apiKeyEnv] : undefined;
    const apiKey = input.environment[config.apiKeyEnv] ?? serverKey ?? "";
    // A SuperGrok sign-in goes only to xAI itself, ahead of the key; a refused request is resent once with the key.
    // A 401 renews the sign-in once (only invalid_grant asks to reconnect); a 403 refuses one model, so the sign-in stays in use.
    const subscription = config.url === DEFAULT_URL;
    if (subscription) await ensureGrokSubscriptionFresh();
    // Set by a 403 and read by that request's resend, which runs before anything else reads the key.
    let keyOnce = false;
    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      get apiKey() {
        if (keyOnce) {
          keyOnce = false;
          return apiKey;
        }
        const token = subscription ? grokSubscriptionToken() : "";
        return token && !keyRejected(config.url, token) ? token : apiKey;
      },
      onRefusedKey(key, status) {
        if (!subscription || key === apiKey) return false;
        if (status === 401) {
          noteKeyRejected(config.url, key);
          void renewGrokSignIn(grokStoreFile(), fetch, key).catch(() => {});
        } else keyOnce = Boolean(apiKey);
        return Boolean(apiKey);
      },
      apiUrl: config.url,
      tools: config.tools,
      models: () => MODELS,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "xAI",
      missingKeyError: subscription
        ? `Connect SuperGrok in Settings, save an xAI API key in Settings → API keys, or set ${config.apiKeyEnv}.`
        : `Save an xAI API key in Settings → API keys, or set ${config.apiKeyEnv}.`,
      unavailableReason: subscription ? "No SuperGrok sign-in or xAI API key — open Settings." : "No xAI API key — open Settings → API keys.",
      timeoutMs: 120_000,
      retryScale: Number(process.env.FAKE_GROK_RETRY_SCALE ?? "1"),
      generateModel: () => "grok-3-mini",
      nativeLog: {
        source: "xai.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, usage }) => ({ text, usage }),
      },
    });
  },
};
