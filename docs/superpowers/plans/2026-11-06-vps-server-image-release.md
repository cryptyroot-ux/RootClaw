# VPS Server Image Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish RootClaw `v0.1.138` as a public, versioned multi-arch VPS server image and update VPS Live to that image after verification.

**Architecture:** Build only the Dockerfile `server` target for `linux/amd64` and `linux/arm64`; stage each architecture's native DuckDB modules explicitly. A tag-triggered GitHub Actions workflow gates GHCR publication on version consistency, server tests, and image health smoke. Docker VPS Compose pulls the pinned image while retaining the existing `/data` volume.

**Tech Stack:** Docker Buildx, GitHub Actions, GHCR, Docker Compose, Node 24, pnpm 10, Vitest, RootClaw isolated fixture CLI.

**Spec:** `docs/superpowers/specs/2026-11-06-vps-server-image-release-design.md`

## Global Constraints

- Publish only the self-hosted `server` image; do not publish desktop installers or `cloud-home`.
- Support exactly `linux/amd64` and `linux/arm64` in the first public manifest.
- Keep the image tag immutable and versioned `v0.1.138`; do not publish mutable `latest`.
- Match the Git tag, `package.json`, Compose default, and GHCR image tag.
- GHCR pulls for installers must work anonymously after package visibility is public.
- Preserve Compose service settings and the `/data` volume; image updates must not reset user data.
- Run isolated fake-engine verification before deploying; never use a live provider or account in fixtures.
- Update only RootClaw on VPS Live, after publication; preserve its data and verify health.

## Review Focus

- A mistyped/non-matching tag can publish the wrong version — pin matching checks in the release-workflow test and workflow gate.
- An image can select `linux-x64` DuckDB on ARM64 — pin architecture mapping in the Dockerfile test and smoke each platform image.
- Existing `.env` files may lack a new tag variable — test Compose's version default and legacy-env config in the Compose test.
- A private GHCR package blocks fresh installs — make anonymous pull verification a release acceptance step.
- A Compose edit can detach or replace persistent data — assert the `/data` volume and retain it during the live update procedure.

---

### Task 1: Make the server Docker target architecture-aware

**Files:**
- Modify: `Dockerfile`
- Modify: `scripts/prepare-duckdb.mjs`
- Modify: `scripts/prepare-duckdb.test.mjs`
- Modify: `scripts/docker-image.test.ts`

**Interfaces:**
- Consumes: `scripts/prepare-duckdb.mjs` can stage both `linux-x64` and `linux-arm64` trees during a Docker build while preserving the existing x64 Cloud-home input.
- Produces: the `server` target maps BuildKit `TARGETARCH` to the matching DuckDB package directory and copies only that tree into `/app/duckdb`.

- [x] **Step 1: Write the failing architecture test**

  Add a test to `scripts/prepare-duckdb.test.mjs` asserting an explicit Docker build request stages both Linux native architectures. Add a test to `scripts/docker-image.test.ts` asserting the server image maps Docker `amd64` to `linux-x64`, Docker `arm64` to `linux-arm64`, and copies only the selected server tree while Cloud home retains its x64 tree.

- [x] **Step 2: Run the focused test and confirm it fails**

  Run: `pnpm exec vitest run scripts/prepare-duckdb.test.mjs scripts/docker-image.test.ts`
  Expected: the target-architecture and Dockerfile-selection assertions fail against the current x64-only staging and hard-coded Dockerfile copy.

- [x] **Step 3: Implement multi-architecture staging and Docker mapping**

  Teach the staging script to accept an explicit Linux architecture list and ask it for both trees in the shared build stage. Keep the existing x64 tree for Cloud home, use BuildKit's `TARGETARCH` to map `amd64` to DuckDB's `x64` tree and `arm64` to its `arm64` tree, and stage the selected one under a stable server-only path. Copy only that stable path into the `server` runtime image.

- [x] **Step 4: Run the focused test**

  Run: `pnpm exec vitest run scripts/prepare-duckdb.test.mjs scripts/docker-image.test.ts`
  Expected: PASS, including existing runtime-contract and Dockerfile-layer assertions.

