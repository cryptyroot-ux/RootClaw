# API providers (native engine)

Every provider runs on the in-process native loop (`server/drivers/openai-chat.ts`) through a `ModelAdapter`
(`server/drivers/model-adapter.ts`). API-key mode is always available; no subscription sign-in is used.

| Instance id       | Driver             | Wire protocol                                              | Key (Settings → API keys / env)                 |
|-------------------|--------------------|------------------------------------------------------------|-------------------------------------------------|
| `anthropicApi`    | `anthropic`        | Anthropic Messages API `POST /v1/messages` (SSE, tool_use, prompt caching via `cache_control` on system + tools) | `anthropic.key` / `ROOTCLAW_ANTHROPIC_API_KEY` |
| `geminiApi`       | `gemini`           | Gemini API `models/{m}:streamGenerateContent?alt=sse`, function calling | `gemini.key` / `ROOTCLAW_GEMINI_API_KEY` |
| `openaiResponses` | `openai-responses` | OpenAI Responses API `POST /v1/responses` (`store: false`, function tools) | `openai.key` / `ROOTCLAW_OPENAI_API_KEY` |
| `ollamaCloud`     | `ollama`           | Ollama Cloud's **OpenAI-compatible** endpoint `https://ollama.com/v1/chat/completions` (Bearer key). The native `/api/chat` endpoint is not used. | `ollama.key` / `ROOTCLAW_OLLAMA_API_KEY` |
| `openai`, `openrouter`, `openaiCompat`, … | `openai-compat` | OpenAI Chat Completions | as before |

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

Pending sign-ins expire after 10 minutes, and each `state` can be used only once.
