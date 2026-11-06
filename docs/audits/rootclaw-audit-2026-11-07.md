# RootClaw Deep Audit — 2026-11-07

## Executive summary

Pinned main: `d5d9ca4faf28ab067faddc4cd1bbd18afb517c34` (2026-11-07 02:38 WIB), independently rechecked as current main. Read-only: no repository commits, pushes, PR/comments, cloud-agent launch, VPS access, deployments or paid model evaluations.

This is a deep, evidence-backed **bounded audit**, not a claim that every byte of all 6,200 files was manually reviewed. The entire Git tree was inventoried; 81 selected files (2,690,219 exact bytes, 53,849 text lines) were fetched with sanctioned GitHub reads and verified against their pinned Git blob hashes. `/workspace/audit/RootClaw` is that selected-file snapshot, **not a git clone**: source-control instructions prohibit local cloning for investigation. Fifty recent commit records were obtained; eleven recent commit patches were pattern-scanned. Full-tree LOC, all-file branding/secret scans, all historical commits, installed-image OS scans, and end-to-end exploitation were not completed. No full Vitest suite was run. Do not treat unreviewed surfaces as safe.

Key conclusions:
- Latest CI `42281466760`: 6/8 Vitest shards fail, with **14 failing assertions in 8 distinct files**. Twelve failures follow the new skills default/selection behavior; two deterministic failures predate it.
- Two earlier diagnoses need correction: **“disk full” is deliberately injected in passing EventBus tests**, not verified disk exhaustion; **all 243 weighted Linux test paths still exist**. The 211 e2e paths are intentionally excluded, leaving exactly 32 matching weights.
- The encrypted-backup test did restore the archive; it fails on the changed skill-library response/migration shape, not on demonstrated encryption failure.
- Native-only runtime registry is real. Remaining unwanted engine dependency/build residues are separate from legitimate Anthropic/Gemini/Responses/Ollama API adapters and the required legacy migration module.
- Highest-priority security/reliability gaps: service-loopback cross-bot authority, unenforced macOS network:false, incomplete/fail-open money budgets, and loss of unknown external-effect state on crash.
- Production workspace dependency audit returned 9 advisories (2 high / 5 moderate / 2 low). This is dependency-graph evidence, not proof all are exploitable in the packaged server.

**Ranked findings: 0 Critical, 5 High, 8 Medium, 4 Low = 17 findings.** Severity counts refer to grouped findings, not to individual failing tests or advisories. Zero verified Critical does not mean none exist outside reviewed scope.

## 1. Repository inventory

- Complete tree: 6,200 tracked file blobs; 206,404,251 blob bytes (196.84 MiB; Git history and filesystem allocation excluded); tree not truncated.
- Languages by extension: 3,739 `.ts`, 541 `.tsx`, 406 `.mjs`, 58 `.mts`, 28 `.cjs`; 312 Markdown, 43 MDX; 571 PNG and 235 JPG. Counts are files, not executable-code percentages.
- Tests by filename pattern: 2,038 test/spec files, including 273 e2e-named files. This is not a runnable-test/assertion count.
- Directory file counts: server 2,173; src 1,639; docs 1,075; electron 389; scripts 277; shared 196; apps 84; evals 77; cloudflare 58; companion 44; third_party 41; connector 31; build 26; skills 18; deploy 16.
- Five package manifests: root, apps/docs, cloudflare/control-plane, companion, connector. Root uses pnpm 10.33.0, Node >=24, TypeScript, React/Vite and Electron; version 0.1.138; Apache-2.0.
- Entrypoints: electron/main.mjs; CLI server/rootclaw.ts → dist-server/rootclaw.js; main server server/index.ts; companion/src/index.ts; connector/src/main.ts; Next-based docs and Cloudflare control-plane workspace.
- Build: tsc frontend/server checks, Vite renderer build, server bundle via scripts/bundle-server.mjs, separate companion/updater/native asset packaging and Electron builders. `pnpm test` is broader than Vitest (also broker, Electron and packaged-server smoke).
- Seven workflows inspected: ci, ci-stop-closed, connector-e2e, docker, shared-terminal-smoke, vps-image-release, windows-defender-check. Main CI is change-scoped; selected jobs/platforms differ by push/PR/nightly. Versioned image release validates tag/package/Compose consistency, typechecks/lints, runs focused release tests and amd64/arm64 image smoke, then publishes.
- Four Dockerfiles inspected: root multi-stage server/cloud-home, deploy/local derivative, connector, and .oss-scanner. Root runtime runs self-hosted server as rootclaw; cloud-home starts a root supervisor then drops child privileges. Connector intentionally runs as root and controls a Docker socket: it is a privileged host agent, not a bot sandbox. Scanner image is a development audit environment, not production.
- Largest verified code files: server/index.ts 15,643 lines / 930,253 bytes; server/index.test.ts 12,426 lines / 650,646 bytes; openai-chat.ts 1,368 lines; workspace-tools.ts 1,092; skills.ts 1,390. Tree metadata also identifies vendored Electron updater 599,074 bytes, src/state/store.tsx 156,807 bytes, and electron/main.mjs 142,625 bytes; their full LOC was not measured.
- Whole-repository LOC was not measured. The verified 53,849 text-line count is only the selected snapshot, including tests/config/lockfiles; it is not source-code-only LOC.

## 2. Severity-ranked findings

