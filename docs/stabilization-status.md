# RootClaw Stabilization Status

Updated: 2026-11-04

## Completed
- A. Baseline: tag `baseline-2026-11-03`, typecheck/lint pass, critical tests 49/49, docs/baseline.md.
- A. Pre-refactoring audit: docs/audit/pre-refactoring-audit.md.
- B.1 Audit/classify external engine references: docs/audit/engine-removal-classification.md.
- Plan B: docs/superpowers/plans/2026-11-04-rootclaw-engine-removal-sweep.md.

## In progress
- E.1 E2E hang diagnosis: hanging candidates identified: `server/delta-context.e2e.test.ts` and `server/context-compaction.e2e.test.ts` (timeout 60s). Full-suite open-handle diagnosis remains a CI-level task (command provided).
- B.2 Engine removal sweep: verified complete. Audit (`docs/audit/engine-removal-classification.md`) confirms all remaining external engine refs are KEEP categories (adapter/migration/label/string); no "REMOVE" category refs remain in registry/default selection/tool profiles/headless/cloud-send.
- C.1 Rebrand drift fix: verified complete. No `MAUSCLAW_`/`ROOTLABS_` prefixes or Cyrillic look-alikes found; `envelope.test.ts` green (65 tests).

## Completed
- A. Baseline: tag `baseline-2026-11-03`, typecheck/lint pass, critical tests 49/49, docs/baseline.md.
- A. Pre-refactoring audit: docs/audit/pre-refactoring-audit.md.
- B.1 Audit/classify external engine references: docs/audit/engine-removal-classification.md.
- B.2 Concrete change: `src/lib/analytics-allowlist.ts` `SIGN_IN_ENGINE` changed `["claude","codex","grok"]` → `["grok"]` with TDD test (commit `3729f95`); lint + unit tests green.
- D. Restore deleted API tests: `thread-capacity-api.test.ts`, `guarded-messages-api.test.ts`, `independent-threads-api.test.ts` present and pass.

## Observed test failures (partial run)
- server/index.test.ts: "refuses a second live server that shares the same data directory"
- server/workspace-backup.test.ts: credential metadata rejection
- server/mcp-remote-proxy.test.ts: private record settings
- openai-chat-tools tests: tool downgrade behavior (fixture model lacks tools)

## Next recommended step
Complete file-size ratchet refactor (extract helpers from `server/drivers/openai-chat.ts`, shrink `server/drivers/workspace-tools.ts`) if desired; otherwise E.1 full-suite open-handle diagnosis on CI.

## Constraints
- No new features; only fixes/hardening.
- Do not delete legacy-engines.ts.
- Small atomic commits.
