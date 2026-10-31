// Token counting for native turns: a real BPE count (gpt-tokenizer, pure JS) for model families whose
// encoding is known, a deliberately over-counting chars/3.5 estimate for everything else. Encodings load
// lazily on first use so boot never pays for the merge tables; until one is loaded the estimate is used.
type Count = (text: string) => number;
type EncodingName = "o200k_base" | "cl100k_base";

/** Characters per token for the fallback; below English's ~4 so it over-counts rather than under-counts. */
export const FALLBACK_CHARS_PER_TOKEN = 3.5;
/** Text longer than this is estimated, not tokenized, to bound CPU on huge payloads. */
const MAX_TOKENIZE_CHARS = 400_000;
const NO_SPECIAL = { allowedSpecial: new Set<string>(), disallowedSpecial: new Set<string>() };

const loaded = new Map<EncodingName, Count>();
const loading = new Map<EncodingName, Promise<Count | null>>();

/** The fallback estimate. A flat chars/3.5 suits prose but came out ~27% under a BPE count on JSON (audit T01): short
 * words, punctuation and digits are each a token of their own. So the text is split the way BPE pre-tokenizers split it
 * (letter runs, digit runs, punctuation runs, whitespace) and each run is costed: a word ~4.5 chars a token (non-ASCII
 * letters dearer), digits 3 a token, punctuation 2 a token, a single space free (it joins the next word). With a 15%
 * margin, and never below chars/3.5, so prose keeps its old margin. */
export function estimateTokensByChars(text: string): number {
  let tokens = 0;
  for (const [run] of text.matchAll(/\p{L}+|\p{N}+|\s+|[^\s\p{L}\p{N}]+/gu)) {
    const first = run[0]!;
    if (/\p{L}/u.test(first)) tokens += Math.max(1, run.length / 4.5) + (/[^\p{ASCII}]/u.test(run) ? run.length * 0.4 : 0);
    else if (/\p{N}/u.test(first)) tokens += Math.ceil(run.length / 3);
    else if (/\s/.test(first)) tokens += run === " " ? 0 : Math.max(1, run.length / 8);
    else tokens += Math.ceil(run.length / 2);
  }
  return Math.ceil(Math.max(text.length / FALLBACK_CHARS_PER_TOKEN, tokens * 1.15));
}

/** The BPE encoding for a model id (provider prefixes like "openai/" are ignored); null when unknown. */
export function encodingForModel(model: string | undefined): EncodingName | null {
  if (!model) return null;
  const id = model.toLowerCase().split("/").pop()!;
  if (/^(gpt-(4o|4\.1|4\.5|5|6|oss)|o[1-9](-|$)|chatgpt-4o|codex)/.test(id)) return "o200k_base";
  if (/^(gpt-4|gpt-3\.5|text-embedding)/.test(id)) return "cl100k_base";
  return null;
}

async function load(name: EncodingName): Promise<Count | null> {
  const ready = loaded.get(name);
  if (ready) return ready;
  let pending = loading.get(name);
  if (!pending) {
    pending = (name === "o200k_base" ? import("gpt-tokenizer/encoding/o200k_base") : import("gpt-tokenizer/encoding/cl100k_base"))
      .then((module) => {
        const count: Count = (text) => module.countTokens(text, NO_SPECIAL);
        loaded.set(name, count);
        return count;
      })
      .catch((error: unknown) => {
        console.warn(`tokenizer: could not load ${name}; using the character estimate (${error instanceof Error ? error.message : String(error)})`);
        return null;
      })
      .finally(() => loading.delete(name));
    loading.set(name, pending);
  }
  return pending;
}

/** Loads the model's encoding if it has one; resolves true when exact counts are available. Never throws. */
export async function prepareTokenizer(model: string | undefined): Promise<boolean> {
  const name = encodingForModel(model);
  return name ? Boolean(await load(name)) : false;
}

/** Tokens in `text` for `model`: exact when its encoding is loaded, the character estimate otherwise. */
export function countTokens(text: string, model?: string): number {
  if (!text) return 0;
  const name = encodingForModel(model);
  const count = name ? loaded.get(name) : undefined;
  if (!count || text.length > MAX_TOKENIZE_CHARS) return estimateTokensByChars(text);
  try { return count(text); } catch { return estimateTokensByChars(text); }
}
