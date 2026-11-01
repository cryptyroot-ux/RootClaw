# OpenCode (removed)

The OpenCode engine (`opencodeGo`, which ran the OpenCode CLI over ACP) is no
longer part of RootClaw. RootClaw runs every bot on its built-in native engine
and does not launch external agent CLIs, so nothing starts the OpenCode CLI and
Settings no longer offers OpenCode keys. The `opencodeGo` id survives only as
migration data: a saved `opencodeGo` instance is dropped when the config loads,
and bots that used it move to an engine that is ready, or to the native
OpenAI-compatible engine (`openaiCompat`) until it has a key.

To keep using a model you reached through OpenCode, give RootClaw that
provider's API key directly:

- A built-in provider (OpenAI, OpenRouter, Anthropic, Gemini, Groq, Meta, xAI,
  Mistral, Cerebras, Ollama Cloud): Settings → API keys, the server environment,
  or `rootclaw engine set KIND --key-env VAR` for the kinds it lists
  (`rootclaw help engine set`). See [install.md](install.md#3-configure-a-provider) and
  [api-providers.md](api-providers.md).
- Any other OpenAI-compatible endpoint (DeepSeek, Fireworks AI, a local
  vLLM or LM Studio server, …): an `openai-compat` instance. See
  [custom-engines.md](custom-engines.md). OpenCode's own Zen
  (`https://opencode.ai/zen/v1`) and Go (`https://opencode.ai/zen/go/v1`)
  endpoints are listed as OpenAI-compatible in RootClaw's bundled model
  catalog; to try one, point an `openai-compat` instance's `url` at it with your
  OpenCode API key.

After moving, open each bot's settings and pick the model you want on the new
provider; see [migration.md](migration.md).
