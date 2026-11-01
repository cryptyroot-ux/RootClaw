# Deploy RootClaw on a VPS

From a blank Linux server to RootClaw running on it around the clock, reachable from your laptop, the desktop app and your phone, with your bots working while every laptop is closed. It assumes nothing beyond being able to open a terminal and paste commands. About twenty minutes, most of it waiting.

Three ways to make the server reachable are covered. Pick one; the rest of the guide is the same.

| | You need | Who can reach it | Best for |
|---|---|---|---|
| **A. Public address, no domain** (`serve --tunnel`) | an RootClaw account (email code) | anyone with a pairing code, over HTTPS | the fastest path; a phone on cellular |
| **B. Your own domain** (Docker + Caddy) | a domain name, ports 80/443 | anyone with a pairing code, over HTTPS | a permanent address you own |
| **C. Your Tailscale network** (`serve --tailscale`) | Tailscale on the server and your devices | only your tailnet | the most private; nothing public at all |

Whichever you pick, the login is the same: you **pair** each device once with a short code and it stays signed in. A session lasts 30 days; using it with half that or less left renews it to a full 30, up to 180 days from pairing (`ROOTCLAW_SESSION_TTL_DAYS` and `ROOTCLAW_SESSION_MAX_DAYS` change both numbers). There is no password.

## Hetzner launch check (2026-09-07)

Path A was exercised on a blank Hetzner CX43 (x86-64, Ubuntu 24.04), using
Node 24.20.0 and Codex 0.153.4. The published 0.1.60 baseline was followed by
local candidate fixes from this change; these results do not certify the
unmodified published 0.1.60 package. This check predates the removal of the
external engines: it ran the Codex CLI, which RootClaw no longer uses.

The paired web UI completed a real GPT-6-Astra chat, two automatically
scheduled routine runs, and a browser title/screenshot test. The browser
needed the Ubuntu sandbox setup below. A full reboot restored the service
and managed tunnel automatically; the existing paired device, bots, chats,
and paused schedule remained available. A new real chat turn also succeeded.

A stopped application-data backup restored with matching file hashes and
SQLite integrity. The restored copy was not started; provider reauthentication
and browser-login migration were not tested. Docker, Tailscale, ARM64, other
providers, and capacity limits were outside this run.

## What runs on a server, and what does not

Runs fully on the server: the built-in engine with every model provider, chats, rooms, bot-to-bot coordination, routines, connected apps and custom MCP servers, webhooks, Company Brain, computer use on cloud or container computers, text-to-speech, and the web UI (the server serves it itself).

Needs the desktop app instead: dictation and controlling the server's own desktop. Bots browse on a server too, once the browser engine is installed (below).

## Before you start

1. **A server.** Any Linux VPS: Ubuntu 22.04 or 24.04, 2 CPUs and 4 GB of RAM is plenty. You need `sudo` or root. Hetzner, DigitalOcean, Lightsail, a Mac mini in a cupboard: all fine.
2. **Node 24 or newer** for paths A and C (`node --version`). On Ubuntu:

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
   ```

   Path B uses Docker instead and needs no Node on the host.
3. **A model provider key.** Bots run on RootClaw's built-in engine; you give the server one provider API key (Ollama Cloud, OpenAI, OpenRouter, Anthropic, Gemini and others). No agent CLI is installed or signed in.

Connect to the server for everything below:

```sh
ssh root@YOUR_SERVER_IP
```

For paths A and C, use the same unprivileged Linux account for setup and the
running service. The examples below use `rootclaw` with home `/home/rootclaw`. From an
administrator shell, create it if it does not already exist, then switch to it:

```sh
sudo useradd --create-home --shell /bin/bash rootclaw
sudo -iu rootclaw
```

The login shell also changes into `/home/rootclaw`; run setup there, not from `/root`.
Run the `npx` commands below, including the provider setup, in this account. Keep a separate
administrator shell for system packages and systemd. If you already signed in as
root, sign in again as `rootclaw`; those accounts have different homes and credentials.

## Path A: a public address with one command

No domain, no proxy, no open port. The server gets an address like `https://c-7f3a9c.rootclaw.example` through a Cloudflare tunnel; only traffic through the tunnel reaches it, and that traffic still has to pair.

```sh
npx rootclaw setup          # once: choose AI access, connect, and choose a model
npx rootclaw login          # once: an emailed code signs this machine in and reserves its address
npx rootclaw serve --tunnel # runs the server there and prints the pairing link with a QR code
```

`setup` connects an AI provider; it is separate from the RootClaw account.
Paste a provider API key into the hidden prompt; it works over SSH. More
providers can be added later. See [CLI setup](cli-onboarding.md).

