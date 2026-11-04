# RootClaw handoff: native tool safety follow-up

> Updated: 2026-11-05 (Asia/Jakarta)
> Repository: `/root/RootClaw`
> Active checkout: `/root/RootClaw/.worktrees/fix-native-tool-safety`
> Branch: `fix/native-tool-safety`
> Handoff scope: continue the remaining local E2E suite issue; the native-tool-safety fixes themselves are already pushed.

## Goal

Continue the RootClaw native-tool-safety work without widening its scope. The user originally asked to investigate and fix 23 failures, then explicitly authorized committing and pushing to the main repository. The focused failure set was fixed, reviewed, committed, and pushed. The next useful step is to resolve the separate failure discovered when a broader local `pnpm test` run reached a stale group-local VM E2E file. Keep RootClaw as the project; this is not MausClaw work.

## Current state

**Confirmed working:**

- `HEAD`, local `main`, and `origin/main` all point to `ec6f5cb90631b63e2c4c577328dbb50ca3b108c4` (`fix remaining native tool safety failures`).
- GitHub Actions run [41893123055](https://github.com/cryptyroot-ux/RootClaw/actions/runs/41893123055) completed with conclusion `success` for that commit.
- The 12-file set previously failing in this task passed locally: 170/170 tests. The focused context subset passed 35/35.
- `pnpm lint`, `pnpm typecheck`, `pnpm control-plane:check`, isolated `pnpm control-plane:test` (142/142), `pnpm control-plane:dry-run`, and `git diff --check` passed.

**Still unresolved:**

- A full local `pnpm test` run was interrupted after `server/group-local-vm.e2e.test.ts` reported 43 failures and 2 skips out of 46 tests. The complete `pnpm test` pipeline therefore has not passed; it did not finish its later broker, Electron, or packaged-server stages.
- The representative test initially failed with `provider instance "" is unavailable`. Adding a `newBotDefaults.profile.modelSelection` for `claude` got past that error, but the test then timed out waiting for the fake CLI dump. The config change is still an exploratory, uncommitted edit and is not a demonstrated fix.

## Files in play

| File | Relevance |
|---|---|
| `server/group-local-vm.e2e.test.ts` | The currently failing legacy E2E suite. Its test setup still selects `driver: "claudeAgent"` and points at a removed fake CLI. It has one uncommitted exploratory config addition near line 111. |
| `server/routes/bots-create.ts` | Confirms bot creation reads `cfg.newBotDefaults`; the earlier attempted global default did not affect this route. |
| `server/testing/fake-claude-cli.ts` | Referenced by the E2E setup but absent from the current tree. Commit `daeed835` removed the external CLI/ACP engines and this fixture. |
| `server/testing/fake-openai-chat.ts` | Existing native fake provider fixture to inspect as a possible basis for migrating the E2E setup. |
| `.codebase-memory/` | Untracked local codebase index data. It is not product work; leave it unstaged and intact. |

## Work completed and pushed

The current main tip contains these task commits:

- `fb3e9086` — native tool request-budget handling and stale retry-entry cleanup.
- `7a59ef81` — preserve complete outward command evidence before preview/summary truncation.
- `ec6f5cb9` — remaining native-tool-safety fixes, including request budgeting, plan-only behavior, test fixture floors, and related expectations.

These commits are already on `origin/main`; do not repeat or rewrite that history. The green Actions run above is for `ec6f5cb9`.

## What was tried and why it failed

1. **Set a global default model selection for the representative VM test.** It did not change the bot created by this test because `server/routes/bots-create.ts` resolves the bot template through `cfg.newBotDefaults`.
2. **Add `newBotDefaults.profile.modelSelection` pointing at `claude`.** This cleared `provider instance "" is unavailable`, but the test still waited for a fake CLI dump that never arrived. The setup still requests the removed `claudeAgent` driver and references `server/testing/fake-claude-cli.ts`, which no longer exists. The addition therefore only moved the failure and is not a complete correction.
3. **Treat the successful CI run as proof the full local suite is green.** That conclusion is unsupported: the observed CI workflow passed, but the local broad Vitest run exposed a separate stale E2E suite and was stopped before the rest of the `pnpm test` script ran.

## Best current theory

The E2E test fixture was left behind when the project removed external CLI/ACP engines in `daeed835`. The test still configures the retired Claude CLI driver, while the current codebase provides native engines and `server/testing/fake-openai-chat.ts`. This is strong evidence of fixture drift, but confirm the intended bot/Boat startup path and every test's assertions before editing. Prefer migrating this test to a supported native fake provider if it can preserve the scenario; do not restore a removed driver just to make the old fixture pass. If the scenario is obsolete, establish that from its purpose and current product contract before changing or deleting coverage.

## Next steps

1. Start in this worktree and inspect `git status`, the diff in `server/group-local-vm.e2e.test.ts`, and the E2E setup/teardown plus all 46 test cases. Preserve the existing exploratory edit until its role is understood; `.codebase-memory/` is local generated data and must remain unstaged.
2. Reproduce only this suite with `pnpm exec vitest run server/group-local-vm.e2e.test.ts`. Capture the first failure and trace how the fake provider should trigger the expected Boat create/wake behavior.
3. Read the native fixture and nearby native-engine E2E tests. Replace the retired `claudeAgent`/CLI setup with the supported native fake-provider path if it faithfully exercises this scenario. Keep the correction narrow and add/update regression coverage first.
4. Run the focused E2E file until all its tests pass. Then run the full `pnpm test` pipeline to completion, followed by lint/typecheck and `git diff --check`. Record the actual outcomes; do not describe the whole suite as green until all pipeline stages finish successfully.
5. Review the change against the RootClaw native-engine direction and the user's original scope. The user has already authorized committing and pushing the task to main; use the repository's expected review/verification process and preserve the existing pushed commits.

## Guardrails and user context

- Follow applicable `using-superpowers` instructions for the next task; for this reported test failure use the systematic-debugging process before changing code, then test-first implementation and verification-before-completion.
- Stay on RootClaw and the native-tool-safety / stale test-fixture follow-up. Do not redirect this into MausClaw or unrelated refactors.
- Keep changes precise. The user has repeatedly requested careful, proactive execution and clear progress reporting.
- Do not stage or delete `.codebase-memory/`. It is untracked in this checkout and unrelated to the fix.
- Do not claim that the full test suite passed based only on focused tests or the green CI workflow.

## Memory pointers

Claude-mem search for `RootClaw native-tool-safety failures ec6f5cb9 group-local-vm e2e test stale CLI driver` returned no observations at handoff time. Useful future searches: `RootClaw native tool safety ec6f5cb9` and `RootClaw group-local-vm.e2e.test fake-claude-cli`.
