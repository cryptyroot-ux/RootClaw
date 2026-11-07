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

## Batch 2: native-engine review

- Base: `main` at `04554f8350e3b6bf91a922e9d40aa09713dafd4b`, including PR #30 and PR #31.
- Target ancestry was checked against `dad50e140ef7f332ef101ae93aff8e9e0a83343b`.

| Upstream SHA | Ancestry | Decision | Port / reason | Tests run |
|---|---|---|---|---|
| `583fc85d438aea0d15c473077df3aaa730d6f250` | Ancestor | AMBIL | Retain Gemini `extra_content` on structured tool calls, preserving thought signatures across tool execution and replay. Applied only the protocol behavior, not unrelated upstream changes. | `server/drivers/openai-chat-protocol.test.ts` (27 passed) |
| `3f660d1d29597e9ef630683506a1b315ca472218` | Ancestor | AMBIL | Charge replacement streamed signature data by its size delta, so repeated signatures are counted once rather than bypassing the bounded accumulator. | `server/drivers/openai-chat-protocol.test.ts` (27 passed) |
| `5bfb0f0128567d381fbcbe36bda152d39306f89b` | Ancestor | LEWATI | The upstream change introduces new routing/refusal machinery across `openai-chat.ts` and new response-stream infrastructure. RootClaw already has a separate Responses adapter; switching an active turn after tool rejection needs an explicit retry/accounting state design and regression coverage to guarantee the PR #30 H03 handled-tool/usage invariants. Do not transplant the upstream driver rewrite or ship an unverified fallback. | No port tests; existing Responses adapter tests not rerun for this skipped candidate. |
| `637161105062b5609d02a4f9cc14767482a3a10d` | Ancestor | LEWATI | Adds local-model text-to-tool parsing and a repeat guard across the core completion loop. RootClaw has no equivalent local-only parser/guard seam; this is a substantial new behavior needing separate focused safety/accounting design, not a minimal native-engine patch. | None; no code ported. |
| `9022b06ba82e178fd1c0601171c7a04de2e1c34e` | Ancestor | LEWATI | Requires Ollama model cloning/context provisioning, lifecycle and memory policy, and changes across local injection and registry paths. This operational behavior is broader than the requested minimal native-engine compatibility port. | None; no code ported. |
| `4776d25b079881f8118559c08d7dbd8ccd8d9665` | Ancestor | LEWATI | Auto-enables the tool bridge for local engines and OpenAI-compatible network endpoints, changing default prompt/tool behavior. Defer until the local-engine selection and opt-out behavior are independently validated in RootClaw. | None; no code ported. |
| `3c165f55d0dac30418dc8da3385c715a53d094be` | Ancestor | LEWATI | Changes OpenAI-compatible instance creation and UI handling for reply wait; it is a settings/UI behavior, not a native chat-driver fix, and would expand the requested scope. | None; no code ported. |
| `a47625150b24dccf9582ba65163046d0bd3c14c3` | Ancestor | LEWATI | Large MCP tool-budget redesign touching hosting, validation, UI, and `openai-chat.ts`. It overlaps RootClaw's native tool budgeting and PR #30 turn accounting; defer rather than import an unisolated budget rewrite. | None; no code ported. |
| `f6af8a06e` | Not verifiable | LEWATI | The object is unavailable in the fetched `v0.1.144` graph; ancestry cannot be established, so excluded as required. | None. |

### Batch 2 verification

- `pnpm exec vitest run server/drivers/openai-chat-protocol.test.ts`: passed (1 file, 27 tests); the two new regressions were observed failing before the protocol fix.
- `pnpm exec vitest run server/drivers/openai-chat-protocol.test.ts server/drivers/openai-chat-tools.test.ts`: passed (2 files, 155 tests).
- `pnpm typecheck`: passed.
- `pnpm exec oxlint --deny-warnings server/drivers/openai-chat-protocol.ts server/drivers/openai-chat-protocol.test.ts`: passed.
- `git diff --check`: passed.
- `pnpm exec vitest run server/drivers/openai-chat-protocol.test.ts server/drivers/openai-chat-tools.test.ts server/openai-tools.e2e.test.ts`: the two driver files passed, but the existing end-to-end file had 3 failures (155 passed, 3 failed total). Each failure asserts that the prompt omits `File locations for this bot`; the test file and prompt construction are unchanged by this port. This is recorded as a blocker for claiming the full acceptance flow green; tests were not weakened.
