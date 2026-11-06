# Phase 5 Native E2E Fixture Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve exactly the six remaining Phase 5 candidate suites while keeping coverage for current product behavior and documenting each retired engine-only contract.

**Architecture:** Reproduce the six-suite baseline once, then work in four root-cause groups: removed CLI fixtures (`hooks` and `helper-model`), Claude engine-home assumptions, legacy engine selection/status, and proactive-routine request evidence. Tasks 2–5 touch disjoint suite files and can run independently; Task 6 consolidates their dispositions. Use the existing loopback OpenAI-compatible fake wherever native behavior remains supported; do not add a provider or change runtime code for a fixture-only failure.

**Tech Stack:** Node.js, TypeScript, pnpm, Vitest, `launchVerificationServer()`, `startFakeOpenAiChat()`, and the existing fake connected-apps service.

**Spec:** `docs/superpowers/specs/2026-11-05-phase-5-native-e2e-repair-design.md`

## Global Constraints

- Keep end-to-end coverage for behavior the current product supports, using isolated temporary homes and loopback fakes only.
- Replace removed CLI setup with `launchVerificationServer()` / `fake-openai-chat.ts` where the behavior remains supported.
- Remove or replace only assertions for contracts the native architecture retired, with the reason recorded in the Phase 5 progress notes.
- Do not restore Claude/Codex/ACP drivers, the deleted fake CLI, or legacy instance APIs to satisfy tests.
- Do not broadly skip tests or weaken behavior assertions.
- Do not change runtime code unless a separate product defect is reproduced with its own failing regression; treat that as out of this plan and request approval before expanding scope.
- Do not contact live providers, accounts, machines, or user data.
- Scope is exactly the six named candidate suites. `server/escalations.e2e.test.ts` is already migrated and out of scope; the rest of the original ledger and the parent plan's Task 6 full pipeline are also out of scope.
- The Cloud Lending request/thread correlation and incidents retry/security follow-ups remain outside this phase and unresolved.
- Do not commit or push; no such authorization has been given.

## Review Focus

- A suite with no selected native model must fail for the recorded fixture reason, not silently contact a provider — pin the isolated fixture and exact result in Task 1.
- Native tool-result evidence and helper one-shot calls must not be confused with retired engine callbacks or streamed turns — pin only supported paths in Task 2.
- Removing Claude-owned home/transcript checks must not remove current team privacy coverage — retain or cite the current Cloud and bot-box boundary tests in Task 3.
- Legacy `computer` selections must move only to a real current replacement, and status refresh must use current provider APIs rather than resurrecting Claude auth/CLI routes — pin in Task 4.
- Read-and-draft routines must still refuse sends, other apps, and drafts to the wrong recipient while allowing only the authorized draft — pin in Task 5.

---

## File Map

- `server/hooks.e2e.test.ts`: native tool-result and current hook-capability coverage; retire only the removed CLI lifecycle assertions.
- `server/helper-model.e2e.test.ts`: current helper-model setting coverage; remove setup and expectations tied only to deleted provider drivers.
- `server/cloud-team-engine-homes.e2e.test.ts`: migrate any still-supported assertion; remove the Claude-owned filesystem-home suite only if its remaining contract is confirmed retired and already covered elsewhere.
- `server/computer-engine-removal.e2e.test.ts`: preserve legacy saved-selection migration and Computer safety using a current native replacement.
- `server/engine-status-reads.e2e.test.ts`: replace CLI probing/auth lifecycle with loopback native-provider status reads, or record an exact retired-contract disposition if the behavior is already covered by current tests.
- `server/proactive-routines.e2e.test.ts`: read streamed and one-shot evidence from the native fake, and script only tools offered by the current request.
- `.superpowers/sdd/2026-11-05-native-e2e-fixture-repair/progress.md`: record the baseline in Task 1 and consolidate per-test dispositions and final verification in Task 6; preserve the original failure ledger as historical evidence.

