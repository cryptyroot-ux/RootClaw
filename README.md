# RootClaw

RootClaw is a local-first chat app for running a team of AI agents. One local
server (default port `8799`) hosts bots, teams, channels, routines, and
approvals, and serves the web, desktop (Electron), mobile, CLI, and MCP clients.

## Quick start

```bash
pnpm install
pnpm dev
```

Data lives in `~/.rootclaw`. Keep port `8799` bound to localhost or behind an
authenticated reverse proxy, and run the service as an unprivileged user.

## Development

```bash
pnpm typecheck
pnpm test
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
