# File-Size Ratchet Refactor Plan

Goal: Make `scripts/testing/file-size-ratchet.test.ts` pass by reducing file sizes, not by weakening the ratchet.

## Current failures
- `server/drivers/openai-chat.ts`: 1441 lines (pinned 1365) → must reduce by at least 76 lines.
- `server/drivers/workspace-tools.ts`: 1078 lines (unlisted) → must either reduce below 1000 or list with justification (preferred: reduce).

## Approach
- Extract cohesive helper modules from each file.
- Keep behavior identical; add/keep tests.
- Run ratchet after each extraction.

## Task 1: Extract openai-chat helpers
- Identify a cohesive block (e.g., tool execution helpers, message formatting, usage tracking).
- Move to a new module `server/drivers/openai-chat-*.ts`.
- Update imports.
- Run typecheck + ratchet.

## Task 2: Reduce workspace-tools.ts below 1000
- Extract git/web helpers already separate; move more tool definitions or helpers.
- Run ratchet.

## Constraints
- No behavior change.
- No weakening ratchet counts.
- Small atomic commits.