### Task 1: Reproduce and group the six-suite baseline

**Files:**
- Modify: `.superpowers/sdd/2026-11-05-native-e2e-fixture-repair/progress.md`
- Read: `docs/superpowers/triage/2026-11-05-native-e2e-failures.md`
- Read: the six suites listed in the File Map

**Interfaces:**
- Consumes: the original failure ledger and the Phase 5 reproduction in `progress.md`.
- Produces: an exact six-suite baseline and a per-test list of first causal failures for Tasks 2–5.

- [ ] **Step 1: Run the six suites together, excluding the already-migrated escalations suite**

  Run:

  ```sh
  pnpm exec vitest run --reporter=verbose \
    server/hooks.e2e.test.ts \
    server/helper-model.e2e.test.ts \
    server/cloud-team-engine-homes.e2e.test.ts \
    server/computer-engine-removal.e2e.test.ts \
    server/engine-status-reads.e2e.test.ts \
    server/proactive-routines.e2e.test.ts
  ```

  Expected: record the actual current counts; do not assume the earlier 21-failure count if the run differs.

- [ ] **Step 2: Reproduce one exact failure in every failing file before editing it**

  Use the individual suite command and `-t` with the exact test name from the verbose output. At minimum, trace `each person's private chat runs in their own engine home, signed in with the team's sign-in, and the team's in the team's`, `moves bots off it once, keeps each conversation where it worked, and never hands a turn to Boat's own agent`, `probes the engine's CLI once on a later start while the model lists arrive and the engine list is read`, `probes again after a sign-out, a model refresh, a saved key and a Claude update, and reuses the last read otherwise`, `new mail and a meeting become one read-and-draft run; the reminder needs no AI; the brief and prep are posted`, and `refuses sends, other apps and drafts to anyone but the thread's sender, outright and with no card; one reply draft gets through once`. For `hooks` and `helper-model`, capture the `beforeAll` failure first because the removed CLI chmod prevents their cases from starting.

  Expected: each workstream has a reproduced first cause, distinct from downstream assertion failures.

- [ ] **Step 3: Append the baseline and root-cause assignment to `progress.md`**

  Record the exact command, counts, failed test names, first causal error, and assignment to Tasks 2–5. Do not rewrite the original full-ledger counts or include `escalations` in the six-suite result.

### Task 2: Replace removed CLI setup in hooks and helper-model suites

**Files:**
- Modify: `server/hooks.e2e.test.ts`
- Modify: `server/helper-model.e2e.test.ts`
- Reference: `scripts/control-rootclaw.ts`, `server/testing/fake-openai-chat.ts`, `server/side-jobs.test.ts`

**Interfaces:**
- Consumes: `launchVerificationServer()` and its `fakeChat` (`requests`, `set()`), `FAKE_OPENAI_MODEL`, and the existing helper dispatch contract in `side-jobs.test.ts`.
- Produces: no chmod/import/spawn of deleted fake CLIs; assertions remain only for behaviors supported by the current provider architecture, with a per-case disposition summary for Task 6.

- [ ] **Step 1: Remove the deleted CLI from the hooks harness and script a native turn**

  Replace the custom CLI process setup with an isolated loopback native fixture. Use the native tool protocol for any still-supported full-result/digest assertion. Preserve the forged `/api/internal/hook` bearer rejection if that route remains part of the current contract. Retire `ROOTCLAW_HOOKS` and Claude `PreCompact`/`SessionStart`/`PostToolUseFailure` expectations only where they specifically assert callbacks from the removed CLI; return each retired case and reason for Task 6's progress entry rather than skipping it.

