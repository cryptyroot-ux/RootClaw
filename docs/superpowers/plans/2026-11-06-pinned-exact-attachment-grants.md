# Pinned Exact-File Attachment Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the full native workspace toolset available while ensuring each attachment grant authorizes only the exact file referenced in that thread.

**Architecture:** Replace attachment directory roots with typed grants containing the message's lexical path and its validated canonical target. Enforce exact-path and pinned-target equality in workspace tools, and keep grants separate from directory read roots. Linux bubblewrap opens each grant once, passes the checked descriptor, and uses `--ro-bind-fd` at the lexical message path; macOS `sandbox-exec` uses a read allowlist for workspace/toolchain roots and exact attachment paths.

**Tech Stack:** TypeScript, Node.js filesystem/path APIs, Vitest, bubblewrap, macOS `sandbox-exec`, RootClaw fake-engine fixtures.

**Spec:** `docs/superpowers/specs/2026-11-06-thread-attachment-read-access-design.md`

## Global Constraints

- Only standalone `<attached-file>` tags in user messages from the current thread grant read access.
- Each grant carries an exact lexical path and the canonical target validated under the attachments store; never grant a directory or another thread's file.
- Attachment files remain read-only. Preserve normal writes to the bot's writable workspace roots.
- Keep `read_file`, file-scoped `grep`, and `shell` usable for an authorized file; exact file grants do not authorize descendants, directory listing, or recursive search.
- On Linux, bind an opened, canonical-path-checked descriptor with bubblewrap `--ro-bind-fd`; never pass the grant pathname as the sandbox mount source or fall back to path-based binding.
- Do not copy files into bot workspaces or desktop containers.
- Preserve the explicit `ROOTCLAW_SHELL_SANDBOX=off` and global workspace-unrestricted opt-outs; when normal confinement is active, do not widen workspace or per-thread access.

## Review Focus

- A configured attachment-store symlink still allows its unchanged referenced file — test the helper's lexical and canonical paths together.
- Retargeting a store-parent symlink after grant creation cannot make the grant follow it — test through `read_file` and the shell policy.
- Replacing a granted path with an external symlink cannot authorize the external target — test descriptor and sandbox checks against the pinned canonical path, including a deterministic replacement after opening and before bubblewrap mounts the fd.
- Replacing a granted file with a directory cannot authorize children, `list_dir`, `glob`, or recursive shell reads — assert exact-file behavior in workspace and shell tests.
- macOS shell reads must allow the workspace/toolchain and exact grant while denying an unreferenced sibling and an unrelated host file — exercise the generated profile and run the conditional macOS sandbox test where available.
- Direct and room turns must continue to grant only their own referenced files, deny cross-thread files, and refuse writes — retain fake-engine integration coverage.

---

### Task 1: Produce typed pinned attachment grants

**Files:**
- Modify: `server/contracts.ts`
- Modify: `server/message-file.ts`
- Modify: `server/index.ts`
- Test: `server/message-file.test.ts`

**Interfaces:**
- Produces: `WorkspaceReadFileGrant = { path: string; canonicalPath: string }` in `server/contracts.ts`.
- Produces: `threadAttachmentReadFiles(messages, attachmentsDir): WorkspaceReadFileGrant[]` in `server/message-file.ts`.
- The helper accepts only existing non-symlink regular files directly under the canonical attachment store, deduplicates grants, keeps the lexical path for matching the message, and pins the canonical file path for later checks.
- `server/index.ts` adapts both current turn call sites to the renamed helper by passing only grant `path` values through the existing directory-root field until Task 5 wires `readFiles`. This temporary adapter keeps the server buildable; it must not be used after Task 5.

- [x] **Step 1: Write failing helper tests**

Assert a valid user tag returns `{ path, canonicalPath }`, a store reached through a symlink retains its lexical path while pinning its real target, and existing denials remain for bot messages, image tags, malformed/prose tags, siblings, missing files, directories, file symlinks, and paths outside the store.

- [x] **Step 2: Run tests and verify the expected failure**

Run: `pnpm exec vitest run server/message-file.test.ts -t "thread attachment read files|symlink"`

