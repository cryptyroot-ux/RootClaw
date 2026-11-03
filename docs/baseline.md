# RootClaw Baseline (pre-stabilization)

- Date: 2026-11-03
- Branch: `main`
- Commit: `a7b75fa` (fix: widen native engine E2E driver kind whitelist to include all built-in providers)
- Freeze tag: `baseline-2026-11-03`
- Package version: `0.1.137`

## Environment
- Node: 24.x
- Package manager: pnpm
- Runtime: self-hosted VPS (claw.pango.fun), Node service `rootclaw.service`
- Storage: `/home/rootclaw/.rootclaw`

## Verification baseline
- `pnpm typecheck` (`tsc -b && tsc -p tsconfig.server.json`): **PASS**
- `pnpm lint` (`oxlint --deny-warnings .`): **PASS**
- Critical unit tests:
  - `turn-context.test.ts`, `retry.test.ts`, `failover.test.ts`, `context-budget.test.ts`: **49/49 PASS**
- Full `vitest run`: not completed in this session (long-running; see known issues). Partial run shows many failures in e2e/agents-bridge suites.

## Known issues (from docs/HANDOFF.md and repo state)
1. CI on `main` is RED: ~64 failing test files (as of run 41215755420).
2. External engine removal incomplete: `codex`, `claude`, `kimi`, `grok`, `moonshot` still referenced in engine registry/default model/tool profiles.
3. Rebrand drift: pre-rename env prefixes, Cyrillic look-alikes, broken brackets in `server/runtime/envelope.test.ts`.
4. Count mismatches (e.g. `sessions.test.ts` 57 vs 52, `agents-bridge-wire` tools object).
5. E2E tests hang in CI (open handles); excluded from main shards.
6. Lost coverage: thread capacity, guarded messages, independent threads API tests deleted.
7. Phase 5 features not implemented: response caching, intelligence layer wiring, plugin system, multi-agent swarm.

## Risk areas for hardening / refactoring
- `server/drivers/openai-chat.ts` (1441 lines): native turn loop, high blast radius.
- `server/drivers/turn-context.ts` (507 lines): compaction, offload, request-size recovery.
- `server/drivers/capability-provider.ts`: capability lifecycle.
- `server/legacy-engines.ts`: must be retained for migration; do not delete.
- Security: shell sandbox (`ROOTCLAW_SHELL_SANDBOX`), SSRF guards, secret vault, untrusted fencing.
- Context management: learned windows, token calibration, output reserve, request budget/fit.

## Hardening checklist
- [ ] Install bubblewrap in CI or keep test opt-out documented.
- [ ] Finish external engine removal at source (`rg` sweep).
- [ ] Fix rebrand drift (env prefixes, Cyrillic look-alikes).
- [ ] Restore deleted API test suites on `fake-openai-chat.ts`.
- [ ] Diagnose and fix e2e hangs; return to CI.
- [ ] Secret scan before every push.
- [ ] Keep `engine.planVerify` OFF by default.
- [ ] Small atomic commits with quoted error lines.

## Code freeze rules (during stabilization)
- No new features; only fixes/hardening.
- No UI/logo/icon changes.
- Do not delete `legacy-engines.ts`.
- New advanced features behind flags, OFF by default.
- Kill processes by PID only.
