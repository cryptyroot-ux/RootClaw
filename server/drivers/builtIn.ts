import type { AnyProviderDriver } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { MistralDriver } from "./mistral.ts";
import { CerebrasDriver } from "./cerebras.ts";
import { GroqDriver } from "./groq.ts";
import { MetaDriver } from "./meta.ts";
import { GrokDriver } from "./grok.ts";
import { MinimaxDriver } from "./minimax.ts";
import { AnthropicDriver, GeminiDriver, OllamaCloudDriver, OpenAIResponsesDriver } from "./api-providers.ts";

/** RootClaw runs only in-process API engines: no external agent CLI is ever spawned. */
export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  OpenAICompatDriver,
  GrokDriver,
  MinimaxDriver,
  MistralDriver,
  CerebrasDriver,
  GroqDriver,
  MetaDriver,
  AnthropicDriver,
  GeminiDriver,
  OpenAIResponsesDriver,
  OllamaCloudDriver,
];