Expected: FAIL because the helper still returns unpinned string roots.

- [x] **Step 3: Add the grant contract and implement `threadAttachmentReadFiles`**

Keep `canonicalPath` from `realpathSync(candidate)` only after validating the direct canonical parent. Deduplicate on the lexical grant path; do not add the attachment directory or canonical path alone as a read root. Update the direct and room call sites in `server/index.ts` to use the renamed helper and map grants to lexical `path` strings in the existing `readRoots` field; Task 5 replaces this temporary mapping with typed `readFiles` wiring.

- [x] **Step 4: Run helper tests**

Run: `pnpm exec vitest run server/message-file.test.ts && pnpm typecheck && pnpm exec vitest run server/index.test.ts -t "reads only thread attachments in direct and room turns"`

Expected: all message-file tests pass, type checking succeeds, and existing direct/room behavior remains operational during the staged migration.

- [x] **Step 5: Commit the helper and contract**

```sh
git add server/contracts.ts server/message-file.ts server/message-file.test.ts server/index.ts
git commit -m "fix: pin exact thread attachment grants"
```

### Task 2: Enforce exact-file grants in workspace tools

**Files:**
- Modify: `server/drivers/workspace-tools.ts`
- Test: `server/drivers/workspace-tools.test.ts`

**Interfaces:**
- Consumes: `WorkspaceReadFileGrant` from Task 1.
- Produces: `WorkspaceToolsConfig.readFiles?: readonly WorkspaceReadFileGrant[]`.
- Directory roots remain in `readRoots`; `readFiles` are point grants and must never be processed with directory `within()` containment.

- [x] **Step 1: Write failing exact-file authorization tests**

Assert that `read_file` and file-scoped `grep` accept the exact lexical path only when its current canonical target equals the grant's pinned `canonicalPath`. Assert that descendants, writes, `glob`, and `list_dir` are denied even if the path is replaced by a directory. Retarget the store symlink and replace the file with an external symlink after constructing the grant; both reads must fail closed. Add a deterministic real-filesystem test that swaps the granted path to an external symlink after path resolution succeeds but before the OS open, then assert both `read_file` and exact-file `grep` reject it without returning the target contents.

- [x] **Step 2: Run tests and verify the expected failures**

Run: `pnpm exec vitest run server/drivers/workspace-tools.test.ts -t "exact read file grants|pinned attachment"`

Expected: FAIL because workspace paths do not yet distinguish file grants from directory roots.

- [x] **Step 3: Implement exact path and descriptor checks**

Add `readFiles` to `WorkspaceToolsConfig`. In `createWorkspacePaths`, allow a grant only when the resolved lexical path equals `grant.path`, the current real target equals `grant.canonicalPath`, and the opened descriptor's real target equals that same pinned path. Keep exact grants out of directory containment. Make exact-file `grep` read the pinned file through the confined file path; reject exact grants as bases for `glob` and `list_dir`.

- [x] **Step 4: Run workspace-tool tests**

Run: `pnpm exec vitest run server/drivers/workspace-tools.test.ts -t "exact read file grants|pinned attachment|symlinked configured store path"`

Expected: exact unchanged files remain readable; pre-invocation and between-resolution/open replacements, descendants, directory-list, and write attempts are denied. The separately known baseline process-group test remains untouched.

- [x] **Step 5: Commit exact workspace-tool enforcement**

```sh
git add server/drivers/workspace-tools.ts server/drivers/workspace-tools.test.ts
git commit -m "fix: enforce pinned exact workspace read files"
```

### Task 3: Confine shell access to pinned read files with bubblewrap

**Files:**
- Modify: `server/drivers/workspace-tools.ts`
- Test: `server/drivers/workspace-tools.test.ts`

**Interfaces:**
- Consumes: `WorkspaceReadFileGrant[]` through `WorkspaceToolsConfig.readFiles`.
- Produces: `sandboxedShell(...): { file: string; args: string[]; extraFds: number[] }`; each exact attachment fd is passed to bubblewrap at child fd `3 + index`, while directory read roots remain path-based mounts.

