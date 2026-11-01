# RootClaw harness server — hosted/self-hosted tenant image, and the
# ROOTCLAW Cloud Pro home machine (docs/cloud-pro.md).
#
# Build the renderer + the self-contained server bundle, then ship only those
# artifacts on a slim Node runtime. The runtime stage holds what changes
# rarely (Chrome's libraries, agent-browser and its Chrome) beneath the app
# files, which change with every commit: a code-only change rebuilds only the
# small app layers, so a pull downloads only those. RootClaw's engine is
# native: it talks to model providers over their APIs, so no external engine
# CLI is installed. The server keeps binding 127.0.0.1 inside the container (the
# loopback-trust invariant is the auth model); deploy/docker-compose.yml puts
# Caddy in the same network namespace to terminate TLS and authentication at
# the edge.
#
#   docker build -t rootclaw .
#   docker build --build-arg ENGINES="<npm packages>" -t rootclaw .   # opt-in extra CLIs; none by default
#   docker build --target cloud-home -t rootclaw-cloud-home .
#
# HOME is the /data volume, so RootClaw's own state (~/.rootclaw: config,
# provider keys, bots) persists across container restarts.
#
# A plain `docker run` of either image wants `--init --shm-size=512m`, as the
# compose files set: the bots' browsers leave exited processes for an init to
# collect, and Chrome needs shared memory (docs/browser-packaging.md, "Process
# hygiene"). On Fly Machines (the Cloud home) Fly's own init is PID 1.

FROM caddy:2.10.2 AS edge
# Official Caddy carries a privileged-port file capability. The Cloud home's
# edge uses the unprivileged 8080, and a plain copy to a fresh inode drops the
# capability (and the build user's ownership).
RUN cp /usr/bin/caddy /caddy

FROM node:24-bookworm-slim AS build
WORKDIR /src
# pinned to package.json#packageManager; corepack is being removed from Node
RUN npm install -g pnpm@10.33.0
# The image never runs Electron, so skip its ~100MB postinstall download.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# every workspace member's manifest must exist before install resolves the lockfile
COPY apps/docs/package.json ./apps/docs/package.json
COPY cloudflare/control-plane/package.json ./cloudflare/control-plane/package.json
# package.json's `prepare` runs during install. The script itself is written to
# no-op without a .git (it exits 0 here), but node still has to be able to LOAD
# it, and .dockerignore keeps .git out — so copy it in before install or the
# whole build dies on MODULE_NOT_FOUND.
COPY scripts/install-git-hooks.mjs ./scripts/install-git-hooks.mjs
RUN pnpm install --frozen-lockfile
COPY . .
# The Cloud home runs these as root, so nobody else may write them.
# The Data engine's native modules (server/data/engine.ts), staged like the
# desktop app's extraResources; the runtime stages copy this tree.
RUN node scripts/prepare-duckdb.mjs && chmod -R go-w dist-native/duckdb
RUN pnpm build:server && pnpm exec vite build && chmod -R go-w dist dist-server skills

FROM node:24-bookworm-slim AS runtime
# Install Chrome's Bookworm libraries directly: agent-browser --with-deps
# invokes sudo even as root, and this image deliberately does not ship sudo.
# git + curl: agent CLIs shell out to git; curl backs the healthcheck
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 \
    libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 \
    libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 \
    libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 \
    libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
    libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --home-dir /data --shell /bin/bash rootclaw
# The bots' browser (docs/plans/browser-engine.md): the pinned agent-browser
# and a Chrome for Testing with its libraries, so a server bot can browse.
# Pin here and in server/browser-engine-release.ts together.
ARG AGENT_BROWSER_VERSION=0.37.0
# `agent-browser install` fetches Chrome for Testing's last-known-good Stable;
# the publish job passes that version so a Chrome release rebuilds this layer.
ARG CHROME_CACHE_TAG=""
# The global link must be the native binary for this platform (agent-browser's
# postinstall points it there); the other platforms' binaries are never run.
RUN echo "agent-browser ${AGENT_BROWSER_VERSION}, Chrome for Testing ${CHROME_CACHE_TAG:-Stable}" \
  && npm install -g --cache /tmp/npm-cache agent-browser@${AGENT_BROWSER_VERSION} \
  && HOME=/opt/rootclaw-browser agent-browser install \
  && ln -s /opt/rootclaw-browser/.agent-browser/browsers/chrome-*/chrome /opt/rootclaw-browser/chrome \
  && native="$(readlink -f "$(command -v agent-browser)")" \
  && case "$native" in */agent-browser/bin/agent-browser-linux-*) ;; *) echo "agent-browser is not a native binary: $native" >&2; exit 1;; esac \
  && [ "$(head -c 4 "$native")" = "$(printf '\177ELF')" ] \
  && for binary in "${native%/*}"/agent-browser-*; do [ "$binary" = "$native" ] || rm "$binary"; done \
  && agent-browser --version \
  && rm -rf /tmp/npm-cache /tmp/node-compile-cache
