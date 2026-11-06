# Thread Attachment Read Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let native workspace tools read only uploaded files explicitly attached in the bot's own conversation.

**Architecture:** Parse standalone attachment tags from human messages in a thread, validate each referenced file as a regular file inside the attachments store, and pass those individual paths as read-only roots to native workspace tools. Wire the same behavior for direct and room turns; never expose the attachments directory itself.

**Tech Stack:** TypeScript, Node.js filesystem/path APIs, Vitest, RootClaw's isolated fake OpenAI-compatible engine and `control:rootclaw` verification fixture.

**Spec:** `docs/superpowers/specs/2026-11-06-thread-attachment-read-access-design.md`

## Global Constraints

- Only standalone `<attached-file>` tags in user messages from the current thread grant read access.
- Each grant is an exact file path inside the attachments store; never grant the store directory or another thread's unreferenced file.
- Attachment roots are read-only; all other workspace confinement remains unchanged.
- Do not copy files to a bot workspace or desktop container, and do not inspect production attachment contents during verification.

## Review Focus

- An earlier user attachment in the same thread remains readable on a later turn — test it in the thread-roots and direct-chat cases.
- An attachment-shaped string in prose, code, a bot message, or an `attached-image` tag grants no file access — pin this in parser tests.
- Missing, non-regular, symlinked, or outside-store paths grant no access — pin these in root-validation tests.
- An unreferenced sibling upload stays outside the allowed roots — assert denial in the conversation integration test.
- A referenced attachment remains read-only — assert a write attempt is refused in the conversation integration test.

---

### Task 1: Parse and validate per-thread attachment read roots

**Files:**
- Modify: `server/message-file.ts`
- Test: `server/message-file.test.ts`

**Interfaces:**
- Produces: `threadAttachmentReadRoots(messages: readonly { role: string; text?: string | null }[], attachmentsDir: string): string[]`.
- The helper returns unique, existing regular-file paths from standalone `<attached-file>` tags in `role === "user"` messages only. It rejects paths outside the attachments directory, directory entries, symlinks, and missing files. It does not return `<attached-image>` paths.

- [x] **Step 1: Write failing tests**

Add tests proving that a valid file referenced by a user message is returned once (including when referenced by an earlier message), while bot messages, prose/code examples, malformed tags, image tags, outside paths, missing files, directories, and symlinks return no root.

- [x] **Step 2: Run the tests and verify they fail**

Run: `pnpm exec vitest run server/message-file.test.ts -t "thread attachment read roots"`

Expected: FAIL because `threadAttachmentReadRoots` is not implemented.

- [x] **Step 3: Implement `threadAttachmentReadRoots` in `server/message-file.ts`**

Use the existing Markdown-aware standalone-tag rules and attribute decoder. Canonicalize the attachments directory and candidate paths; accept only regular files whose direct parent is that directory, and deduplicate without widening to the directory root.

- [x] **Step 4: Run the focused tests**

Run: `pnpm exec vitest run server/message-file.test.ts -t "thread attachment read roots"`

Expected: PASS, including each denial case above.

- [x] **Step 5: Commit the tested helper**

Run: `git add server/message-file.ts server/message-file.test.ts && git commit -m "fix: scope thread attachment read roots"`

Expected: the helper and its tests are committed together.

### Task 2: Wire roots into direct and room turns

**Files:**
- Modify: `server/index.ts`
- Test: `server/index.test.ts`

**Interfaces:**
- Consumes: `threadAttachmentReadRoots(...)` from Task 1.
- Produces: direct and room `sendTurn` inputs whose `workspaceTools.readRoots` contains only the validated attachment paths for that thread.

- [x] **Step 1: Write failing conversation tests**

Using synthetic attachment files and the isolated fake engine, cover both a direct chat and a room: a later turn can still `read_file` a file attached in an earlier user message; an unreferenced sibling is refused as outside the workspace; and `write_file` cannot modify the referenced attachment.

- [x] **Step 2: Run the tests and verify they fail**

Run: `pnpm exec vitest run server/index.test.ts -t "reads only thread attachments"`

Expected: the referenced-file `read_file` calls fail as outside the workspace before the wiring change.

- [x] **Step 3: Pass per-thread roots in both turn paths**

In `server/index.ts`, compute roots from `store.messagesFor(threadId)` and `ATTACHMENTS_DIR`, then pass them in `workspaceTools.readRoots` for the direct-chat and room `sendTurn` inputs. Do not change Local VM mounts or the existing message-download authorization.

- [x] **Step 4: Run the conversation tests**

Run: `pnpm exec vitest run server/index.test.ts -t "reads only thread attachments"`

Expected: PASS for direct and room turns, with unreferenced reads and writes still refused.

- [ ] **Step 5: Commit the turn wiring and regression tests**

Run: `git add server/index.ts server/index.test.ts && git commit -m "fix: let bots read their thread attachments"`

Expected: direct/room wiring and its regression coverage are committed together.

### Task 3: Document and run isolated verification

**Files:**
- Modify: `docs/verification/chat-turns.md`

- [x] **Step 1: Add an attachment-read scenario**

Document a disposable fake-engine scenario using a synthetic file in the fixture attachments directory and the shared `control:rootclaw` commands. Check a referenced read succeeds, an unreferenced read is denied, and a write is refused; do not use raw API calls or the live application.

- [x] **Step 2: Run focused automated verification**

Run: `pnpm exec vitest run server/message-file.test.ts server/index.test.ts -t "thread attachment read roots|reads only thread attachments"`

Expected: all selected tests pass.

- [x] **Step 3: Run type checking**

Run: `pnpm typecheck`

Expected: exit code 0.

- [x] **Step 4: Run the documented isolated conversation fixture**

Launch with `node --experimental-strip-types scripts/control-rootclaw.ts launch`, then use the printed URL with `pnpm control:rootclaw` as documented in `docs/verification/chat-turns.md`.

Expected: the referenced read succeeds; the unreferenced read is denied; and the mutating-tool refusal leaves the synthetic file unchanged. The write attempt may make `wait` report `failed` because that refusal is terminal. The automated regression checks the specific read-only error for both direct and room turns.

- [x] **Step 5: Commit the verification recipe**

Run: `git add docs/verification/chat-turns.md && git commit -m "docs: verify thread attachment reads"`

Expected: the documented isolated verification is committed.
