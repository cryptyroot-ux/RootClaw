# Fenced Native Read-and-Draft Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable unattended `read-and-draft` checks on the native OpenAI-compatible driver while preserving server-enforced read/draft-only authority.

**Architecture:** Add the existing `openai-compat` driver kind to the proactive host's explicit fenced-engine set. Keep `createReadAndDraft` and check-key authorization as the only action boundary, and prove the integrated native path using the loopback OpenAI and connected-app fakes. Update the routine and verification docs to match the behavior.

**Tech Stack:** TypeScript, Vitest, `launchVerificationServer()`, `startFakeOpenAiChat()`, `startFakeConnectedApps()`, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-06-native-read-and-draft-checks-design.md`

## Global Constraints

- Runtime eligibility is based on the server-selected `driverKind`, not user-controlled model text or prompt contents.
- Run with Ask-level approvals and no approval cards: only the native Composio multi-execute gateway reaches the per-call route fence, which refuses every out-of-policy connected-app call before generic grant denials; calls allowed by that fence still require connector grants and scopes. The handler refuses every other out-of-policy request itself.
- Only read-and-draft routine refusals are returned as handled results; preserve the Cloud first-look fence's tool-error refusals.
- Reuse `createReadAndDraft`, `RoutineChecks.mayDraft`, and the existing check key; expand runtime enforcement only if the E2E exposes a concrete gap.
- Do not add a per-bot setting, new provider, or new trust level.
- Do not allow sending, replying by send, Slack or other apps, arbitrary Gmail writes, drafts outside checked threads, extra recipients, or multiple drafts for the same checked thread.
- Do not simulate tool results in tests; all provider and connected-app interactions use loopback fakes in an isolated fixture.
- Follow `docs/verification/README.md`; never verify mutations against the user's live app or data.

## Review Focus

- Add only the selected `openai-compat` driver to the explicit fence; keep the existing `fenced: false` check proving an unfenced engine starts no AI run.
- No connected work must still produce no AI request — preserve the existing no-work and disconnected assertions in `server/proactive-routines.e2e.test.ts`.
- The one draft must target a checked thread and its recorded sender, with no extra recipients and no duplicate — assert exact fake-app write effects and denial records in the E2E.
- Sends and Slack/other-app actions must never reach the connected-app fake — script them through the actual offered native tool and assert absence from fake effects plus server denials.
- Out-of-fence requests must not become approval cards, and ordinary native routines must continue to work — preserve the existing E2E assertions for both.

---

### Task 1: Add native read-and-draft E2E coverage (parallel with Task 3)

**Files:**
- Modify: `server/proactive-routines.e2e.test.ts`

**Interfaces:**
- Consumes: `launchVerificationServer()`'s `fakeChat.requests` / `.set()`; `startFakeConnectedApps()`'s recorded calls; existing `/api/routines` test helpers.
- Produces: native E2E proof that the default watch starts a fenced native run and that its one allowed draft is the only connected-app write.

- [x] **Step 1: Convert the supported mail/meeting watch case to native AI evidence.**

  Script the fake chat to return a valid watch result for the fixture email and meeting. Assert one streamed request, the actual offered Composio tool name, records-wrapped input, completed `read-and-draft` run, brief rows, and the meeting prep/reminder behavior. Keep the no-work and disconnected checks asserting no model request.

- [x] **Step 2: Add an isolated native fence E2E for allowed and refused actions.**

  In a fixture with a checked email from `ada@example.test`, script the actual offered native Composio tool through `fakeChat.set()`: one `GMAIL_CREATE_EMAIL_DRAFT` for the checked thread to Ada, then attempts for a duplicate, wrong recipient, extra recipient, `GMAIL_SEND_EMAIL`, `GMAIL_REPLY_TO_THREAD`, `GMAIL_DELETE_MESSAGE`, and `SLACK_SEND_MESSAGE`. Return a valid final watch result. Assert the fake service records exactly one draft to Ada and no forbidden writes, the run completes without an approval card, and the decision log records the refused attempts under `read-and-draft`.

- [x] **Step 3: Run the new focused E2E before any runtime change.**

  Run: `pnpm exec vitest run server/proactive-routines.e2e.test.ts -t "new mail and a meeting|refuses sends"`

  Expected: **FAIL** because the current empty `FENCED_ENGINES` intentionally produces no native checked-run turn. Record the exact failure as RED; do not weaken the expected assertions.

### Task 2: Enable only the OpenAI-compatible driver behind the existing fence

**Files:**
- Modify: `server/host/proactive.ts:35-36`

**Interfaces:**
- Consumes: the `driverKind` returned by `deps.registry.get()` and the failing native integration cases from Task 1.
- Produces: `fenced(botId)` returns true for the `openai-compat` driver and remains false for unlisted drivers.

- [x] **Step 1: Add `openai-compat` to `FENCED_ENGINES`.**

  Preserve the existing `driverKind` lookup and all `read-and-draft` route/tool enforcement. If the native E2E demonstrates an ordering gap, permit only the exact Composio multi-execute gateway request to reach the existing per-call fence; do not widen other approvals or change draft authorization. Evaluate that fence before generic connector-grant denials, but continue to require grants and scopes for every call it allows. Commit an allowed draft only after those permissions pass and are revalidated immediately before relay. A per-call fence refusal is returned as a handled MCP result so the routine can keep a valid final report.

- [x] **Step 2: Run the native read-and-draft and fence suites.**

  Run: `pnpm exec vitest run server/proactive-routines.e2e.test.ts server/read-and-draft.test.ts server/host/routine-checks.test.ts`

  Expected: all tests pass; the new mail/meeting and authorized-once draft E2Es pass, while the unit case for a non-fenced engine still confirms no AI run.

### Task 3: Update proactive routine docs (parallel with Task 1)

**Files:**
- Modify: `docs/proactive-routines.md`
- Modify: `docs/verification/proactive-routines.md`

**Interfaces:**
- Consumes: the selected `openai-compat` fence behavior and E2E assertions from the spec.
- Produces: user and verification docs that describe server-fenced native checks, loopback fakes, and the actual security guarantees.

- [x] **Step 1: Update runtime behavior documentation.**

  Replace the statement that the fenced run needs Claude with the explicit `openai-compat` driver behavior; retain the allow-only route, connected-app, and draft constraints.

- [x] **Step 2: Update verification documentation.**

  Replace removed fake-Claude CLI instructions with the native loopback provider and connected-app fixtures. Document the one allowed sender-constrained draft and the blocked send/other-app/wrong-recipient/duplicate attempts.

- [x] **Step 3: Check the documentation diff.**

  Run: `git diff --check -- docs/proactive-routines.md docs/verification/proactive-routines.md`

  Expected: no whitespace errors and no claim that a live provider or account is used.

### Task 4: Verify, review, and open the PR

**Files:**
- Verify: `server/proactive-routines.e2e.test.ts`, `server/read-and-draft.test.ts`, `server/host/routine-checks.test.ts`, all six Phase 5 candidate suites, and the final branch diff.
- Include: `docs/superpowers/specs/2026-11-06-native-read-and-draft-checks-design.md` and this plan.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: verified commits pushed to `origin/native-e2e-fixture-repair` and a PR against the default branch; do not merge or release.

- [x] **Step 1: Run the focused security and routine suites.**

  Run: `pnpm exec vitest run server/proactive-routines.e2e.test.ts server/read-and-draft.test.ts server/host/routine-checks.test.ts`

  Expected: all tests pass, including exact connected-app side-effect and refusal evidence.

- [x] **Step 2: Run the six Phase 5 candidate suites together.**

  Run: `pnpm exec vitest run --reporter=verbose server/hooks.e2e.test.ts server/helper-model.e2e.test.ts server/cloud-team-engine-homes.e2e.test.ts server/computer-engine-removal.e2e.test.ts server/engine-status-reads.e2e.test.ts server/proactive-routines.e2e.test.ts`

  Expected: all retained tests pass; retired-contract dispositions remain as recorded in the Phase 5 progress ledger. The complete `pnpm test` pipeline is outside this narrowed scope and must not be claimed.

- [x] **Step 3: Run repository checks.**

  Run: `pnpm typecheck && pnpm lint && pnpm i18n:check && git diff --check`

  Expected: each command exits successfully.

- [ ] **Step 4: Review the final diff and commit/push.**

  Inspect for accidental weakening of `server/read-and-draft.ts`, user changes, or inclusion of the unrelated untracked `docs/superpowers/plans/2026-11-05-openmausbot-vps-team.md`. Commit only requested feature/design/plan changes, then push the current branch; allow the repository pre-push checks to run.

- [ ] **Step 5: Create a PR.**

  Search the repository for its pull-request template, use it to structure the description, and create a PR against the default branch. Include test evidence and disclose any remaining limits. Do not merge.