- [ ] **Step 2: Remove deleted driver inventory from helper-model setup**

  Keep generic `helperModel` validation, persistence, creation, and config-reload assertions that still apply. Do not configure `claude`, `codex`, or `pi` merely to make the old E2E pass. Preserve helper execution coverage only if the current native provider contract can invoke that helper path; otherwise return the retired provider-specific one-shot cases and reasons for Task 6, retaining the existing `side-jobs.test.ts` coverage. Use `FakeOpenAiChat.requests` to distinguish a native streamed turn (`stream: true`) from a supported non-streamed helper request; never count one as the other.

- [ ] **Step 3: Run both focused suites and account for each old case**

  Run: `pnpm exec vitest run server/hooks.e2e.test.ts server/helper-model.e2e.test.ts`

  Expected: all retained cases pass; every retired case has a concrete contract reason for Task 6's consolidated progress entry; no broad skip or replacement assertion that is weaker than the supported behavior.

### Task 3: Resolve Claude engine-home assumptions in the Cloud Team suite

**Files:**
- Modify or delete: `server/cloud-team-engine-homes.e2e.test.ts`
- Reference: `server/cloud-team.e2e.test.ts`, `server/engine-homes/box.linux.test.ts`, `server/engine-homes/layout.ts`

**Interfaces:**
- Consumes: Task 1's exact reproduction and the current native provider/home contract.
- Produces: retained end-to-end checks only for supported Cloud behavior, with a per-case disposition summary for Task 6.

- [ ] **Step 1: Classify all seven existing cases against the current provider contract**

  Check the cases for per-person `.claude` homes and sign-in, transcript secrecy/resume, refreshed Claude credentials, relocation of legacy transcripts, member-left home cleanup, and My Cloud's Claude transcript home. Do not classify the whole file as stale from the missing model alone.

- [ ] **Step 2: Keep supported privacy coverage and retire only provider-owned filesystem contracts**

  If a case still proves a current user-facing Cloud boundary, port it to the native fixture and retain its behavior assertion. If it only proves that the removed Claude driver reads/writes its own `HOME`, remove that test (and delete the file if no current case remains), returning the exact retired contract for Task 6's progress entry. Confirm the existing Cloud team privacy suite and engine-home box test still cover their respective current boundaries; do not edit those reference suites as part of this task.

- [ ] **Step 3: Run the retained suite and record the disposition of every original test**

  Run: `pnpm exec vitest run server/cloud-team-engine-homes.e2e.test.ts` when the file remains. If the file is deleted because all seven cases are retired, run the cited current coverage suites only as needed and return the deletion evidence for Task 6's progress entry.

  Expected: no skipped placeholder suite; each of the seven original cases is either retained with a passing current fixture or documented as a retired Claude-owned filesystem contract.

### Task 4: Migrate legacy engine selection and status-read coverage

**Files:**
- Modify: `server/computer-engine-removal.e2e.test.ts`
- Modify: `server/engine-status-reads.e2e.test.ts`
- Reference: `scripts/control-rootclaw.ts`, `server/testing/fake-openai-chat.ts`, `server/harness/registry-start-read.test.ts`, `server/openai-tools.e2e.test.ts`

**Interfaces:**
- Consumes: the native `openaiCompat` instance/model, isolated loopback fake, current refresh-model API, and Task 1 reproductions.
- Produces: migration coverage for saved legacy `computer` IDs with a real native replacement, plus status-read/refresh coverage without Claude auth or CLI endpoints; return any retired-case dispositions for Task 6.

- [ ] **Step 1: Replace the missing Claude destination in the Computer-removal fixture**

  Keep the legacy `computer` selections only as saved migration input. Use a configured native `openaiCompat` model as the replacement and retain the assertions for bot/task migration, computer surface, user-facing notice, defaults, no duplicate migration after restart, and never calling Boat's agent. Replace fake-CLI dump assertions with captured native request/tool configuration. For “moves a bot later,” make the loopback provider appear only after the initial no-replacement state; do not install a CLI wrapper.

