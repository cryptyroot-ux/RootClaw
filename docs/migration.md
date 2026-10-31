# Migrating to the native engine

RootClaw now runs every bot on its built-in (native) engine. The external CLI and ACP engines
(Claude Code, Codex, Gemini CLI, Copilot, Cline and the like) were removed.

1. **Pick a provider.** In Settings → Engines, add an OpenAI-compatible, Anthropic, Gemini or Ollama
   provider (or run `pnpm start` then `rootclaw engine set ollama`). Keys stay in the environment
   variable you name; they are never written to config.
2. **Re-point bots.** A bot whose model belonged to a removed engine shows "provider instance is
   unavailable": open its settings and choose a model on the new provider.
3. **Shell sandbox.** On Linux with bubblewrap, a bot's shell sees only its workspace, skill folders
   and system tools, gets a private `/tmp` and an empty `$HOME`, and has no network unless the call
   asks for it (`network: true`, shown on the approval card). `ROOTCLAW_SHELL_SANDBOX=off` disables it.
4. **Tool loading.** RootClaw's own tools load on demand through `load_tools`, which keeps each
   request small. `ROOTCLAW_LAZY_TOOLS=0` offers every schema up front, as before.

Install and VPS setup: see [install.md](install.md).