`login` asks for your email, sends an 8-digit code, and prints the address it reserved for this machine. `serve --tunnel` downloads `cloudflared` on the first run (a pinned version with a verified digest, into `~/.rootclaw`), starts the server, connects the tunnel, and after a few seconds prints `tunnel: live at https://…`. Leave it running; see "Keep it running" for a service.

The account credentials live in `~/.rootclaw/tunnel-account.json`, readable only by your user. `npx rootclaw logout` releases the address.

Skip to "Connect a model provider".

## Path B: your own domain, with Docker

One container for the server plus Caddy for HTTPS at `https://rootclaw.example.com`.

1. **Point a name at the server.** In your DNS provider add an **A record** (name `rootclaw`, value the server's public IP). After a few minutes `ping rootclaw.example.com` should answer with that IP. Ports 80 and 443 must be open; most providers open them by default.
2. **Install Docker:**

   ```sh
   curl -fsSL https://get.docker.com | sh
   docker compose version   # prints a version; if "command not found", log out and back in
   ```

3. **Get the deploy files and set the name:**

   ```sh
   git clone https://github.com/cryptyroot-ux/RootClaw && cd RootClaw/deploy
   cp .env.example .env
   nano .env                # DOMAIN=rootclaw.example.com ; ENGINES=
   ```

   Leave `ENGINES` empty. It installs agent CLIs into the image at build time, and RootClaw no longer runs them; the example file still lists one.

4. **Start it:**

   ```sh
   docker compose pull rootclaw && docker compose up -d
   docker compose ps        # rootclaw "healthy", caddy "running"
   ```

   Caddy requests the certificate on its own; give it a minute. Then `https://rootclaw.example.com` shows a page asking for a pairing code. That is correct: nothing works until you pair.

In this path, every `npx rootclaw …` command below is run inside the container instead:

```sh
docker compose exec rootclaw node dist-server/rootclaw.js pair --label "My MacBook"
```

## Path C: only your Tailscale network

From the administrator shell, install Tailscale on the server and sign in (`curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`). Enable HTTPS certificates for your tailnet once in the admin console (DNS → HTTPS Certificates), then run this from the `rootclaw` shell:

```sh
npx rootclaw serve --tailscale
```

Tailscale terminates HTTPS with its own certificate and the pairing link uses the server's MagicDNS name (`https://rootclaw.tail1234.ts.net`). Only devices on your tailnet can reach it, which is a very good property for a server that can run tools.

## Give the bots a browser (optional)

Bots can browse on a server. Docker (path B) ships the engine and Chrome in
the image. For paths A and C, install Linux system libraries once from the
administrator shell:

```sh
sudo -H npx --yes rootclaw browser install --with-deps
```

Then install the browser in the service account's home, from the `rootclaw` shell:

```sh
npx --yes rootclaw browser install
```

The administrator's browser download is in a different home; it does not install
the service account's browser. Both commands must finish successfully.

On Ubuntu 24.04, AppArmor may also require [administrator sandbox setup](#ubuntu-2404-browser-sandbox).
The one-click installer downloads the browser; it does not grant these OS permissions.

Then turn the browser on under Settings → Computers, and per bot. Each bot
gets its own isolated session whose logins persist across restarts.

## Connect a model provider

The server needs one model provider key. For paths A and C, from the service
account's shell while the server runs:

```sh
export ROOTCLAW_OLLAMA_API_KEY=...        # or use --key-file FILE
npx rootclaw engine set ollama --key-env ROOTCLAW_OLLAMA_API_KEY
```

`--key-env` is read by the CLI only; the key is saved in `~/.rootclaw/config.json`
(mode 600) and never printed. Other kinds: `claude` (Anthropic), `openai`,
`openrouter`, `xai`, `groq`, `mistral`, `cerebras`,
`openai-compatible --base-url URL`. You can instead paste the key under
**Settings → API keys** after pairing, or put a `ROOTCLAW_*_API_KEY` variable in
the service's environment, which wins over a saved key. For path B, use
**Settings → API keys**; the key is saved in the `/data` volume. See
[API providers](api-providers.md) for every provider and variable name.

## Pair your first device

`serve` already printed a pairing link and QR code when it started. For another device later:

```sh
npx rootclaw pair --label "Kitchen iPad"
```

```
pairing code:  RR8Y-BLR6-H939
expires:       10:59:45 AM (single use)
open or scan:  https://c-7f3a9c.rootclaw.example/pair#code=RR8Y-BLR6-H939
```

- **A browser:** open the link. The code is filled in; press **Connect**. That browser is paired for 30 days, renewed on use as above.
- **The desktop app:** copy the link, then in the app's **Server** menu choose **Add Server from Copied Pairing Link…**. The menu switches between your own machine and every server you added.
- **The phone:** scan the QR code from the iOS app's pairing screen, or paste the whole link into its address field. The phone can chat, approve, and read; creating bots, changing models, and connecting apps stay with you in the server's UI.

Worth knowing: a code works **once** and expires after **five minutes**; the link only works on that address (typing the code by hand: open `…/pair` and enter it); ten wrong codes in a minute from one address pause pairing for that address for a minute; `--client` mints a code for a device that may chat and approve but not change settings or pair others.

## Manage devices

Every paired device is a session:

```sh
npx rootclaw sessions              # id, device, scope, last seen, expires
npx rootclaw sessions revoke ID    # signs that device out and closes its stream at once
npx rootclaw status                # what the server says about itself
```

## Keep it running

`npx rootclaw serve` is a plain foreground process. For systemd (paths A and C),
install a chosen release first, from the `rootclaw` shell. Replace `X.Y.Z` with the
published version you want to run:

```sh
npm install --global --prefix "$HOME/.local" rootclaw@X.Y.Z
```

Stop the foreground server with Ctrl-C before enabling the service. From the
administrator shell, save this as `/etc/systemd/system/rootclaw.service`:

```ini
# /etc/systemd/system/rootclaw.service
[Unit]
Description=RootClaw server
After=network-online.target

[Service]
User=rootclaw
WorkingDirectory=/home/rootclaw
Environment=HOME=/home/rootclaw
Environment=PATH=/home/rootclaw/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/home/rootclaw/.local/bin/rootclaw serve --tunnel --no-pair
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now rootclaw
journalctl -u rootclaw -f            # the server's log, including "tunnel: live at …"
```

Use `--tailscale` instead of `--tunnel` for path C. `--no-pair` skips printing a code at every restart; mint one with `npx rootclaw pair` when you need it. Docker (path B) restarts on its own (`restart: unless-stopped`).

Adjust the account, home, and PATH if yours differ; Node 24 must be available on
that PATH. The service runs the installed CLI directly, so a restart uses the
same release without an npm install prompt or an implicit upgrade.

## Update

- **Paths A and C with the service above:** choose the new published version,
  then run these commands from the administrator shell, replacing `X.Y.Z`:

  ```sh
  sudo systemctl stop rootclaw
  sudo -iu rootclaw npm install --global --prefix /home/rootclaw/.local rootclaw@X.Y.Z
  sudo systemctl start rootclaw
  ```

  Check that installation succeeded before starting. A service restart by itself
  does not update the installed package. For foreground `npx` usage, specify the
  desired release as `npx --yes rootclaw@X.Y.Z serve --tunnel`.
- **Path B:** `cd RootClaw/deploy && docker compose pull rootclaw && docker compose up -d`.

Routines and queued work survive a restart. A teammate turn running at that moment runs again once at the next start, told to check what it already did, and the bot that asked for it is told. A person's own turn and a running routine are not run again: the conversation says it was interrupted. Update between runs where you can.

## Back up

Stop the server before copying its SQLite database: Ctrl-C for a foreground
process, or `sudo systemctl stop rootclaw` from the administrator shell for
the service above. Stop any managed desktops still writing files you intend to
back up.

For paths A and C, this backs up application state (bots, chats, routines, tunnel
credentials, and paired sessions). Run it from the service account's shell:

```sh
umask 077
backup_dir=$(mktemp -d "$PWD/rootclaw-backup.XXXXXX")
tar czf "$backup_dir/rootclaw-data.tgz" -C "$HOME" .rootclaw
```

The archive includes `config.json`, so it holds any provider keys saved there;
protect it accordingly. A full backup also needs the service's environment file
if provider keys live there, browser session state under `~/.agent-browser` if
used, any configured home/data-directory overrides, and workspaces outside the
app directory. These are not included in the command above.

For path B, the whole `/data` volume includes saved provider keys. From
`RootClaw/deploy`, stop the app before archiving; `deploy_data` is the default
volume name, so use your actual volume name if you changed the Compose project:

```sh
docker compose stop rootclaw
backup_dir=$(mktemp -d "$PWD/rootclaw-backup.XXXXXX")
docker run --rm -v deploy_data:/data:ro -v "$backup_dir":/b alpine sh -c 'umask 077; tar czf /b/rootclaw-data.tgz -C /data .'
```

Each command creates a fresh private folder in the current directory, so it
cannot overwrite an older archive with more permissive access. Keep the
archive inside that folder privately on another machine. Restore with the server stopped,
using the same paths and original ownership. After backup or restore, start the
service with `sudo systemctl start rootclaw`, or `docker compose start rootclaw`.

## The rules the setup relies on

Read this before putting anything else in front of the server.

- The server only ever listens on loopback (`127.0.0.1:8799`). Never publish that port yourself. The tunnel, Caddy and Tailscale each reach it from the same machine.
- A request that arrives through a proxy or the tunnel is treated as remote and needs a session, whatever headers it carries. A proxy of your own (nginx, Traefik, Cloudflare Tunnel) must forward the real `Host` and add `X-Forwarded-For` and `X-Forwarded-Proto`, must not buffer the event stream, and must **not** rewrite `Host` to `127.0.0.1`.
- Pairing is the login. Want a second wall in front of it? Path B's `Caddyfile` has a commented `basic_auth` block for a shared password.
- The session cookie is marked `Secure`; do not serve this over plain HTTP on the public internet.
- The one thing a stranger can read is `/.well-known/rootclaw/environment` (the server's id, label, version, capabilities) and `/api/health` (only the app name). Everything else answers "pair this device".

## Troubleshooting

**`serve --tunnel` says "no account on this machine yet".** Run `npx rootclaw login` on this machine first; the credentials are per machine.

**The tunnel stays on "retrying".** The server is running and usable locally; the public hop is not verified yet. Wait a minute (Cloudflare needs a moment on a fresh address), then check `journalctl`/the terminal for the reason. If it never comes up, `npx rootclaw logout && npx rootclaw login` issues a fresh address.

**Path B: the page never loads or shows a certificate error.** Caddy could not get a certificate. Check that the name resolves to the server and that ports 80 and 443 are open; `docker compose logs caddy` shows the reason.

**"forbidden: pair this device to use the server remotely" / "this request came through a proxy".** Expected before pairing, and for tools that call the API without a session. Pair the device. Scripts send `Authorization: Bearer <token>` with the token from the pairing response instead of a cookie.

**Pairing code refused.** It expired (five minutes) or was used. Mint a new one. "Too many failed pairing attempts" means wait a minute.

**A bot says its provider has no API key.** Save the key under Settings → API keys, or run `engine set` again with `--rotate`.

**What does the server think it is?** `https://<address>/.well-known/rootclaw/environment` is public and shows its id, label, version and capabilities; `npx rootclaw status` prints the same on the server.

**Something else.** `journalctl -u rootclaw --since -10m` (or `docker compose logs rootclaw --tail 100`) shows the server's startup lines. Paste them with your question in the community channel.

### Ubuntu 24.04 browser sandbox

If Chrome reports `No usable sandbox!` and `sudo journalctl -k --since -10m`
shows an AppArmor `DENIED` for `userns`, the browser download is installed but
Ubuntu is blocking its sandbox. [Chromium documents this restriction](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).
Do not add `--no-sandbox` or disable `kernel.apparmor_restrict_unprivileged_userns` globally.

For paths A and C, an administrator can allow only a trusted, root-owned Chrome
copy. Find the service user's downloaded executable:

```sh
find /home/rootclaw/.agent-browser/browsers -type f -name chrome -executable
```

Use its actual `chrome-VERSION` directory in every path below; `VERSION` is a
placeholder, not a fixed Chrome release. Copy the whole directory, including its
libraries, to a new location that the service user cannot modify:

```sh
sudo install -d -o root -g root -m 0755 /opt/rootclaw-browser
sudo cp -R /home/rootclaw/.agent-browser/browsers/chrome-VERSION /opt/rootclaw-browser/
sudo chown -R root:root /opt/rootclaw-browser/chrome-VERSION
sudo chmod -R go-w /opt/rootclaw-browser/chrome-VERSION
```

Save this as the root-owned `/etc/apparmor.d/rootclaw-chrome`, replacing
`VERSION` with the same value. Keep the exact executable path: a wildcard under
the writable service home would also allow replacement executables.

```text
abi <abi/4.0>,
include <tunables/global>

profile rootclaw-chrome /opt/rootclaw-browser/chrome-VERSION/chrome flags=(unconfined) {
  userns,
}
```

Load the profile:

```sh
sudo apparmor_parser -r /etc/apparmor.d/rootclaw-chrome
```

Add the following line under `[Service]` in the systemd unit above, again using
the exact installed version, then run `sudo systemctl daemon-reload` and
`sudo systemctl restart rootclaw`:

```ini
Environment=AGENT_BROWSER_EXECUTABLE_PATH=/opt/rootclaw-browser/chrome-VERSION/chrome
```

For a foreground server, export `AGENT_BROWSER_EXECUTABLE_PATH` to that same
path in the `rootclaw` shell before starting `serve`. After a Chrome update, copy the
new version and update both the AppArmor profile and service environment; the
root-owned copy is not updated by the browser installer. Keep
`kernel.apparmor_restrict_unprivileged_userns=1`.
