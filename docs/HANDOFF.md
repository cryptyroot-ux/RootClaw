# HANDOFF: RootClaw — continue development

## 1. What this is
RootClaw is a standalone AI agent platform with its OWN native engine, execution system and capability management. It does not ride on external AI engines (Claude Code, Codex, Hermes, OpenCode, Pi, etc.). Any LLM provider/model plugs in through adapters, never tied to an engine.
- Repo: https://github.com/cryptyroot-ux/RootClaw (public), branch `main`. Owner: cryptyroot-ux.
- Origin: a renamed fork of an earlier open-source app; the upstream project is credited only in the required NOTICE file.
- Stack: TypeScript, Node, pnpm, vitest, Electron app + server.

## 2. Goal
Build a native engine strong enough to compete with Claude Code / Codex / OpenCode. Pillars: context management, tool orchestration, reliability, planning/verification, measurable evals. Short-term goal: a clean, secure, CI-green **beta release**.

## 3. Architecture (key files)
- `server/drivers/openai-chat.ts`: native turn loop.
- `server/drivers/turn-context.ts`: context compaction.
- Provider drivers: `server/drivers/adapters/` holds only the Anthropic, Gemini and OpenAI Responses wire adapters (+ `http.ts`). `server/drivers/api-providers.ts` registers those plus Ollama Cloud (its OpenAI-compatible endpoint); `server/drivers/openai-compat.ts` is the shared OpenAI-compatible driver (custom installs with their own base URL + key, OpenAI, OpenRouter); xAI (`grok.ts`), Groq, Mistral, Cerebras, Meta and MiniMax have their own files in `server/drivers/`, all on the shared `openai-chat.ts` loop.
- Workspace tools (shell/fs/patch): bwrap sandbox; web fetch/search with SSRF guard.
- `server/engine-memory.ts`: memory (not yet wired into the turn loop).
- `server/testing/fake-openai-chat.ts`: scriptable fake provider for tests.
- `evals/engine-tasks`: eval harness; results in `evals/results/`.
- `legacy-engines.ts`: KEEP (migrates pre-rename data). Never delete.
- Docs: README, `docs/install.md`, `docs/migration.md`, `docs/design/*.md`.

## 4. Done
- Rebrand to RootClaw; external engines largely removed.
- Prompt trimmed 19.8k → 7.3k tokens.
- Compaction keeps ERROR/finding lines; folds enough per pass; capped summary.
- Retry: OpenRouter in-stream 502 retry; retry-wait quit fix; a failed read no longer fails the turn.
- Already present: parallel tool batching, lazy skill/tool loading (`load_tools`), web tools with SSRF guard, planVerify (OFF by default).
- Security audit v1 fixed: undici upgrade, bwrap FS restriction + `--unshare-net` + private tmp, Anthropic `is_error`, JSON token estimate.
- Security audit v2 (N01–N10, N16) fixed up to commit `14292f9`; PoC run: 64 SAFE, 0 VULNERABLE.
  - N01 symlink TOCTOU, N02 shell fail-closed without sandbox (`ROOTCLAW_SHELL_SANDBOX=off` = explicit opt-out), N03 safe mounts only, N04 htmlToText, N05 IPv6 SIIT, N06 truncated tool calls refused, N07/N08 Gemini errors, N09/N10 SSE, N16 tool/web results fenced as untrusted.
- Tests: `server/index.test.ts` 0 failures; e2e tests split out of main vitest shards; removed-engine test files deleted; `fake-acp-cli` references gone.
- Packaged server smoke passes. Typecheck + lint pass in CI.
- Eval (Ollama Cloud `beam`, hard suite): 8/10 pass (80%). Fails: `multi-refactor` (round cap), `async-bug` (budget cap).
- Phase 5 design notes exist (stubs only): parallel tools, response caching, intelligence layer, plugin system, multi-agent swarm.