- [x] **Step 5: Commit**

  Commit the Dockerfile, staging script, and tests as `fix(docker): stage server native modules per architecture`.

### Task 2: Switch Docker VPS Compose to a versioned public image

**Files:**
- Modify: `deploy/docker-compose.yml`
- Modify: `deploy/.env.example`
- Modify: `scripts/docker-image.test.ts`
- Modify: `docs/deploy-vps.md`

**Interfaces:**
- Consumes: image tag `v0.1.138` from the release workflow.
- Produces: Docker VPS installs pull the server image; `ROOTCLAW_IMAGE_TAG` can override the default for rollback.

- [x] **Step 1: Write failing Compose assertions**

  Extend the Docker image tests to assert the Docker VPS service uses `ghcr.io/cryptyroot-ux/rootclaw:${ROOTCLAW_IMAGE_TAG:-v0.1.138}`, has no source `build` section, retains `/data`, and keeps `init`, `shm_size`, ports, healthcheck, and restart behavior.

- [x] **Step 2: Run the focused test and confirm it fails**

  Run: `pnpm exec vitest run scripts/docker-image.test.ts`
  Expected: the image/default/pull assertions fail against the current local-build Compose file.

- [x] **Step 3: Implement Compose and operator documentation**

  Set the versioned image default and optional `ROOTCLAW_IMAGE_TAG` override. Update `docs/deploy-vps.md` for anonymous pull on fresh install, update with `git pull`, `docker compose pull`, and `docker compose up -d`, and rollback by selecting the previous image tag. Retain existing service and volume settings. Do not alter non-Docker install paths.

- [x] **Step 4: Verify the resolved Compose config**

  Run: `docker compose --env-file deploy/.env.example -f deploy/docker-compose.yml config`
  Expected: the resolved image is the public `v0.1.138` server image, there is no build context, and the named `data` volume remains mounted at `/data`.

- [x] **Step 5: Run focused tests and commit**

  Run: `pnpm exec vitest run scripts/docker-image.test.ts`
  Expected: PASS. Commit the Compose, test, and docs changes as `feat(vps): install the versioned server image`.

### Task 3: Add a gated multi-architecture image release workflow

**Files:**
- Create: `.github/workflows/vps-image-release.yml`
- Modify: `scripts/docker-image.test.ts`

**Interfaces:**
- Consumes: versioned source tag and the architecture-aware Docker `server` target.
- Produces: public `ghcr.io/cryptyroot-ux/rootclaw:v<package-version>` manifest for `linux/amd64` and `linux/arm64` only after all gates pass.

- [x] **Step 1: Write workflow contract assertions**

  Extend `scripts/docker-image.test.ts` to parse and assert the workflow has a `v*` tag trigger, `contents: read`, `packages: write`, a tag/package/Compose version equality gate, the `server` target, both required platforms, and no desktop release or `latest` tag publication.

- [x] **Step 2: Run the focused test and confirm it fails**

  Run: `pnpm exec vitest run scripts/docker-image.test.ts`
  Expected: workflow assertions fail because the VPS image release workflow does not exist.

- [x] **Step 3: Implement workflow gates and architecture smoke jobs**

  Add a tag-triggered workflow that rejects tag/version mismatch, installs Node 24 and pnpm 10, runs server checks, builds and smoke-tests the `server` image for each platform, then publishes one versioned multi-arch manifest to GHCR with the workflow token. Keep publication downstream of both architecture smoke jobs. Do not publish `latest`, desktop artifacts, or `cloud-home`.

- [x] **Step 4: Run the focused workflow-contract test**

  Run: `pnpm exec vitest run scripts/docker-image.test.ts`
  Expected: PASS and the existing Dockerfile/Compose contracts remain intact.

- [x] **Step 5: Commit**

  Commit workflow and tests as `ci(vps): publish gated multi-arch server images`.

### Task 4: Prepare and publish `v0.1.138`

