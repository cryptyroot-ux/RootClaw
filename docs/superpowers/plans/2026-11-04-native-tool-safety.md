# Native Tool Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close RootClaw's native tool scope-dispatch bypass and prevent `network_tool`/`process_tool` arguments from being interpreted as shell syntax.

**Architecture:** Recheck native tool scope at the dispatch boundary before provider validation or execution. Represent diagnostic commands as an executable plus argument list for host execution; render computer-exec command strings by quoting every argument through one tested POSIX helper.

**Tech Stack:** Node.js 24+, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-native-tool-safety-design.md`

## Global Constraints

- RootClaw remains the existing product and repository.
- Keep `network_tool` and `process_tool` available and retain current approval semantics.
- Do not add dependencies unless existing code cannot safely express argument handling.
- Cover both host execution and the computer-exec command-string path.
- A native call excluded by `toolScope` must not reach provider validation or execution, even if the model returns its name directly.

## Review Focus

- A denied native tool call returned by the model must be refused before provider validation and execution; test a denied `network_tool` call with invalid arguments so the ordering is observable.
- An allowed native call must still pass through its existing validation, approval, safety-floor, and execution flow; retain or extend existing approval coverage.
- Host diagnostics must invoke executables without a shell and pass shell metacharacters as literal arguments; test with temporary fake executables and confirm no marker command ran.
- Computer-exec command strings must preserve quotes, whitespace, `$()`, backticks, semicolons, and pipes as literal argument content; run generated commands against temporary fake executables under `/bin/bash`.
- Invalid diagnostic arguments and unavailable-backend behavior must remain refusals/errors rather than launching a fallback shell.

### Task 0: Repair the 23 baseline test failures

**User-directed scope expansion:** The approved implementation plan could not start cleanly because the baseline had 23 failures. The user explicitly asked to investigate and fix those failures before continuing the original tasks.

**Files:**
- Modify: `server/drivers/openai-chat.ts`
- Modify: `server/drivers/chat-mcp-tools.ts`
- Modify: `server/drivers/chat-context.ts`
- Test: `server/drivers/openai-chat-tools.test.ts`

**Root causes:** Diagnostic tools were listed without a workspace or computer execution backend; native engine tools were appended after the MCP allocator had already spent the full 128-tool budget; `chat-context.ts` used `outputTokensFor` without importing it, causing summary compaction to fall back.

- [x] Add a regression assertion that backend-dependent diagnostics are absent without a backend while `system_info` remains available; update unrelated-retry/text tests to assert this valid inventory.
- [x] Run the new assertion and existing tool inventory/limit and compaction tests to confirm the failures are reproducible.
- [x] Only offer and mount process/package/network/file-watch providers when a workspace or computer execution backend exists.
- [x] Reserve the other engine-owned definitions before `mountChatTools` allocates MCP tools, keeping every request within 128 and retaining all engine-owned tools.
- [x] Import the existing `outputTokensFor` helper used by context summarization.
- [x] Run the isolated OpenAI Chat driver test file and confirm all 127 tests pass before continuing Tasks 1 and 2.

---

### Task 1: Enforce tool scope at native dispatch

**Files:**
- Modify: `server/drivers/openai-chat.ts` at the `nativeProvider` branch in `runCall`
- Test: `server/drivers/openai-chat-tools.test.ts`

**Interfaces:**
- Consumes: parsed `scope: ToolScope | undefined`, `allowsTool(scope, { kind: "native", name })`, and `CapabilityProvider` dispatch.
- Produces: no new exported API; denied native calls return through the existing per-call refusal path.

- [x] **Step 1: Write the failing test**

Add `it("refuses a native provider call excluded by tool scope even when the model returns it", ...)`. Have the fixture return `network_tool` with `{ action: "invalid", target: "localhost" }`, start the turn with `toolScope: { deny: ["native:network_tool"] }`, and then return a final answer. Assert the tool result contains `Tool selection excludes this tool` and does not contain the argument-validation message.

- [x] **Step 2: Run the test to verify it fails for the current bug**

Run: `pnpm exec vitest run server/drivers/openai-chat-tools.test.ts -t "native provider call excluded by tool scope"`

Expected: FAIL because current dispatch reaches `validateNetworkToolArgs` and reports the invalid action.

- [x] **Step 3: Add the dispatch guard**

Immediately inside the `nativeProvider` branch and before `nativeProvider.validate`, call `allowsTool(scope, { kind: "native", name: call.function.name })`; throw the existing selection-refusal error when it returns false.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run server/drivers/openai-chat-tools.test.ts -t "native provider call excluded by tool scope"`