- [x] **Step 1: Write the failing bubblewrap mount test**

Assert the generated arguments use `--ro-bind-fd` for the exact pinned file at its lexical message path, never use the attachment pathname as a mount source, never mount the attachment parent, and do not mount a replacement directory or link target. Retarget the lexical store symlink before generating the sandbox command and assert the stale grant is omitted or refused. In a real bubblewrap test, replace the canonical source pathname with an external symlink after `sandboxedShell` has opened and validated the grant but before spawning bubblewrap; assert the shell still reads only the content held by the opened fd and never the replacement target.

- [x] **Step 2: Run the policy tests and verify the expected failures**

Run: `pnpm exec vitest run server/drivers/workspace-tools.test.ts -t "exact file shell mounts"`

Expected: FAIL because the current bubblewrap path bind does not pin the source inode across command generation and mount setup.

- [x] **Step 3: Implement file-only bubblewrap mounts**

Pass exact grants separately from `SandboxOptions.readable`. Open each lexical grant read-only, verify the opened descriptor resolves to `grant.canonicalPath`, and verify its descriptor is a regular file. Add it to `extraFds` and use `--ro-bind-fd` with the corresponding child descriptor number and the lexical message path. Update both foreground and background `spawn` calls to pass `extraFds` through stdio and close the parent descriptors after spawn setup, including error paths. If descriptor binding is unsupported, fail closed; never fall back to a pathname source. Create empty destination ancestors inside the sandbox as needed, but never bind a host parent directory. Ensure tests close descriptors returned by command generation when they do not spawn a process.

- [x] **Step 4: Run bubblewrap shell tests**

Run: `pnpm exec vitest run server/drivers/workspace-tools.test.ts -t "exact file shell mounts|confines a confined shell"`

Expected: the exact synthetic file is mounted read-only from the opened descriptor; its sibling, descendants, stale symlink targets, and outside files are not mounted or readable. The deterministic post-open replacement test still reads the original opened file and never the external replacement.

- [x] **Step 5: Commit bubblewrap shell confinement**

```sh
git add server/drivers/workspace-tools.ts server/drivers/workspace-tools.test.ts
git commit -m "fix: bind pinned attachment descriptors into shell sandbox"
```

### Task 4: Confine macOS shell reads to approved roots

**Files:**
- Modify: `server/drivers/workspace-tools.ts`
- Test: `server/drivers/workspace-tools.test.ts`

**Interfaces:**
- Consumes: `WorkspaceReadFileGrant[]` through `WorkspaceToolsConfig.readFiles`.
- Produces: a macOS sandbox profile that allows reads from system/toolchain paths, the workspace and writable roots, configured directory read roots, and exact pinned attachment files only.

- [ ] **Step 1: Write failing macOS profile tests**

Assert that the generated `sandbox-exec` profile allows the workspace, toolchain, configured read roots, and exact canonical attachment path; denies an unreferenced sibling and unrelated host path; and does not allow the attachment's parent directory. Assert writes to the attachment remain denied. Add a conditional `process.platform === "darwin"` shell test using synthetic files to execute those allow/deny cases.

- [ ] **Step 2: Run macOS profile tests and verify the expected failures**

Run: `pnpm exec vitest run server/drivers/workspace-tools.test.ts -t "macOS shell read allowlist|macOS shell confines reads"`

Expected: FAIL because the current `sandbox-exec` profile allows default file reads.

- [ ] **Step 3: Replace macOS default read access with an allowlist**

Build explicit file-read permissions for the shell executable and system/toolchain paths, writable workspace roots, configured directory read roots, and each exact canonical file. Keep the existing write allowlist and network behavior. Do not grant the attachments directory or use a read-all rule. Preserve the explicit opt-outs already documented by the spec.

- [ ] **Step 4: Run profile and conditional macOS sandbox tests**

Run: `pnpm exec vitest run server/drivers/workspace-tools.test.ts -t "macOS shell read allowlist|macOS shell confines reads"`

Expected: profile assertions pass on every platform; on macOS, the conditional shell test reads only the exact synthetic file plus normal allowed roots, denies a sibling/outside file, and cannot write the attachment.

