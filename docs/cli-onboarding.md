# Terminal setup

Install [Node.js](https://nodejs.org/) 24 or newer and git. The `rootclaw` npm package is not
published for this repository, so `npx rootclaw` and `npm install -g rootclaw` do not work; build it
from a clone instead ([install](install.md#1-clone-install-build) has the details):

```sh
git clone https://github.com/cryptyroot-ux/RootClaw.git && cd RootClaw
corepack enable --install-directory ~/.local/bin && export PATH=~/.local/bin:$PATH
pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=6144 pnpm build && pnpm build:server
alias rootclaw="node $PWD/dist-server/rootclaw.js"
rootclaw
```

Use the same command next time. The first launch guides you through setup; later launches reuse your saved AI connection and phone-access choice. `rootclaw start` is the same as the bare command. If that workspace is already running, RootClaw opens it instead of starting a second server.

## First launch

The setup wizard uses Clack. Use ↑/↓ and Enter to select an option. Plain terminals show numbered choices instead.

1. Choose a model provider. Setup is API-key only: OpenAI-compatible presets (OpenAI API, OpenRouter, Groq, Meta Model API, Ollama Cloud), the native Anthropic, Google Gemini and OpenAI Responses APIs, or another OpenAI-compatible endpoint. Existing OpenAI-compatible connections are also listed. There is no CLI to install or sign in.
2. Paste the provider's API key into the hidden prompt.
3. Choose a model and save. An OpenAI-compatible connection asks permission to send a short test message, which the provider may charge for. A native API key is checked when you send the first message.
4. Optionally connect a phone, or choose **Skip for now**. Your AI setup is already saved before this step.

The workspace then starts and opens its local address in a browser on this computer. On SSH or a computer without a graphical desktop, open the printed address using an appropriate connection instead. Automatic browser opening only uses the local address; `--no-open` disables it.

Keep the terminal open while using your bots. This runs a foreground server, not an installed background service. Ctrl-C stops the server without deleting saved work; closing the browser alone does not stop it. Bots keep working only while the computer and server are running.

Every bot runs on RootClaw's built-in engine: chat, plus approved MCP tools when the model supports tool calling. Provider API usage is billed by the provider per token; a ChatGPT or Claude chat subscription does not include it. Changing the saved default affects **new bots only**; existing bots and conversations keep their settings.

## Optional phone access

A phone cannot connect to this computer's `localhost` address. The harness also does not listen on your LAN address. The guide does not create a phone QR until a configured HTTPS address has been checked against this workspace.

Choose one connection method:

- **Managed HTTPS address:** setup asks explicit permission for a public endpoint through Cloudflare and a possible connector download. Device pairing protects chat and settings; the pairing page and basic server identity remain publicly reachable. Sign in to an **RootClaw account** using an emailed code, or reuse this machine's saved account. This account is separate from your model provider account. The connection stays active while RootClaw runs.
- **Existing Tailscale:** both computer and phone must already be signed in to the same tailnet, with HTTPS certificates enabled. Setup asks before enabling HTTPS serving to that tailnet; it does not install or sign in to Tailscale for you.
- **Existing HTTPS address (advanced):** supply the origin of a reverse proxy you already configured, such as `https://rootclaw.example.com`. Do not paste a password, path, query, or pairing code. Entering an address does not create the proxy or open a LAN listener.

After the connection is ready:

- **iPhone/iPad:** scan the QR with Camera to open Safari. If you already have the RootClaw iOS app, use its pairing scanner or paste the full link there.
- **Android:** the QR is an app link, so scan it inside the RootClaw app. To use a browser instead, open the web address printed above it and type the code.

Choose **Connect** on the phone. Scanning alone is not a successful pairing. The code is private, single-use, and expires after five minutes. Guided phone pairing grants client access for chat and approvals, not settings or pairing administration.

If the workspace starts but its HTTPS check fails, the local workspace remains usable and no phone code is created. Fix the connection and run `rootclaw pair` in another terminal to try again. A missing account, connector, or Tailscale prerequisite can prevent startup; follow the printed error, or use `rootclaw --local`. To add phone access after skipping it, stop the server, run `rootclaw setup`, then start it again.

## Commands

The examples below use the `rootclaw` alias from above (`node /path/to/RootClaw/dist-server/rootclaw.js`).

| Command | Use |
| --- | --- |
| `rootclaw` | Set up once, then start with saved settings. |
| `rootclaw setup` | Revisit AI and optional phone setup, save, and exit without starting. This is not a reset. |
| `rootclaw --no-open` | Start without opening a browser. |
| `rootclaw --local` | Ignore saved remote access for this launch; keep the saved choice for next time. |
| `rootclaw --no-pair` | Suppress phone setup prompts and pairing invitations. This does **not** turn off saved remote access; use `--local` for that. |
| `rootclaw pair` | Create another phone invitation while the configured workspace and HTTPS connection are running. |
| `rootclaw sessions` | List paired devices; `rootclaw sessions revoke ID` signs one out. |
| `rootclaw serve` | Start without onboarding prompts or automatic browser opening; specify remote-access flags explicitly for a service. |
| `rootclaw login` | Sign in to a RootClaw account for `--tunnel`; this does not sign in to an AI provider or start the tunnel. |

`start` accepts the same server options as `serve`, including `--port`, `--data-dir`, `--tailscale`, `--tunnel`, and `--public-url`. Keep using your custom data directory and port when starting or pairing:

```sh
rootclaw setup --data-dir /path/to/rootclaw-data --port 8799
rootclaw --data-dir /path/to/rootclaw-data --port 8799
```

Setup needs an interactive terminal. Later starts can run without one once setup is complete. Stop a running server before changing its setup or access mode: `--local` does not turn off a remote connection belonging to a server that is already running. You do not need to delete configuration, bots, or conversations to reconfigure it.

## Credentials and cancellation

API keys are hidden while typed or pasted. New API connections save their key in the data directory's `config.json` as **plaintext, not encrypted**, with owner-only permissions (`0600`) on Unix. Managed-access account credentials in `tunnel-account.json` are also plaintext with `0600` permissions on Unix. Keep these files and backups private.

Ctrl-C during AI setup leaves unsaved RootClaw changes unapplied. Ctrl-C during the later phone step keeps the AI setup you already saved, exits without starting a server, and does not undo an account sign-in already completed. Run `rootclaw setup` to continue; no destructive reset is needed.

For remote access and background deployment options, see [self-hosting](self-hosting.md) and [the VPS guide](deploy-vps.md).
