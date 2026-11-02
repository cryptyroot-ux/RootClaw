# API providers (native engine)

Every provider runs on the in-process native loop (`server/drivers/openai-chat.ts`) through a `ModelAdapter`
(`server/drivers/model-adapter.ts`). API-key mode is always available; no subscription sign-in is used.

| Instance id       | Driver             | Wire protocol                                              | Key (Settings → API keys / env)                 |
|-------------------|--------------------|------------------------------------------------------------|-------------------------------------------------|
| `anthropicApi`    | `anthropic`        | Anthropic Messages API `POST /v1/messages` (SSE, tool_use, prompt caching via `cache_control` on system + tools) | `anthropic.key` / `ROOTCLAW_ANTHROPIC_API_KEY` |
| `geminiApi`       | `gemini`           | Gemini API `models/{m}:streamGenerateContent?alt=sse`, function calling | `gemini.key` / `ROOTCLAW_GEMINI_API_KEY` |
| `openaiResponses` | `openai-responses` | OpenAI Responses API `POST /v1/responses` (`store: false`, function tools) | `openai.key` / `ROOTCLAW_OPENAI_API_KEY` |
| `ollamaCloud`     | `ollama`           | Ollama Cloud's **OpenAI-compatible** endpoint `https://ollama.com/v1/chat/completions` (Bearer key). The native `/api/chat` endpoint is not used. | `ollama.key` / `ROOTCLAW_OLLAMA_API_KEY` |
| `openai`          | `openai-compat`    | OpenAI Chat Completions at `https://api.openai.com/v1`     | `openai.key` / `ROOTCLAW_OPENAI_API_KEY` |
| `openrouter`      | `openai-compat`    | OpenAI Chat Completions at `https://openrouter.ai/api/v1`  | `openrouter.key` / `ROOTCLAW_OPENROUTER_API_KEY` |
| `openaiCompat`    | `openai-compat`    | OpenAI Chat Completions at any URL                         | `openaiCompat.key` / `OPENAI_COMPAT_API_KEY` (plus `OPENAI_COMPAT_URL`, `OPENAI_COMPAT_MODEL`, `OPENAI_COMPAT_PROVIDER`) |
| `groq`, `meta`, `mistral`, `cerebras`, `xaiApi` | `groq`, `meta`, `mistral`, `cerebras`, `grok` | OpenAI Chat Completions | `ROOTCLAW_GROQ_API_KEY`, `ROOTCLAW_META_API_KEY`, `MISTRAL_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY` |

**Custom providers:** add any number of `openai-compat` instances, each with its own `url` and `key`
(`instances.<id>.config`), or with `rootclaw setup --provider custom --base-url … --api-key …`.

Any of the new drivers also takes a per-instance `config: { url, key, model, apiKeyEnv }`; an instance with its own
URL or key never receives the workspace key.

## Headless setup

```
rootclaw setup --provider anthropic|gemini|openai-responses|openai|openrouter|groq|meta|ollama|custom \
  --api-key KEY [--base-url URL] [--model ID] [--skip-verify]
```

## Errors and failover

Adapters map provider errors into the shared contract: HTTP status → `HttpStatusError` (429 quota and 5xx feed
`retry.ts` and `failover.ts`; Anthropic 529 is treated as 503), context overflow → `RequestTooLargeError`
(compaction, smaller resend, then failover). See `docs/fallback-and-budgets.md`.

## Official OAuth (optional)

API-key mode always works. RootClaw adds only these official OAuth flows. It has no subscription OAuth: no Claude Pro and no ChatGPT/Codex sign-in.

- **OpenRouter (PKCE key exchange):** `POST /api/oauth/openrouter/start` returns `{url}`. Open that URL and approve. OpenRouter redirects to `/api/oauth/openrouter/callback?state=…&code=…`. RootClaw exchanges the code at `https://openrouter.ai/api/v1/auth/keys` and saves the resulting key as `openrouter.key`.
- **Google / Gemini:** Register your own OAuth client in Google Cloud Console (type "Web application"). Add the redirect URI `http(s)://<your RootClaw host>/api/oauth/google/callback`. Then set `gemini.oauth.clientId` and `clientSecret` in config, or use `ROOTCLAW_GOOGLE_OAUTH_CLIENT_ID` and `ROOTCLAW_GOOGLE_OAUTH_CLIENT_SECRET`. Optionally set `gemini.oauth.projectId`, which is sent as `x-goog-user-project` for quota and billing. `POST /api/oauth/google/start` returns the consent URL, and the callback stores a refresh token. When no `gemini.key` is set, the Gemini driver mints access tokens from that refresh token. The start route returns 409 until a client id is configured.

