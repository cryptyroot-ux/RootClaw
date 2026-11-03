# RootClaw Pre-Refactoring Audit

Date: 2026-11-03  
Baseline tag: `baseline-2026-11-03`  
Commit: `a7b75fa`

## 1. Audit scope
This audit supports the stabilization sprint: hardening, technical debt paydown, and safe refactoring. It maps high-risk files, hotspots, dependency clusters, and security boundaries. No code changes are made in this audit.

## 2. Largest non-test source files
1. `server/index.ts` — 928,945 bytes (monolithic route/bootstrap)
2. `server/store.ts` — 110,379
3. `server/drivers/openai-chat.ts` — 91,005 (native turn loop)
4. `server/routines.ts` — 72,518
5. `server/config.ts` — 68,551
6. `server/drivers/agents-catalog.ts` — 65,521
7. `server/routine-requests.ts` — 65,354
8. `server/drivers/workspace-tools.ts` — 63,439
9. `server/workspace-backup.ts` — 57,687
10. `server/cli.ts` — 56,887
11. `server/drivers/agents-call.ts` — 56,782
12. `server/data/tools.ts` — 56,536
13. `server/browser-live.ts` — 56,315
14. `server/boat.ts` — 55,249
15. `server/vps-computer.ts` — 54,620
16. `server/skills.ts` — 53,766
17. `server/browser-runtime.ts` — 53,134
18. `server/composio.ts` — 50,648
19. `server/routes/bot-messages.ts` — 50,222
20. `server/container-computer.ts` — 48,755

## 3. Hotspots (most changed in recent history)
Top changed files:
- `server/drivers/openai-chat.ts` (46)
- `server/index.ts` (25)
- `server/drivers/workspace-tools.ts` (19)
- `server/config.ts` (16)
- `server/drivers/turn-context.ts` (12)
- `package.json` (12)
- `server/testing/fake-openai-chat.ts` (11)
- `server/index.test.ts` (11)
- `server/drivers/openai-chat-tools.test.ts` (10)
- `server/contracts.ts` (10)

## 4. Dependency clusters (native engine)
`openai-chat.ts` directly depends on:
- Contracts: `contracts.ts`, `model-adapter.ts`
- Context: `turn-context.ts`, `context-budget.ts`, `chat-size-limit.ts`
- Retry/failover: `retry.ts`, `failover.ts`, `engine-errors.ts`, `tool-failure.ts`
- Compaction/plan: `plan-verify.ts`, `compaction-journal.ts` (via turn-context)
- Tools: `workspace-tools.ts`, `computer-exec-tools.ts`, `system-info-tools.ts`, `process-tools.ts`, `package-tools.ts`, `network-tools.ts`, `file-watch-tools.ts`
- Capability layer: `capability-provider.ts`, `tool-batch.ts`, `tool-loading.ts`
- Orchestration: `openai-chat-orchestration.ts`, `chat-mcp-tools.ts`, `chat-tool-approval.ts`
- Delivery/replay: `delivered-replay.ts`, `image-fallback.ts`, `prompt-split.ts`
- Budget/guard: `budget-guard.ts`, `token-calibration` (via turn-context), `output-reserve` (via turn-context)

This cluster is the highest-risk refactoring surface.

## 5. Security boundaries
- Shell sandbox: `ROOTCLAW_SHELL_SANDBOX` (fail-closed without bwrap)
- SSRF guard in `web-tools.ts` (private/loopback/link-local refused)
- Secret vault / secret folder / secret requests
- Untrusted fencing for tool/web results
- Capability grants (allowed/denied) in native turn runtime
- MCP gate config and tool schema validation

## 6. Test coverage observations
- Typecheck and lint pass.
- Critical context/retry/failover tests pass (49/49).
- CI red: ~64 failing test files (HANDOFF).
- E2E tests hang (open handles).
- Deleted coverage: thread capacity, guarded messages, independent threads.
- External engine removal incomplete; tests still expect legacy ids in places.

## 7. Refactoring recommendations (order)
1. Do not refactor `openai-chat.ts` first; stabilize tests around it.
2. Extract context-budget/turn-context into a cohesive module with tests (already relatively isolated).
3. Keep `legacy-engines.ts` intact (migration only).
4. Split `index.ts` route registration by domain only after tests green.
5. Prefer small, atomic commits with quoted errors.

## 8. Pre-refactor checklist
- [ ] Run full unit suite (`vitest run --exclude "**/*.e2e.test.ts"`) and record failures.
- [ ] Run e2e subset with `--reporter=hanging-process`.
- [ ] Capture baseline performance (turn latency, compaction) if possible.
- [ ] Confirm `ROOTCLAW_SHELL_SANDBOX` behavior in CI.
- [ ] Secret scan.