- [ ] **Step 2: Replace CLI status/auth scenarios with the current OpenAI-compatible status contract**

  Use a loopback `/v1/models` stand-in with a request counter. Exercise repeated `/api/instances` reads and `POST /api/instances/openaiCompat/refresh-models`; assert the current snapshot reuse and explicit refresh behavior. Remove expectations for Claude sign-out, auth status, and `claude-update`; those are not native-provider operations. Keep this E2E only if it adds HTTP-level coverage beyond `registry-start-read.test.ts` and `openai-tools.e2e.test.ts`; otherwise document the exact duplicate/retired cases and remove only those tests.

- [ ] **Step 3: Run both focused suites**

  Run: `pnpm exec vitest run server/computer-engine-removal.e2e.test.ts server/engine-status-reads.e2e.test.ts`

  Expected: migration behavior still passes against a native replacement; status assertions use only loopback requests and current APIs; no removed provider ID is advertised as a current engine.

### Task 5: Capture proactive-routine evidence through the native provider

**Files:**
- Modify: `server/proactive-routines.e2e.test.ts`
- Reference: `server/testing/fake-openai-chat.ts`, `server/testing/fake-connected-apps.ts`

**Interfaces:**
- Consumes: `launchVerificationServer()`'s `fakeChat.requests` / `fakeChat.set()`, `FakeScript.textRoutes` and streamed tool scripts, and the existing loopback connected-apps fake.
- Produces: the same routine, brief, reminder, and read-and-draft safety assertions using current native request evidence rather than CLI dump fields; return any retired-case dispositions for Task 6.

- [ ] **Step 1: Reproduce the first failed routine and inspect the native request's offered tools**

  Run the exact `new mail and a meeting become one read-and-draft run; the reminder needs no AI; the brief and prep are posted` case. Record the actual request's `tools` names and the missing dump/tool-call cause; do not infer a valid native call from the legacy composed-tool name.

- [ ] **Step 2: Script current streamed and one-shot requests separately**

  Replace unsupported marker-reply environment names with `FAKE_CHAT_TEXT_ROUTES` or `fakeChat.set({ textRoutes })`. Script only function names present in the captured native `tools` list, preserving all fake connected-app side effects and wrong-recipient refusals. Read streamed prompt/tool evidence from the captured request or the launcher's native dump; inspect non-streamed requests separately because one-shots do not write that dump.

- [ ] **Step 3: Run the complete proactive-routines suite**

  Run: `pnpm exec vitest run server/proactive-routines.e2e.test.ts`

  Expected: routine and brief flows pass; sends, Slack calls, wrong-recipient drafts, and unexpected cards remain absent; exactly the authorized reply draft reaches the loopback fake.

### Task 6: Verify the narrowed Phase 5 result

**Files:**
- Verify: the six candidate suites and their documented dispositions.
- Update: `.superpowers/sdd/2026-11-05-native-e2e-fixture-repair/progress.md`

**Interfaces:**
- Consumes: focused results and case-by-case dispositions from Tasks 1–5.
- Produces: exact Phase 5 verification evidence only; no claim about the original full ledger or the parent plan's Task 6.

- [ ] **Step 1: Run every retained candidate suite independently**

  Run each retained file with `pnpm exec vitest run <file>`. If the Cloud Team file was deleted as a retired contract, record that disposition and run its cited current coverage tests instead.

- [ ] **Step 2: Run the retained Phase 5 candidate suites together**

  Run the six-file verbose command from Task 1 with any deleted/retired file omitted and its disposition reported alongside the result.

  Expected: all retained tests pass; no broad skips; each removed case is listed with a specific retired-contract reason and current coverage reference where one exists.

- [ ] **Step 3: Run static checks**

  Run: `pnpm typecheck && pnpm lint && git diff --check`.

  Expected: all three checks exit successfully. Do not run or claim `pnpm test` as part of this narrowed phase.

- [ ] **Step 4: Append the exact six-suite outcome to `progress.md`**

  Include focused and combined results, static-check results, and every retired-test disposition. Do not commit or push.
