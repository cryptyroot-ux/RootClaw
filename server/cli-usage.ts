export { HEADLESS_VERBS as HEADLESS_VERB_NAMES } from "./headless/args.ts";

export const HEADLESS_USAGE = `Drive a running workspace (scripts, CI, other agents):
  rootclaw doctor                    check the server answers and an engine is ready
  rootclaw bots | channels | models  your bots, your rooms, the engines and their models
  rootclaw run BOT "do this"         give a bot one job and wait until it and every teammate it asked are done
  rootclaw send BOT "text"           send one message and return at once
  rootclaw wait BOT                  wait on work already running
  rootclaw messages BOT              the latest messages of a conversation
  rootclaw interrupt BOT [--tree]    press Stop (--tree: and every teammate on its job)
  rootclaw export BOT --out DIR      write a job's transcripts, files and screens to DIR
  rootclaw events [--job THREAD]     the server's live events as JSON lines
  rootclaw team apply FILE           make the workspace match a team file (team export writes one)
  rootclaw engine set claude --key-env ANTHROPIC_API_KEY   give it an engine without a screen
  rootclaw connect URL --code CODE --out FILE              get a token for a workspace elsewhere
  rootclaw new-bot | new-channel | set-model | edit | mcp

  Server: --url URL (or ROOTCLAW_URL), --port N (or ROOTCLAW_PORT), else this computer's.
  Token: ROOTCLAW_TOKEN or --token-file FILE. --json prints one JSON document;
  progress goes to stderr (--quiet drops it). rootclaw help VERB for the details.`;

export const USAGE = `rootclaw — your team of AI bots, ready in a few steps

  rootclaw                         set up once, then open your workspace
  rootclaw setup [--data-dir DIR]
  rootclaw start [the same options as serve]
  rootclaw serve [--port 8799] [--data-dir DIR] [--label NAME]
                    [--public-url https://host] [--tailscale | --tunnel | --domain HOST] [--no-pair]
  rootclaw pair  [--label NAME] [--client] [--phone ios|android]
                    [--public-url https://host]
  rootclaw sessions [revoke ID]
  rootclaw status
  rootclaw login [--email you@example.com]
  rootclaw logout
  rootclaw access list | add EMAIL [--chat-only] | remove EMAIL
  rootclaw service install [--domain HOST | --tunnel | --tailscale] [--port N] [--data-dir DIR] | uninstall
                    [--sentinel]   (the health scan below, every two minutes, instead of the server)
  rootclaw sentinel [--data-dir DIR] [--out DIR] [--once] [--json]   (read-only health scan; see --help)
  rootclaw browser install [--with-deps] | status
  rootclaw fleet init --domain HOST [--operator USER] | create NAME --admin EMAIL [--member EMAIL] [--brand FILE]
                    [--anthropic-key-file FILE] [--cap USD] [--license-key KEY] [--memory 1G]
                  | list | users NAME add|remove EMAIL [--chat-only] | suspend NAME | resume NAME
                  | delete NAME --yes [--keep-data] | upgrade   (all take --dry-run)
                  | agent [--socket PATH] [--group USER]   (root; installed by init --operator)

setup   choose AI access and optional phone access; keep existing bots and chats
start   same as rootclaw: use your saved settings and open the workspace
serve   starts the server without prompts and prints a pairing link + QR code
pair    mints a pairing code against a running server (--client: chat only)
sessions lists paired devices; "sessions revoke ID" signs one out
status  what the server says about itself
login   signs this machine in to an RootClaw account (an emailed code)
        and reserves its public address for --tunnel
logout  releases that address and signs out
access  who may sign in with an emailed code at /pair: an address or
        @domain; --chat-only gives chat and approvals without settings.
        Takes effect at once, no restart.
service keep the server running across reboots: writes a systemd unit
        (Linux) or a launchd agent (macOS) for the same serve options and
        prints the commands that install it. Run it from your built
        clone; the unit points at that clone's dist-server/rootclaw.js.
browser install: the bots' browser engine (agent-browser, pinned) into the
        data dir, and Chrome for Testing into the user's browser cache.
        --with-deps also installs
        the Linux libraries Chrome needs (run as root once). Then run
        browser install as the user running serve, from that user's home.
        status: what the current user and data directory have.
fleet   many client workspaces on one Linux server, each its own account,
        service, data folder, brand, sign-in list and keys at NAME.HOST
        behind the system Caddy. Plans are printed unless run as root;
        --dry-run always prints. Run it from a built git clone;
        upgrade does git pull, pnpm install, build and build:server there.
        init --operator USER also installs the fleet agent, a root service
        on a Unix socket only USER may open, so the workspace running as
        USER manages the others from Settings → Installations.

--tailscale  serve over your tailnet: Tailscale terminates HTTPS and the
             link uses this machine's MagicDNS name (needs Tailscale signed in
             and HTTPS certificates enabled for the tailnet)
--tunnel     serve at a public https://c-… address through a
             Cloudflare tunnel: no domain, no proxy, no open port. Run
             \`rootclaw login\` once on this machine first.
--domain     serve at https://HOST on your own domain: a pinned Caddy is
             downloaded once and run alongside the server, and gets the
             certificate itself. Point the domain's DNS at this machine and
             open ports 80 and 443.

--no-open   do not open a browser window
--no-pair   skip phone setup and do not print a pairing code
--local     start locally this time, ignoring saved remote-access settings

${HEADLESS_USAGE}

The rootclaw npm package is not published. Clone the repository, then run
\`pnpm install && pnpm build && pnpm build:server\` (docs/install.md) and
\`alias rootclaw="node $HOME/RootClaw/dist-server/rootclaw.js"\`. Node 24+ is required.
`;
