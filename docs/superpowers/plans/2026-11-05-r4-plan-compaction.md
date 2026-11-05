# Preserve the Latest Plan Across Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development if explicitly chosen) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the latest planner state in the trailing plan message after compaction.

**Architecture:** Keep the existing `ChatContextDeps` contract and make only the `plan` and `planHint` properties live getters at the `ChatContext` construction site in `openai-chat.ts`. The existing `ChatContext` getters and `compact()` cleanup then read the loop's current values without changing compaction call sites.

**Tech Stack:** TypeScript, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-05-r4-plan-compaction-design.md`

## Global Constraints

- Work in the existing RootClaw checkout; do not create a new project or version.
- Change only the wiring of `plan` and `planHint`; do not change plan format, update rules, compaction triggers, or summary algorithms.
- Use the local scripted driver test; never contact a live provider or use live app data.
- Before claiming the server change works, run an isolated fixture per `docs/verification/README.md`.
- Do not commit or push unless separately requested.
- If dependencies are absent, install from the existing lockfile with `pnpm install --frozen-lockfile`; leave the lockfile unchanged.

## Review Focus

- `plan` is `null` when `ChatContext` is constructed and becomes a new plan object later; the regression test must see that plan on the next provider request.
- A status update replaces the plan object with a later revision; assert that the later status, not the initial status, is pinned.
- The accepted plan changes `planHint` from its initial value to `PLAN_KEEP_HINT`; assert the current hint is pinned and only once.
- A compaction attempt may return `null`; set the threshold so `compact()` runs and verify its `finally` path does not restore the old state.
- The plan message must remain the sole trailing `PLAN_TAG` message, with the system prefix unchanged; assert both in the regression test, preserving the existing prefix-cache contract.

---

### Task 1: Prove and fix stale plan restoration

**Files:**
- Modify: `server/drivers/openai-chat-plan-verify.test.ts`
- Modify: `server/drivers/openai-chat.ts` at the `new ChatContext({ ... })` construction

**Interfaces:**
- Consumes: Existing `OpenAICompatDriver` scripted local-server fixture, `PLAN_TAG`, `PLAN_KEEP_HINT`, and `SendTurnInput.turnContext`.
- Produces: The `ChatContextDeps.plan` and `.planHint` properties resolve to the current outer-loop variables; no interface or call-site signature changes.

- [x] **Step 1: Add the failing driver regression test**

Add a case named `keeps the latest plan and hint after compaction between planner rounds`. Script `plan`, `status`, then `answer`; run in `plan` mode with `turnContext: { compactAt: 1 }` so the budget check invokes `ChatContext.compact()` between requests. On the final streamed request, assert there is exactly one `PLAN_TAG` message, it is trailing, its text contains `PLAN_KEEP_HINT` and `1. [x] Find the bug`, and the system message remains unchanged.

- [x] **Step 2: Restore the locked test dependencies**

`node_modules` is absent in the current checkout. Run `ROOTCLAW_SKIP_HOOKS=1 pnpm install --frozen-lockfile` to avoid changing the local git `core.hooksPath` while installing dependencies.

Expected: dependencies install successfully and `pnpm-lock.yaml` remains unchanged.

- [x] **Step 3: Run the test and confirm the regression**

Run: `pnpm exec vitest run server/drivers/openai-chat-plan-verify.test.ts -t "keeps the latest plan and hint after compaction between planner rounds"`

Expected: FAIL because compaction re-pins the construction-time `plan`/`planHint` snapshot instead of the current revision.

- [x] **Step 4: Wire live plan getters**

In `server/drivers/openai-chat.ts`, replace the `plan` and `planHint` values in the `ChatContext` deps literal with getter properties that return the loop variables of the same names. Leave `planning` as-is and do not alter `ChatContextDeps` or any of the three compaction call sites.

- [x] **Step 5: Re-run the regression test**

Run: `pnpm exec vitest run server/drivers/openai-chat-plan-verify.test.ts -t "keeps the latest plan and hint after compaction between planner rounds"`

Expected: PASS; the final provider request contains one trailing plan with the latest hint and status.

- [x] **Step 6: Run adjacent planner and turn-compaction tests**

Run: `pnpm exec vitest run server/drivers/openai-chat-plan-verify.test.ts server/drivers/plan-verify.test.ts server/drivers/turn-context.test.ts`

Expected: PASS.

- [x] **Step 7: Run the isolated server compaction fixture and record its result**

Run: `pnpm exec vitest run server/context-compaction.e2e.test.ts`

Expected: run only against the documented isolated fixture. If it fails for a fixture/config mismatch unrelated to plan state, record the evidence and do not widen the R4 change.

Observed: 6/7 tests fail because the fixture selects `openaiCompat/fixture-model` while these assertions still expect Claude-specific config and older evidence/prompt shapes. Planner/verifier is off in this suite, so the live plan getters are not involved.

- [x] **Step 8: Run static checks and inspect the final diff**

Run: `pnpm typecheck && pnpm lint && git diff --check`

Expected: all checks pass; the implementation diff changes only the regression test and the `ChatContext` deps literal. Report any environment limitation instead of implying a check passed.

Observed: `pnpm typecheck`, `pnpm lint`, and `git diff --check` passed. The required full `pnpm test` was also run; its Vitest stage failed with 584 failures across 184 files, 23,833 passed, 354 skipped, and one unhandled socket error. Later broker, Electron, and packaged-server stages did not run.
