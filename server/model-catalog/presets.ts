// Pinned base URLs: a catalog refresh can never change where a newly pasted key for a recommended provider is sent.

export type AnthropicAuth = "bearer" | "x-api-key";

export interface AnthropicEndpoint {
  /** Claude Code's ANTHROPIC_BASE_URL; Claude Code adds /v1/messages. */
  baseUrl: string;
  /** A fixed auth style. Absent: the check decides, preferring Bearer. */
  auth?: AnthropicAuth;
  doc?: string;
}

export interface ProviderPreset {
  id: string;
  catalogId?: string;
  label: string;
  recommended?: number;
  /** OpenAI-compatible base URL. Wins over models.dev's `api`. */
  api: string;
  /** For when models.dev's `npm` is for a different endpoint (MiniMax: its Anthropic one). */
  npm?: string;
  env?: string;
  doc?: string;
  anthropic?: AnthropicEndpoint;
  /** Path added to `api` for a GET that proves the key (a 2xx means it works). */
  keyCheck?: string;
  /** GET {api}/models answers without a key, so it proves nothing about one. */
  publicModels?: true;
  chat?: "after-check";
  /** Last checked by hand (YYYY-MM-DD). */
  checkedAt: string;
}

const CHECKED = "2026-09-30";

export const OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openrouter",
    catalogId: "openrouter",
    label: "OpenRouter",
    recommended: 1,
    api: "https://openrouter.ai/api/v1",
    anthropic: {
      baseUrl: "https://openrouter.ai/api",
      auth: "bearer",
      doc: "https://openrouter.ai/docs/guides/guides/claude-code-integration",
    },
    // /models is public; /key answers only with a valid key.
    keyCheck: "/key",
    publicModels: true,
    checkedAt: CHECKED,
  },
  {
    id: "fireworks-ai",
    catalogId: "fireworks-ai",
    label: "Fireworks AI",
    recommended: 2,
    api: "https://api.fireworks.ai/inference/v1",
    anthropic: {
      baseUrl: "https://api.fireworks.ai/inference",
      auth: "bearer",
      doc: "https://docs.fireworks.ai/tools-sdks/anthropic-compatibility",
    },
    checkedAt: CHECKED,
  },
  {
    id: "deepseek",
    catalogId: "deepseek",
    label: "DeepSeek",
    recommended: 3,
    api: "https://api.deepseek.com",
    anthropic: { baseUrl: "https://api.deepseek.com/anthropic", doc: "https://api-docs.deepseek.com/guides/anthropic_api" },
    checkedAt: CHECKED,
  },
  {
    id: "cline-pass",
    catalogId: "cline-pass",
    label: "Cline (ClinePass)",
    recommended: 4,
    api: "https://api.cline.bot/api/v1",
    publicModels: true,
    checkedAt: CHECKED,
  },
  {
    // Cline's pay-as-you-go credits: the ClinePass API with a larger model list. Not in models.dev.
    id: "cline-credits",
    label: "Cline (credits)",
    recommended: 5,
    api: "https://api.cline.bot/api/v1",
    env: "CLINE_API_KEY",
    doc: "https://docs.cline.bot/api/overview",
    publicModels: true,
    checkedAt: CHECKED,
  },
  { id: "groq", catalogId: "groq", label: "Groq", recommended: 6, api: "https://api.groq.com/openai/v1", checkedAt: CHECKED },
  { id: "togetherai", catalogId: "togetherai", label: "Together AI", recommended: 7, api: "https://api.together.xyz/v1", checkedAt: CHECKED },
  { id: "mistral", catalogId: "mistral", label: "Mistral", recommended: 8, api: "https://api.mistral.ai/v1", checkedAt: CHECKED },
  { id: "xai", catalogId: "xai", label: "xAI", recommended: 9, api: "https://api.x.ai/v1", checkedAt: CHECKED },
  {
    id: "moonshotai",
    catalogId: "moonshotai",
    label: "Moonshot (Kimi)",
    recommended: 10,
    api: "https://api.moonshot.ai/v1",
    anthropic: { baseUrl: "https://api.moonshot.ai/anthropic" },
    checkedAt: CHECKED,
  },
  {
    id: "zai",
    catalogId: "zai",
    label: "Z.ai",
    recommended: 11,
    api: "https://api.z.ai/api/paas/v4",
    anthropic: { baseUrl: "https://api.z.ai/api/anthropic" },
    checkedAt: CHECKED,
  },
  {
    // models.dev lists MiniMax's Anthropic endpoint (with @ai-sdk/anthropic); the chat engine and OpenCode need the OpenAI one.
    id: "minimax",
    catalogId: "minimax",
    label: "MiniMax",
    recommended: 12,
    api: "https://api.minimax.io/v1",
    npm: OPENAI_COMPATIBLE_NPM,
    anthropic: { baseUrl: "https://api.minimax.io/anthropic" },
    chat: "after-check",
    checkedAt: CHECKED,
  },
  { id: "cerebras", catalogId: "cerebras", label: "Cerebras", recommended: 13, api: "https://api.cerebras.ai/v1", checkedAt: CHECKED },
  {
    id: "openai",
    catalogId: "openai",
    label: "OpenAI",
    api: "https://api.openai.com/v1",
    checkedAt: CHECKED,
  },
  {
    id: "opencode",
    catalogId: "opencode",
    label: "OpenCode Zen",
    api: "https://opencode.ai/zen/v1",
    anthropic: { baseUrl: "https://opencode.ai/zen" },
    checkedAt: CHECKED,
  },
  {
    id: "wallaby",
    catalogId: "wallaby",
    label: "Wallaby",
    api: "https://api.wallabytoken.com/v1",
    keyCheck: "/models",
    checkedAt: "2026-10-05",
  },
];

const BY_ID = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export function providerPreset(id: string): ProviderPreset | undefined {
  return BY_ID.get(id);
}
