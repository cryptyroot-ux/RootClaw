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

## Batch 3 — core fixes

Target remains `v0.1.144` (`dad50e140ef7f332ef101ae93aff8e9e0a83343b`). Candidate ancestry was checked with `git merge-base --is-ancestor <sha> dad50e140ef7f332ef101ae93aff8e9e0a83343b` against the fetched upstream tag. The upstream tag resolves to the stated target SHA.

| Upstream SHA | Ancestry | Decision | Port / reason | Focused tests |
|---|---|---|---|---|
| `ee7d52ce66b6c852aaf6df8c1015c668e3b2c8d0` | Ancestor | AMBIL | Added a RootClaw-named page error boundary with reload action around the app root. | `src/components/PageBoundary.test.ts` (2 passed) |
| `d5520bd5011b12fa754b10c5acd6b3ec2f155d6c` | Ancestor | AMBIL | Compensate watchdog silence timestamps for long event-loop gaps; ordinary late sweeps still count. | `server/turn-watchdog.test.ts` (19 passed) |
| `3fd3b547c2e8c03916c6bace4b8f0ac3c9ae2a1f` | Ancestor | AMBIL | Added a narrow done-notice state machine for held teammate/follow-up notices, using RootClaw's coordinator and steer queue. | `server/done-notice.test.ts`, `server/chat-followups.test.ts` (16 passed) |
| `b1e0ba941e5c0aa5ef4c7543edbab04b98253e80` | Ancestor | AMBIL | Batch upkeep-state mutations across tick/tidy/dream, while flushing capture progress promptly; added write-count regression. | `server/memory-upkeep-writes.test.ts` (1 passed; observed 4 writes before fix) |
| `f6967835c` | Not verifiable | LEWATI | SHA was unavailable in the fetched tag graph and fetching the short SHA from upstream failed; ancestry could not be established, so excluded as required. | None. |
| `4fe6439cf875e8a4af19d2d1461cf6fe19f6b844` | Ancestor | AMBIL | Stable-sort working/waiting bots to the top within each displayed sidebar list; drag/drop continues to use saved ordering. | `src/lib/sidebar-layout.test.ts`, `src/components/Sidebar.departments.test.ts` (47 passed) |
| `ac08cf72a70f4d334ea39e9044ecc514c0c1056c` | Ancestor | LEWATI | Adjusts simple-mode sidebar activity rows based on the upstream waiting/unread task semantics; RootClaw's task activity and selection rules differ, and the change is not required for the core fixes being ported. | None; no code changed for this item. |
| `823f7e1f3cefcf6dcdcd9ff1af90c20bf9397237` | Ancestor | LEWATI | Requires coordinated changes to runtime ancestry rules, assignment envelopes, notices, and coordinator interfaces across 11 files; no isolated thread-only subset preserves the runtime contract. | None; no code changed for this item. |
| `ef71364537a635dc6d5ac402cca3550b2f8b7660` | Ancestor | LEWATI | Long tool-output loading changes the wire contract, authenticated routes, companion allowlist, pagination, and multiple chat views; it is a broad feature rather than a clean core-fix patch. | None; no code changed for this item. |
| `a72d920d155600a4ccaa6b8354d1e0326eed5f0a` | Ancestor | LEWATI | Running-routine sidebar rows require new filtering/rendering states in both simple and advanced modes; deferred as UI-specific behavior outside the selected core-fix set. | None; no code changed for this item. |
| `73ab955eb4d44eb288e37be109d7525626900343` | Ancestor | LEWATI | Requires a new confinement rule preventing externally driven work from opening threads; this is a separate security-policy change, not the selected core-fix subset. | None; no code changed for this item. |
| `7d7e7a1c1e400d08e85e493bb0436f19ab9703b5` | Ancestor | LEWATI | Suppresses a routine banner for results-thread conversations; routine navigation behavior is adjacent UI polish, not a core fix in this batch. | None; no code changed for this item. |

### Batch 3 verification

- `pnpm exec vitest run src/components/PageBoundary.test.ts server/turn-watchdog.test.ts server/done-notice.test.ts server/chat-followups.test.ts server/memory-upkeep-writes.test.ts`: passed (5 files, 38 tests).
- `pnpm typecheck`: passed.
- `pnpm exec oxlint --deny-warnings` on the touched TS/TSX files: passed.
- `pnpm exec vitest run src/lib/sidebar-layout.test.ts src/components/Sidebar.departments.test.ts`: passed (2 files, 47 tests); the new ordering regression failed before the helper was added.
- `pnpm i18n:check`: passed (16 language catalogs valid).
- `git diff --check`: passed.
- Isolated fake-engine fixture: `doctor --url http://127.0.0.1:21216` reported connected and no problems; fixture was stopped afterward.
- Logo/icon changes and Phase 5 stubs were not touched. No external engines were used.

