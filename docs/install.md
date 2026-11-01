# Installing RootClaw on a Linux VPS

These steps were tested on a clean Linux box (fresh clone, empty home
directory) on 2026-10-31: install, build, start, connect Ollama Cloud, create a
bot, chat, and have the bot write a file in its workspace.

## Requirements

- Linux x86_64 or arm64 (macOS works the same, minus systemd)
- 2 vCPU / 4 GB RAM minimum. The web build is memory hungry: give it ~6 GB of
  heap (add swap on small boxes, or build elsewhere and copy `dist/` and `dist-server/`)
- **Node.js 24 or newer** (`engines.node >= 24`; Node 22 is too old)
- **pnpm 10.33.0** through corepack (pinned in `packageManager`)
- git, curl
- **`bubblewrap`** (`apt install bubblewrap`) for the bots' shell tool. Bot shell
  commands run inside a bwrap sandbox; without it the shell tool refuses to run.
  `ROOTCLAW_SHELL_SANDBOX=off` in the server environment lets commands run
  without the sandbox, confined by folder only (writes outside the workspace are
  not blocked, and each result says it ran unsandboxed). Use it only if you
  accept that risk.

Install Node 24 any way you like (distro package, nvm, or the nodejs.org
tarball). Tarball example:

```bash
curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
V=$(grep -o 'node-v24[^ ]*-linux-x64.tar.xz' SHASUMS256.txt | head -1)
curl -fsSLO https://nodejs.org/dist/latest-v24.x/$V
sudo mkdir -p /opt/node24 && sudo tar -xJf $V -C /opt/node24 --strip-components=1
export PATH=/opt/node24/bin:$PATH
node -v   # v24.x
```

Run the server as an unprivileged user and do everything below as that user:

```bash
sudo adduser --disabled-password --gecos "" rootclaw
sudo -iu rootclaw
export PATH=/opt/node24/bin:$PATH
```

## 1. Clone, install, build

```bash
git clone https://github.com/cryptyroot-ux/RootClaw.git
cd RootClaw
corepack enable --install-directory ~/.local/bin   # plain `corepack enable` needs root
export PATH=~/.local/bin:$PATH
pnpm -v                                            # 10.33.0
pnpm install --frozen-lockfile                     # ~30 s
NODE_OPTIONS=--max-old-space-size=6144 pnpm build  # web UI -> dist/      (~2 min)
pnpm build:server                                  # server -> dist-server/ (~20 s)
```

`pnpm install` warns that some dependencies' build scripts were ignored
(core-js, workerd). That is expected and harmless.

## 2. Start it

```bash
pnpm start            # = node dist-server/rootclaw.js serve
# options: pnpm start --port 8799 --data-dir ~/.rootclaw --no-pair
```

You should see `RootClaw is running on http://127.0.0.1:8799` and
`data: /home/rootclaw/.rootclaw`. Check it from another terminal:

```bash
curl -s http://127.0.0.1:8799/api/health   # {"app":"rootclaw",...}
```

The server listens on 127.0.0.1 only (plus the webhook receiver on 8800).
Never expose 8799 directly; use the reverse proxy below.

The rest of this guide uses the CLI from your clone:

```bash
alias rootclaw="node $HOME/RootClaw/dist-server/rootclaw.js"
```

The `rootclaw` npm package is not published for this repository, so
`npx rootclaw` / `npm install -g rootclaw` (mentioned in older docs and the
CLI help) will not work. Run it from the clone as above.

## 3. Configure a provider

Give the running server a key. The key is read from an environment variable
(or `--key-file FILE`), sent to the server and saved in the data directory.
It is never printed.

```bash
export ROOTCLAW_OLLAMA_API_KEY=...        # any variable name works; or use --key-file FILE
rootclaw engine set ollama --key-env ROOTCLAW_OLLAMA_API_KEY
rootclaw models                           # ollamaCloud · available · ...
```

`--key-env VAR` is read by the CLI on your side only; the key is then saved in
`~/.rootclaw/config.json` (mode 600). Other kinds: `claude` (Anthropic),
`openai`, `openrouter`, `xai`, `groq`, `mistral`, `cerebras`,
`openai-compatible --base-url URL`. Add `--rotate` to replace a saved key.

