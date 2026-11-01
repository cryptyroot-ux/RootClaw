# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- **Email** **lunaticagentic@gmail.com** with the details.
- **Or, if it is enabled on this repository,** use GitHub's private vulnerability reporting:
  <https://github.com/cryptyroot-ux/RootClaw/security/advisories/new>. The report stays visible
  only to you and the maintainers until a fix is published.

You'll get a response as soon as possible, normally within a few days.

## Scope notes for researchers

- The harness server binds **127.0.0.1 only**. Packaged builds allow anonymous loopback reads, but
  public mutations require either the desktop's private per-launch capability or a paired session;
  built-in agent integrations use narrower per-turn capabilities. Anything that makes it reachable
  from off-machine without a paired session, lets one bot reuse another turn's capability, or lets
  a local *unprivileged other user* drive it is a vulnerability. On a hosted or shared workspace
  (service loopback trust, see `docs/self-hosting.md`) a session-less loopback caller — which
  includes every bot's shell — may use only the routes in `SERVICE_ALLOW`
  (`server/request-auth.ts`); reaching an admin route or approving a card that way is a
  vulnerability. Known and documented, not yet closed: that caller keeps the Slack worker's
  guarded routes, so a bot's shell can post into an existing Full-access thread, or open one while
  shared Full access is on, and get Full-access work done without a card. A worker-only relay token
  is the planned fix.
- API keys live in `~/.rootclaw/config.json` (written with mode 0600) and are write-only through
  the API (`configured` booleans out, never values). Environment variables (`ROOTCLAW_*_API_KEY`,
  `XAI_API_KEY`, `MISTRAL_API_KEY`, `CEREBRAS_API_KEY`, `OPENAI_COMPAT_API_KEY`; see
  `server/config.ts` `loadConfig`) take precedence over the file. The Anthropic, Gemini, OpenAI
  Responses, Ollama Cloud and Meta drivers fall back to the provider's unprefixed variable from the
  server's environment (for example `OLLAMA_API_KEY`) only when the instance uses the provider's
  default URL (`server/drivers/api-providers.ts`, `server/drivers/meta.ts`). Any path that echoes a
  stored secret back — API response, SSE event, log line, argv visible in `ps` — is a
  vulnerability.
- RootClaw runs only its built-in native engine: provider APIs are called in-process and no external
  agent CLI is ever spawned (`server/drivers/builtIn.ts`). A bot acts on the machine through the
  native workspace tools (shell, file read/write/patch, web fetch and search), and the consent layer
  is the bot's **approval level** ([docs/approval-levels.md](docs/approval-levels.md)): in **Ask for
  approval**, shell commands, file writes and web calls raise an approval card; **Approve for me**
  adds only the built-in web-search allowance. The other grants are explicit: a saved exact command,
  a remembered MCP read tool, a session "always allow", and a bot's plain reads of its own files
  (`server/auto-approve.ts`). Running a tool call that needed approval without a user decision or a
  matching grant is a vulnerability unless that bot is explicitly set to **Full access**. Full access is a
  standing user decision to approve the bot's tool permission requests; it must never answer
  questions or silently broaden product-level confirmations such as credentials, routines, skills,
  or peer communication. When the optional safety floor is on (`safetyFloor.enabled` in
  `config.json` or `ROOTCLAW_SAFETY_FLOOR=1`; not applied on Windows), a destructive command on its
  never-list (`server/safety-floor.ts`) being approved automatically at any level is a
  vulnerability.
- The shell tool runs under an OS sandbox when the bot's workspace is confined
  (`server/drivers/workspace-tools.ts`): bubblewrap on Linux (read-only system toolchain, the
  workspace and its writable folders, read-only skill folders, a private `/tmp`, an empty `$HOME`,
  and no network unless the call asks for `network`, which the approval card shows), or
  `sandbox-exec` on macOS (confines writes only). With no sandbox available the shell **refuses to
  run** (fail closed). `ROOTCLAW_SHELL_SANDBOX=off` is the operator's explicit opt-out: commands then
  run confined by folder only, writes outside the workspace are not blocked, and every result says
  the command ran unsandboxed. That documented opt-out is not a vulnerability; escaping the sandbox
  or the workspace folders, reaching the network from a call that did not ask for it, or a shell
  running unsandboxed without the opt-out is.
- `web_fetch` refuses private and local addresses. `ROOTCLAW_WEB_ALLOW_PRIVATE` (`1`, or a comma
  list of IPv4 CIDRs) is the operator's exception (`server/drivers/web-tools.ts`); reaching a
  private address without it is a vulnerability.
- Spawning must never route user-influenced strings through a shell. Report any `shell: true` /
  `cmd.exe` string-building you find.
