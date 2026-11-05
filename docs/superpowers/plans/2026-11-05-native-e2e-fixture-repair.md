# Native E2E Fixture Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the full RootClaw test pipeline by migrating stale E2E fixtures to the supported native fake while preserving coverage for current product behavior.

**Architecture:** Reuse `launchVerificationServer()` and `startFakeOpenAiChat()`; migrate custom server fixtures to an isolated loopback OpenAI-compatible provider. Treat the original Vitest failures as distinct clusters: migrate supported behavior, update retired engine-specific tests only when the current contract proves they are obsolete, and investigate independent failures separately.

**Tech Stack:** Node.js 24+, TypeScript, pnpm, Vitest, RootClaw's `fake-openai-chat.ts` loopback fixture.

**Spec:** `docs/superpowers/specs/2026-11-05-native-e2e-fixture-repair-design.md`

## Global Constraints

- Do not restore `claudeAgent`, Codex/ACP drivers, or `fake-claude-cli.ts`.
- Do not weaken assertions or broadly skip E2E tests.
- Use only temporary homes and loopback fake providers; never contact live providers, accounts, workspaces, or user data.
- Change runtime code only for an independently reproduced product defect, with its own failing test and narrow fix.
- Do not commit or push this follow-up without separate authorization.

## Review Focus

- A bot with a missing legacy selection must use the native fixture model after restart — pin in `server/group-local-vm.e2e.test.ts`.
- Slow, hanging, failing, and released turns must preserve cancellation and cleanup — pin in `server/cloud-lending-memory.e2e.test.ts`, `server/incidents.e2e.test.ts`, and `server/steer-unattended.e2e.test.ts`.
- Native tool calls must retain per-bot ownership and room/desktop authority — pin in `server/group-local-vm.e2e.test.ts` and `server/direct-coordination.e2e.test.ts`.
- Streamed turns and one-shot helper requests must remain distinct, and evidence must only be asserted when that request type emits it — pin in `server/proactive-routines.e2e.test.ts` and any remaining prompt/evidence cluster in the triage ledger.
- Tests must not silently reintroduce removed provider IDs or provider-specific APIs — pin in `server/computer-engine-removal.e2e.test.ts` and the current instance/model contract tests identified in the ledger.

---

### Task 1: Establish an evidence-based failure ledger

**Files:**
- Create: `docs/superpowers/triage/2026-11-05-native-e2e-failures.md`
- Read: `.superpowers/sdd/2026-11-05-r4-plan-compaction/pnpm-test.log`

**Interfaces:**
- Consumes: the original full Vitest log and current `server/testing/fake-openai-chat.ts` behavior.
- Produces: a ledger of unique failed files, failed test names, first causal error, reproduction command, and confirmed root-cause cluster. Later tasks use this ledger to avoid treating reference counts as failure counts.

- [x] **Step 1: Record the original suite summary and enumerate failures**

  Preserve the exact Vitest footer and list every failing test/file from the saved log. Reconcile the summary's reported 584 failed tests with parsed failure blocks; do not silently substitute one count for the other.

- [x] **Step 2: Classify only evidence-backed causes**

  Separate at least: removed driver/provider selection; direct attempts to chmod/import the absent fake CLI; stale instance API/schema expectations; stale prompt/evidence expectations; and waits/timeouts/socket errors. Record overlaps explicitly. `FAKE_CLAUDE_*` names alone are not proof of stale behavior because the native fake intentionally supports aliases for several knobs.

- [x] **Step 3: Reproduce representative failures before assigning causes**

  Run the first relevant failing test for each cluster and record the exact command and first causal error. Keep downstream assertion failures separate from the earliest failure in the test.

- [x] **Step 4: Validate the ledger against the source log**

  Expected: every reported failing test is represented once; the list of unique failing paths matches the Vitest summary; each cause has either a reproduced error or is marked unconfirmed.

### Task 2: Migrate the Group Local VM fixture to the native fake

**Files:**
- Modify: `server/group-local-vm.e2e.test.ts`
- Reference: `scripts/control-rootclaw.ts`, `server/testing/fake-openai-chat.ts`

