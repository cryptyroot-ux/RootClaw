// Which models take image input, from the models.dev catalog (our cached copy, else the bundled snapshot).
import { DATA_DIR } from "../config.ts";
import { ModelCatalogStore } from "../model-catalog/catalog.ts";

/** "unknown": the catalog does not list the model, so images go and a refusal turns them off (openai-chat.ts). */
export type VisionInput = boolean | "unknown";

let store: ModelCatalogStore | undefined;

/** `provider` is a models.dev provider id, e.g. "ollama-cloud" or "openrouter". */
export function visionInput(provider: string | undefined, model: string): VisionInput {
  if (!provider) return "unknown";
  store ??= new ModelCatalogStore({ dataDir: DATA_DIR, fetchDisabled: true, openCodeCachePath: null });
  const input = store.get().providers[provider]?.models[model]?.modalities.input;
  return input ? input.includes("image") : "unknown";
}
