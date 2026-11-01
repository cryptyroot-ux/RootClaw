export function modelContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  // Opus 5.5 and Sonnet 5.5 are 1M without a `[1m]` suffix: only the exact slug, alone or after a slash or provider dot.
  if (/(?:^|[/.])claude-(?:opus|sonnet)-5(?:-5|\.5)$/.test(id)) return 1_000_000;
  if (/claude/.test(id) || /^(opus|sonnet|haiku|fable)\b/.test(id)) return /\[1m\]|-1m\b|1m-context/.test(id) ? 1_000_000 : 200_000;
  if (/^(gpt-5|o[34]\b|codex)/.test(id)) return 272_000;
  if (id.startsWith("gpt-4.1")) return 1_000_000;
  if (/gemini/.test(id)) return 1_000_000;
  if (id === "grok-4.7") return 500_000;
  if (id.startsWith("grok")) return 256_000;
  return openWeightContextWindow(id.split("/").pop()!);
}

/** Published windows of open-weight families, at the size most hosts serve (Ollama Cloud, OpenRouter, Groq, vLLM). */
function openWeightContextWindow(id: string): number | undefined {
  if (id.startsWith("deepseek")) return 128_000;
  if (/^qwen-?3[^a-z]*coder/.test(id)) return 262_144;
  if (id.startsWith("qwen")) return 131_072;
  if (id.startsWith("kimi-k2")) return 262_144;
  if (id.startsWith("glm-4.5")) return 131_072;
  if (id.startsWith("glm")) return 202_752;
  if (/^(meta-)?llama/.test(id)) return 131_072;
  if (/^gemma-?3:?-?(270m|1b)\b/.test(id)) return 32_768;
  if (id.startsWith("gemma")) return 131_072;
  if (id.startsWith("gpt-oss")) return 131_072;
  if (id.startsWith("codestral")) return 262_144;
  if (/^(mistral|ministral|devstral|magistral|pixtral)/.test(id)) return 131_072;
  return undefined;
}