Expected: PASS; the refused call does not reach provider validation or execution.

- [x] **Step 5: Run the focused driver tests**

Run: `pnpm exec vitest run server/drivers/openai-chat-tools.test.ts server/drivers/openai-chat-safety-floor.test.ts`

Expected: PASS; existing approval and safety-floor behavior remains intact.

---

### Task 2: Make native diagnostic arguments shell-safe

**Files:**
- Create: `server/drivers/shell-args.ts`
- Create: `server/drivers/native-command.ts`
- Modify: `server/drivers/network-tools.ts`
- Modify: `server/drivers/process-tools.ts`
- Test: `server/drivers/native-diagnostic-tools.test.ts`

**Interfaces:**
- Produces: `quotePosixShellArg(value: string): string` in `shell-args.ts` for command-string backends.
- Uses: each provider's executable and argument list for host `spawn`; the command-string backend renders the same dynamic arguments with `quotePosixShellArg`.
- Keeps: the existing `executeNetworkTool`, `executeProcessTool`, `networkToolCommandScope`, and `processToolCommandScope` exports and their public result shapes.

- [x] **Step 1: Write failing host-execution tests**

In `native-diagnostic-tools.test.ts`, create temporary fake `nslookup`, `ping`/`curl` as needed, and `ps` executables that record their received argument vectors. Call `executeNetworkTool` and `executeProcessTool` with targets/filters containing whitespace and shell metacharacters including `$()`, backticks, semicolons, and pipes. Assert the fake executable receives the original value as data and a marker file was not created. For host process filtering, assert the filter is applied to captured `ps` output in-process rather than through a shell pipeline.

- [x] **Step 2: Run the tests to verify they fail for the current bug**

Run: `pnpm exec vitest run server/drivers/native-diagnostic-tools.test.ts`

Expected: FAIL because host execution currently invokes `/bin/bash -c` with interpolated arguments.

- [x] **Step 3: Implement argument-vector host execution and safe command rendering**

Implement `quotePosixShellArg` and test its output through actual `/bin/bash -c` execution with temporary fake commands. Refactor network/process command construction so host paths call the executable with an argument array and computer-exec paths quote each dynamic argument before building the command string. Keep approval command scopes aligned with the executed command, and retain argument validation before execution.

- [x] **Step 4: Add command-string backend regression assertions**

Use the exact command builders used by the computer-exec path and run their output under `/bin/bash` with temporary fake executables. Assert values containing quotes, whitespace, `$()`, backticks, semicolons, and pipes arrive as one literal argument and no marker command executes.

- [x] **Step 5: Run the diagnostic tests to verify they pass**

Run: `pnpm exec vitest run server/drivers/native-diagnostic-tools.test.ts`

Expected: PASS for host argv behavior and computer-exec shell-quoting behavior.