**Files:**
- Modify: `package.json`
- Modify: `deploy/docker-compose.yml` if Task 2 used a temporary version default

**Interfaces:**
- Consumes: passing Tasks 1–3 and merged read-and-draft fix.
- Produces: source commit with version `0.1.138`, tag `v0.1.138`, and public GHCR manifest.

- [x] **Step 1: Bump the application version**

  Change root `package.json` version from `0.1.137` to `0.1.138`; keep it equal to the Compose image default.

- [x] **Step 2: Run local verification**

  Run: `pnpm exec vitest run scripts/docker-image.test.ts server/read-and-draft.test.ts server/proactive-routines.e2e.test.ts`, `pnpm typecheck`, and `pnpm lint`.
  Expected: all commands exit 0.

- [ ] **Step 3: Build and smoke both images locally**

  Build and smoke `linux/amd64` locally with target `server`. This local Buildx daemon has no ARM64 emulation; do not alter its host-level binfmt state. Require the tag workflow's QEMU-backed ARM64 build and smoke to pass before publication. Run each available image in an isolated container and verify its healthcheck and native DuckDB query; do not connect to a live provider/account.
  Expected: the local amd64 image is healthy and runs a native DuckDB query; before publication, the release workflow confirms the arm64 image is healthy and its native DuckDB query succeeds.

- [x] **Step 4: Run canonical isolated behavior verification**

  Run the canonical `server/proactive-routines.e2e.test.ts` and `server/read-and-draft.test.ts` documented in `docs/verification/proactive-routines.md`. The shared CLI has no routine create/run verbs; use the documented fake-provider and loopback connected-apps fixture rather than raw API calls. Retain the verbose test output under `.rootclaw-scratch`.
  Expected: the documented read-and-draft authorization, refusal, and duplicate-draft checks pass against the disposable fixture, with test output retained under `.rootclaw-scratch`.

- [ ] **Step 5: Push branch and open a PR**

  Commit the version bump and verification changes. Push the feature branch, use the repository's PR template, and open a PR against `main`.
  Expected: all required CI checks pass on the exact PR head before merge.

- [ ] **Step 6: Merge, tag, and wait for publication**

  After required checks pass, merge the PR, create `v0.1.138` at the merge commit, and push the tag. Wait for `.github/workflows/vps-image-release.yml` to finish successfully.
  Expected: the workflow reports success and the public image manifest lists both `linux/amd64` and `linux/arm64`.

- [ ] **Step 7: Verify anonymous registry pull**

  From a clean Docker config, inspect and pull `ghcr.io/cryptyroot-ux/rootclaw:v0.1.138` without logging in.
  Expected: both platform variants resolve and anonymous pulls succeed.

### Task 5: Update VPS Live safely

**Files:**
- No repository files; operate only on the explicitly authorized VPS Live deployment.

**Interfaces:**
- Consumes: publicly available, verified image `v0.1.138` and the VPS's existing deployment method.
- Produces: VPS Live running `v0.1.138`, with its existing data preserved and service healthy.

- [ ] **Step 1: Identify the configured VPS Live deployment**

  Use only the configured deployment target and its documented install path. Confirm the checkout and Compose/systemd path before changing anything. If no configured target or safe path is available, stop without guessing another host.

- [ ] **Step 2: Preserve live data**

  Follow the matching backup instructions in `docs/deploy-vps.md` for the discovered deployment method. Do not expose or copy provider credentials outside the existing host.

- [ ] **Step 3: Update only RootClaw**

  Apply the documented pull/recreate or source rebuild path at `v0.1.138`; do not alter provider settings, bots, credentials, Caddy, or unrelated services.

- [ ] **Step 4: Verify live health and version**

  Check the service health endpoint, container state, and deployed image/version. Confirm the existing data volume is still attached and routine/chat state remains present.
  Expected: healthy service at `v0.1.138` with persistent data intact.

- [ ] **Step 5: Report release status**

  Report the GHCR tag, both supported architectures, CI/workflow outcome, anonymous pull result, VPS Live health/version, and any remaining blocker. Do not claim deployment success unless the live checks pass.
