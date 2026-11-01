# Self-hosting the RootClaw server

Run the harness server on an always-on Linux box (a VPS, a home server, a
Mac mini in a closet) and pair browsers, the desktop app, or phones with it.
The `rootclaw` CLI supports a managed public tunnel, Tailscale, or your own proxy.

> **Security first:** by default a self-hosted server trusts loopback as its
> owner — any process that can reach `127.0.0.1:8799` has full control,
> including the shell your bots can use. A browser is the exception: even on
> this machine it signs in once (see [A browser signs in](#a-browser-signs-in)).
> **Never expose that port directly and never bind it to a public interface.** Reach it through an SSH tunnel, a
> private network you trust, or an authenticated remote path below. Requests
> through the managed tunnel or a correctly configured proxy require a paired
> session. If several people use one server, read
> [Loopback trust](#loopback-trust-owner-or-service) below.

Step by step, for a server you do not have yet: [Deploy RootClaw on a
VPS](deploy-vps.md) walks through the three ways in (public address, own
domain, Tailscale), connecting a model provider, pairing, keeping it running,
updating and backups. This page is the reference behind it.

## What works headless (and what doesn't)

Runs fully on a server:

- the built-in engine with every model provider (give the server one provider
  API key; no agent CLI is installed or signed in)
- chats, rooms, bot-to-bot coordination, routines (they keep running with
  every laptop on the planet closed — this is the point)
- connected apps / custom MCP servers, webhooks, Company Brain
- computer use on **cloud or container computers** (the bot's computer runs
  server-side anyway)
- text-to-speech (with a key), the web UI (the server serves it itself)

- a browser for bots, once the engine is installed on the server
  (`rootclaw browser install`, or nothing to do in the Docker image,
  which ships it): each bot gets its own isolated, persistent session.
  Watching it live from the app is the next step (docs/plans/browser-engine.md).
  It reaches the public internet and the dev servers a bot starts itself,
  not this server's network or other services unless `browserEngine.egress.allow`
  lists them ([what a bot's browser can reach](browser-packaging.md#what-a-bots-browser-can-reach)).

Desktop-only for now (needs the Mac/Linux app):

- dictation/voice, controlling the host desktop

## Quickest: build it once with Node

The `rootclaw` npm package is not published for this repository, so
`npx rootclaw` and `npm install -g rootclaw` do not work. On any machine with
Node 24 or newer and git (a VPS, a Mac mini, a Raspberry Pi), build it from a
clone ([install](install.md#1-clone-install-build) has the details):

```sh
git clone https://github.com/cryptyroot-ux/RootClaw.git && cd RootClaw
corepack enable --install-directory ~/.local/bin && export PATH=~/.local/bin:$PATH
pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=6144 pnpm build && pnpm build:server
alias rootclaw="node $PWD/dist-server/rootclaw.js"
rootclaw start
```

Every `rootclaw …` command on this page means that alias (or
`node /path/to/RootClaw/dist-server/rootclaw.js …`).

First launch asks for a model provider API key (OpenAI, Anthropic, Gemini,
OpenRouter, Groq, Meta, Ollama Cloud or another OpenAI-compatible service) and
the default model for new bots. An existing OpenAI-compatible connection can be
reused. The [setup guide](cli-onboarding.md)
explains the choices, key storage, and how to run setup again safely.

It then starts the server and keeps your data in `~/.rootclaw`. If you
choose phone access, it prints a pairing link and QR code only after checking
the HTTPS connection. Choosing **Skip for now** keeps the workspace local-only
and creates no pairing invitation. Use `rootclaw setup` to configure without starting, or
`rootclaw serve` (or `pnpm start` in the clone) to start non-interactively with your existing config
(for services and scripts).

Every bot runs on RootClaw's built-in engine; there are no agent CLIs to
install. Setup saves the key in `~/.rootclaw/config.json` (owner-only
permissions). Run setup and the server as the same unprivileged
operating-system user.

For a Linux service, the [VPS guide](deploy-vps.md#before-you-start) shows the
account setup, provider key, and browser dependency installation.
After installing browser libraries as administrator, also run
`rootclaw browser install` as the service user so that user's browser
is present. Three ways to make the server reachable from elsewhere:

- **On your Tailscale network, no domain needed:**
  `rootclaw serve --tailscale`. Tailscale terminates HTTPS with its
  own certificate and the link uses this machine's MagicDNS name, so only
  devices on your tailnet can reach it. Needs Tailscale signed in and HTTPS
  certificates enabled for the tailnet (admin console → DNS).
- **A public address, no domain, no proxy, no open port:**

  ```sh
  rootclaw login          # once: an emailed code signs this machine in
  rootclaw serve --tunnel
  ```

  `login` reserves an address like `https://c-….rootclaw.example` for this
  machine; `serve --tunnel` connects it through a Cloudflare tunnel (the same
  one the desktop app uses for its companion) and prints the pairing link at
  that address. The first run downloads `cloudflared` (pinned version and
  digest) into the data dir. Only traffic through the tunnel reaches the
  server, and it still has to pair: the tunnel lands on a separate listener
  the server treats as "through a proxy", never as the owner. That listener
  also gzips JSON replies of 1 KB or more when the client accepts gzip, since
  the hop to Cloudflare runs on this machine's upload uncompressed; the
  loopback port never compresses. `rootclaw logout` releases the
  address. The account credentials live in
  `~/.rootclaw/tunnel-account.json` (mode 0600).
  Starting it from a fleet or a container, where nobody can type an emailed
  code? Set `ROOTCLAW_INSTALLATION_CREDENTIAL` to the installation credential the
  fleet issued and skip `login`: the address and connector token are fetched
  at every start and nothing is written to disk. A rejected credential stops
  the start with a clear message rather than serving locally.
- **Your own domain, still one command:**

  ```sh
  rootclaw serve --domain rootclaw.example.com
  ```

  Point the domain's A record at this machine and open ports 80 and 443.
  The server downloads a pinned Caddy once into its data dir, writes the
  same Caddyfile the Docker stack uses, runs it as a child, and Caddy gets
  and renews the certificate from Let's Encrypt. On Linux, binding ports 80
  and 443 as a normal user needs one privilege grant; when Caddy reports the
  refusal, `serve` prints the exact `setcap` command to run once.
- **Behind your own proxy or domain:** `rootclaw serve --public-url
  https://rootclaw.example.com`, with the proxy rules from "Putting a proxy in
  front".

Later: `rootclaw pair --label "Kitchen iPad"` for another device
(`--client` for one that may chat but not change settings), and
`rootclaw sessions` to see or revoke them. `rootclaw serve` is a
plain foreground process. For unattended use, follow the
[systemd example](deploy-vps.md#keep-it-running): `rootclaw service install`
writes a unit that runs your built clone directly. Restarting that service
does not download or rebuild anything.

## Add a provider key from the browser

A browser paired with Full access can add or replace provider keys under
**Settings → API keys**: paste a key and it saves and checks itself. Keys are
write-only; the page shows connected-or-not, never the key. Without a browser,
`rootclaw engine set KIND --key-env VAR` does the same from the server's
terminal (see [install](install.md#3-configure-a-provider)). A `ROOTCLAW_*`
variable in the server's environment wins over a saved key.

## Connect a custom domain in Settings

For a self-hosted server, open **Settings → Remote access → Connect your
domain** from a browser paired with Full access. This is an address-setting and verification
flow, not a DNS or hosting service. Enter the domain to see a compact DNS record
with copy buttons for **Type**, **Name / Host**, and **Value / IP**. The full
hostname is shown; providers that already append the DNS zone need only the
relative name (or `@` at the zone root). Server/proxy instructions are under
**Advanced server setup**.

The IP comes from this server's network interfaces, never the browser, tunnel
hostname or an IP-echo service. Only a single unambiguous public IPv4 is shown.
For containers/NAT or hosts with multiple public addresses, an administrator can
set `ROOTCLAW_PUBLIC_IPV4` to the public IPv4 of the HTTPS proxy and restart ROOTCLAW.
This is a display hint, not proof of reachability; verification still checks
HTTPS and the workspace identity. If the IP is missing or invalid, the UI asks
for administrator help instead of inventing a DNS value.

To configure the connection:

1. Point your chosen name's DNS **A** record at the server's public IPv4 address.
   Add **AAAA** only when IPv6 routes to the same server.
2. Configure HTTPS with a reverse proxy such as Caddy. The Settings example uses
   your actual app and webhook ports; the [supplied Caddyfile](../deploy/Caddyfile)
   is the reference. Keep ROOTCLAW listening on loopback, forward the original Host
   and proxy headers, and keep event streams unbuffered. Caddy needs incoming
   ports 80/443 for its usual certificate setup. For containers, follow the
   Docker recipe below so Caddy can reach the loopback listener.
3. Enter `bots.yourcompany.com` (or its bare `https://` origin) and choose
   **Connect domain**. ROOTCLAW checks HTTPS and the workspace identity at that
   domain before saving it. An incorrect domain leaves the existing address
   unchanged.

The saved custom address takes precedence over the server's configured public
address for **new server pairing links**. Removing it restores that fallback
address, if any; neither action changes DNS, the proxy, bots, conversations, or
existing sessions. A different browser origin needs its own pairing, so keep
your original tab open until the new one works. The setting does not change
`ROOTCLAW_WEBHOOK_PUBLIC_URL`, existing webhook URLs, or the desktop companion's
managed connection. This feature is for self-hosted servers, not the desktop
app's managed phone endpoint.

## Docker (with HTTPS on your own domain)

For a single rootless Podman engine running the server, Caddy, and per-bot
desktops, see the optional [Podman full-stack recipe](../deploy/podman/README.md)
for Windows/WSL2 and Linux x64. It is separate from the Docker deployment below.

For local Docker Desktop or private Tailscale access without a public domain,
use the [local Compose setup](../deploy/local/README.md). It defaults to
`http://localhost:8080` and supports optional `.env` overrides.

One tenant = one container for the server plus Caddy for HTTPS.
Requirements: Docker with Compose, a DNS name pointing at the machine, and
ports 80/443 open.

```sh
git clone https://github.com/cryptyroot-ux/RootClaw && cd RootClaw/deploy
cp .env.example .env            # set DOMAIN
docker compose up -d --build
```

That builds the image from your checkout. No prebuilt image is published: the
Docker CI workflow builds with `push: false`, so `docker compose pull rootclaw`
has nothing to fetch.

Then mint a pairing code for your first device, and once paired add a
provider key under **Settings → API keys** (it is saved on the `data` volume,
so it survives restarts and image upgrades):

```sh
docker compose exec rootclaw node dist-server/rootclaw.js pair # prints a code, a link and a QR
```

Open the link (`https://<DOMAIN>/pair#code=…`) in a browser and it is
paired; see "Using it from your computer" for what a session is. Webhook
URLs (`https://<DOMAIN>/hooks/wh_…`) work without a session, and that is the
base the app prints on new hooks because the stack sets
`ROOTCLAW_WEBHOOK_PUBLIC_URL`. The URL carries no secret: senders put it in
an `Authorization: Bearer <secret>` or `x-rootclaw-secret` header. Older
addresses with the secret in the path still work but are deprecated and log
a warning (without the secret); rotate them with **Replace address** (or
`POST /api/webhooks/<id>/rotate`), since a secret in a path lands in proxy
access logs.

What the stack does, so you can adapt it:

- [`Dockerfile`](../Dockerfile) builds the UI and the self-contained
  server bundle, and runs them as an unprivileged user with `HOME=/data`.
  `--build-arg ENGINES="…"` (or `ENGINES=` in `.env`) still bakes npm
  packages into the image; RootClaw no longer runs agent CLIs, so leave it
  empty (the example `.env` still lists one).
- [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) runs Caddy
  **in the server's network namespace**, so Caddy reaches the server on
  `127.0.0.1` and the server never binds anything public.
- [`deploy/Caddyfile`](../deploy/Caddyfile) terminates TLS and forwards
  the real `Host` plus `X-Forwarded-For`/`X-Forwarded-Proto`; the server's
  own pairing is the login. A shared-password `basic_auth` block is there,
  commented out, if you want a second wall in front of pairing.

Upgrade with `git pull && docker compose up -d --build`. State (chats, routines,
saved provider keys, paired sessions) is on the `data` volume; back that up.

A build keeps the Chrome (and any `ENGINES`) it
installed first, because those layers sit beneath the app and stay cached
across code changes. To pick up the current ones, rebuild with a new tag:

```sh
docker compose build --build-arg CHROME_CACHE_TAG=$(date +%F) rootclaw && docker compose up -d
```

## From source

Requirements: Node 24+, pnpm, and an API key for one model provider.

```sh
git clone https://github.com/cryptyroot-ux/RootClaw && cd RootClaw
pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=6144 pnpm build  # web UI -> dist/
pnpm build:server                                  # server -> dist-server/

# choose where data lives and start the server
pnpm start --port 8799 --data-dir "$HOME/.rootclaw"   # = node dist-server/rootclaw.js serve
```

For something durable, let the CLI write the service for you:

```sh
rootclaw service install --domain rootclaw.example.com   # or --tunnel, --tailscale, or nothing
```

It renders a systemd unit (Linux) or a launchd agent (macOS) that runs the
same `rootclaw serve …` with your options, restarts it if it stops, and,
for `--domain`, grants the unit the capability to bind ports 80 and 443
without root. The file is written next to your data and the two commands
that install and start it are printed (they need `sudo` on Linux).
`rootclaw service uninstall` prints the reverse. Run it with the built
clone (`node dist-server/rootclaw.js service install …`): the unit points
at the Node binary and script that ran the command, so keep the clone where
it is. (Its help text still says `npm install -g rootclaw`; that package is
not published.)

Give the service a provider key (Settings → API keys, `rootclaw engine set`,
or a `ROOTCLAW_*_API_KEY` variable in the unit's environment) before you rely
on routines running unattended.

## Provider keys, billed per token

**Settings → API keys** takes the keys a whole workspace runs on. Keys are
write-only: the page shows connected-or-not, never the key, and checks a key
when you paste it. Each provider has its own key and server variable
(`ROOTCLAW_ANTHROPIC_API_KEY`, `ROOTCLAW_OPENAI_API_KEY`,
`ROOTCLAW_OPENROUTER_API_KEY`, `ROOTCLAW_OLLAMA_API_KEY`, `XAI_API_KEY` and the
rest; the full list is in [install](install.md#3-configure-a-provider)). The
server's own `ANTHROPIC_API_KEY` environment variable is deliberately ignored
for the workspace's Anthropic key; use the page, `config.json`, or
`ROOTCLAW_ANTHROPIC_API_KEY`.

A saved key goes only to its own provider and only to the workspace's
endpoint: an OpenAI-compatible instance in `config.json` with its own base URL
or its own key (a router or proxy) never receives it.

## Many client workspaces on one server

`rootclaw fleet` runs one workspace per client on a single Linux server,
each as its own OS user, its own `rootclaw@<name>` service on its own
loopback ports, its own data folder, brand, sign-in list and provider key,
reached at `<name>.<your domain>` through the system Caddy. Bots of one
workspace cannot read another's files or reach its API: the data lives in a
private home, the unit runs with a private `/tmp`, no new privileges and a
read-only system, and an nftables rule keeps each workspace's ports to its
own user, Caddy and root.

Once, as root, with the package installed permanently and a wildcard DNS
record (`*.example.com`) pointing at the server:

```sh
rootclaw fleet init --domain example.com
```

That writes the template unit, the fence and its unit, the workspace folders,
and adds `import /etc/caddy/rootclaw.d/*.caddy` to `/etc/caddy/Caddyfile`. Then per
client:

```sh
rootclaw fleet create acme --admin owner@acme.test --member @acme.test \
  --brand /root/acme-brand.json --anthropic-key-file /root/acme-anthropic.key \
  --cap 50 --memory 1G
rootclaw fleet users acme add bob@acme.test --chat-only
rootclaw fleet list
rootclaw fleet suspend acme      # 503 page, service stopped; resume undoes it
rootclaw fleet upgrade           # new release, then every running workspace restarted in turn
rootclaw fleet delete acme --yes # add --keep-data to keep the home folder
```

Give `init` `--operator USER` (the Unix user your own workspace runs as; the
user behind `sudo` by default) and it also installs the **fleet agent**: a
root service on a Unix socket only that user may open. Your workspace then
shows **Settings → Installations** (with the enterprise `admin` feature): create
an installation, add or remove who may sign in, suspend, resume, delete, upgrade
all, and see each one's spend this month. Every action goes through the
agent's audit log at `/var/log/rootclaw/fleet.jsonl`.

`https://acme.example.com` is up when `create` returns; the first admin signs
in with an emailed code. `ROOTCLAW_LICENSE_KEY` in the environment (or
`--license-key`) is carried into every workspace so a partner's white-label
key covers them all. Not root? Every command prints the exact steps to run as
root instead, and `--dry-run` always prints.

## Using it from your computer

Pair once, then use the server from any browser on any machine that can
reach it. On the server:

```sh
node dist-server/rootclaw.js pair                 # from a built checkout
pnpm rootclaw pair                                # from a checkout, no build
docker compose exec rootclaw node dist-server/rootclaw.js pair   # Docker
```

It prints a 12-character code (single use, five minutes) and, when the
server knows its public address (`ROOTCLAW_PUBLIC_URL`, set by the Docker stack),
a link like `https://rootclaw.example.com/pair#code=XXXX-XXXX-XXXX`. Open the
link, or open `/pair` on the address you use and type the code. The browser
gets a session cookie (30 days, renewed on use up to 180 days from pairing, revocable) and the app loads. Sessions are
listed and revoked at `GET`/`DELETE /api/auth/sessions` for now; a Settings
screen follows.

From the **desktop app**, use the server dropdown above Search → **Connect
to a server…**, or **Settings → Servers**. Enter the server's
HTTPS address or full pairing link, with an optional name. Custom domains and
Cloudflare tunnel addresses work; Tailscale is not required. Generate a fresh
link for each device: `rootclaw pair --label "My desktop"` creates an
owner link without the phone wizard; add `--client` for chat-only access.
A code already used by your phone cannot also pair your desktop.

Confirm the server address in the app's connection dialog, then finish pairing
on the server page. The app stays signed in across restarts. The workspace
dropdown switches between **This computer** and saved hosted workspaces, without
moving bots or chats. The **Server** menu and **Add Server from Copied Pairing
Link…** remain available there too (on Windows and Linux press Alt to show
the menu bar). The separate **Desktop companion** option in Settings is for
the six-digit code from another desktop app, not a self-hosted server's
12-character code. Older hosted UIs may not show the dropdown; use the native
Server menu to switch back until the server is updated.

After pairing, **Share this computer?** offers **Choose access** or **Not now**.
Nothing is shared automatically, unless you make the server your bots' home
(below). In **Settings → Servers → Computer
access**, choose read-only folders and optionally allow edits. Unrestricted
terminal and screen/app control are separate opt-ins, confirmed in a native
dialog. They can access information outside the selected folders. Share only
with a workspace you trust; its bots and AI providers may receive shared content.
A folder read takes a file of up to 2 MiB and a write at most 256 KiB;
transfers do not follow links or delete files. Local screen control also needs OS permissions and a supported
desktop driver. Microphone access is not included.

**Make the server your bots' home.** Bots work together only within one
place: bots on this computer can't reach bots on the server. To bring them
together, right-click the server's circle at the window's left edge and choose
**Make <server> my home**. The app moves this computer's bots, chats, memory,
skills, logins, apps and keys, and routines there the way it moves them to My
Cloud: everything is copied while you keep working, then at a quiet moment this
computer stops for good, the rest goes, both sides are checked, and the server
switches on what was on here, so no routine ever runs twice. The account area
says how it goes, and after a day of failing it says the move needs you, with
Try again. Afterwards the server is what the window opens, and this computer
works for it by itself as it does for My Cloud: no access dialog, only the
menu bar's item with Pause.

Until then, a bot that asks for a teammate living in your other place says where
that teammate lives and how to bring them together, instead of only that it
can't reach it: the app tells each place of yours the names of the bots your
other places have, and nothing more.

This is offered only for a server that is yours alone: you paired with it as an
admin, and its sign-in list names no members and no other admin (Settings →
People). A server other people sign in to keeps the explicit **Share this
computer?** flow above, and its bots stay where they are. Both sides need this
release: an older server says to update it first.

To move by hand instead, export a backup from this computer in **Settings →
Backups → Export backup**, then import it on the server in **Settings → Backups
→ Import backup**. API keys, engine sign-ins and paired devices stay where they
are on both sides; routines arrive paused. An older desktop app's **Copy this
computer here** is answered with "Update RootClaw to bring your bots here by
itself."

Only conversations you start yourself on that server can use what you share;
other people's bots, routines and webhooks there cannot. Keys and sign-in
stores (`~/.ssh`, cloud CLIs, browser profiles, keychains) and `.git`
internals stay out of reach of any shared folder, and the desktop keeps a log
of every request under **Computer access**.

Sharing works while this desktop is awake and running, including when viewing
another workspace. **Stop sharing** revokes access; closing the app stops the
connector. An action already sent to a local app may still finish. **Forget**
also stops sharing and signs this desktop out, without deleting the server's
bots or conversations. If sign-out cannot reach the server, the app warns you;
revoke its session there when reachable again, or if the device is gone.

What this changes about the trust model: the server still binds loopback
and still trusts programs on loopback as the owner, though never a browser
(below). A **paired session** is the second way in: a bearer token or the cookie, same-origin only, with a scope (`admin`
by default, `--client` for a device that may chat but not change settings or
pair others). Five bad codes from one address lock that address out for ten
minutes. Over plain HTTP (a LAN address without TLS) the cookie is not
marked `Secure` and travels in clear: use the Docker stack, Tailscale, or
another TLS front for anything beyond a trusted private network.

Native clients (CLI, scripts) send the token as `Authorization: Bearer …`
and take a 5-minute ticket from `POST /api/auth/stream-ticket` for the
event stream, because `EventSource` cannot set headers:
`GET /api/events?ticket=…`.

`GET /.well-known/rootclaw/environment` is public and tells a client what
it is talking to: a stable `environmentId`, the label, the version and
capabilities. Saved connections check the id so a reused address that now
points at a different server is refused loudly.

An SSH tunnel still works, and is the right answer when the server has no
address of its own:

```sh
ssh -L 8799:localhost:8799 you@your-server
# then run `rootclaw pair` on the server and open the "this computer:" link it prints
```

The browser signs in once through the tunnel, like any browser on the server
itself.

### A browser signs in

A browser never gets loopback trust, on any server: a request that carries
the `Sec-Fetch-Site` or `Sec-Fetch-Dest` header (every browser sends them to a
loopback address, and a page cannot remove them), or a WebSocket handshake
with an `Origin`, needs a session: a web page is not the person who owns the
server, even when it runs on the same machine. Programs are unaffected: the
CLI, scripts, `curl` and the companion send neither header.

So the first time you open the web UI in a browser on the server's own
machine, it shows the sign-in page. `rootclaw serve` and `rootclaw pair`
print a link for it:

```
this computer: http://127.0.0.1:8799/pair#code=XXXX-XXXX-XXXX
```

Open it and choose **Connect** (or type the code on the sign-in page); the browser
keeps its session cookie from then on. `rootclaw` (the guided start) prints
the same link when it opens the browser. The desktop app is unaffected:
its window adds the app's own per-launch owner header to every request and
WebSocket it sends to its server, and no other Electron session may reach the
server at all.

For development, `pnpm dev:server` sets `ROOTCLAW_DEV_TRUST_LOCAL_BROWSER=1`, so a
browser on Vite's dev page (`pnpm dev`) is the owner as before. The server
honours it only when it runs from source with owner trust, logs a warning, and
ignores it in a build, the desktop app, a hosted workspace and RootClaw Cloud.
Run `ROOTCLAW_DEV_TRUST_LOCAL_BROWSER=0 pnpm dev:server` to try the sign-in.

### Loopback trust: owner or service

Every bot's shell runs on the server as the same user, so every bot is a
loopback caller too. On a server one person uses that is fine: the bots are
theirs. On a workspace several people share it is not: a user could ask a
bot to `curl` the local API and change settings, keys, MCP servers or
webhooks as the owner. The server therefore decides at start-up how far a
loopback request **without a session** is trusted, and logs it:

```
local requests: owner trust (self-hosted default)
local requests: service trust (hosted workspace); without a session, loopback may use only health, the Slack worker's guarded routes and bot capability routes
```

| Trust | Default for | A session-less loopback request may |
|---|---|---|
| `owner` | a self-hosted server, the desktop app | do everything, as today |
| `service` | a hosted workspace: any of `ROOTCLAW_ADMIN_URL`, `ROOTCLAW_ADMIN_WORKSPACE` or `ROOTCLAW_ADMIN_MEMBERSHIP` set (shared-workspace Full access only works there, so it is covered too) | read health, who-am-I, the bot list, a thread's messages and a bot's picture; open a thread; send through the guarded route; watch and stop its exact request; withdraw a queued line; **decline** a card; use the bots' own capability routes (`/api/internal/*`, which check their own per-turn token) |

Under `service`, everything else from loopback needs a real session and
answers 403: settings and keys (`/api/config`), instances, MCP servers,
webhooks, sessions and pairing, people and sign-in lists, usage, budgets,
the decision log, fleet, workspace backups, creating or loosening bots, and
approving or answering any card. The Slack worker (the only session-less
local caller a hosted workspace has) needs nothing more and keeps working
unchanged. Sessions — a portal sign-in, an email sign-in or a pairing — work
exactly as before, with their own scopes.

Set `ROOTCLAW_LOOPBACK_TRUST=service` on a self-hosted server people share (with
an email sign-in list, say), or `ROOTCLAW_LOOPBACK_TRUST=owner` to opt a hosted
workspace back into the old behaviour (the log then warns). Any other value
means `service`. The desktop app ignores the setting: its local changes
already need the app's own per-launch capability. RootClaw Cloud ignores
it too and is always `service` (docs/cloud-pro.md).

With `service` on a self-hosted server:

- `rootclaw serve` still prints the first pairing code. It hands the
  server it starts a one-off secret over the server's stdin (never its
  environment, which every engine inherits), and that secret opens the
  pairing route for that CLI alone. Pass `--no-pair` to skip the code; if
  the server refuses one anyway, `serve` says why and keeps running.
- `rootclaw pair` and `rootclaw sessions`, run later from another
  terminal, are refused like any other admin change and say so. Pair from
  Settings → Remote access while signed in as an admin, or let people sign
  in with their email (`rootclaw access add you@example.com`, which edits
  the sign-in list on disk).
- A browser on an SSH tunnel gets the sign-in page instead of the app.
- The MCP server script works with `ROOTCLAW_TOKEN` set to a paired session.

**What `service` does not close yet.** Any bot's shell can still do
everything the Slack worker does, and on a shared workspace that is a real
gap: it can post into any bot's thread through the guarded route, including
an existing Full-access thread (`expectedApprovalMode: "full"`), and while
shared Full access is on it can open new Full-access threads. Either way the
work runs with Full access and no card, so a user who can talk to a bot
can get Full access through it. It can also stop a request and decline a
card. It cannot approve a card, change settings, keys, people or sessions,
or loosen a bot's permissions. The planned fix is a relay token that only
the Slack worker holds, so these routes stop answering session-less loopback
at all; until then, turn shared Full access on only where every user may
have Full access. Files the server's user owns (`config.json`, the engine's
environment) are also still readable from a bot's shell; that needs a
second user for engines, a separate change.

## Sign in with your email

A pairing code is fine for the owner's own devices. For a workspace other
people use every day, let them sign in with an emailed code instead: set an
allow-list, and `/pair` on your server offers "Sign in with your email" first.

```sh
ROOTCLAW_SIGNIN_EMAILS="her@yourcompany.com, @yourcompany.com"   # full access
ROOTCLAW_SIGNIN_MEMBER_EMAILS="freelancer@example.com"          # chat and approvals only
```

Signed in as an admin? Settings → Remote access → **Who can sign in with an
email** edits the same list in the browser, no command line needed. With the
`rootclaw` CLI, the same thing from the command line, with the server running
or not, no restart needed:

```sh
rootclaw access add her@yourcompany.com
rootclaw access add freelancer@example.com --chat-only
rootclaw access list
```

An entry is an address or `@domain` (everyone at that domain). Admins get
the same access as a pairing code from `rootclaw serve`; users get the
chat-only scope, the same as `rootclaw pair --client`. The same lists live
in `config.json` under `signIn.admins` and `signIn.members` and can be changed
through the settings API without a restart; the environment variables win
when set, which is how a container or a service unit is bootstrapped.

The code itself comes from `accounts.rootclaw.example`, the RootClaw
account service, so your server needs no email credentials. Your server asks
it to send the code, checks the answer, and then issues its own session
cookie: the browser only ever talks to your server, and who is welcome is
decided only by your allow-list. Wrong codes count against the same lockout
as pairing codes. Sessions from a sign-in show the email in
`rootclaw sessions` and can be revoked the same way.

### Inviting people

**Settings → People** lists who may sign in, their role, when they were last
seen, and what each person spent this month. **Invite** adds an address (or
`@company.com` for everyone there) and shows a link like
`https://your.host/pair?email=name%40company.com`: it opens the sign-in page
with the address filled in, and the one-time code still goes to that address.
Roles change with one click; removing someone stops new sign-ins.

On a hosted workspace whose members your organization's Admin manages
(`ROOTCLAW_ADMIN_MEMBERSHIP=portal`), this list decides nothing, so Settings →
People shows, read-only, who has signed in and what they spent, with a
**Manage people in Admin** link to that workspace in Admin → People. Remote
access there lists signed-in devices and offers no pairing codes, since a
hosted workspace refuses them.

### Who may answer a card

Approval cards are the provider's own (see the approval modes); RootClaw
adds none. On a workspace several people share — portal membership, or an
email sign-in list that names users — it narrows only whose answer counts,
and only when the card can be traced to a person:

- a card for a request a user sent, or in a thread a user opened, is
  theirs to answer (admins and the owner may answer any card);
- a thread a bot opened while working on someone's request (a job it handed
  a teammate with `coordinate_bots`) is traced back to that person, so the cards of work done
  for them are theirs too;
- a card that names nobody — sent by the owner on this machine, by a
  routine or webhook, from Slack (until Slack passes the asker through), or
  in a thread from before this existed — may be answered by any user, as
  before;
- a session-less local caller under `service` trust may only decline.

On a workspace with one person, anyone who can chat may answer, as before.
Each answered card records who answered it (`card.answeredBy`), and so does
its row in the decision log. Who a thread was opened for is kept in a
server-private file (`<data dir>/thread-starters.json`), never sent to clients.

### Who can see a bot

On a workspace several people share, an admin can limit who sees a bot:
**Bot settings → Who can see it** (in the browser, for admins), or when
creating it — **New bot** offers the same choice, and `POST /api/bots` and
`POST /api/teams/import?visibility=…` take it — so a bot for a sensitive job
is never shown to everyone first. Over the API it is `visibility`:

- `"everyone"` — every signed-in person, the default and today's behaviour;
- `"admins"` — admin sessions only;
- `{ "people": ["ada@company.com", "@hr.company.com"] }` — the listed
  addresses and `@domain` entries, plus admins.

It is access control, not an approval step, and it applies at once. For a
user who may not see a bot, the server answers the bot, its threads and
their messages, images, exports, reactions, cards, sends, routines, runs and
attachments exactly as it answers an id that does not exist (404), and leaves
the bot out of the bot list, search results, routines, webhooks, the team map
and the live event stream. Every bot a user is sent, by any route, comes
without its audience list or the ids of teammates they cannot see. When an
admin changes a bot's audience, every user's open app reconnects and
reloads exactly what that person may now see (a user who was away and
resumes from an older point gets the same fresh load); admins' apps are left
alone.

- **Rooms.** A room is one shared transcript, so its bots must be visible
  to the same people: creating a room, adding a bot to one, or scheduling a
  call between bots that other people see differently is refused with a
  plain sentence (for admins too). If an admin later restricts a bot that
  is already in a room, the change is allowed and the room narrows to the
  people who can see all its bots. A room also keeps the narrowest audience
  it has ever had (its floor): taking the restricted bot out, deleting it,
  or widening it again never shows the transcript to more people. A user
  sees a room only if they can see every bot in it and the floor admits
  them. Such a room stays out of the recall, recent-work brief and daily
  memory log of any bot more people can see, and that bot cannot write
  notes from it into its memory — so a bot everyone sees cannot repeat, in
  a chat with anyone, what a restricted bot said there. To widen a room, an
  admin says so explicitly: **Bot settings → Who can see it** lists the
  rooms visible to fewer people than the bot, each with **Show … to everyone
  its bots allow** (`PATCH /api/groups/:id` with `{"resetAudience": true}`),
  which resets the floor to what the room's current bots allow and is
  recorded in the admin activity log.
- **Departments.** A department (sidebar section) is listed to a user only when it
  holds a bot or room they can see.
- **Bots working together.** A bot reaches any teammate, in any department
  (`coordinate_bots`, its roster and `list_bots`, @mentions, a Chief's team),
  but only when exactly the same people can see both: otherwise one bot's
  thread could carry the other's answers to people who cannot see it. Bots nobody restricted all
  share "everyone", so nothing changes until an admin restricts one. A bot a
  Chief creates (directly, or in a reviewed team setup) gets exactly the
  Chief's audience, and a copy of the Chief's connected apps.
- **Who sees everything.** Admin sessions, the owner on this machine, and a
  session-less local service (the Slack worker under `service` trust) see
  every bot. A pairing-code device with no email sees only bots everyone
  can see. Users never receive a bot's audience list.
- **Files.** An attachment is refused only when everything that uses it —
  a message in a thread, a bot's picture — is hidden from that user. A
  file nothing uses yet (someone's own upload) is served; its name is random.
- **Not covered.** Words already quoted into a conversation a user can
  see (an earlier hand-off, a message copied by hand, or something a bot
  wrote into its own memory files with its file tools while it shared a room
  with a restricted bot) stay there. A bot's
  shell can still read files on the server, as it always could. Slack is
  decided in your organization's Admin: whoever may message a bot's Slack
  app reaches that bot there.

The desktop app has no chat-only user sessions and does not show this setting;
nothing there changes.

On the Workspaces screen, creating a client workspace shows the same kind of
link for that workspace's admin, so a client gets one address, one workspace
and one link.

## Attachment storage

Files people attach, and pictures a bot shows inline, live in the
`attachments` folder of the data directory. Nothing there is deleted, since
old messages still point at it, so the server stops taking new files once the
folder holds 512 MB. A team fills that sooner: set
`ROOTCLAW_ATTACHMENTS_MAX_BYTES` in the server's environment and restart, for
example `ROOTCLAW_ATTACHMENTS_MAX_BYTES=4294967296` for 4 GB.

## Putting a proxy in front

Any reverse proxy works, given three things:

1. **Forward the real `Host`** and set `X-Forwarded-Proto`. Any request that
   carries forwarded headers is treated as remote and needs a session, so a
   proxy that rewrites `Host` to `127.0.0.1`, or forwards a stranger's
   `Host: localhost`, gains nothing. The proxy's scheme decides whether the
   session cookie is `Secure` and is part of the same-origin check.
2. **Set `X-Forwarded-For` yourself** (Caddy and nginx do by default) and
   drop any the client sent: the pairing lockout counts failures per first
   forwarded address.
3. **Do not buffer** the event stream (`flush_interval -1` in Caddy,
   `proxy_buffering off` in nginx); the UI streams events over SSE.

Plus one convenience: set `ROOTCLAW_PUBLIC_URL=https://your.domain` so pairing
links, and `ROOTCLAW_WEBHOOK_PUBLIC_URL=https://your.domain` so hook URLs, are
printed with the public address. [`deploy/Caddyfile`](../deploy/Caddyfile)
is the reference implementation.

## Opening a desktop from another device

In a paired admin browser, as in the desktop app, **Take control** turns the
Computer panel's picture into the live desktop for Local VMs and your own VPS,
through the same address as RootClaw; **Full screen** fills the window with
the same session. Shared, per-bot and pool Local VMs connect through their
managed container's loopback port. VPS desktops connect
through an SSH tunnel opened by the server. Neither needs an additional public
port or viewer origin setting. Keep Local VM VNC ports bound to loopback and
VPS VNC ports private.

Your app reverse proxy must support WebSocket upgrades, preserve `Host`, and
set `X-Forwarded-Proto` to the browser-facing scheme. This also applies when
using Tailscale Serve. Viewer requests require an admin session. Logging out
or revoking that session closes open viewers. Client-only pairing does not
grant desktop control.

An open Local VM viewer keeps that VM's idle timer active. Remote VPS viewers
share a tunnel; it closes 30 seconds after the last viewer leaves, allowing
reconnects during that interval. **Hand control back**, closing the panel or
leaving the page gives the computer back to the bot.

Use **Keyboard** to send text from a phone and **Clipboard** to exchange text
with the desktop; clipboard edits sync automatically. The desktop fits the
window, with fullscreen available when the browser supports it. Hosted Cloud
keeps its provider-issued viewer in its own window or tab.

These controls are in the web app. The native phone apps have their own
computer viewers; use a paired browser for interactive Local VM or VPS access.
For the proxy boundary and offline regression checks, see the
[viewer verification recipe](verification/desktop-viewer.md).

## Using it from your phone

Signed in on a hosted server as an admin (with a pairing code or your
email)? Settings → Remote access → **Pair a phone or another computer**
creates a one-time code with a QR right in the browser, and lists every
paired device with a sign-out button. Nobody needs the command line.

The iOS app pairs with a server the same way a laptop does: scan the QR
code that `rootclaw serve` (or `rootclaw pair`) prints, paste the
whole `https://host/pair#code=…` link into the address field on the pairing
screen, or type the address and then the code. The phone gets a session of
its own, listed and revocable with `rootclaw sessions`. What it may do is
the code's scope: a code from `rootclaw pair` carries `admin` and the app
shows everything; a code from `rootclaw pair --client` (also what the
guided phone setup mints) can chat, approve and read, and the app hides
creating bots and sections, changing models, generating avatars, connecting
apps and cloud desktops — those stay with the owner. A server reinstalled at
the same address has a new identity; the app then asks to pair again rather
than present the old session to it.

Both native apps pair this way. `rootclaw pair --phone android` prints the
app-scheme QR that Android's scanner needs, and the iOS app accepts either
that QR or the web link. Pass `--phone` whenever nothing is watching the
terminal, such as `docker compose exec rootclaw node dist-server/rootclaw.js
pair --phone android --public-url https://your-domain`, since a scripted run
never reaches the question the interactive command asks. Nothing extra to install, and the phone becomes a
session like any other.

Older way, still supported, and only useful on a LAN or a tailnet: run the
companion sidecar next to the harness and pair by its own QR. It advertises
on your private networks (Tailscale-aware) and issues its own per-device
credentials, which are **not** `rootclaw sessions` and are revoked from
its own page at the `127.0.0.1:8811/#token=…` link it prints. It also serves phones over cleartext HTTP
on port 8810, so do not expose it from a public server. It ships only in a
git checkout: the Docker image does not contain it.

```sh
node --experimental-strip-types companion/src/index.ts
```

## Usage and costs

Every settled turn is appended to `<data dir>/usage/YYYY-MM.jsonl`: which
bot, which model and engine, tokens in and out, the cost the engine reported
(real on a metered key, an equivalent on a subscription, absent when the
engine reports none), and who asked: the email a person signed in with, the
device label otherwise, a routine, another bot, or this computer. No message
text is stored. **Settings → Usage → History** shows a period grouped by bot,
model, person, day or engine, and **Export CSV** downloads one line per turn.
Owners can read the same over the API:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://rootclaw.example.com/api/usage?from=2026-09-01&to=2026-09-30&groupBy=user"
curl -H "Authorization: Bearer $TOKEN" -o usage.csv \
  "https://rootclaw.example.com/api/usage.csv?from=2026-09-01&to=2026-09-30"
```

Dates are inclusive, UTC, at most a year apart; without them you get the
current month to date.

### When an engine runs out

When a turn ends on a usage limit (a subscription's 5-hour or weekly limit,
one model's own weekly window, a model's extra usage credits), the bot carries
on by itself with another AI the person has set up until that limit resets,
and the person hears it once for that stretch of the limit, as a notification:
"Ollama Cloud reached its limit until 14:00, so Kai is using OpenRouter meanwhile." With
no AI to carry on, it says the bot waits instead. Nobody is asked.

- **Which AI.** For one model's own limit, the same AI's default model first;
  then the backups chosen for the bot or in Automatic recovery; then the AI a
  new bot would get. Only an AI that can run a turn now (has a key, allowed by
  your organisation, not limited itself) with the tools and the working folder
  the current one has, and one the conversation's approval level can move to
  without asking.
- **What moves.** The person's message that met the limit is sent again on that
  AI, in that conversation alone; the bot's own model and its other
  conversations stay where they are. While the limit lasts, every new turn and
  conversation of every bot that uses the limited AI (a person's, a routine's,
  a webhook's) goes straight to that AI without asking the limited one first,
  and a routine run the limit stopped starts again on it.
- **How long.** The limited AI is held until the reset it named, or for an hour
  when it named none or named one already past; the next turn after that hour
  checks it again. One model's own limit holds that model alone, and for at
  most six hours before it is tried again. The holds are saved
  (`limit-holds.json`, `limit-takeover-holds.json`), so a restart, an update or
  a sleep the Cloud was stopped for keeps them. A conversation that moved goes
  back once its AI's limit has reset, with one line saying so.

This is on by default. Start the server with `ROOTCLAW_QUOTA_SWITCH=0` to switch it
off: then only the backups Automatic recovery names take over, and the
notification says the bot waits. Any other value, or none, leaves it on. It
has no setting in `config.json` yet.

### When an engine is signed out

When a turn stops because its AI is signed out (its sign-in expired or was
revoked), the person hears it once, in that conversation and as a
notification: "Claude is signed out on the Cloud. Sign in again in Settings →
AI to keep using it.", with a Sign in button that opens those settings. Each
later refused turn still shows that it failed, with no second notice; its
Chief gets one incident, not one a turn. An account out of credit, which some
engines stop the same way, is no sign-out.

The backups a turn its AI never started would get carry on meanwhile (the
bot's own backup AIs, or else the app-wide backup while Automatic recovery is
on), by the same rules as a usage limit (another sign-in to the same AI is fine
here, since nothing is rotated around a limit): the person's message is sent
again there, every new turn and conversation starts there, and a conversation
that moved goes back once the AI is signed in again in the app, or a turn on it
works. No AI is picked for a sign-out by itself, so with no such backup nothing
moves. A new turn tries the signed-out AI again an hour after its last refusal,
unless its status still says signed out.

### Which engine a new bot uses

A saved default model (Settings, `rootclaw setup`, or the New Bot
defaults) always wins. Without one, new bots get the first provider that can
run, in the order of `instances`; a provider ready only through free models
(no key of the person's own) comes last.

The server picks at once at start, then sends the person's own engines one
tiny test message each in the background ("Reply with the single word OK",
90 seconds at most), best first, stopping at the first that answers. One
miss alone doesn't move the default: that engine is tried again two minutes
later. Two misses in a row move the default to the best engine that
answered; the engine is tried again ten minutes later, then once an hour.
An engine that already answered (for example one the welcome checked) can
take the default after a single miss. An organization's models and the
trial credit are never tested this way. Results are kept for a day per
engine and sign-in in `<data dir>/providers/ai-checks.json`, so a restart
doesn't send them again. On a later start, where the engines are read one at
a time, nothing is tested or moved until that read ends: never on the status
the last run recorded.

The first bot the app made follows the default until someone writes to it
or picks a model for it or one of its conversations: it moves only after a
test result, only to an engine that answered, and only away from one whose
latest test missed or that is signed out or turned off, or up to a better
one. A status read that timed out moves nothing. No other bot ever moves. To stop the
background test messages, start the server with `ROOTCLAW_AI_CHECKS=0`.

### The decision log

Every approval decision — a rule that let a tool call through, a card that
was shown, and a person's answer, with who gave it (the session's email or
device label, `loopback` for the owner, `worker` for a session-less local
service) — is appended to `<data dir>/decisions/YYYY-MM.ndjson` (0600,
credentials redacted). Month files are kept for at least 180 days; set
`decisions.retentionDays` in `config.json` (or through `PUT /api/config`),
or `ROOTCLAW_DECISION_RETENTION_DAYS`, to keep them longer or shorter (1–3650
days; the environment wins). A month is deleted only once all of it is older
than the window. An older server's `decisions.ndjson` and `.1` are still read
and age out the same way. Admins can read it back:

```sh
curl -H "Authorization: Bearer $TOKEN" "https://rootclaw.example.com/api/decisions?limit=200"
curl -H "Authorization: Bearer $TOKEN" -o decisions.csv \
  "https://rootclaw.example.com/api/decisions.csv?from=2026-09-01&to=2026-09-30"
```

The CSV has one line per decision (time, decision, source, bot, tool,
summary, rule, unattended, answered by, thread, request); cells that would
start a spreadsheet formula are prefixed with `'`.

### The safety floor

Full access answers every permission request for a bot, and a saved command
answers one. The safety floor is a short never-list that neither can answer:
a recursive delete of the filesystem root, of the home directory or of a
top-level system directory (`rm -rf /`, `rm -rf ~`, `rm -rf /etc`);
formatting or overwriting a disk (`mkfs` on a device, `diskutil eraseDisk`,
`dd of=/dev/sda`, a redirection into a disk device); and a fork bomb. Making
a filesystem in an image file or on a loop device is not on it.

It is off unless you switch it on: set `safetyFloor.enabled` to `true` in
`config.json` (or through `PUT /api/config`), or start the server with
`ROOTCLAW_SAFETY_FLOOR=1`, which turns it on whatever the file says.
`GET /api/config` reports whether it is in force as `safetyFloor.enabled`.

**It is not applied on a Windows server yet.** There the setting is accepted
and does nothing: no command is checked, denied or held, and every approval
behaves as it does with the setting off. The server says so once at startup
(`[safety-floor] … not applied on a Windows server yet`), and
`GET /api/config` reports `safetyFloor.enabled: false`. Telling cmd,
PowerShell and Git Bash apart needs to know which shell a request is for,
which the server does not know yet.

With it on, on macOS or Linux, a command on the list that a grant was about
to allow is denied instead. The bot is told why, the conversation shows
`Blocked by the safety floor: …`, and the decision log gets an `auto-denied`
row with source `safety-floor`. A card you answer yourself is not overridden:
at "Ask for approval" the request still reaches you, and your Allow stands.
The floor applies to every bot the same way, and it only checks automatic
allows: Full access, a saved command, and "Always allow this session". A turn
a guest drives always asks, so a person answers its cards.

A command the floor cannot read is not approved automatically either: one
with a quote or heredoc that never closes, or longer than 32 KB. The request
comes to you as a card instead, and the server log says so once, without the
command. An API-key bot at Full access has no card to show, so there the call
is refused.

It reads a command as a POSIX shell line. cmd commands (`rd /s /q`,
`format C:`) are not evaluated: a Mac or Linux machine does not run them, so
a server there that drives a Windows machine gets no protection for what
runs on it. PowerShell is the exception, because PowerShell 7 runs on macOS
and Linux: what follows `pwsh -c` or `powershell -Command` is read too, both
as a POSIX line and as PowerShell, so `pwsh -c 'rm -rf /'` and
`pwsh -c 'Remove-Item -Recurse -Force $HOME'` are blocked.

Every bot runs on the built-in engine, which asks the server about every
shell command, so the floor covers all bots, at Full access and under "Always
allow this session". Treat it as a net under saved commands and automatic
approvals, not as a sandbox.

### Admin activity

On a workspace several people share — a hosted workspace, an email sign-in
list that names more than one person or a whole `@domain`, or a device paired
(or a pairing code open) with chat-only access, whether before or after the
change — every admin change is recorded beside the decision
log, in `<data dir>/admin-activity/YYYY-MM.ndjson` (0600), and kept for the
same window (`decisions.retentionDays` / `ROOTCLAW_DECISION_RETENTION_DAYS`; a
quiet server prunes on a timer, and pending rows are written out at
shutdown): settings
(which keys changed), sign-in lists and people, pairing codes and revoked
sessions, webhooks, MCP servers, engines and keys, bots created, deleted or
given different permissions, spend limits and prices, and who can see a bot.
Each row names who acted — the session's email or device label, `This
computer` for the owner, `Command line` for `rootclaw` commands such as
`rootclaw access add` — and the values before and after. Values are
redacted: anything under a key that names a credential, every value in a
headers or environment map, the value after a flag such as `--api-key` or
`-k`, URL parameters such as `?key=`, a token before a URL's host
(`https://TOKEN@host`), and key-like URL path parts (`/s/<key>/sse`) are
written as `[hidden]`, so a key change
shows that the key changed and never the key. Each row covers only what that
request named or saved, so two admins changing things at the same moment are
each credited with their own change. The desktop app, and a server one person
uses, keep no such log.

**Settings → Activity** (admins, in the browser) shows these rows together
with the cards people answered, filtered by who, what and when, and exports
them as CSV. The same over the API:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://rootclaw.example.com/api/admin-activity?from=2026-09-01&to=2026-09-30&what=visibility"
curl -H "Authorization: Bearer $TOKEN" -o activity.csv \
  "https://rootclaw.example.com/api/admin-activity.csv?who=ada@company.com"
```

`what` is `all` (admin changes and answered cards, the default), `approvals`,
`decisions` (every decision, automatic ones too), or one of `config`,
`people`, `session`, `webhook`, `mcp`, `engine`, `bot`, `budget`,
`visibility`; `who` matches part of a name or email; without `from` the list
starts 30 days ago. Nothing here is sent to your organization's cloud Admin,
which keeps its own activity log.

## Spend limits and sell prices (enterprise)

With the `budgets` entitlement, **Settings → Usage → Monthly spend limit**
caps the workspace: once the month's cost reaches it, no bot starts a turn,
whether a person wrote, a routine fired, a peer asked or a webhook arrived,
until an admin raises it. A warning shows at a configurable percentage, and
admins get one in-app notification the first time each month crosses the
warning and one when it reaches the limit (a new month or a new limit starts
over).

The figure is every cost in the usage ledger. A provider that reports tokens
but no price gets an **estimate** from a built-in list
of vendor list prices (`server/model-prices.ts`, each entry with its source
and the date it was read) and marks the row `costSource: "estimated"`. A model
that is not in the list is unpriced and not counted; Usage says how many
turns that was. Estimates use each vendor's standard short-context rate, so
long prompts, cache writes and priority tiers cost more than estimated.

With the `billing` entitlement, **Sell prices** takes your own price per
million tokens by model id, `driver/model`, or `default`, and History and the
CSV export gain a **billable** column next to the provider's cost. For an
engine that reports no cost, a price you set for that exact model also
replaces the list price in its estimate; `default` is used only for models
the list does not know. Both are plain settings in `config.json` (`budgets`,
`billing`) and through `PUT /api/config`.

## A bot that also runs outside the server

Some engines have their own long-running front door — a Hermes Agent Telegram
gateway, a Slack bot, an OpenClaw session. That process is the same bot with
the same workspace and memory, but the server did not spawn it, so it holds
none of the turn-scoped capabilities the peer-comms tools need and cannot hand
work to its teammates.

Give it a standing one with `external-runtimes.json` in the data directory,
mapping the bot's id to a secret of at least 32 characters and one existing
thread owned by that bot. Use the bot and task `threadId` from the local
`GET /api/bots` response; selecting a different thread in the sidebar will
not change this binding. This connects peer communications, not the external
engine's filesystem or login configuration.

For a **new** file (add entries to the existing JSON instead if already set up):

```sh
umask 077
BOT_ID=your-bot-id
THREAD_ID=your-existing-thread-id
TOKEN=$(openssl rand -hex 32)
printf '{ "%s": {"token":"%s","threadId":"%s"} }\n' "$BOT_ID" "$TOKEN" "$THREAD_ID" > ~/.rootclaw/external-runtimes.json
chmod 600 ~/.rootclaw/external-runtimes.json
```

Keep the file private (`600` on Unix; restrict its Windows file permissions).
A Unix file other users can access is ignored with a warning. It is read on
demand, so adding, removing or rotating a token needs no restart, including
requests waiting on a body, approval or status poll. Use a different secret
for each bot. Deleting or archiving the bound thread disables its token; it
never silently moves to another conversation. A bare token without `threadId`
is rejected, including on bots that currently have just one thread.

The runtime runs the bundled MCP bridge from the source checkout with the same
bot, thread and token (replace the port with your server's actual address):

```sh
ROOTCLAW_HARNESS_URL=http://127.0.0.1:8799 ROOTCLAW_BOT_ID=$BOT_ID ROOTCLAW_THREAD_ID=$THREAD_ID \
  ROOTCLAW_COMMS_TOKEN=$TOKEN ROOTCLAW_EXTERNAL_RUNTIME=1 \
  node --experimental-strip-types server/drivers/agents-proxy.ts
```

Scope is deliberately narrow: the token is an *agents* capability for that
bot's pinned thread only, and the server accepts just three kinds of route
with it — list peers (`GET /api/internal/agents`), hand work on
(`POST /api/internal/coordinate-bots`) and read how it went
(`GET /api/internal/assignment-status`). Opening threads, creating bots or
rooms, skills, memory and every other internal route answer 403. The bridge
offers the one tool surface every turn gets (docs/runtime-contract.md §9):
`coordinate_bots` (work; a question with `consult: true`; a one-way notice
with `reply: "none"`) and the read-only `assignment_status`. Every call from
the standing capability is its own root on the job
runtime with `reply: poll`: it completes without a turn once the teammates'
work settles, and the runtime reads the results with `assignment_status`,
long-polling `wait_ms` (at most 240 s) on the root's `rootId` or a receipt's
`requestId` from the same long-running process, without inventing a turn end.
A settled hand-off never wakes the bot's own engine on that thread. The
server still enforces peer access and approval settings. A free teammate
starts at once; a busy one is queued on the runtime until a slot frees
(docs/runtime-contract.md §2). Regular in-app turns keep their existing
dispatch timing.

The credentials stay on this server and are excluded from workspace backups;
restoring a backup preserves destination registrations. Never put this token
in chat or source control. Everything else the server offers still needs the
owner's session or a per-turn capability.

Verification: [external runtime fixture](verification/external-runtime.md).

## A bot stuck on a failing command

Every server shows a chat notice when a bot repeats the same tool call 5, 10
and 20 times in one turn. That notice only tells you. The loop guard, which is
off by default, also tells the bot:

- Set `loopGuard.enabled` to `true` in `config.json` (or through
  `PUT /api/config`), or start the server with `ROOTCLAW_LOOP_GUARD=1`. When the
  same whole shell command fails the same way five times in a row
  (`loopGuard.steerAt`, 2-1000), the server puts one short note into the
  running turn saying so. A command that succeeds, or that fails differently,
  ends the count, so a turn that re-runs its tests after each edit or polls a
  build is left alone.
- Stopping the turn is a separate choice. Set `loopGuard.stopAt` (2-1000), or
  `ROOTCLAW_LOOP_GUARD_STOP_AT`, and the turn is stopped at that many identical
  failures in a row, with a line in the chat that names the command and offers
  Retry. Leave it unset and the guard never stops a turn. A wait that fails
  until something is ready (`curl -f` against a server that is still starting)
  counts as a failing command, which is why the stop is not on by default.

The note and the stop cover the built-in engine too: the note goes into the
running turn as a steer, and the stop interrupts it like the Stop button. They
do not cover turns in a room yet. `correctiveRounds`, below, is an extra on top
of them, not a replacement.

Bots on API models (xAI, Mistral, Groq, Greenference, Cerebras, Meta, MiniMax or an
OpenAI-compatible endpoint) end a turn as failed when a tool call failed and
the bot then answered. With the loop guard on, set `loopGuard.correctiveRounds`
(0-5, default 0) and such a bot is sent back to re-run the failed call up to
that many times first; the turn counts as done only if the tools it runs after
that succeed. A tool call that was denied is never sent back.

## A turn that goes silent

The server stops a turn that has sent it nothing for 20 minutes
(`ROOTCLAW_TURN_STALL_MS`) and says why in the chat. Engines report a tool only
when it starts and when it ends, so while one of the turn's tools is still
running the turn may stay silent for up to `ROOTCLAW_TOOL_STALL_MS` (default 2
hours). Any event from the turn starts the silence over, and time spent waiting
on a person or a computer never counts. Either way the turn stops with "no
activity for N minutes".

Both take whole milliseconds. `ROOTCLAW_TURN_STALL_MS` is never below 60000 (one
minute) and `ROOTCLAW_TOOL_STALL_MS` never below `ROOTCLAW_TURN_STALL_MS`. A value that
is not a positive finite number (empty, `65m`, `0`, a negative number,
`Infinity`, `1e309`) leaves the default. Set them in the server's environment
and restart it; the restart stops every running turn.

A turn in a room also has a limit of its own, `rooms.turnTimeoutMinutes` in
`config.json` (default 5 minutes, 1-1440, which one conversation can replace).
It stops a member's turn that shows no progress for that long. While one of the
turn's tools runs, the turn may show nothing for up to 60 minutes (the longest
an MCP call can be set to take) or the room's limit if that is longer. These two
settings do not change it.

## Updating

Pull and rebuild the clone, then restart ([details](deploy-vps.md#update)):

```sh
git pull && docker compose -f deploy/docker-compose.yml up -d --build   # Docker
git pull && pnpm install --frozen-lockfile && NODE_OPTIONS=--max-old-space-size=6144 pnpm build && pnpm build:server && sudo systemctl restart rootclaw   # from source
```

Routines and queued work survive restarts. A teammate turn in flight runs
again once at the next start, told to check what it already did, and the bot
that asked for it is told. A person's own turn and a running routine are not
run again: the conversation says it was interrupted. Update between runs
where you can.

Stop the server before a filesystem backup so SQLite is copied consistently.
Back up the entire app data directory and, separately, the service user's
engine credentials, browser state, and external workspaces. For Docker, the
whole `/data` volume includes the CLI homes. See the
[backup and restore instructions](deploy-vps.md#back-up) for the exact scope
and stop/start commands.