## 5. Not done / open problems
1. **CI on main is RED.** ~64 failing test files as of run 41215755420, mostly:
   - Remaining external engine ids in CODE (`codex`, `claude`, `kimi`, `grok`, `moonshot`, ...) in engine registry, default model selection and tool profiles. Tests expect e.g. default instance `claude`. Root cause: removal of external engines is incomplete.
   - Rebrand drift: pre-rename env prefixes → `ROOTCLAW_` names; Cyrillic look-alike text and broken brackets in `server/runtime/envelope.test.ts`.
   - Count mismatches (e.g. `sessions.test.ts` 57 vs 52, `agents-bridge-wire` tools object).
   - `agents-bridge-chat.test.ts` ("carries on after use_tool") fails independently.
2. **Shell sandbox on CI:** GitHub runners lack bubblewrap; shell tools refuse there. Tests use `ROOTCLAW_SHELL_SANDBOX=off`. Either install bwrap in CI (`apt-get install -y bubblewrap`) or keep the opt-out in tests only. (Done: the setting and the fail-closed behavior are documented in `docs/install.md` → Requirements.)
3. **Lost coverage:** API tests for thread capacity, guarded messages and independent threads were deleted (needed the removed fake Claude CLI). Rewrite them on `fake-openai-chat.ts`.
4. **E2E tests** hang in CI (open handles). Excluded from main shards. Diagnose per file with `--reporter=hanging-process`.
5. **Phase 5 code not implemented:** response caching (beyond Anthropic cache_control), intelligence layer wiring, plugin system, multi-agent swarm.
6. Eval: fix engine-side causes of the 2 failures; run more models.
7. Release checklist not done: CHANGELOG, version tag, clean install test, pre-rename data migration test, final secret scan.

## 6. Next steps (in order)
1. `git pull`. Latest failing CI run: `gh run list -b main -L 3`, then `gh run view <id> --log-failed`.
2. **Finish engine removal at the source.** `rg -n "codex|claude|kimi|grok|hermes|opencode|moonshot" server shared src --type ts -g '!*.test.ts'`. Only the native engine may exist; providers are adapters, not engines. Keep `legacy-engines.ts` for migration only. Revert patches that added external-engine support (e.g. kimi/moonshot tool profile) unless it is a provider adapter.
3. Update tests to native-only expectations, by group (engine counts, defaults, manifests via `UPDATE_AGENTS_CATALOG_GOLDENS=1`, rebrand drift). Fix Cyrillic look-alikes in source, not by widening filters.
4. CI green: install bubblewrap in the workflow or keep the test opt-out; triage every remaining failing job with a quoted error line.
5. Rewrite the 3 deleted API test suites on the fake provider.
6. Fix e2e hangs; return them to CI.
7. Release beta: CHANGELOG, tag `v0.1.0-beta`, clean install from `docs/install.md`, migration test, secret scan.
8. Then Phase 5, in order: response caching → intelligence layer → plugin system → multi-agent swarm (OFF by default, depth 1, budgets).

## 7. Hard rules
- No UI, logo, icon or visual changes.
- Never delete `legacy-engines.ts`.
- No deploy to any VPS/server without the owner's explicit approval.
- `engine.planVerify` stays OFF by default; new advanced features behind flags, OFF by default.
- Never print, log or commit secrets. Secret scan before every push. API keys from env vars only.
- Paid model eval: max 500 requests total, only after owner approval. Prefer free models / fake provider.
- Kill processes by PID only.
- Small atomic commits (`fix(tests):`, `feat(engine):`, `ci:`); `git fetch && git rebase origin/main` before each push. If the pre-push hook fails on corepack, set `COREPACK_HOME=/tmp/corepack`.
- No "environment issue" claims without a quoted log line. Never weaken a test to pass unless it tests a removed engine.
- Do not claim RootClaw beats other agents without head-to-head evals on the same tasks.

## 8. Report format (after each session)
- Commits (hash + one line)
- Failing test files: before → after
- CI run link + status per job
- What's left, with quoted errors