| ID | Severity | Finding | Source | Evidence | Fix |
|---|---|---|---|---|---|
| H01 | High | Session-less service loopback crosses bot boundaries | server/request-auth.ts:34–55,607–620 | SERVICE_ALLOW exposes bot/message reads, guarded sends, task creation and interruption to any non-browser loopback caller; the source explicitly documents that bot shells can act in other bots’ Full-access threads. Self-hosted default is owner trust at lines 87–109. | Require a relay-specific token and principal on worker routes, remove them from session-less SERVICE_ALLOW, enforce target-bot/thread authorization, and explicitly use service trust for shared installs. Test an untrusted local subprocess against every allowed route. |
| H02 | High | macOS shell network flag is not enforced | server/drivers/workspace-tools.ts:105,454,480–513,588 | Linux conditionally adds --unshare-net. The macOS sandbox starts with (allow default), denies only filesystem reads/writes, and never examines options.network or denies network access. Therefore network:false does not impose the advertised network boundary on that platform. Static confirmation; no macOS execution was available. | Add (deny network*) by default and a deliberate network allow only for network:true; test localhost, LAN and Internet access with both settings on macOS. |
| H03 | High | Monetary budgets fail open and omit paid requests | server/budget-guard.ts:70–86; server/drivers/chat-context.ts:131–145; server/drivers/openai-chat.ts:924–935,1007–1012 | An isolated execution of the exact BudgetMeter class returned ok / wouldExceed:false for a USD-only cap with price=null after 2 million tokens; the priced control returned stop. Compaction discards response usage entirely. The verifier adds token usage but not costUsd, and ignores the meter stop result. Normal USD metering uses a fixed local model price, not provider-reported cost. | Centralize all provider calls behind a per-call usage/budget observer; charge summaries, verifier and retries; prefer actual cost when reported; retain per-model/cache pricing; reserve input plus output before dispatch; reject USD-only caps when neither usable price nor actual-cost enforcement exists. |
| H04 | High | Crash recovery cannot represent an unknown external outcome | server/run-store.ts:16–19,300–310,413–427; server/index.ts:9602–9609 | Persisted tool states are running/ok/failed/interrupted, with name and timestamps but no durable effect receipt. A restart maps running tools to interrupted, and the retry action starts a generic continue-and-finish prompt. Native seen-call protection exists only in the current turn. This does not prove an automatic replay: retry is an explicit route, but it cannot safely distinguish a never-dispatched action from an accepted external action whose receipt was lost. | Persist prepared/dispatched/succeeded/failed/unknown outcomes and action fingerprints, request IDs and reconciliation receipts. On crash, unknown mutating actions must be reconciled or explicitly resolved before continuation. Include this state in the continuation prompt and UI; do not blindly replay. |
| H05 | High | Production workspace graph contains known advisories | pnpm-lock.yaml:2488,3862,4776,5214 | pnpm@10.33.0 audit --prod --json completed with exit 1: 9 advisories = 2 high, 5 moderate, 2 low; no critical. High findings concern docs’ Vite/source-map dependency path, not a demonstrated remotely exploitable packaged-server endpoint. KaTeX is a root renderer dependency with a conditional low-severity advisory. | Upgrade/override source-map-js to >=1.2.2, Vite to >=7.3.7, @vitest/mocker to >=4.1.12 via its owning dependency, and KaTeX to >=0.18.2 with compatibility tests. Re-audit all workspace importers; separately scan runtime OS/browser/Electron images. |
| M01 | Medium | Skills availability was changed into unconditional prompt injection | server/skill-library.ts:13–14,113–132; server/index.ts:9877–9889 | d5d9ca4 ignores the text parameter and selects every default-enabled capability-compatible skill. Five new process manuals have no required capabilities. Trigger terms remain required by manifest validation but are never consulted. Twelve of the latest CI’s fourteen failing assertions derive from this default/selection change, including restored-skill migration expectations. | Separate library availability from per-turn relevance. Keep intentional default-on behavior with explicit false opt-out tests, restore relevance/lazy selection, and preserve negative relevance tests. Update genuinely stale default-off fixture assumptions, not every failing assertion indiscriminately. |
| M02 | Medium | Descriptor execution test is not sandbox-capability gated | server/drivers/workspace-tools.test.ts:11–12,374–428; .github/workflows/ci.yml:122–144 | The new ordered-FD test forcibly builds bwrap and executes it unconditionally, while neighboring real execution cases use runIf(shellSandbox() === "bwrap"). CI reports result.status=null; the assertion does not expose result.error/signal. The same failure precedes d5d9ca4 in both previous runs. The logs do not establish ENOENT versus a killed process. | Keep pure argument/FD-numbering assertions platform independent; gate actual spawn on a proven working bwrap sandbox or provision a dedicated enabled sandbox lane. Assert/report result.error and signal. Do not label this a descriptor-numbering bug or a runner disk failure without that evidence. |
| M03 | Medium | Self-hosted server image lacks the shell sandbox it requires | Dockerfile:63–79,118–125,164–176; deploy/local/Dockerfile:1–9; server/drivers/workspace-tools.ts:389–399,574–577 | Only cloud-home installs bubblewrap. The server target is built from runtime, whose apt list does not include it; the local derivative installs only optional CLIs. Confined native shell fails closed when no OS sandbox works. Current image health smoke does not execute a confined tool. | Install and verify the sandbox for the server target, including the host user-namespace/security policy requirements, or explicitly document unsupported confined shell. Add an image smoke proving an allowed command succeeds and forbidden filesystem/network access fails. Do not make SANDBOX=off the production fix. |
| M04 | Medium | External-engine removal still has dependency/build residues | package.json:108; pnpm-lock.yaml:50,1571,6526; Dockerfile:166–169; deploy/local/Dockerfile:7–8; .github/workflows/docker.yml:30–60,76–79 | @muse-code/sdk remains a direct production dependency. Both server/local images retain ENGINES installation escape hatches. The manual image workflow still resolves Claude Code and Codex packages and sends now-unused cloud engine build arguments. The native driver registry itself contains only API drivers; this is residue, not proof that those removed runtimes execute. | Remove the unwanted agent SDK after a full usage search, remove engine-specific CLI installation/build variables and dead npm lookups, regenerate the lockfile, and add a native-only dependency/build policy check. Keep legacy-engines.ts and legitimate provider adapters. |
| M05 | Medium | Bundled process skills are incomplete packages | skills/brainstorming/SKILL.md:229,293; skills/test-driven-development/SKILL.md:216; skills/systematic-debugging/SKILL.md:112,281; skills/writing-plans/SKILL.md:14,59,201–204 | The tree lacks builder-check-prompt.md, visual-companion.md, writing-good-tests.md and root-cause-tracing.md referenced as required companion files. It also lacks the required using-git-worktrees, subagent-driven-development and executing-plans skills named in writing-plans. These instructions are now broadly mounted. | Package the real helper files and supported prerequisite skills, or rewrite the workflows to tools RootClaw actually offers. Validate required file/skill references and record upstream source/version/license at packaging time. |
| M06 | Medium | Main vitest lanes explicitly exclude all e2e-named suites | .github/workflows/ci.yml:144; scripts/testing/vitest-shard-weights.json; docs/HANDOFF.md:44–46 | The workflow passes --exclude **/*.e2e.test.ts and **/*.e2e.test.tsx. The complete tree has 273 e2e-named files; Linux weights include 211 such files. Other targeted smoke/release workflows cover some scenarios, but a green main vitest matrix is not an exhaustive integration result. | Inventory excluded suites, identify which targeted job owns each, and restore a bounded deterministic portable e2e lane. Track quarantine reason/owner/expiry for remaining hangs. Do not launch the entire suite during this audit. |
| M07 | Medium | Gemini OAuth model catalog uses refresh token as API key | server/drivers/api-providers.ts:78–94,134–142 | When Google OAuth is used without a key, apiKey becomes GOOGLE_OAUTH_REFRESH_TOKEN. Inference correctly uses googleAccessToken, but refreshModels passes that same refresh token to the catalog function, which places it in x-goog-api-key. Failure is swallowed and the static list remains. This is a verified request-construction mismatch, not evidence that a live account was exercised. | Make catalog authentication use the same access-token/header provider as inference. Never pass a refresh token to a model endpoint as an API key. Test key-only and OAuth-only catalog refresh against a fake provider. |
| M08 | Medium | Handoff no longer describes current CI or runtime state | docs/HANDOFF.md:32,38–45,48,50–58 | It claims index.test.ts has zero failures, cites ~64 failed files and old removed-engine causes, and describes prerelease work while package/image is 0.1.138. Latest verified CI instead has 14 assertion failures in 8 files; 12 are d5d9ca4 skills regressions. The source already has send deduplication and durable native run records. | Replace mutable historical claims with dated evidence and current run links; separate historical findings from current blockers. Explain native provider fixtures named claude are aliases, not restored external engine processes. |
| L01 | Low | Upstream branding remains outside NOTICE | README.md:192 | The README directly names and links the former project. This violates the stated branding constraint that the former name appears only in NOTICE, except the retained migration module. This is one verified matching line in inspected text, not a complete all-file clean bill. | Replace the README sentence with neutral attribution pointing to NOTICE; leave NOTICE’s legal attribution intact and leave logos/icons unchanged. |
| L02 | Low | Size ratchet correctly catches two new overages | scripts/testing/file-size-ratchet.test.ts:24,36,55–73 | Native loop is 1368 lines against 1367; workspace tools is 1092 against 1090. Both failures already exist before d5d9ca4. The test’s strict cap is intentional. | Move a cohesive helper out of each file and keep behavior/coverage intact, bringing counts below the recorded baselines. Do not silently raise the baselines or call this flaky. |
| L03 | Low | Shard warning compares discovered unit tests with excluded e2e weights | scripts/testing/duration-sequencer.ts:73–91; .github/workflows/ci.yml:144 | All 243 Linux weighted paths exist in the pinned tree. Exactly 211 are e2e paths excluded by the command, leaving exactly the 32 matched files in the warning. The warning is not evidence of stale paths or an actual fallback branch: planShards still uses weights for matches. | Calculate the denominator after applying the same include/exclude filters, or use a unit-only weights set for this lane. Refresh durations only when measurements warrant it. |
| L04 | Low | Manual image smoke contains no meaningful image assertion | .github/workflows/docker.yml:17–24,26–27,65–79 | “Prove each image ships its files once” only assigns Python variables and exits: it does not inspect an image or assert anything. The job named publish has no needs on smoke and push:false. This workflow is manual, so this is misleading automation, not proof an unsafe image was published. | Replace it with executable image assertions or remove it in favor of the versioned release workflow; remove unused engine arguments; make any real publishing job depend on its checks. |

