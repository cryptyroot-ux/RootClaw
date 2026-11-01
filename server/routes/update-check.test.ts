import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { ApplyRefused, type ApplyStatus, type UpdateApplier } from "../update-apply.ts";
import type { UpdateCheck } from "../update-check.ts";
import { dispatchRoutes } from "./table.ts";
import { createUpdateCheckRoutes, selfUpdateRefusal } from "./update-check.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin"] };

async function serve(check: () => Promise<UpdateCheck>, applier: UpdateApplier | null = null, auth: RequestAuth = OWNER): Promise<string> {
  const routes = [createUpdateCheckRoutes({ check, applier })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("update check route", () => {
  it("is open to chat-only sessions: it only reads a version", () => {
    expect(requiredScope("GET", "/api/updates/check")).toBe("client");
  });

  it("answers with the check, and leaves other requests to the next handler", async () => {
    const result: UpdateCheck = { current: "0.1.92", install: "docker", latest: "0.1.93", available: true };
    const base = await serve(async () => result);
    const response = await fetch(`${base}/api/updates/check`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...result, canApply: false });
    expect((await fetch(`${base}/api/updates/check`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/api/updates`)).status).toBe(404);
  });

  it("reports a failed lookup as a 502 with the reason", async () => {
    const base = await serve(async () => { throw new Error("GitHub answered 403"); });
    const response = await fetch(`${base}/api/updates/check`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Could not check for updates: GitHub answered 403" });
  });
});

const available: UpdateCheck = { current: "0.1.92", install: "git", latest: "0.1.93", available: true };

function fakeApplier(initial: Partial<ApplyStatus> = {}, refuse?: string) {
  let status: ApplyStatus = { phase: "idle", current: "0.1.92", log: [], ...initial };
  let running = false;
  const started: string[] = [];
  const applier: UpdateApplier = {
    status: () => status,
    busy: () => running,
    start: (latest) => {
      if (refuse) throw new ApplyRefused(refuse);
      if (running) return false;
      running = true;
      started.push(latest);
      status = { phase: "fetching", from: "0.1.92", to: latest, current: "0.1.92", log: [] };
      return true;
    },
  };
  return { applier, started };
}

describe("one-click update routes", () => {
  const post = (base: string) => fetch(`${base}/api/updates/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

  it("are admin-only at the gate", () => {
    expect(requiredScope("POST", "/api/updates/apply")).toBe("admin");
    expect(requiredScope("GET", "/api/updates/status")).toBe("admin");
  });

  it("tell the owner the check can be installed here, and nobody else", async () => {
    const { applier } = fakeApplier();
    expect(await (await fetch(`${await serve(async () => available, applier)}/api/updates/check`)).json()).toMatchObject({ canApply: true });
    const client: RequestAuth = { kind: "session", via: "cookie", scopes: ["client"], session: {} as never };
    expect(await (await fetch(`${await serve(async () => available, applier, client)}/api/updates/check`)).json()).toMatchObject({ canApply: false });
    expect(await (await fetch(`${await serve(async () => available)}/api/updates/check`)).json()).toMatchObject({ canApply: false });
  });

  it("refuse a client session and a service loopback", async () => {
    const client: RequestAuth = { kind: "session", via: "cookie", scopes: ["client"], session: {} as never };
    const service: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
    for (const auth of [client, service]) {
      const { applier, started } = fakeApplier();
      const base = await serve(async () => available, applier, auth);
      expect((await post(base)).status).toBe(403);
      expect((await fetch(`${base}/api/updates/status`)).status).toBe(403);
      expect(started).toEqual([]);
    }
  });

  it("start the update once and report its progress", async () => {
    const { applier, started } = fakeApplier();
    const base = await serve(async () => available, applier);
    const first = await post(base);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ phase: "fetching", to: "0.1.93" });
    const second = await post(base);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "An update is already running." });
    expect(started).toEqual(["0.1.93"]);
    expect(await (await fetch(`${base}/api/updates/status`)).json()).toMatchObject({ phase: "fetching" });
  });

  it("refuse when there is nothing to install, nothing can install it, or it waits for a restart", async () => {
    const upToDate = await serve(async () => ({ ...available, latest: "0.1.92", available: false }), fakeApplier().applier);
    expect(await (await post(upToDate)).json()).toMatchObject({ error: "RootClaw is already up to date." });
    const noApplier = await serve(async () => available);
    const refused = await post(noApplier);
    expect(refused.status).toBe(409);
    expect((await fetch(`${noApplier}/api/updates/status`)).status).toBe(404);
    const waiting = await serve(async () => available, fakeApplier({ phase: "done", restart: "manual", to: "0.1.93" }).applier);
    const pending = await post(waiting);
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ error: "v0.1.93 is already installed. Restart RootClaw to run it." });
    const broken = await serve(async () => { throw new Error("offline"); }, fakeApplier().applier);
    expect((await post(broken)).status).toBe(502);
  });

  it("answer a release tag that is not a version, or a refused start, with a JSON error instead of a crash", async () => {
    const odd = fakeApplier();
    const oddTag = await serve(async () => ({ ...available, latest: "nightly-2026-11-01" }), odd.applier);
    const bad = await post(oddTag);
    expect(bad.status).toBe(502);
    expect(await bad.json()).toMatchObject({ error: "The newest release (nightly-2026-11-01) is not a version number RootClaw can install. Update by hand from the release page." });
    expect(odd.started).toEqual([]);
    const leftover = await serve(async () => available, fakeApplier({}, "A saved build from an earlier update is still in .rootclaw-update-backup.").applier);
    const refused = await post(leftover);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "A saved build from an earlier update is still in .rootclaw-update-backup." });
  });

  it("offer self-update only on a git clone, off Windows, unless switched off", () => {
    expect(selfUpdateRefusal({ install: "git" }, "linux", {})).toBeNull();
    expect(selfUpdateRefusal({ install: "git" }, "darwin", {})).toBeNull();
    for (const install of ["docker", "podman", "npm", "desktop", "managed", "unknown"] as const) expect(selfUpdateRefusal({ install }, "linux", {})).toMatch(/git clone/);
    expect(selfUpdateRefusal({ install: "git" }, "win32", {})).toMatch(/Windows/);
    expect(selfUpdateRefusal({ install: "git" }, "linux", { ROOTCLAW_DISABLE_SELF_UPDATE: "1" })).toMatch(/switched off/);
  });
});
