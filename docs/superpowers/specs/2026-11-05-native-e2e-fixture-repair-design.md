# Design: Repair E2E fixtures after native-engine migration

- **Date:** 2026-11-05
- **Status:** Approved
- **Repository:** `/root/RootClaw`
- **Scope:** Local test-suite failures exposed by the native-engine migration

## Intent

Restore meaningful, isolated integration coverage and make the full `pnpm test` pipeline pass on the current native-engine architecture. Do not make product behavior imitate engines that RootClaw intentionally removed.

## Evidence and problem statement

The full Vitest run recorded 584 failing tests across 184 files, 23,833 passing, 354 skipped, 3 todo, and one unhandled local socket error. It stopped before broker, Electron, and packaged-server stages.

The common structural mismatch is confirmed: commit `daeed83` intentionally removed external CLI/ACP engines and their fake executables; the current fixture launcher configures `openaiCompat` backed by `fake-openai-chat.ts`; yet many current E2E files still configure `claudeAgent`/`codex` or reference the absent `server/testing/fake-claude-cli.ts`. The log contains direct `ENOENT` failures, unavailable/empty provider selections leading to HTTP 409 and timeouts, as well as separate stale instance-schema and prompt/evidence assertions. Therefore the 584 failures are not assumed to have one cause; each cluster must be triaged.

## Goals

- Replace legacy engine fixture setup with the supported loopback native fake where the scenario still describes supported product behavior.
- Preserve the behavioral assertion of each migrated scenario, including tool dispatch, waiting, cancellation, and recorded evidence where applicable.
- Identify failures unrelated to fixture migration (including environment-sensitive socket/timeouts) and fix only when independently reproducible and in scope.
- Run the complete `pnpm test` pipeline and report exact outcomes.

## Non-goals and anti-goals

- Do not restore `claudeAgent`, Codex/ACP drivers, or `fake-claude-cli.ts` just to satisfy old tests.
- Do not weaken assertions, broadly skip E2E tests, or update expected results without matching the current product contract.
- Do not modify runtime behavior unless a migrated test exposes a separately confirmed product defect; such a defect gets its own failing test and narrow fix.
- Do not contact live providers, accounts, workspaces, or user data.

## Approaches considered

1. **Migrate legacy fixtures to the native fake — selected.** Use the existing `launchVerificationServer` / `startFakeOpenAiChat` loopback fixture and `openaiCompat/fixture-model`. Script replies and tool calls through the fixture API, preserving scenarios that remain supported. This matches the current architecture and retains coverage.
2. **Remove or disable the old E2E tests.** Faster, but discards coverage and can hide supported behavior regressions. Use only for a scenario proven to test a retired product contract, replacing it with relevant native coverage when possible.
3. **Restore a test-only legacy CLI/driver shim.** Rejected: it would test an engine the product no longer supports, mask fixture drift, and conflict with the migration's native-only contract.

## Design

Treat the run as a set of failure clusters, not 584 unrelated edits. Start with test files that directly reference removed engine IDs or fake executables, then migrate the highest-impact native fixture failures. Reuse the existing isolated fake provider; do not create another fake protocol. Set model selection explicitly to `openaiCompat` and script each test's required reply/tool sequence. Update prompt, config, and evidence assertions only after reading the current producer and confirming the intended contract. For tests whose only subject is a removed engine-specific behavior, document why the behavior is retired and replace or remove only that coverage.

Each cluster follows red/green: run the affected test against the current tree, make the smallest fixture/assertion change, then rerun the whole affected file. Keep fixture cleanup and evidence isolated. Maintain a ledger of failure counts by root-cause cluster so broad reductions can be distinguished from unrelated failures.

## Acceptance

- Every remaining failure from the original run is either fixed or has a specific, reproducible environment/contract explanation; no failure is dismissed solely because the fixture changed.
- Focused tests for each migrated cluster pass.
- `pnpm typecheck`, `pnpm lint`, and `git diff --check` pass.
- The full `pnpm test` pipeline reaches completion and passes, or any remaining blocker is reported precisely without claiming suite success.
- All verification uses loopback/temporary fixtures as required by `AGENTS.md` and `docs/verification/README.md`.

## Boundaries

Work remains on RootClaw. The R4 change already on `main` is out of scope and must remain intact. No commit or push is authorized by this design request; ask separately before integrating this follow-up.