- [x] **Step 6: Run static checks and the full project test suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`

Expected: all commands pass. Report any pre-existing or environment-related failures by command and test name; do not treat a partial test run as a green suite.

Initial verification note (resolved in Task 3): changed-file lint passed, while `pnpm typecheck` and `pnpm lint` reported existing import/unused-binding errors. The first default-reporter `pnpm test` run showed no progress for about ten minutes and was interrupted (exit 130).

---

### Task 3: Close verification gaps and clear static-check blockers

**User-approved follow-up:** explain the silent full-suite run, fix the existing project-wide typecheck/lint errors, add permanent invalid-input and unavailable-backend tests, and rerun verification.

**Files:**
- Modify: `server/drivers/chat-context.ts`, `server/drivers/openai-chat.ts`
- Modify: `server/context-compaction.e2e.test.ts`, `server/delta-context.e2e.test.ts`, `server/drivers/workspace-tools.test.ts`
- Test: `server/drivers/native-diagnostic-tools.test.ts`

- [x] Add permanent invalid-argument tests for both diagnostic tools and assert no executable runs.
- [x] Add direct no-backend tests for both diagnostic tools and assert no host executable runs.
- [x] Correct `TurnPlan`/`RuntimeOptions` imports and export the internal runtime options type used by `ChatContext`.
- [x] Remove the unused compaction session variable and dead delta-context wrapper; import `globToRegExp` from its owning module.
- [x] Verify `pnpm typecheck` and `pnpm lint` both pass.
- [x] Verify native driver/workspace tests: 162 passed, 1 skipped; diagnostic tests include the two new regressions.
- [x] Verify representative compaction and delta-context cases, broker tests (103 passed), Electron relaunch test in isolation, and packaged-server smoke.
- [x] Run Vitest with the verbose reporter. It progressed through 2,581 passing tests and 154 failing tests before interruption; representative `runtime-roots`, `delta-context`, `direct-coordination`, `group-local-vm`, and `cloud-lending-memory` failures were reproduced at base commit `a505e65`.
- [x] Repair a race in the runtime-roots stall fixture: wait for the credential/sign-in tool activity to complete before advancing its synthetic clock. `server/runtime-roots.e2e.test.ts` now passes (14 passed, 1 skipped).
- [x] Re-verify the directly changed driver, diagnostic, fake-chat, workspace, and turn-outcome tests: 6 files, 198 passed, 1 skipped; `pnpm typecheck` and `pnpm lint` both exit 0.
- [ ] Full project test suite green. The current full Vitest result is not green; `pnpm test:electron` also had one 45-second timeout among 1,255 passing tests, while that Electron test passed alone in 0.85 seconds. Broker and packaged-server checks passed separately.

**Full-suite diagnosis:** default Vitest reporting does not print individual test progress. Verbose reporting showed that the runner was progressing through long integration tests (including 30–90 second waits), not hanging. The suite also exposes baseline failures outside this safety change; the sampled controls at `a505e65` failed in the same way. Do not claim `pnpm test` passes.

The latest full-project run remains non-green; the representative failures listed above were reproduced at the base commit. Do not claim `pnpm test` passes.

---

### Task 4: Incorporate final review findings and rerun affected coverage

**Review follow-up:** two shared-computer action-evidence gaps and one fake-provider routing mismatch were reproduced with regression tests. The owner-capture positive control was retained in the native memory fixture because this checkout no longer registers the legacy `claudeAgent` provider used by the old Cloud `done` fixture.

- [x] Preserve outer shared-computer `action`/`command` fields when the input also has `arguments`, and recover a complete action plus command summary when the persisted preview is truncated.
- [x] Gate shared-computer command classification on `action: run_command`; cover `read_file` summaries that mention `git push` as a false-positive control.
- [x] Match fake-provider room-plan and error routes against the current turn after removing recalled or replayed passages.
- [x] Re-read file-backed one-shot text routes on every request; the memory-layer regression exposed stale capture candidates after a route file changed.
- [x] Keep owner capture and turn-log journal assertions in the active native `memory-layer.e2e.test.ts` fixture; remove the impossible poll for the unregistered legacy `done` instance.
- [x] Verify six focused suites: 198 passed, 1 skipped; memory-layer e2e: 1 passed; selected Cloud reopen-refusal e2e: 1 passed, 31 skipped.
- [x] Re-run `pnpm typecheck`, `pnpm lint`, and `git diff --check`; all exit 0.
- [ ] Full project suite green. Known sampled baseline failures remain outside this change.

---

## Plan Self-Review

- Scope and command-injection fixes are separate tasks with independently testable outputs.
- Each task defines the files, expected behavior, and a test that must fail before its implementation.
- The helper is limited to the computer-exec shell-string seam; host execution remains shell-free.
- Approval, safety-floor, invalid-input, unavailable-backend, and shell-metacharacter cases are assigned to tests.
- No repository-wide executor redesign or dependency addition is included.
