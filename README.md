# RootClaw

RootClaw is a self-hosted workspace for a team of AI bots. One server (port
`8799`) runs your bots, teams, channels, routines and approvals, and serves the
web app, the `rootclaw` CLI and an MCP endpoint. Bots run on RootClaw's native
engine against any API provider you give it a key for.

## Features

- Bots with their own model, instructions, skills and a private workspace folder
- Tools: files, shell (sandboxed where available), background jobs, web fetch/search, MCP servers
- Teams and channels where bots hand work to each other
- Approval levels (Ask / Approve-for-me / Full) for anything a bot does
- Routines, webhooks and a headless CLI (`rootclaw run BOT "..."`) for scripts and CI
- Providers: Anthropic, OpenAI, OpenRouter, Gemini, xAI, Groq, Mistral, Cerebras,
  Ollama Cloud, any OpenAI-compatible endpoint
- Phone/desktop pairing; data stays in `~/.rootclaw`

## Quick start (Linux or macOS, Node 24+)

```bash
git clone https://github.com/cryptyroot-ux/RootClaw.git && cd RootClaw
corepack enable            # provides pnpm 10.33.0 (see packageManager)
pnpm install --frozen-lockfile
pnpm build && pnpm build:server
pnpm start                 # = node dist-server/rootclaw.js serve, on http://127.0.0.1:8799
```

In a second terminal, give it a provider key and talk to a bot:

```bash
node dist-server/rootclaw.js engine set ollama --key-env OLLAMA_API_KEY
node dist-server/rootclaw.js new-bot helper --model ollamaCloud/beam   # rootclaw models lists the rest
node dist-server/rootclaw.js run helper "Hello!"
```

Open `http://127.0.0.1:8799` in a browser on the same machine. For a VPS
(systemd, HTTPS, pairing a remote browser, updates) follow
[docs/install.md](docs/install.md).

Keep port `8799` on localhost or behind the HTTPS reverse proxy, and run the
server as an unprivileged user.

## Development

```bash
pnpm dev:server   # API server from source
pnpm dev          # web UI (Vite)
pnpm typecheck && pnpm lint
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
