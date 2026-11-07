# Development handoff

This note is a navigation aid, not a source of project status. Verify current
behavior and CI evidence from the checked-out branch before continuing work.

## Project map

- `server/drivers/openai-chat.ts`: native model turn loop.
- `server/drivers/`: provider implementations and protocol adapters.
- `server/legacy-engines.ts`: migration data for older configurations; retain it.
- `server/testing/fake-openai-chat.ts`: scripted provider fixture for isolated tests.
- `docs/verification/README.md`: required isolated verification workflow for
  server and conversation changes.
- `docs/audits/rootclaw-audit-2026-11-07-fixlog.md`: statuses and evidence for
  the November 2026 audit remediation.

## Safety constraints

- Do not modify logos or other visual branding as part of backend maintenance.
- Do not deploy to a VPS or alter its Docker/services without explicit approval.
- Never expose secrets in logs, test output, or commits.
- Run focused tests for the code changed; do not run the full Vitest suite for
  audit follow-ups unless specifically requested.
- Preserve user changes and confirm repository status before committing.
