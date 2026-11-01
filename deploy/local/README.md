# Local Docker Compose

From the repository root, run `docker compose up -d --build`, then open
http://localhost:8080. Docker with Linux containers is required.
Compose supplies defaults; no `.env` file is required.
The application container uses Docker's init process to reap orphaned agent
subprocesses.

To customize, copy `.env.example` to `.env` in the repository root.
The `.env` file is ignored by Git. Shell environment variables take precedence.
`ROOTCLAW_HTTP_PORT` changes the host port and the default public URL.
Internal service ports remain fixed inside the shared network namespace.
RootClaw's engine is native and talks to model providers over their APIs, so
no external engine CLI is installed. `ENGINES` (empty by default) optionally
adds space-separated npm packages for bots' shells. Add a provider key in
Settings → API keys, or with `rootclaw engine set` (below).

For Tailscale Serve, set `ROOTCLAW_PUBLIC_URL` to your HTTPS URL and
`ROOTCLAW_HTTPS_HOST` to its hostname without scheme or path. Configure Tailscale
Serve on the host to forward to the chosen localhost HTTP port.
Keep the default `ROOTCLAW_BIND_ADDRESS=127.0.0.1`. Caddy refuses to start when
`ROOTCLAW_HTTPS_HOST` is set with any other bind address, so direct remote HTTP
clients cannot claim HTTPS semantics by supplying that hostname.
The hostname mapping preserves HTTPS
semantics for that host while localhost access continues to use HTTP.
Private tailnet webhook URLs are only reachable by callers on that tailnet.
Without `ROOTCLAW_HTTPS_HOST`, the bind address can be changed for HTTP access.
Only use HTTPS hostname mapping with a trusted local TLS-terminating proxy.

Add a model provider key and pair a browser:

```sh
docker compose exec -e ROOTCLAW_OLLAMA_API_KEY rootclaw node dist-server/rootclaw.js engine set ollama --key-env ROOTCLAW_OLLAMA_API_KEY
docker compose exec rootclaw node dist-server/rootclaw.js pair
```

On Windows, `./rootclaw.ps1` forwards arguments to Compose using the repository
directory. It respects Docker's selected context and `DOCKER_CONTEXT`.

Data and saved provider keys persist in the named data volume. For an existing
volume, set `ROOTCLAW_DATA_VOLUME` to its name and `ROOTCLAW_DATA_EXTERNAL=true`.
Fresh installs create their volume automatically.

Update with `docker compose build --pull` followed by `docker compose up -d`.
Stop with `docker compose stop`. `docker compose down -v` deletes managed volumes.
