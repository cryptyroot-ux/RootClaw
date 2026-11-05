# Design: Phase 5 native E2E repair

- **Date:** 2026-11-05
- **Status:** Approved
- **Repository:** RootClaw
- **Base:** `69eaa2e` (`native-e2e-fixture-repair`)

## Intent

Finish the six remaining candidate suites from the Phase 5 reproduction, quickly and without hiding failures. These are the suites in scope:

- `server/hooks.e2e.test.ts`
- `server/helper-model.e2e.test.ts`
- `server/cloud-team-engine-homes.e2e.test.ts`
- `server/computer-engine-removal.e2e.test.ts`
- `server/engine-status-reads.e2e.test.ts`
- `server/proactive-routines.e2e.test.ts`

The `server/escalations.e2e.test.ts` subcluster is already migrated and passed 4/4. The user has narrowed this phase to the six suites above; the other failures in the original ledger and Task 6's full pipeline are not part of this design.

## Evidence

The prior combined Phase 5 run failed 21 tests in these six suites and passed 6; it completed in 94.69s. The first observed causes were:

- Hooks and helper-model setup try to chmod the removed `fake-claude-cli.ts`.
- Cloud team engine-home cases select no native model and assert Claude transcript files.
- Computer engine removal assumes a removed `claude` catalog entry and obsolete `computer`/`claude` replacement IDs.
- Engine-status reads depend on CLI probing and authentication for the removed `claude` instance.
- Proactive routines reads the removed fake CLI dump and scripts a legacy composed-tool name the native fixture does not offer.

These are starting hypotheses from that run, not blanket classifications. Reproduce the exact failing case in each workstream before changing it.

## Goals

- Keep end-to-end coverage for behavior that the current product supports, using isolated temporary homes and loopback fakes only.
- Replace removed CLI setup with `launchVerificationServer()` / `fake-openai-chat.ts` where the behavior remains supported.
- Remove or replace only assertions for contracts the native architecture retired, with the reason recorded in the ledger.
- Finish with all six in-scope files passing, or a precise documented disposition for any test that only covered a retired contract.

## Non-goals and constraints

- Do not restore Claude/Codex/ACP drivers, the deleted fake CLI, or legacy instance APIs to satisfy tests.
- Do not broadly skip tests or weaken behavior assertions.
- Do not change runtime code unless a separate product defect is reproduced with a failing regression test.
- Do not contact live providers, accounts, machines, or user data.
- Do not treat this narrowed scope as completion of every failure in the original ledger or of Task 6.

## Approaches

1. **Serial, file-by-file.** Reproduce, update, and run each suite before moving to the next. This is easiest to trace but repeats setup and delays independent work.
2. **Group by root cause, then work independently — selected.** Refresh the six-suite failure picture once, confirm exact failing cases, and split independent files into separate workstreams/worktrees: removed CLI-only hooks/helper setup; cloud engine-home/transcript assumptions; legacy instance selection/status; native proactive-routine request evidence. Each stream keeps edits in its assigned files, runs its focused suite, and reports supported behavior versus retired contract. Integrate and run all six together plus static checks. This gives the shortest likely wall-clock time while keeping evidence and ownership clear. If a common fake/helper change becomes necessary, coordinate it as a shared dependency instead of making conflicting parallel edits.

## Verification and acceptance

1. Re-run the six suites together with a verbose Vitest command and retain the exact result.
2. Reproduce each remaining red test by name before editing; record its first causal error and disposition in the existing Task 1 ledger / Phase 5 progress notes.
3. Run each changed file independently, then all six files together.
4. Run `pnpm typecheck`, `pnpm lint`, and `git diff --check`.
5. Report the exact six-file results. Do not claim the complete original Vitest ledger or full `pnpm test` pipeline passed.

## Separate follow-up

The prior read-only review also identified two test-quality gaps in already-pushed Task 3/4 files (`cloud-lending-memory.e2e.test.ts` request/thread correlation and retry-security assertions in `incidents.e2e.test.ts`). They are outside these six suites and remain explicit follow-up work; Phase 5 completion will not mark them resolved.
