# RootClaw Stabilization Status

Updated: 2026-11-04

## Completed
- A. Baseline: tag `baseline-2026-11-03`, typecheck/lint pass, critical tests 49/49, docs/baseline.md.
- A. Pre-refactoring audit: docs/audit/pre-refactoring-audit.md.
- B.1 Audit/classify external engine references: docs/audit/engine-removal-classification.md.
- Plan B: docs/superpowers/plans/2026-11-04-rootclaw-engine-removal-sweep.md.

## In progress
- B. Engine removal sweep: B.1 audit done; no further external engine refs in registry/default selection (remaining refs are adapters/migration/labels).
- E.1 E2E hang diagnosis: 10-file batch completed (7 min, 6 failed, 3 passed, 1 skipped). No single-file hang observed; full-suite open-handle diagnosis still pending.
- C. Rebrand drift fix: no remaining pre-rename env prefixes or Cyrillic look-alikes found; envelope.test.ts green.
- D. Restore deleted API tests.
- E. E2E hang diagnosis.

## Observed test failures (partial run)
- server/index.test.ts: "refuses a second live server that shares the same data directory"
- server/workspace-backup.test.ts: credential metadata rejection
- server/mcp-remote-proxy.test.ts: private record settings
- openai-chat-tools tests: tool downgrade behavior (fixture model lacks tools)

## Next recommended step
Start with one small, well-scoped cluster:
- B.2: remove external engine ids from tool profiles (tool-schema-profile.ts) only if tests permit.
or
- C.1: fix one concrete rebrand drift item with a failing test.

## Constraints
- No new features; only fixes/hardening.
- Do not delete legacy-engines.ts.
- Small atomic commits.
