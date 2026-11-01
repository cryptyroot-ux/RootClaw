ARG BASE_IMAGE=ghcr.io/cryptyroot-ux/rootclaw:latest
FROM ${BASE_IMAGE}
USER root
# Opt-in extra npm CLIs for bots' shells (space-separated packages). Empty by
# default: RootClaw's native engine talks to model providers over their APIs
# and needs no external engine CLI.
ARG ENGINES=""
RUN if [ -n "$ENGINES" ]; then HOME=/tmp/rootclaw-build-home npm install -g $ENGINES && rm -rf /tmp/rootclaw-build-home /tmp/node-compile-cache; fi
USER rootclaw