## Catch-up: remaining v0.1.144 candidates

- Target: `v0.1.144` (`dad50e140ef7f332ef101ae93aff8e9e0a83343b`); branch `port/0144-catchup`, stacked on `port/0144-skills-tools`.
- Candidate ancestry was checked against the target tag; `f6967835c` and `f6af8a06e` are post-tag and excluded. This catch-up supersedes the earlier Batch 2 defer for `637161105`, after its behavior was isolated behind the local-network runtime path and covered by focused integration tests.

| Upstream SHA | Ancestry | Decision | Port / reason | Focused tests |
|---|---|---|---|---|
| `637161105062b5609d02a4f9cc14767482a3a10d` | Ancestor | AMBIL | Recovered local-model text tool calls through RootClaw's existing validation, approval, and tool execution path; held possible markup from streamed output; re-asked once for unreadable calls; added local repeat guard and corrective rounds. Enabled only for OpenAI-compatible endpoints on the local network. | `server/drivers/chat-text-tool-calls.test.ts`, `server/drivers/chat-repeat-guard.test.ts`, `server/drivers/openai-chat-local-model.test.ts` |
| `9022b06ba82e178fd1c0601171c7a04de2e1c34e` | Ancestor | LEWATI | Adds model cloning/context provisioning, lifecycle, and memory policy across injection and registry. RootClaw has no isolated provisioning contract; importing it would add engine lifecycle behavior beyond this catch-up's proven chat-path changes. | None; no code changed. |
| `4776d25b079881f8118559c08d7dbd8ccd8d9665` | Ancestor | LEWATI | Auto-enables the agents tool bridge for local engines. RootClaw's bridge is explicitly opt-in and its permission decision depends on engine-owned tool policy; changing the default is a separate security decision. | None; no code changed. |
| `3c165f55d0dac30418dc8da3385c715a53d094be` | Ancestor | SUDAH ADA | OpenAI-compatible instances already accept `replyWaitMinutes` and apply it to the runtime timeout (`server/drivers/openai-compat.ts`). No additional settings/UI port needed. | Existing compat tests; no new code. |
| `a47625150b24dccf9582ba65163046d0bd3c14c3` | Ancestor | SUDAH ADA / LEWATI | RootClaw already bounds and validates MCP tool definitions, schemas, and runtime calls with its own policy; upstream's broader tool-budget redesign is not a safe incremental transplant into that contract. | None; no code changed. |
| `ac08cf72a70f4d334ea39e9044ecc514c0c1056c` | Ancestor | LEWATI | Adjusts simple-mode sidebar activity rendering; RootClaw's activity/selection semantics differ and this is outside the selected driver catch-up. | None; no code changed. |
| `823f7e1f3cefcf6dcdcd9ff1af90c20bf9397237` | Ancestor | LEWATI | Requires coordinated runtime ancestry, assignment-envelope, notice, and coordinator contract changes across multiple layers; no isolated thread-only port preserves the current contract. | None; no code changed. |
| `ef71364537a635dc6d5ac402cca3550b2f8b7660` | Ancestor | LEWATI | Adds long tool-output loading across the wire contract, authenticated routes, companion allowlist, and chat views; too broad for a minimal catch-up. | None; no code changed. |
| `a72d920d155600a4ccaa6b8354d1e0326eed5f0a` | Ancestor | LEWATI | Running-routine sidebar rendering is UI-specific and outside this driver catch-up. | None; no code changed. |
| `7d7e7a1c1e400d08e85e493bb0436f19ab9703b5` | Ancestor | LEWATI | Routine result-thread banner behavior is UI polish outside this catch-up. | None; no code changed. |
| `73ab955eb4d44eb288e37be109d7525626900343` | Ancestor | LEWATI | Adds a separate confinement policy for externally opened threads, not required for the selected driver catch-up. | None; no code changed. |

### Catch-up verification