**Interfaces:**
- Consumes: `startFakeOpenAiChat(env)`, `FakeOpenAiChat.setBotMode(botId, mode)`, and exported `FAKE_OPENAI_MODEL`.
- Produces: a disposable test server whose `config.json` selects `openaiCompat` with `fixture-model`; existing VM, Boat, gate, cleanup, and restart assertions remain intact.

- [x] **Step 1: Keep the reproduced red test as the regression check**

  Run: `pnpm exec vitest run server/group-local-vm.e2e.test.ts -t "resumes an existing per-bot VM even at the instance cap"`

  Expected before the change: POST `/api/bots/:id/messages` fails because provider instance `""` is unavailable; this was reproduced on the current tree.

- [x] **Step 2: Replace the removed provider fixture**

  In `beforeAll`, start the loopback fake, configure `openaiCompat` and `defaultModelSelection` with `FAKE_OPENAI_MODEL`, and script the tool call/reply and gate behavior the existing tests require. Keep the current temporary home, Boat stub, environment isolation, and process cleanup; do not add a product driver or a new fake protocol.

- [x] **Step 3: Run the focused regression and full file**

  Run the single test above, then `pnpm exec vitest run server/group-local-vm.e2e.test.ts`.

  Expected: the single regression passes, then all existing Group Local VM tests pass without changing their behavioral assertions.

### Task 3: Migrate Cloud Lending Memory's per-engine fixtures

**Files:**
- Modify: `server/cloud-lending-memory.e2e.test.ts`
- Reference: `server/testing/fake-openai-chat.ts`

**Interfaces:**
- Consumes: the fake provider's `mode`, `routes`, `textRoutes`, and `setBotMode()` support.
- Produces: one isolated native provider serving the `held`, `done`, and `brief` scenarios, with the same memory/tool permission checks and owner/guest turn ordering.

- [x] **Step 1: Reproduce a failing memory-turn test**

  Run: `pnpm exec vitest run server/cloud-lending-memory.e2e.test.ts -t "a turn in a conversation a guest left behind cannot write a bot's memory with its tools"`

  Expected before the change: the request is rejected because the selected `held` provider is unavailable.

- [x] **Step 2: Replace custom CLI wrappers with native fixture scripting**

  Start `startFakeOpenAiChat()` in the parent fixture; configure the child server's `openaiCompat` URL and default model; replace the `held`/`done`/`brief` driver records with native model selections. Use per-bot modes/routes for held and completing turns, and native one-shot routing for memory capture. Preserve the test's existing owner/guest assertions and offline fetch guard.

- [x] **Step 3: Run the memory E2E file**

  Run: `pnpm exec vitest run server/cloud-lending-memory.e2e.test.ts`.

  Expected: all tests pass, including guest denial, owner authorization, and turn cleanup; no test reaches a non-loopback address.

### Task 4: Port generic CLI-fake E2Es that test still-supported behavior

**Files:**
- Modify as confirmed by Task 1: `server/bulk-delete-tasks.e2e.test.ts`, `server/steer-unattended.e2e.test.ts`, `server/incidents.e2e.test.ts`, `server/direct-coordination.e2e.test.ts`
- Reference: `scripts/control-rootclaw.ts`, `server/testing/fake-openai-chat.ts`

**Interfaces:**
- Consumes: `startFakeOpenAiChat()` for the two standalone server harnesses; `launchVerificationServer()`'s returned `fakeChat` for the control-rootclaw harnesses; `FakeOpenAiChat.set()` / `setBotMode()` for test-controlled native responses.
- Produces: preserved coverage for bulk task operations, unattended steering, incident reporting/retry, and coordinated handoffs without a CLI executable or a removed-engine API.

- [x] **Step 1: Run each confirmed failing test before editing its fixture**

  Run the failing tests in the listed files by exact names from the ledger. Record whether the first error is missing executable, unavailable provider, unsupported legacy knob, or a retired assertion; do not port a file solely because it contains a `FAKE_CLAUDE_*` string.