Alternatives: paste the key in the web app under Settings → API keys, or set
it in the server's environment before it starts (see `EnvironmentFile`
below). A variable in the server's environment wins over a saved key. The
server reads these names:

| Provider | Instance | Server environment variable |
| --- | --- | --- |
| Ollama Cloud | `ollamaCloud` | `ROOTCLAW_OLLAMA_API_KEY` |
| OpenAI | `openai` | `ROOTCLAW_OPENAI_API_KEY` |
| OpenRouter | `openrouter` | `ROOTCLAW_OPENROUTER_API_KEY` |
| Anthropic | `anthropicApi` | `ROOTCLAW_ANTHROPIC_API_KEY` (optional `ROOTCLAW_ANTHROPIC_API_URL`) |
| Google Gemini | `geminiApi` | `ROOTCLAW_GEMINI_API_KEY` |
| Groq | `groq` | `ROOTCLAW_GROQ_API_KEY` |
| Meta | `meta` | `ROOTCLAW_META_API_KEY` |
| xAI | `xaiApi` | `XAI_API_KEY` |
| Mistral | `mistral` | `MISTRAL_API_KEY` |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` |
| Any OpenAI-compatible API | `openaiCompat` | `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_URL`, `OPENAI_COMPAT_MODEL`, `OPENAI_COMPAT_PROVIDER` |

Use the `ROOTCLAW_` names. The unprefixed `OLLAMA_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, `OPENAI_API_KEY` (OpenAI Responses), `GROQ_API_KEY` and
`META_API_KEY` are only a fallback inside the driver, used when no key is saved
and the provider's default URL is in use. That fallback still lets the engine run, but Settings
and `rootclaw engine list` do not count it as a configured key. More on each
provider: [api-providers.md](api-providers.md).

## 4. First bot

```bash
rootclaw new-bot helper --model ollamaCloud/gemma4:31b   # or any id from `rootclaw models`
rootclaw run helper "Reply with exactly: hello from rootclaw"
rootclaw run helper "Create hello.txt in your workspace containing: install test ok"
```

Each job's files land in `~/.rootclaw/task-workspaces/<bot-id>/<thread-id>/`.
`rootclaw doctor` checks the server and engines. `rootclaw help` lists everything.

## 5. Run as a systemd service

Stop the foreground server (Ctrl+C), then let RootClaw write the unit:

```bash
rootclaw service install --port 8799
sudo install -m 644 ~/.rootclaw/rootclaw.service /etc/systemd/system/rootclaw.service
sudo systemctl daemon-reload
sudo systemctl enable --now rootclaw
journalctl -u rootclaw -f
```

The generated unit runs `node ~/RootClaw/dist-server/rootclaw.js serve --port 8799
--data-dir ~/.rootclaw --no-pair` as your user with `Restart=always`, using the
same Node binary you ran it with. Keys saved with `engine set` survive restarts.
To pass keys or settings through the environment instead, add to `[Service]`:

```ini
EnvironmentFile=/etc/rootclaw.env
```

with `/etc/rootclaw.env` (mode 600) containing for example
`ROOTCLAW_OLLAMA_API_KEY=...` and `ROOTCLAW_PUBLIC_URL=https://rootclaw.example.com`.

## Context and compaction

Long conversations are compacted automatically. The defaults work; to tune
them, add a `context` block to `~/.rootclaw/config.json` (all keys optional):

| Key | Meaning |
| --- | --- |
| `autoCompact` | `false` turns automatic compaction off (default on). |
| `compactAt` | When to compact: a fraction of the model's context window below 1 (e.g. `0.7`) or a token count. Default 80% of the window. |
| `turnCompactAt` | Compact inside a long turn at this fraction (below 1) of the window or this many tokens (default `0.75`). |
| `toolOffloadBytes` | Tool outputs above this many bytes are saved to disk and paged (default 16000, range 1000–10,000,000). |
| `turnSummaryModel` | A cheaper model id for mid-turn summaries; absent uses the turn's model. |
| `rebuildBytes` | Bytes of history replayed into a rebuilt session (default 24000). |
| `replayToolHistory` | `true` also tells a rebuilt session which tools already ran, one line per call (off by default; `ROOTCLAW_REPLAY_TOOL_HISTORY=1` or `0` overrides). |