- [ ] **Step 5: Commit macOS shell confinement**

```sh
git add server/drivers/workspace-tools.ts server/drivers/workspace-tools.test.ts
git commit -m "fix: confine macOS shell reads to allowed roots"
```

### Task 5: Wire grants to direct and room turns

**Files:**
- Modify: `server/index.ts`
- Modify: `server/drivers/openai-chat.ts`
- Test: `server/index.test.ts`
- Modify: `docs/verification/chat-turns.md`

**Interfaces:**
- Consumes: `threadAttachmentReadFiles(...)` and `WorkspaceReadFileGrant` from Task 1.
- Produces: direct and room `SendTurnInput.workspaceTools.readFiles` containing only grants validated from `store.messagesFor(threadId)`.

- [ ] **Step 1: Update the fake-engine integration test**

Keep direct and room coverage for earlier-message reads, unreferenced sibling denial, cross-thread denial, and refused writes. Add file-scoped `grep` coverage; shell access is covered by Tasks 3 and 4.

- [ ] **Step 2: Run the integration test and verify the expected failure**

Run: `pnpm exec vitest run server/index.test.ts -t "reads only thread attachments in direct and room turns"`

Expected: FAIL because direct and room turns still populate `workspaceTools.readRoots` rather than typed exact grants.

- [ ] **Step 3: Wire exact grants through both turn paths and the driver**

In `server/index.ts`, call `threadAttachmentReadFiles(store.messagesFor(threadId), ATTACHMENTS_DIR)` for direct and room turns. In `server/drivers/openai-chat.ts`, pass `turn.workspaceTools.readFiles` to the native workspace provider without merging these files into skill `readRoots`.

- [ ] **Step 4: Run direct/room integration tests**

Run: `pnpm exec vitest run server/index.test.ts -t "reads only thread attachments in direct and room turns"`

Expected: earlier referenced files are readable; sibling and cross-thread files are denied; attachment writes are refused in both turn types.

- [ ] **Step 5: Update the isolated verification recipe**

Update `docs/verification/chat-turns.md` to describe direct/room exact-file grants and state that path replacement, descendants, and shell access are covered by automated synthetic-fixture tests. Keep the manual fixture synthetic and isolated.

- [ ] **Step 6: Commit turn wiring, integration coverage, and recipe**

```sh
git add server/index.ts server/drivers/openai-chat.ts server/index.test.ts docs/verification/chat-turns.md docs/superpowers/specs/2026-11-06-thread-attachment-read-access-design.md docs/superpowers/plans/2026-11-06-thread-attachment-read-access.md
git commit -m "fix: wire pinned attachment grants to turns"
```

### Task 6: Full verification and review

**Files:**
- Verify: `server/message-file.test.ts`, `server/drivers/workspace-tools.test.ts`, `server/index.test.ts`
- Verify: whole repository Vitest suite and typecheck/lint

- [ ] **Step 1: Run focused tests and isolated fixture verification**

Use synthetic files only. Run the focused tests for all six tasks and the documented `control:rootclaw` recipe; never inspect the user's live app or data.

- [ ] **Step 2: Run the complete Vitest suite**

Run: `pnpm exec vitest run`

Expected: report every failure by name. Leave the separately reproduced baseline process-group failure unchanged.

- [ ] **Step 3: Run type checking and lint**

Run: `pnpm typecheck && pnpm lint`

Expected: both commands exit with code 0.

- [ ] **Step 4: Request a fresh read-only code review**

Review the complete change range against the approved spec. The review must check pinned path replacement, the deterministic Linux fd swap before bubblewrap mount, exact-file vs subtree behavior, both turn paths, and macOS profile allow/deny behavior.

- [ ] **Step 5: Complete the plan ledger**

Mark steps complete only after their exact command succeeds; record known baseline failures without modifying unrelated tests.

- [ ] **Step 6: Commit the completed implementation plan**

```sh
git add docs/superpowers/plans/2026-11-06-pinned-exact-attachment-grants.md
git commit -m "docs: complete pinned attachment grants plan"
```