- [x] **Step 2: Migrate supported scenarios to the existing native fake**

  In `bulk-delete-tasks.e2e.test.ts` and `steer-unattended.e2e.test.ts`, start `startFakeOpenAiChat()` in the test process and configure the disposable child's `openaiCompat` URL and `fixture-model`. In `incidents.e2e.test.ts` and `direct-coordination.e2e.test.ts`, use the existing launcher's returned `fakeChat`. For dynamic error/retry scenarios, control `fakeChat` modes/routes rather than PATCHing `/api/instances/claude` or launching a wrapper. Replace only engine-specific expected error text (for example, CLI exit wording) with the current provider error while keeping incident creation, retry acceptance, and resulting conversation assertions.

- [x] **Step 3: Run affected files and retain their meaningful assertions**

  Run: `pnpm exec vitest run server/bulk-delete-tasks.e2e.test.ts server/steer-unattended.e2e.test.ts server/incidents.e2e.test.ts server/direct-coordination.e2e.test.ts`.

  Expected: the migrated cases pass; if a case proves to test only a retired CLI/driver contract, move it to Task 5 rather than skipping or weakening it here.

### Task 5: Resolve retired contracts and independent failure clusters

**Files:**
- Modify only files still failing in the Task 1 ledger, including as applicable: `server/hooks.e2e.test.ts`, `server/helper-model.e2e.test.ts`, `server/cloud-team-engine-homes.e2e.test.ts`, `server/computer-engine-removal.e2e.test.ts`, `server/engine-status-reads.e2e.test.ts`, `server/proactive-routines.e2e.test.ts`, and tests with stale `/api/instances/claude` or legacy model selections.
- Modify runtime files only if a separate product regression is demonstrated.

**Interfaces:**
- Consumes: the current native instance/model and prompt contracts, plus Task 1's reproduced error evidence.
- Produces: tests aligned with supported behavior, each remaining failure fixed or documented with a reproducible environmental cause.

- [ ] **Step 1: Re-run the remaining failed Vitest paths from the ledger**

  Run: `pnpm exec vitest run` with the ledger's remaining failed file paths. Update each row with the new result and first causal error.

- [ ] **Step 2: Decide each legacy test from the current product contract**

  If the test covers supported user behavior, migrate its model/provider setup and keep its behavior assertions. If it asserts only retired CLI-specific behavior (such as a Claude transcript directory or CLI lifecycle hook), document the removed contract and replace it with a current native test where an equivalent supported behavior exists; otherwise remove only that obsolete test. Do not convert unrelated failures into skips.

- [ ] **Step 3: Reproduce each remaining prompt, schema, evidence, timeout, and socket failure**

  Run the affected test by its exact name from the ledger and capture the first causal error. Do not infer a shared cause from similar timeout or assertion text.

- [ ] **Step 4: Trace each reproduced failure to its current contract**

  For stale fixtures or retired engine-only behavior, update or replace only the affected test as specified in Step 2. For a confirmed product defect, add the narrow failing regression before changing runtime code. If a failure is environmental, record the exact reproduction and evidence without claiming it passed.

- [ ] **Step 5: Re-run each affected file and update the ledger**

  Expected: every original failing case is either green or has a specific, reproducible explanation; no cluster is declared resolved based only on a reduced failure count.

### Task 6: Verify the complete pipeline

**Files:**
- Verify: all changed files and the complete repository test pipeline.

**Interfaces:**
- Consumes: all focused test outcomes and the final failure ledger from Tasks 1–5.
- Produces: verified status for typecheck, lint, Vitest, broker, Electron, and packaged-server stages; no source changes in this task unless a failed check sends work back to its owning task.

- [ ] **Step 1: Run static checks**

  Run: `pnpm typecheck && pnpm lint && git diff --check`.

  Expected: all commands exit successfully.

- [ ] **Step 2: Run the full test pipeline**

  Run: `pnpm test`.

  Expected: Vitest, broker tests, Electron tests, and packaged-server tests all reach completion and pass. If a stage cannot run, record the exact command, stage, and error; do not claim the pipeline passed.

- [ ] **Step 3: Reconcile the final result with the ledger**

  Expected: the ledger records exact final counts and disposition for each original failure cluster; no commit or push is made.