### OAuth audit (checked 2026-10-31)

Only a provider's own public OAuth that grants **API access billed as API usage** qualifies. Subscription sign-ins are
excluded on purpose, and the API key stays available for every provider.

| Provider | Official third-party OAuth for API access? | RootClaw |
|---|---|---|
| OpenRouter | Yes: PKCE flow that mints a user API key | Implemented (above) |
| Google Gemini | Yes: Google OAuth with your own Cloud client (generative-language scope) | Implemented (above) |
| Anthropic | No public flow for third parties (Console sign-in is first-party; Claude Pro/Max OAuth is a subscription and banned in third-party tools since Feb 2026) | API key only |
| OpenAI | No: "Sign in with ChatGPT" is identity-only (limited partner trial) or bills the user's ChatGPT plan (Codex-style); no Platform API OAuth | API key only |
| xAI | No API OAuth; SuperGrok sign-in is xAI's device authorization grant (RFC 8628) at `auth.x.ai` with xAI's public Grok CLI client id | **Connect SuperGrok** in **Settings → Model providers** (also on the first-run connect screen): approve the code on xAI's page; RootClaw keeps the tokens in `~/.rootclaw/xai-subscription.json` (0600), renews them itself, sends the token only to `api.x.ai`, and falls back to `XAI_API_KEY` when signed out, expired or refused (a 401 renews once; **Reconnect SuperGrok** shows only when xAI refuses the renewal); **Disconnect** deletes the tokens |
| Meta (Muse) | No: device sign-in mints a Muse Code subscription key under Meta's own client | API key only |
| Ollama Cloud, Groq, Mistral, Cerebras, DeepSeek | No OAuth offered | API key only |
| OpenAI-compatible (custom) | Depends on the server; RootClaw sends a bearer key | API key only |

Pending sign-ins expire after 10 minutes, and each `state` can be used only once.

## Default models

These defaults were checked against each provider's public model list on 2026-10-31. Any model id from the provider's live catalog also works.

| Provider | Default | Source |
|---|---|---|
| Anthropic | `claude-sonnet-5-5` | docs.anthropic.com, Models overview |
| Gemini | `gemini-3.8-flash` | ai.google.dev/gemini-api/docs/models |
| OpenAI Responses | `gpt-6.1-sol` | platform.openai.com/docs/models |
| Ollama Cloud | `gemma4:31b` | docs.ollama.com/cloud |

`rootclaw setup` lists all of them interactively. For the native APIs (Anthropic, Gemini, OpenAI Responses) it asks for the key and an optional model id, then checks the key on the first message.

## Run records

Every native engine run (one turn on one engine) is recorded in `<dataDir>/runs/runs.jsonl`: the bot, thread, engine,
the model chain it went through (a failover run lists the models that failed before it), rounds, each tool call with its
status, usage and cost, stop reason, errors, retries and timings. The file is append-only and compacted to the newest 500
runs. A run still going when RootClaw stopped is marked `interrupted` on the next start.

- `GET /api/runs?botId=&threadId=&status=&limit=`: runs newest first, only on threads the session can see.
- `GET /api/runs/<id>`: one run.
- `POST /api/runs/<id>/retry`: run an interrupted or failed run's thread again on its bot, once.

## Your own model prices

RootClaw knows list prices for the big providers' models. For anything else, such as a model behind a custom
OpenAI-compatible endpoint, set its USD price per million tokens in `config.json` (or `PUT /api/config`):

```json
{ "modelPrices": { "MyCombo": { "inputPerMillion": 0.5, "outputPerMillion": 1.5 } } }
```

A key may be the model id or `driver/model` (for example `openai-compat/MyCombo`); `null` drops one. These prices feed
the per-turn budget guard, usage costs and run records, ahead of the list price but never ahead of an operator's billing price.
