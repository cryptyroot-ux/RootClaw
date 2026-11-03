# Engine Removal Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove external engine references from non-test source while keeping native engine, provider adapters, and `legacy-engines.ts` migration intact.

**Architecture:** Native engine only. External engine ids (codex, claude, kimi, grok, moonshot, opencode, hermes) must not appear in engine registry, default model selection, tool profiles, or headless command paths unless they are provider adapters or migration code. `legacy-engines.ts` stays for data migration.

**Tech Stack:** TypeScript, Node 24, pnpm, vitest, oxlint.

**Spec:** docs/HANDOFF.md section 6, step 2.

## Global Constraints
- No new features; only removal/hardening.
- Do not delete `legacy-engines.ts`.
- Keep provider adapters (anthropic, gemini, etc.) intact.
- Small atomic commits with quoted errors.
- Run typecheck + lint after each task.
- Secret scan before push.

## Review Focus
- Engine registry still references external engine ids in default selection.
- Tool profiles keyed by external engine kind.
- Headless commands accept removed engine names.
- Cloud-send routing assumes external engines.
- Migration code accidentally removed.

---
### Task 1: Audit and classify external engine references

**Files:**
- Modify: (none, audit only)
- Test: (none)

- [ ] **Step 1: Generate classified reference list**

Run:
```bash
cd /root/github-repos/RootClaw
rg -n "codex|claude|kimi|grok|hermes|opencode|moonshot" server shared src --type ts -g '!*.test.ts' > /tmp/engine-refs.txt
wc -l /tmp/engine-refs.txt
```

- [ ] **Step 2: Review list and mark each as: remove, keep (adapter), keep (migration), keep (string/label).**

- [ ] **Step 3: Commit audit notes**

```bash
git add docs/audit/ 2>/dev/null || true
git commit -m "docs: audit external engine references" --allow-empty
```

### Task 2: Remove external engine ids from engine registry

**Files:**
- Modify: `server/index.ts` (engine registry section)
- Test: `server/index.test.ts`

- [ ] **Step 1: Write failing test (or update expectation) for native-only registry.**

Run existing:
```bash
pnpm vitest run server/index.test.ts 2>&1 | tail -20
```

- [ ] **Step 2: Remove external engine ids from registry.**

- [ ] **Step 3: Run tests**

```bash
pnpm typecheck && pnpm lint && pnpm vitest run server/index.test.ts
```

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(engine): remove external engine ids from registry"
```

### Task 3: Remove external engine ids from default model selection

**Files:**
- Modify: `server/config.ts`, `server/model-catalog/presets.ts`
- Test: `server/config.test.ts` (if exists)

- [ ] **Step 1: Update default model selection to native only.**

- [ ] **Step 2: Run tests**

```bash
pnpm typecheck && pnpm lint && pnpm vitest run server/config.test.ts
```

- [ ] **Step 3: Commit**

```bash
git commit -m "fix(engine): default model selection native only"
```

### Task 4: Remove external engine ids from tool profiles

**Files:**
- Modify: `server/tool-schema-profile.ts`, `server/drivers/agents-catalog.ts`
- Test: `server/tool-schema-profile.test.ts`

- [ ] **Step 1: Remove kimi/moonshot tool profiles (unless adapter).**

- [ ] **Step 2: Run tests**

```bash
pnpm typecheck && pnpm lint && pnpm vitest run server/tool-schema-profile.test.ts
```

- [ ] **Step 3: Commit**

```bash
git commit -m "fix(engine): remove external engine tool profiles"
```

### Task 5: Remove external engine names from headless commands

**Files:**
- Modify: `server/headless/*.ts`
- Test: `server/headless/*.test.ts`

- [ ] **Step 1: Remove accepted engine names for removed engines.**

- [ ] **Step 2: Run tests**

```bash
pnpm typecheck && pnpm lint && pnpm vitest run server/headless
```

- [ ] **Step 3: Commit**

```bash
git commit -m "fix(engine): headless native only"
```

### Task 6: Update cloud-send routing for native only

**Files:**
- Modify: `server/cloud-send-kinds.ts`, `server/agents-bridge-switch.ts`
- Test: related tests

- [ ] **Step 1: Remove external engine routing branches.**

- [ ] **Step 2: Run tests**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git commit -m "fix(engine): cloud-send native only"
```

### Task 7: Keep migration, verify

**Files:**
- Modify: (none)
- Test: `server/legacy-engines.test.ts` (if exists)

- [ ] **Step 1: Verify legacy-engines.ts unchanged.**

- [ ] **Step 2: Run full unit suite (excluding e2e).**

```bash
pnpm vitest run --exclude "**/*.e2e.test.ts"
```

- [ ] **Step 3: Commit (if any).**
