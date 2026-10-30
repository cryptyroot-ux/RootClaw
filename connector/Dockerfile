# The RootClaw connector, published as ghcr.io/cryptyroot-ux/rootclaw-connector for linux/amd64 and linux/arm64. It runs on
# a server of its owner's with the Docker socket, its state volume and /etc/rootclaw (read-only), and talks only outward.
# Node runs its TypeScript as it is; it has no npm dependencies. bubblewrap is here only for the box probe, which runs
# from this image with the home's own security settings.
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && bwrap --version
WORKDIR /app
COPY package.json ./package.json
COPY profiles ./profiles
COPY install.sh ./install.sh
COPY src ./src
RUN printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /app/src/main.ts "$@"\n' > /usr/local/bin/rootclaw-connector \
  && chmod 0755 /usr/local/bin/rootclaw-connector \
  && chmod -R go-w /app \
  && rootclaw-connector version
ENV NODE_ENV=production
USER root
ENTRYPOINT ["rootclaw-connector"]
CMD ["run"]