# Keep the baked-in browser outside both root's private home and /data,
# which may be an existing mounted volume. Session state still lives in HOME,
# which each image sets after its last build step, so no build step writes
# into what a fresh volume starts with.
#  ROOTCLAW_DUCKDB_DIR: the DuckDB binding tree the server requires (no node_modules here).
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/rootclaw-browser/chrome \
    ROOTCLAW_DUCKDB_DIR=/app/duckdb \
    ROOTCLAW_DATA_DIR=/data/.rootclaw \
    ROOTCLAW_STATIC_DIR=/app/dist \
    ROOTCLAW_PORT=8799 \
    ROOTCLAW_WEBHOOK_PORT=8800 \
    NODE_ENV=production
WORKDIR /app

FROM runtime AS cloud-home
# Tools bots reach for in their shell on a My Cloud: Python, pdftotext and
# unzip (about 28 MB unpacked), and the bot box (server/bot-box): bubblewrap
# runs every bot turn in its own namespaces, socat bridges a box's loopback
# ports to the server's gates. Their own layer, so the Chrome layers beneath
# stay cached. pnpm, so a bot's shell can install what its project asks for.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 poppler-utils unzip bubblewrap socat \
  && rm -rf /var/lib/apt/lists/* \
  && HOME=/tmp/rootclaw-build-home npm install -g pnpm@10.33.0 \
  && bwrap --version && socat -V | head -1 && HOME=/tmp/rootclaw-build-home pnpm --version \
  && rm -rf /tmp/rootclaw-build-home /tmp/node-compile-cache
# Caddy is pinned, so it sits beneath the per-commit app files.
COPY --from=edge /caddy /usr/local/bin/caddy
COPY deploy/fly/Caddyfile /app/cloud/Caddyfile
# The root supervisor runs /app's code and hands the server its secrets, so
# no file there may be one `rootclaw` can change: unlike the server image's, these
# copies stay root's. Only the /data volume is rootclaw's; the launcher refuses to
# start otherwise (codeTrustProblem), and this check refuses to build.
# DuckDB and resvg change on a version bump, not per commit: beneath the app files.
COPY --from=build /src/dist-native/duckdb/linux-x64 ./duckdb
COPY --from=build /src/dist-server ./dist-server
COPY --from=build /src/dist ./dist
# The bundled skills (server/skill-library.ts reads ./skills from /app).
COPY --from=build /src/skills ./skills
RUN export HOME=/tmp/rootclaw-build-home \
 && chmod go-w /app/cloud /app/cloud/Caddyfile \
 && caddy version \
 && ROOTCLAW_CLOUD_PUBLIC_HOST=validate.fly.dev caddy validate --config /app/cloud/Caddyfile --adapter caddyfile \
 && test -f /app/dist-server/cloud-home-start.js \
 && untrusted="$(find /app /usr/local/bin/caddy \( ! -user root -o ! -type l -perm /022 \) -print)" \
 && if [ -n "$untrusted" ]; then echo "not root's, or writable by others:" >&2; echo "$untrusted" >&2; exit 1; fi \
 && rm -rf /tmp/rootclaw-build-home
ENV HOME=/data
VOLUME ["/data"]
EXPOSE 8080
# Fly uses the checks in fly.toml; this one serves a plain `docker run`.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -sf http://127.0.0.1:8080/api/health | grep -q rootclaw || exit 1
# Starts as root: hands a fresh volume to `rootclaw`, runs the server and the edge
# as `rootclaw`, and hands the server its secrets over a pipe, never an
# environment `rootclaw` could read (server/cloud-home-start.ts). It runs only
# root's code from the image, never anything on the volume.
USER root
CMD ["node", "/app/dist-server/cloud-home-start.js"]

# The self-hosted server, last so a plain `docker build .` builds it.
FROM runtime AS server
# Opt-in extra npm CLIs for bots' shells (space-separated packages). Empty by
# default: RootClaw's native engine needs none.
ARG ENGINES=""
RUN if [ -n "$ENGINES" ]; then HOME=/tmp/rootclaw-build-home npm install -g $ENGINES && rm -rf /tmp/rootclaw-build-home /tmp/node-compile-cache; fi
COPY --from=build --chown=rootclaw:rootclaw /src/dist-native/duckdb/linux-x64 ./duckdb
COPY --from=build --chown=rootclaw:rootclaw /src/dist-server ./dist-server
COPY --from=build --chown=rootclaw:rootclaw /src/dist ./dist
COPY --from=build --chown=rootclaw:rootclaw /src/skills ./skills
ENV HOME=/data
VOLUME ["/data"]
USER rootclaw
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sf http://127.0.0.1:8799/api/health | grep -q rootclaw || exit 1
# The launcher runs dist-server/index.js and starts it again when it asks to
# (a copied workspace committing, server/restart.ts), so the container, and a
# Caddy sharing its network, stays up through that restart.
CMD ["node", "dist-server/server-launcher.js"]