- `server/drivers/openai-chat-local-model.test.ts`, `server/drivers/openai-responses.test.ts`, `server/drivers/chat-repeat-guard.test.ts`, and `server/drivers/chat-text-tool-calls.test.ts`: passed (4 files, 79 tests).
- `server/routine-model.test.ts` and `server/routines.test.ts`: passed (2 files, 197 tests).
- `pnpm typecheck`: passed.
- Touched-driver `oxlint --deny-warnings` and `git diff --check`: passed.
- Isolated fixture launched with `node --experimental-strip-types scripts/control-rootclaw.ts launch`; `pnpm control:rootclaw doctor --url http://127.0.0.1:22243` reported connected and no problems; fixture was stopped afterward.
- No dependencies added; no full Vitest suite run.

## Batch 4 — skills and tools

- Target: `v0.1.144` (`dad50e140ef7f332ef101ae93aff8e9e0a83343b`); branch `port/0144-skills-tools`, stacked on `fix/memory-upkeep-lifecycle-test` at PR #34 head `107ebc97da374f6b1a463b54797cc08b0880f12f`.

| Upstream SHA | Ancestry | Decision | Port / reason | Focused tests |
|---|---|---|---|---|
| `bd5b2b214f04c0173a936a97408201e1ac55d221` | Ancestor | AMBIL | Skills can be named at the beginning or within a message, multiple skills can run once, and composer suggestions work at the caret while built-ins remain leading-only. Adapted to RootClaw's bot/library/imported/native skills and built-in command set. | `server/skill-command.test.ts`, `server/native-skills.test.ts`, `src/lib/composer-commands.test.ts`, `src/components/Composer.slash.test.ts` (19 passed). |
| `d58ef29f8e1e5f1a1a710f88a3ab3a68d92d2b59` | Ancestor | AMBIL | Added a social-post preview skill and template; folder-page videos are recorded by file identity and streamed by range only while the same file remains. Video paths are excluded from publishing. Added MiniMock/Lucide notices. | `server/page-files.test.ts`, `server/chat-apps.test.ts`, `server/skill-social-posts.test.ts`, `src/lib/social-posts-template.test.ts` (55 passed). |
| `ca3b73be3803d7f0c90e458fa380dbf6df483007` | Ancestor | AMBIL | `start_thread` on the same bot can request an available model selection; validation reuses provider/model and proposal rules, and teammates cannot receive the option. Catalog golden updated. | `server/drivers/agents-proxy.test.ts`, `server/drivers/agents-catalog-wire.test.ts` (207 passed). |
| `9e35731d9d152423f1bbcba83da3b0582f3e921d` | Ancestor | AMBIL | `show_html` and `update_html` accept `frameless`; default framing is unchanged and omitted update options preserve the current frame. RootClaw's existing app renderer already respected `border: false`. | `server/chat-apps.test.ts` (32 passed). |
| `d602f986086d772dde34c8da82015d09199605b0` | Not an ancestor | LEWATI | Provider-independent email sending is after the target tag; excluded by the ancestry rule. No files changed for this item. | None. |

### Batch 4 verification

- Focused unit tests passed: `server/skill-command.test.ts`, `server/native-skills.test.ts`, `src/lib/composer-commands.test.ts`, `src/components/Composer.slash.test.ts`, `server/page-files.test.ts`, `server/chat-apps.test.ts`, `server/skill-social-posts.test.ts`, and `src/lib/social-posts-template.test.ts` (8 files, 74 tests); `server/drivers/agents-proxy.test.ts` and `server/drivers/agents-catalog-wire.test.ts` passed separately (2 files, 207 tests).
- `pnpm typecheck`: passed.
- Touched-file `oxlint --deny-warnings` and `git diff --check`: passed.
- Isolated fixture launched with `scripts/control-rootclaw.ts launch`; `pnpm control:rootclaw doctor --url http://127.0.0.1:22342` reported connected with no problems; fixture was stopped afterward.
- CI review found the generated `shared/app-frame/app-host.html` had not been refreshed for the frameless tool schema. Regenerated with `node --experimental-strip-types scripts/build-app-host.ts`; `shared/app-frame/host-page.test.ts` passed (7 tests).
- Initial PR CI also reported Windows browser S4 tab cleanup failures in `server/browser/cdp/s4-pages.e2e.test.ts`; no browser/CDP files are changed by this batch. Treat that result separately from the app-host generation mismatch and verify on the next CI run.
- `pnpm audit` ran before any dependency changes; no dependency was added.
- `server/folder-pages.e2e.test.ts` was attempted once but its dashboard test failed before assertions because the scripted fixture produced no tool evidence. Whether this is a baseline failure is unverified. No fixture or product code changes were made in response; record as a validation limitation.
- Logo/icon changes and Phase 5 stubs were not touched. No external engines were used.