## 3. CI: all jobs in the latest five main runs

- [42281466760](https://github.com/cryptyroot-ux/RootClaw/actions/runs/42281466760) — `d5d9ca4`, failure; created 2026-11-07 02:38 WIB.
- [42273278750](https://github.com/cryptyroot-ux/RootClaw/actions/runs/42273278750) — `991e90b`, failure; created 2026-11-07 01:43 WIB.
- [42270777975](https://github.com/cryptyroot-ux/RootClaw/actions/runs/42270777975) — `03b2d05`, failure; created 2026-11-07 01:26 WIB.
- [42165864310](https://github.com/cryptyroot-ux/RootClaw/actions/runs/42165864310) — `cf4811b`, success; created 2026-11-06 12:01 WIB.
- [42158988658](https://github.com/cryptyroot-ux/RootClaw/actions/runs/42158988658) — `c432505`, success; created 2026-11-06 10:51 WIB.

S=success, F=failure, —=skipped by scope/condition. This includes every job, including the aggregator.

| Job | d5d9ca4 | 991e90b | 03b2d05 | cf4811b | c432505 |
|---|---|---|---|---|---|
| typecheck + lint | S | S | S | S | S |
| macOS smokes (packaged server + Electron) | S | S | S | S | S |
| renderer smoke (control-rootclaw ui, Ubuntu 24.04) | S | S | S | S | S |
| open-source edition builds without enterprise/ | S | S | S | S | S |
| packaged server smoke (ubuntu-latest) | S | S | S | S | S |
| browser identity (ubuntu-latest) | S | S | S | S | S |
| control-plane check + workerd tests + dry run | S | S | S | S | S |
| vitest (ubuntu-latest, shard 4/8) | F | S | S | S | S |
| vitest (ubuntu-latest, shard 6/8) | F | S | S | S | S |
| vitest (ubuntu-latest, shard 1/8) | F | S | S | S | S |
| vitest (ubuntu-latest, shard 3/8) | F | S | S | S | S |
| vitest (ubuntu-latest, shard 5/8) | F | F | F | S | S |
| vitest (ubuntu-latest, shard 8/8) | F | F | F | S | S |
| vitest (ubuntu-latest, shard 7/8) | S | S | S | S | S |
| vitest (ubuntu-latest, shard 2/8) | S | S | S | S | S |
| Windows CUA host smoke | — | — | — | — | — |
| browser driver S4 (${{ matrix.os }}) | — | — | — | — | — |
| package + smoke (Ubuntu 24.04 x64) | — | — | — | — | — |
| cloudflared installer (Linux ARM64) | — | — | — | — | — |
| CI | F | F | F | S | S |

Latest failing Vitest assertions, individually enumerated:

| Shard | File:line | Test/contract | Classification | Exact fix direction |
|---|---|---|---|---|
| 1/8 | server/index.test.ts:7935 | Dashboard turn excludes create-verification-skill | d5d9ca4 relevance regression | Restore intent-aware selection; retain the negative assertion. |
| 1/8 | server/index.test.ts:8221 | Default feature object | Stale default-off contract | Expect skillsLibrary:true if intentional; assert explicit false still disables; update the later same-object expectations too. |
| 3/8 | server/skill-share.test.ts:136 | asks by default; off when library off | Stale omitted-flag means off fixture | Set features.skillsLibrary:false for the off case; separately assert new default behavior. |
| 4/8 | server/skills-library-api.test.ts:45 | Hides routes when library off | Stale omitted-flag means off fixture | Explicitly turn the feature off before testing 404; add default-on route test. |
| 5/8 | scripts/testing/file-size-ratchet.test.ts:73 | No source size growth | Pre-existing deterministic maintainability failure | Extract helpers to reduce openai-chat 1368→<=1367 and workspace-tools 1092→<=1090. |
| 6/8 | server/skills-library.test.ts:147 | Every-bot skill absent while off | Stale omitted-flag means off fixture | Build off host with features.skillsLibrary:false. |
| 6/8 | server/skills-library.test.ts:155 | Feature defaults off | Stale explicit old contract | Test new default-on and explicit-false opt-out, if owner intends that contract. |
| 6/8 | server/skills-library.test.ts:164 | Unknown config feature keys are stripped | Stale post-strip flag expectation | Continue asserting unknown keys stripped; expect undefined recognized flag to inherit the new true default. |
| 6/8 | scripts/verify-workspace-backup.ts:214; server/workspace-backup-workflow.test.ts:5 | Encrypted restore and continue | d5d9ca4 activates skill-library boot migration | Archive restored; response now has library origin, assignedSkills, everyBot and a migrated importedAt. Either explicitly disable library for the private-legacy case or test migration/provenance separately. Do not diagnose crypto/restore failure. |
| 8/8 | server/skill-library.test.ts:36 | Requires trigger and capability | d5d9ca4 relevance regression | Restore trigger/intent predicate and keep capability predicate. |
| 8/8 | server/skill-library.test.ts:93 | Verification skill requires explicit creation request | d5d9ca4 relevance regression | Only mount that skill on explicit creation intent plus skillAuthoring; no blanket expectation relaxation. |
| 8/8 | server/skill-library.test.ts:107 | No verification skill for generic maintenance | d5d9ca4 relevance regression | Preserve negative intent cases. |
| 8/8 | server/skill-library.test.ts:123 | No dashboards for unrelated prose | d5d9ca4 relevance regression | Restore dashboard intent gating. |
| 8/8 | server/drivers/workspace-tools.test.ts:428 | Ordered child descriptors with stale first grant | Pre-existing capability-ungated bwrap execution; precise spawn cause unreported | Gate/provision actual execution; retain pure FD assertions; report result.error and signal before assigning host cause. |

Historical failures: runs 42273278750 and 42270777975 each fail only shard 5 (size ratchet) and shard 8 (ordered attachment descriptor test), plus the dependent CI aggregator. Their four failure logs were read. Runs 42165864310 and 42158988658 have no failed jobs. No latest failure is classified as proven random flakiness.

The “disk full” messages appear under named EventBus fault-injection tests (`server/harness/bus.test.ts:137,360`); the same file finishes with 31 passing tests in the latest shard 4 log. They are not grounds for deleting runner caches or increasing disk. The warning “Only 32 of 243” is exactly explained by exclusions: all 243 paths exist; 211 are e2e-named; 32 are not. The sequencer does not contain a separate equal-count fallback branch. Weight refresh alone will not fix any failed assertion.

Cheap recommended verification after fixes: the skill-library, skills-library, skills-library-api, skill-share files; the two named index.test.ts cases; the backup workflow; workspace-tools exact-file mount cases; and file-size ratchet. Run on a provisioned sandbox lane where appropriate. This audit deliberately did not run them locally or install the entire project dependency graph; pinned GitHub job logs are the execution evidence.

## 4. Branding and external-engine removal

### Verified upstream-name matches

In the 81 inspected files, the only former-project-name matching line outside the permitted locations is `README.md:192` (display name and repository URL on one line). Every inspected matching line is listed here. GitHub indexed code search returned zero results even for a name directly present in README; therefore it was not used as proof of absence. The remaining 6,119 files have not been content-scanned, and binary screenshot text was not OCR-scanned. An exhaustive all-file hit list is not established.

### Runtime versus residue

- `server/drivers/builtIn.ts:12–25` registers twelve in-process API drivers. Anthropic, Gemini, OpenAI Responses, Ollama Cloud, custom OpenAI-compatible, xAI, Groq, Mistral, Cerebras, Meta, MiniMax and Greenference are provider integrations, not external agent engines.
- `server/legacy-engines.ts:6–17` recognizes removed IDs for migration and must be kept. IDs such as claudeAgent, codex, opencodeGo and hermesAgent in that module are permitted, not removal bugs.
- `package.json:108` and lockfile `50,1571,6526`: unwanted Muse agent SDK residue. No Muse driver is registered. A repository-wide usage search is still needed before asserting the dependency has no other consumer.
- Root/local Dockerfiles retain `ARG ENGINES` / optional global npm installation. Manual `.github/workflows/docker.yml:32` still names Claude Code and Codex packages. The cloud-home target no longer consumes those engine build args; do not claim it actually contains those CLIs merely from this stale workflow.
- `server/native-skills.ts:16,37,40` retains Claude-specific comments/options. `server/imported-skills.ts:31–32,366,405` has claudeCode/codex import-source labels, claudeUserSkills option, and legacy skill folder names. `server/skills.ts:329` duplicates the `.claude/.agents/.grok` skill-directory list. `nativeSkillFolders` now unconditionally returns [] at imported-skills.ts:364–370, making its native-skill discovery path inert. Compatibility import/cleanup is not engine execution; consolidate and label it explicitly rather than deleting upgrade support blindly.
- `server/drivers/prompt-split.ts:113–123` retains a Claude CLI convention comment/helper. Usage outside the inspected set was not globally established.
- `scripts/verify-workspace-backup.ts:36` sets HERMES_HOME in an isolated test environment; this is fixture residue, not a Hermes subprocess.
- `server/index.test.ts:7923,7946,8259` uses an instance named claude and fakeClaudeDump. Passing CI/provider fixture behavior shows these names alone are not proof an external Claude engine is running. Rename fixtures for clarity after checking their native configuration, not by deleting tests.
- `server/oauth/oauth.ts:1–2` explicitly excludes subscription sign-in; Google OAuth uses the person's own registered application. No subscription OAuth engine was verified in inspected runtime files.
- `apps/docs/content/docs/providers/antigravity.mdx:7,17–19` explicitly says external runtimes were removed and explains migration. The historical slug is a compatibility URL, not a live Antigravity integration. `docs/custom-engines.md` describes native OpenAI-compatible providers despite its inherited filename.
- `.claude/skills/...` paths in the tree are contributor skill documents. File/path names are not executable engine integrations by themselves.

## 5. Security review and dependency evidence

### Authentication, CORS and WebSocket

`server/request-auth.ts:542–629` checks scoped sessions, cookie-origin/CSRF rules, expiry/revocation, proxy headers and loopback/browser separation; it does not simply trust any presented Host header from remote TCP listeners. The main HTTP server binds 127.0.0.1 (`server/index.ts:15466`). `server/routes/upgrades.ts:35–64` routes registered WebSocket upgrades through the same HTTP authentication/maintenance handler, with 10-second handshake timeout and bounded early bytes. This is a positive control, not proof every individual endpoint is correct. No wildcard credentialed CORS policy was verified in reviewed code. All route handlers were not individually audited; the 15k-line main server remains a large surface. H01 is a specific verified exception in the trust model.

### Shell/files and network

The native shell is deliberately a command-execution tool, not automatically a command-injection vulnerability. It spawns a fixed program with argument arrays; approvals and tool access gates must decide whether that requested command may run. `shellEnvironment` removes code-loading variables; restricted shells fail closed without a sandbox; Linux gets private tmp/pid/network namespaces and descriptor-backed exact-file grants. Descriptor-based read/write checks and atomic replacement materially improve symlink/hardlink/TOCTOU safety. Full access and explicit ROOTCLAW_SHELL_SANDBOX=off intentionally remove OS confinement and must not be advertised as secure isolation. H02 remains on macOS. No additional exploitable path traversal or shell injection was demonstrated in reviewed paths; this is not a complete absence finding.

`server/drivers/web-tools.ts:39–73,105–162` rejects nonpublic IP ranges including encoded IPv4-in-IPv6 forms, resolves DNS at connection time through a pinned dispatcher, revalidates redirect targets, forbids URL credentials, caps body size/redirects/time, and fences tool outputs in the native loop. ROOTCLAW_WEB_ALLOW_PRIVATE is an explicit operator bypass and needs an operational warning. No live internal-network probe was performed.

### Docker socket and permissions

Commit 991e90b adds Debian docker.io at root Dockerfile:69. Shipping a Docker client is not itself a host escape: access to a daemon/socket is the privilege. Neither inspected server Compose file mounts `/var/run/docker.sock`. Root compose.yaml:8–12 adds host group GID 988 and describes socket access, but **group membership alone is not a socket mount**. Do not report active host-root exposure from those lines alone. A deployment override may mount it; no VPS was inspected.

If that socket is mounted with write access, unrestricted bot shell or compromised server code can control the host daemon; docker-group access is root-equivalent on a normal rootful daemon. Use a separate narrowly authenticated broker or rootless isolated daemon; never hand an ordinary bot the raw host socket. Server code/skills are copied with rootclaw ownership (Dockerfile:170–173), unlike root-owned cloud-home artifacts: do not rely on application ownership as tamper resistance against same-user unrestricted shell. Connector is an intentional privileged host agent and must be a separate trust domain. Pin base images/browser artifacts by digest for reproducibility, minimize CLI-only packages, and scan OS/browser/Electron layers; this audit did not run image builds or binary CVE scans.

### Secret scan (bounded, no values disclosed)

The selected snapshot was pattern-scanned for PEM private keys, GitHub PAT formats, AWS access key IDs and common provider-key formats. Two provider-format candidates in `server/index.test.ts:6245,11680` are intentionally synthetic test values (only suffixes `ment` and `CRET` are reported); no live credential was verified. Eleven recent commit patches, including Docker and attachment/sandbox changes, yielded no matches under those patterns. This does **not** cover all content/history, generic high-entropy strings, deleted old secrets, Git LFS or binaries. No “repo contains no secrets” claim is made. Redaction code uses sensitive-name/content checks, but depth >12 returns objects unchanged (`server/redact.ts:16–18`); deeply nested values are a hardening review item, not a demonstrated leaked production key.

### Production dependency audit

Command: `npx --yes pnpm@10.33.0 audit --prod --json` using the pinned lockfile; no full project install, no fix command. Exit 1 is advisory detection, not a tool crash. Metadata: 749 production graph dependencies; zero critical / two high / five moderate / two low. Workspace-transitive development tools may appear in production dependency paths; this is not an OS-container SBOM.

| Severity | Package/path | Advisory | Fixed version |
|---|---|---|---|
| High | docs → fumadocs-mdx → vite → postcss → source-map-js 1.2.1 | GHSA-68fv-2mgg-jv7q | >=1.2.2 |
| High | docs → fumadocs-mdx → vite 7.3.6 | GHSA-587h-7wmj-h5pm | >=7.3.7 |
| Moderate | same Vite path | GHSA-698v-4r3x-3vcv | >=7.3.7 |
| Moderate | same Vite path | GHSA-r825-w8mm-5pxw | >=7.3.7 |
| Moderate | same Vite path | GHSA-rq7h-c2jc-7f22 | >=7.3.7 |
| Low | same Vite path | GHSA-9jrq-w75r-8gcw | >=7.3.7 |
| Moderate | control-plane → better-auth → vitest → @vitest/mocker 4.1.11 | GHSA-qxg6-89mg-rqv8 | >=4.1.12 |
| Moderate | same mocker path | GHSA-xp26-3454-mjgp | >=4.1.12 |
| Low | root → katex 0.16.47 | GHSA-238p-pmpm-9mq7 | >=0.18.2 |

KaTeX’s advisory requires prior prototype pollution or attacker influence over an options prototype and unsanitized insertion; it does not mean arbitrary math automatically executes code. Full audit JSON retains the exact registry advisory descriptions and conditions.

## 6. Native engine quality and Hermes Hearth lessons

This is an architectural comparison against the requested Hearth lessons, not a benchmark claim or a fresh independent audit of Hermes v0.23.0.

| Lesson | Verified RootClaw mechanism | Remaining gap / next proof |
|---|---|---|
| One conversation authority | Host ownership/generation/resource claims in index.ts:2017,5395,9911–10009; native active map rejects overlapping turns; EventBus serializes per-file append drains | Need explicit single-process/instance lock and durable queue lease tests across restart; do not mistake per-runtime maps for a multi-process distributed lock. No double-writer exploit established. |
| Request idempotency | send-idempotency.ts:19–37 matches accepted send IDs; 40–64 coalesces concurrent requests and returns 409 for changed fingerprints | Optional send IDs and in-memory coalescing are not a durable external-tool transaction. Test ACK loss/restart/reconnect on each channel and mutating endpoint. |
| Explicit unknown outcomes | RunStore persists runs/tools and marks restart interruption; native tool exception text says dispatched actions may have taken effect | H04: no distinct unknown side-effect state/receipt; retry continuation lacks reconciliation details. |
| No blind side-effect replay | Native loop refuses identical repeated call IDs (openai-chat.ts:1047–1059), disables transport retry after handled non-plan calls (907–919), and prevents failover after tool effects (1263–1266) | Good within-turn defenses; new IDs/new turns and crash recovery need persisted operation identity. Tool error correction is not a substitute for authoritative reconciliation. |
| Stable prompt/cache prefix | prompt-split.ts:15–39,92–110 separates stable/volatile context; Anthropic marks system/tools cache_control; library description history stabilizes running prompts | Broad inline skill injection adds prompt bytes and conflicting workflows. Cache read/create categories are collapsed in Anthropic usageOf at 93–96, weakening cost accuracy. Measure cache hit/billed cost rather than inferring savings. |
| Deterministic pruning before LLM summary | turn-context.ts plans fit, preserves finding/error lines, caps summary input/output, provides deterministic fallback and offload; chat-context.ts throttles repeated compaction | Summary text has no explicit UNVERIFIED claim/provenance classification in reviewed implementation. Journaling records counts, not proof that every summary statement is grounded. Add source message/tool IDs and receipt-aware truth labels. |
| Total budgets | BudgetMeter plus per-turn request count counts main model calls and reserves a final response; verifier and compaction consume request slots | H03: request-count enforcement is not monetary completeness; summaries drop usage, USD-only unpriced caps fail open, cached/different-model pricing loses accuracy. Cross-agent/tool budgets were not demonstrated as unified. |
| Tool orchestration | tool-batch.ts:11–42 executes bounded consecutive reads concurrently (default 4, max 16), commits in requested order and serializes mutations | Ensure all read-only annotations are authoritative. Promise.all rejection does not itself cancel sibling read operations; test cancellation and cleanup rather than claiming atomic rollback. |
| Cancellation | AbortController propagates through model/tools; interruptTurn aborts, stops process groups, awaits done; uncertain cleanup is not reported as success | Stopping cannot undo an accepted external effect. Ensure persisted unknown outcomes survive SIGKILL, not just graceful stop. |
| Skill locks/provenance | Library source/SHA/review state, content-match checks, staged learned revisions and edit restrictions exist in skills.ts and skill-library.ts | No explicit immutable policy-skill lock in bundled manifest schema. Cloud-home root ownership helps; self-hosted same-user writable app files do not. Missing helper packages (M05) and blanket loading (M01) undermine reliability. |
| Provider adapters | Correct native protocol mapping and no CLI spawning in builtIn; failed tool envelopes map to Anthropic is_error and Gemini error; truncated tool-call responses are rejected | M07 OAuth catalog auth mismatch; preserve cache/usage breakdown and model-specific pricing. Live provider compatibility, thinking-signature replay and schema-reference handling need dedicated fixture/real API validation; no speculative API bug is asserted without those checks. |

Additional positive controls: request-size learning, bounded 64 rounds/200 tool calls, model-request limit shared with summaries/verifier, lazy tool loading, offload handles, malformed/truncated tool call refusal, no hidden retry of user denial, and turn-continuation files. `server/engine-memory.ts` exists, but no runtime import/use was found in the inspected native loop or main server; the handoff explicitly says it is not wired. Do not describe memory or a “swarm” as a proven completed intelligence subsystem.

## 7. Code quality

Counts below apply **only to the 81 byte-verified inspected files**, not all 6,200 files: TODO 0; FIXME 0; HACK 0; `as any` 20; @ts-ignore 0; @ts-nocheck 0; eslint/oxlint disable directives 0; explicit .skip/.todo calls 0; .only calls 0. The raw path/line hit list is saved in quality-counts-and-hits.json. Runtime conditions such as it.runIf exist and can omit security execution tests; skipped assertions are also reported in the CI shard summaries. Broad e2e exclusions matter more here than a zero .skip count.

Verified maintenance/dead-code candidates, not blanket deletion instructions:
- NativeSkill discovery is inert because nativeSkillFolders always returns []; remove or isolate the unused compatibility-facing abstraction after a global caller check.
- NATIVE_SKILL_DIRS is duplicated in skills.ts:329 and imported-skills.ts:405.
- Trigger terms are parsed/validated but ignored by selectBundledSkills; _text is deliberate dead input introduced in HEAD.
- Manual image workflow contains obsolete package discovery and a no-op “proof”.
- Large index.ts combines authentication, route wiring, bot ownership, integrations, deployment plumbing and session logic. Extract by boundary with regression tests, not a wholesale rewrite while CI is red. The existing size ratchet is a useful constraint, not a failure to suppress.

## 8. Documentation, issues, PRs and release

- README correctly presents native API providers but still names the upstream outside NOTICE (L01).
- docs/HANDOFF.md is materially stale (M08). Its historical security PoC/eval claims were not rerun in this audit and are not independent proof of current safety.
- docs/migration.md and legacy-engines.ts keep users’ old bot/history data and direct users to native provider replacement; retain migration behavior. Existing tests named after old providers must be read as fixtures before being classified as external-engine leftovers.
- docs/custom-engines.md and the antigravity documentation slug now describe native API-compatible setup/migration. Those filenames are confusing but not evidence of an external engine.
- Open issue endpoint returned exactly two open items, both pull requests: **no separate open issues** in that response.
- PR #26: open, not draft; “test: replayRoomPlan script support in fake OpenAI chat”; two files, +171/-21. Exact patch adds deterministic planned-turn replay, one-shot keys, unexpected-turn 422 and unplannedTurns counters. Compare against present fake-provider code before merging; this audit did not merge or certify it. Mergeability returned unknown, not clean/conflicting.
- PR #1: open, not draft; “docs: note Cloud Agent Node, ports, and typecheck heap”; one file, +6/-0. Exact patch is contributor environment guidance (Node/pnpm path, dev ports, 6GB typecheck heap). Its body’s historical claude-fixture failures are not evidence of current CI failure causes. Mergeability returned unknown.
- Latest listed GitHub release: **v0.1.137**, published **2026-11-02 11:20 WIB**, zero release assets in API response. Root package and versioned Compose default are **0.1.138**.
- Versioned image run **42165933611**, tag **v0.1.138**, commit **cf4811b**, succeeded. Earlier runs for the same tag/source c432505 and initial ARM64 fix failed; successful cf4811b run supersedes them. HEAD d5d9ca4 is newer than that image commit: published v0.1.138 is **not verified to contain HEAD’s skills change or 991e90b Docker CLI addition**. The VPS’s installed/running image was not inspected.
- Image version and GitHub release publication are separate pipelines; image success does not make main CI green or mean desktop release assets exist.

## 9. Prioritized fix plan

1. Preserve read-only audit evidence; make no VPS change. Work on a separate branch only after implementation authorization. Keep NOTICE/migration and logos/icons unchanged.
2. Fix H01/H02 first: require worker identity on service routes; deny network by default on macOS. Add abuse/negative tests, not just happy paths.
3. Fix H03/H04: centralized real-cost/usage accounting with fail-closed unknown pricing; durable unknown side-effect states and reconciliation-aware resume. Test SIGKILL after external acceptance but before receipt, and repeat send IDs across reconnect/restart.
4. Repair skills behavior: default-on availability may be intentional, unconditional content injection is not relevance. Retain negative selection tests, explicitly set false for off fixtures, and test backup migration/provenance separately. Package or remove missing helper prerequisites.
5. Repair both pre-existing CI blockers: split tiny helpers to meet the ratchet; make bwrap execution tests capability-aware and provision one real sandbox lane. Log spawn error/signal. Do not “fix” fault-injection disk messages or blanket weaken expectations.
6. Upgrade vulnerable workspace dependencies with compatibility checks and repeat production audit. Avoid unrelated full dependency churn.
7. Remove disallowed engine dependency/build residues, retain the legacy migration module and provider adapters, and add a removal policy test. Check all uninspected docs/UI/config files before calling removal complete.
8. Add a real self-hosted image confined-shell smoke, document Docker socket trust, pin artifacts, fix no-op manual image proof, and inventory excluded e2e ownership/quarantine.
9. Rewrite HANDOFF with the new verified baseline and release/image commit mapping; review #26 and #1 independently, no automatic merges.
10. Finish coverage gaps before calling this exhaustive: full authorized checkout/cloud-agent audit if permitted; repository-wide LOC/branding/secret scan including historical deletions; all route families and dependency usages; image OS/browser/Electron SBOM; targeted security PoCs and then a separately authorized full CI/e2e run. No need for paid model eval to perform these steps.

Suggested acceptance gates: latest scoped CI green without assertion dilution; sandbox negative tests on Linux/macOS; no unauthorized service-loopback mutations; budgets cover every paid call and unknown-pricing case; crash recovery never blindly replays unknown mutations; native-only runtime/dependency policy passes; all excluded suites have an owner/lane; published artifacts identify their exact source commit.

## Evidence and audit limits

Primary immutable source base: https://github.com/cryptyroot-ux/RootClaw/tree/d5d9ca4faf28ab067faddc4cd1bbd18afb517c34

CI run: https://github.com/cryptyroot-ux/RootClaw/actions/runs/42281466760

Image build: https://github.com/cryptyroot-ux/RootClaw/actions/runs/42165933611

PRs: https://github.com/cryptyroot-ux/RootClaw/pull/26 and https://github.com/cryptyroot-ux/RootClaw/pull/1

Saved locally: tree.json (complete Git tree), commits.json (50 records), runs.json/jobs.json, findings.json, ci-failures.json, source-manifest.json (API-fetched hash-verified files), coverage.json (also includes ten exact HEAD-added skill files reconstructed from commit patches), dependency-audit.json/stderr, budget-probe.mts/results, history-secret-scan.json, secret-candidates-paths-only.json, quality-counts-and-hits.json and selected pinned source snapshot. GitHub raw evidence remains in tool-result asset files; local copies were verified with Git blob SHA-1, not trusted by filename alone.

No expensive full test/typecheck, live provider calls, actual wallet/secret handling, browser login, VPS interaction, repository writes or external publishing occurred. The only generated artifact outside the box is the requested private audit Page; no sharing controls were changed. All times in this report are WIB (Asia/Jakarta).

Published audit Page: https://cursor.com/canvas/store-6ced261e-3445-410a-b6ed-52556544ef78/c3e2ec1f-12aa-4b08-b619-7ff88ffe1aa4
