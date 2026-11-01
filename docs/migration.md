# Migrating to the native engine

RootClaw now runs every bot on its built-in (native) engine. The external CLI and ACP engines
(Claude Code, Codex, Gemini CLI, Copilot, Cline and the like) were removed.

1. **Pick a provider.** In Settings → API keys, add an OpenAI-compatible, Anthropic, Gemini or Ollama
   provider (or run `pnpm start` then `rootclaw engine set ollama --key-env VAR`). A key you enter in
   Settings → API keys or pass with `engine set` (`--key-env` is read by the CLI only) is saved in
   `~/.rootclaw/config.json` (mode 600); a `ROOTCLAW_*_API_KEY` variable in the server's environment
   is never written there and wins over the saved key. See [install.md](install.md#3-configure-a-provider).
2. **Bots move on their own.** When the server starts (and again whenever the engine list is read),
   every bot, conversation, fallback and new-bot default that still names a removed engine is moved
   to your default ready engine. With none ready yet, it moves to the built-in OpenAI-compatible
   instance (`openaiCompat`), which works once that has a key. Each moved conversation gets a note
   such as "Helper now uses Ollama Cloud." To use a different model, change it in the bot's settings.
   Only when no built-in engine is available at all does a turn fail with "provider instance … is
   unavailable"; the move is retried and happens as soon as one is.
3. **Shell sandbox.** On Linux with bubblewrap, a bot's shell sees only its workspace, skill folders
   and system tools, gets a private `/tmp` and an empty `$HOME`, and has no network unless the call
   asks for it (`network: true`, shown on the approval card). Without bubblewrap the shell tool
   refuses to run; `ROOTCLAW_SHELL_SANDBOX=off` is the explicit opt-out (folder confinement only).
4. **Tool loading.** RootClaw's own tools load on demand through `load_tools`, which keeps each
   request small. `ROOTCLAW_LAZY_TOOLS=0` offers every schema up front, as before.

Install and VPS setup: see [install.md](install.md).