One related limit sits outside `context`: `engine.maxTurnRequests` (a whole
number from 2 to 64, in the same file) caps how many model requests one turn
may make; unset means no cap. The last request runs with tools off and the
turn ends with "Stopped at this turn's limit of N model requests"; steps that
already ran are kept. Details: [fallback-and-budgets.md](fallback-and-budgets.md).
Without a saved value, the server environment can set it with
`ROOTCLAW_MAX_TURN_REQUESTS`, and `turnCompactAt` / `toolOffloadBytes` with
`ROOTCLAW_TURN_COMPACT_AT` / `ROOTCLAW_TOOL_OFFLOAD_BYTES` (a value in
`config.json` wins).

How compaction is measured and verified:
[verification/context-compaction.md](verification/context-compaction.md).
Spending caps and model fallback live in the same file:
[fallback-and-budgets.md](fallback-and-budgets.md).

## 6. HTTPS and remote access

Put Caddy (or nginx) in front; the server only listens on loopback.
`deploy/Caddyfile` is a ready config: automatic HTTPS, `/hooks/*` to 8800,
everything else to 8799. With Debian/Ubuntu's `caddy` package:

```bash
sudo apt install caddy
sudo sed 's/{$DOMAIN}/rootclaw.example.com/' ~rootclaw/RootClaw/deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Set `ROOTCLAW_PUBLIC_URL=https://rootclaw.example.com` in the service
environment (above) so pairing links use your domain, then
`sudo systemctl restart rootclaw`.

Signing in from a browser elsewhere uses pairing: on the server run
`rootclaw pair`, open `https://rootclaw.example.com/pair` and type the code
(single use, expires in minutes). `rootclaw sessions` lists and revokes devices.

## 7. Update

```bash
cd ~/RootClaw
git pull
pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=6144 pnpm build && pnpm build:server
sudo systemctl restart rootclaw
```

Your data in `~/.rootclaw` is kept; back it up before upgrading.

The owner can also click **Update now** in the profile menu: RootClaw runs the
same steps, puts the old commit and build back if one fails, and restarts. The
old build is kept in `.rootclaw-update-previous` until the new version has
started. Under `rootclaw serve` (which `rootclaw service install` sets up), a new
version that stops while starting twice is replaced by the old one again. A
server started some other way (`node dist-server/index.js`, your own unit) does
not go back by itself: the update log shows the `git reset --hard` commit to
return to. If an update leaves `.rootclaw-update-backup` behind, the next one
refuses to start until you have restored what you need from it and removed it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Unsupported engine` or syntax errors | Node is older than 24 (`node -v`). |
| `corepack enable` fails with EACCES | `corepack enable --install-directory ~/.local/bin` and add it to `PATH`. |
| Build killed / "heap out of memory" | `NODE_OPTIONS=--max-old-space-size=6144`, add swap, or build on another machine. |
| `Cannot find module .../dist-server/rootclaw.js` | Run `pnpm build:server`. |
| Browser shows a blank page | Run `pnpm build` (the web UI lives in `dist/`). |
| Provider shows `unavailable` in `rootclaw models` | No key yet: `rootclaw engine set KIND --key-env VAR`, then `rootclaw doctor`. |
| Bot shell commands fail with "Install bubblewrap (bwrap)…" | `sudo apt install bubblewrap`, then restart the server. |
| `EADDRINUSE` on 8799 | Something else is on the port: `ss -ltnp \| grep 8799`, or use `--port`. |
| "browser engine: unavailable" at start | Optional. `rootclaw browser install --with-deps` (as root once) enables bots' web browsing. |
| Bots' `web_fetch` says every site is "a private or local address" | Your DNS hands out fake IPs (Clash/sing-box/VPN fake-IP mode, e.g. 198.18.0.0/15). Allow just that range: `ROOTCLAW_WEB_ALLOW_PRIVATE=198.18.0.0/15` in the service environment. |
| A remote browser only shows the pair page | Expected: run `rootclaw pair` on the server and enter the code. |

More detail: [self-hosting.md](self-hosting.md), [deploy-vps.md](deploy-vps.md),
[headless-cli.md](headless-cli.md), [api-providers.md](api-providers.md),
[fallback-and-budgets.md](fallback-and-budgets.md),
[verification/context-compaction.md](verification/context-compaction.md).
