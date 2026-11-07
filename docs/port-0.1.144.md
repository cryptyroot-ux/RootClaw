# RootClaw security port from upstream v0.1.144

- Target: `v0.1.144` (`dad50e140ef7f332ef101ae93aff8e9e0a83343b`), only commits ancestral to this tag.
- Base: updated `main` including PR #30 merge `ce8c90ef8cfb224f0db64e9737fbee41cb6dbadc`.
- Scope: Batch 1 security candidates from `/root/rootclaw-upstream-port-plan.md`. Upstream commits were applied individually with their source SHA recorded in Git history.
- All listed SHAs are ancestors of the target tag.

| Upstream SHA | Decision | Port / reason | Tests run |
|---|---|---|---|
| `3a5af94862549608ec69ebee38d2b7d0dd385af3` | AMBIL | Redact GitLab personal, deploy, and runner tokens. | `server/redact.test.ts` (39 tests passed across focused run) |
| `b879e18787aa91e501e1ae25eae6c637386ea259` | AMBIL | Redact Basic credentials in Authorization headers. | `server/redact.test.ts` |
| `0fdb32dfba94adb90d099d177ef2669dc30702c1` | AMBIL | Redact Slack app-level tokens. | `server/redact.test.ts` |
| `c745e178bc77001488efdf3ae1c66fc4256ce21a` | AMBIL | Redact temporary AWS ASIA access key IDs. | `server/redact.test.ts` |
| `5bce1263454603d89a66b8f4aad78d14c03766db` | AMBIL | Redact PyPI API tokens. | `server/redact.test.ts` |
| `09856b05bd3e36e2141360270098366f54dd0639` | AMBIL | Enforce PyPI token minimum length to avoid overmatching. | `server/redact.test.ts` |
| `7dea8644ee98620a25e3ee075164b1a9a51c7c9e` | AMBIL | Redact SendGrid API keys. | `server/redact.test.ts` |
| `2611c0bd314d03aa85d1cc8c5b2d46dc239f176b` | AMBIL | Cover the SendGrid trailing-boundary case. | `server/redact.test.ts` |
| `7918c401e` | AMBIL | Allow MCP sign-in pages over HTTP only on loopback hosts; retain HTTPS and reject credentials. | `src/lib/mcp-sign-in.test.ts` |
| `60f775269fa160d5ca7fde585180b01f05ca8c72` | LEWATI | Depends on a routine-level `modelSelection` feature absent from RootClaw's `Routine` model/API. A trial port failed four assertions in `server/routine-model.test.ts`; do not import that unrelated prerequisite feature in this security batch. The trial was reverted. | Trial: `server/routine-model.test.ts` (4 failed, 3 passed); no change retained. |

## Verification

- `pnpm exec vitest run server/redact.test.ts src/lib/mcp-sign-in.test.ts`: passed (2 files, 39 tests).
- `pnpm exec vitest run scripts/testing/file-size-ratchet.test.ts`: passed (1 test).
- `pnpm typecheck`: passed.
- `pnpm exec oxlint --deny-warnings server/redact.test.ts shared/redact.ts src/lib/mcp-sign-in.test.ts src/lib/mcp-sign-in.ts`: passed.
- `git diff --check`: passed.
