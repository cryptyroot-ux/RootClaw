# VPS server-image release design

## Intent

Publish RootClaw's self-hosted server as a public, versioned container image so
new and existing Docker-based VPS installations can install and update without
building the application from source on every VPS. This release contains no
desktop installers and does not publish a cross-platform desktop release.

The first image should contain the merged read-and-draft fix and be tagged
`v0.1.138`, following the current `package.json` version `0.1.137` and latest
published release `v0.1.137`.

## Goals

- Publish `linux/amd64` and `linux/arm64` variants of the self-hosted `server`
  target to the public GitHub Container Registry package
  `ghcr.io/cryptyroot-ux/rootclaw`.
- Tie each immutable image version to the matching `package.json` version and
  Git tag; do not publish `latest` from ordinary `main` pushes.
- Make the documented Docker VPS install pull the published image, and make
  updates and rollback explicit while preserving the existing `/data` volume.
- After publication, update the explicitly requested VPS Live deployment to the
  same version, preserving its data and verifying health.
- Gate publication on server checks and packaged-image health/smoke checks for
  both supported architectures.
- Verify image behavior through isolated fixtures before any live deployment.

## Non-goals

- macOS, Windows, Linux desktop installers, or a GitHub desktop release.
- Changing the non-Docker VPS install paths.
- Automatically updating other running VPS installations. Their operators
  choose when to pull and restart.
- Publishing the `cloud-home` Docker target as part of the VPS server release.

## Constraints and current state

- `deploy/docker-compose.yml` currently builds from the checked-out repository;
  its `image` field is only a local tag. `docs/deploy-vps.md` says no prebuilt
  image is published and updates by pulling source and rebuilding.
- `.github/workflows/docker.yml` builds the server and cloud-home targets with
  `push: false`; there is no image-release workflow in the repository.
- The server Dockerfile currently copies `dist-native/duckdb/linux-x64` into
  the image. `scripts/prepare-duckdb.mjs` recognizes both `linux-x64` and
  `linux-arm64`, but the image staging and tests must be made architecture-aware
  before an ARM64 image is advertised.
- VPS data is mounted at `/data`; image updates must not replace or migrate that
  volume.
- Public image pulls must work without user-specific registry credentials.

## Approaches considered

1. **Versioned public GHCR image (chosen).** Build and publish only after the
   version tag passes server checks and image smoke tests. Compose defaults to
   that immutable version; operators pull and restart when they choose. This
   gives new and existing Docker VPS installs one repeatable artifact and a
   clear rollback target.
2. **Publish a moving `latest` image from `main`.** This makes updates shorter,
   but turns every successful merge into a deployable release and makes
   rollbacks and support reports less precise. It does not fit the request for
   an intentional release.
3. **Continue building from source on each VPS.** This is the current process
   and avoids registry operations, but does not provide a shared, prebuilt VPS
   release for all installers.

## Proposed design

### Image build and publication

- Add a dedicated VPS image release workflow triggered by a `v*` tag.
- Require the tag version to match `package.json` and the versioned default in
  the VPS Compose file. The release workflow runs server-only checks rather than
  desktop packaging or cross-platform desktop CI.
- Build the Dockerfile's `server` target for `linux/amd64` and `linux/arm64`,
  run architecture-specific health/smoke verification, then push one multi-arch
  manifest under the exact version tag. Do not publish a mutable `latest` tag.
- Use the workflow's scoped `GITHUB_TOKEN` with `packages: write`. Make the
  resulting GHCR package public and verify anonymous pulls before announcing
  availability.
- Keep the existing `Images` workflow as a non-publishing build/validation
  path unless implementation finds a safer, smaller way to share its checks.

### VPS Compose and operator flow

- Make `deploy/docker-compose.yml` consume the versioned public image rather
  than build the application locally. Allow an explicit image-tag override for
  rollback; retain the existing Caddy configuration, health check, ports,
  restart behavior, and `/data` volume.
- Update the VPS guide so a fresh install pulls the versioned image, and an
  existing install updates the repository's Compose file, pulls that image,
  then recreates the service. Document rollback by selecting the previous image
  tag and repeating the pull/recreate steps.
- Keep non-Docker installation/update paths unchanged.

### VPS Live deployment

- After the image is public and verified, update the requested VPS Live using
  its existing deployment method. Before restarting, identify that deployment
  path and preserve its existing data according to the VPS guide.
- Change only the deployed RootClaw version; do not alter credentials, bots,
  provider configuration, or unrelated services.
- Verify the service is healthy and serves the expected version. If the
  configured target or a safe update path cannot be established, do not guess or
  modify another host; report that blocker after the image is published.

### First VPS release

- Bump the application version to `0.1.138` on `main`, matching the merged fix
  and the next version after `v0.1.137`.
- Push `v0.1.138` at that commit after its checks are green. The VPS-only
  workflow builds, verifies, and publishes the multi-arch image; no desktop
  release is created.
- Verify the published manifest contains both architectures and pull/run each
  image against isolated fake-engine fixtures before deployment.

## Acceptance criteria

- The release tag, `package.json`, Compose default, and published image tag all
  agree on `0.1.138`.
- The anonymous GHCR manifest lists `linux/amd64` and `linux/arm64`.
- Both image variants pass the server health/smoke path and the documented
  isolated read-and-draft verification.
- A clean Docker VPS install can pull the image without a GHCR login; updating
  an existing install retains its data volume; rollback to the previous tag is
  documented and tested at the Compose configuration level.
- No desktop installer or cross-platform desktop release is published.
- VPS Live runs the same image version and passes a post-update health check,
  with its existing data preserved.

## Calls left to the builder

- The exact Buildx/QEMU or native-runner layout, selected to produce and smoke
  test both architectures reliably.
- The smallest way to share server-only checks between the existing image
  workflow and the new release workflow without weakening either gate.
- The exact Compose variable name and shell commands, preserving compatibility
  with existing `.env` files that predate the image-tag setting.
