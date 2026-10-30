/** The server's default instances by id, with their driver kinds. */
export const BUILT_IN_INSTANCE_DRIVERS: Readonly<Record<string, string>> = {
  openaiCompat: "openai-compat", mistral: "mistral", cerebras: "cerebras", groq: "groq", meta: "meta",
  openai: "openai-compat", xaiApi: "grok", openrouter: "openai-compat",
  anthropicApi: "anthropic", geminiApi: "gemini", openaiResponses: "openai-responses", ollamaCloud: "ollama",
};
