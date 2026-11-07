# Catch-up CI and Stack Merge Plan

> **For agentic workers:** execute task by task with the TDD cycle and verify each task before proceeding.

**Goal:** Land Batch 4 on `main`, repair PR #36's introduced CI regressions, and merge #36 only after its CI is green.

**Architecture:** Treat stack publication and catch-up code fixes as separate gates. Preserve RootClaw's existing tool-loop protection for every provider and reuse it instead of duplicating the upstream repeat guard; distinguish hosted-behavior test cases from tests exercising local endpoints. Extract code from files that exceed the repository's ratchet rather than raising limits.

**Tech Stack:** TypeScript, Vitest, pnpm, GitHub pull requests and Actions.

**Spec:** User-approved sequence in conversation: Batch 4 first; then green CI on #36; then merge #36. #36 must remain unmerged until both gates pass.

## Global Constraints

- Keep Batch 4's changes separate from catch-up changes and land them on `main` first.
- Do not merge #36 while Batch 4 is absent from `main` or while required checks fail.
- Do not run full Vitest or add dependencies before `pnpm audit`.
- Preserve existing hosted-provider semantics and RootClaw's tool execution safeguards.
- Never verify mutations against a live app; use isolated fixtures.

## Review Focus

- Local repeated calls must retain the existing tool-loop close behavior; pin with `server/drivers/tool-loop-guard.test.ts` plus local-model loop tests.
- Hosted/fake OpenAI-compatible tests must not accidentally assert local-only behavior; pin with explicit hosted/local fixture mode and `server/drivers/openai-chat-tools.test.ts`.
- A refactor must not alter request/output semantics; rerun focused driver tests and typecheck.
- The code-size ratchet must pass without changing its limits; run `scripts/testing/file-size-ratchet.test.ts`.
- CI-only timeouts must be separated from deterministic regressions; rerun `server/thread-capacity-api.test.ts` locally and compare affected CI runs before treating them as product failures.

---

### Task 1: Land Batch 4 on main

**Files:** No source edits. GitHub PR may be needed from `port/0144-skills-tools` to `main` because PR #35 was merged into the #34 branch, not `main`.

- [ ] Confirm the exact compare diff from `main` contains only Batch 4 and its required ancestry.
- [ ] Open a separate Batch 4-to-main PR if needed; require CI green before merging it.
- [ ] Verify `main` contains the Batch 4 head after merge. Do not update/merge #36 before this check.

### Task 2: Restore compatible loop guards

**Files:**
- Modify `server/drivers/openai-chat.ts` or an extracted driver helper.
- Test `server/drivers/tool-loop-guard.test.ts` and `server/drivers/openai-chat-local-model.test.ts`.

- [ ] Add a failing regression proving local repeats still honor the existing closing request/tool-choice-none behavior.
- [ ] Keep the existing `ToolLoopGuard` active for local endpoints too; do not duplicate its cross-round signature tracking with another guard.
- [ ] Run both focused tests and verify the old and new guard contracts pass.

### Task 3: Isolate hosted fixture semantics

**Files:**
- Modify `server/drivers/openai-chat-tools.test.ts` fixture configuration and any narrow driver test seam needed.

- [ ] Reproduce the three reported OpenAI chat test failures.
- [ ] Make tests that assert hosted behavior use an explicit hosted mode; local behavior tests continue using the local endpoint mode.
- [ ] Keep production local detection based on the actual endpoint/network policy.
- [ ] Run `server/drivers/openai-chat-tools.test.ts` and local-model tests.

### Task 4: Meet file-size ratchet

**Files:**
- Extract the smallest cohesive local-model handling from `server/drivers/openai-chat.ts` into a focused module.
- Reduce `server/routines.ts` below its existing ratchet through a focused helper extraction or equivalent small refactor.
- Test the affected driver/routine suites and `scripts/testing/file-size-ratchet.test.ts`.

- [ ] Identify the ratchet caps from the repository's existing configuration; do not increase them.
- [ ] Extract only code with a clear responsibility, preserving behavior and public interfaces.
- [ ] Verify all relevant focused tests and the ratchet.

### Task 5: Triage intermittent thread-capacity failures

**Files:** Start with `server/thread-capacity-api.test.ts`; change production/test code only if failure reproduces and evidence identifies a cause.

- [ ] Rerun the test independently and inspect the fixture's startup path.
- [ ] Classify as environmental/flaky or reproducible; fix only a demonstrated root cause.
- [ ] Record the result without weakening assertions.

### Task 6: Revalidate and merge in order

**Files:** Update `docs/port-0.1.144.md` only with verified final results.

- [ ] Run focused tests, typecheck, full lint, locale check, diff check, and isolated fixture verification.
- [ ] Push the repair commits and wait for all required PR #36 checks to finish green.
- [ ] Confirm the base is `main` after Batch 4 lands, update PR #36's base only then, and confirm CI green on the final head.
- [ ] Merge PR #36 only after those checks; verify merged status and final `main` ancestry.
