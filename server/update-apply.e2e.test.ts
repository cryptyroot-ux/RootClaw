// One-click update end to end: a real clone of a local bare remote, real git and pnpm, the real container launcher
// (server-launcher.ts) restarting a server on exit code 75. The project is a small stand-in for RootClaw with the same
// build scripts and outputs, so the run takes seconds instead of a full RootClaw build.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, it } from "vitest";

import { superviseServer } from "./server-launcher.ts";
import { BACKUP_DIR } from "./update-apply.ts";

const pnpmFound = (() => { try { execFileSync("pnpm", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const base = mkdtempSync(join(tmpdir(), "rootclaw-oneclick-e2e-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.test", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();

const BUILD = `import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
if (process.argv[2] === "web") {
  rmSync("dist", { recursive: true, force: true });
  mkdirSync("dist");
  if (existsSync("break-build")) { writeFileSync("dist/partial.js", "half"); console.error("vite: forced build failure"); process.exit(1); }
  writeFileSync("dist/index.html", "web " + version);
} else {
  mkdirSync("dist-server", { recursive: true });
  cpSync("server.mjs", "dist-server/index.js");
  writeFileSync("dist-server/rootclaw.js", "// cli " + version);
}
`;
// The server reads its version once at start, as RootClaw's serverVersion() does, and wires the real applier.
const SERVER = `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { createUpdateApplier, restartMode } = await import(process.env.E2E_APPLIER);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  if (url.pathname === "/version") return send({ version, pid: process.pid, mode: restartMode() });
  if (url.pathname === "/status") return send(applier.status());
  if (url.pathname === "/apply") return send({ started: applier.start(url.searchParams.get("to")) });
  res.statusCode = 404; res.end();
});
const applier = createUpdateApplier({
  root, current: version, statusFile: join(root, "data", "update-apply.json"), restartMode: restartMode(), restartDelayMs: 100,
  ...(process.env.E2E_REAL_DISK_CHECK ? {} : { diskCheck: () => null }),
  restart: () => server.close(() => process.exit(75)),
});
server.listen(Number(process.env.PORT), "127.0.0.1");
`;

function release(seed: string, version: string, extra: Record<string, string | null> = {}) {
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "rootclaw-e2e", version, private: true, scripts: { build: "node build.mjs web", "build:server": "node build.mjs server" } }, null, 2));
  for (const [file, body] of Object.entries(extra)) {
    if (body === null) rmSync(join(seed, file), { force: true });
    else writeFileSync(join(seed, file), body);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", `release ${version}`);
  git(seed, "tag", `v${version}`);
  git(seed, "push", "-q", "origin", "main", "--tags");
  return git(seed, "rev-parse", "HEAD");
}

const freePort = () => new Promise<number>((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => done(port)); }); });

it.skipIf(!pnpmFound || process.platform === "win32")("updates a clone to the newest tag, rebuilds, restarts, and rolls back a broken release", { timeout: 180_000 }, async () => {
  const remote = join(base, "remote.git"), seed = join(base, "seed"), clone = join(base, "RootClaw");
  git(base, "init", "-q", "--bare", remote);
  mkdirSync(seed);
  git(seed, "init", "-q");
  git(seed, "remote", "add", "origin", remote);
  writeFileSync(join(seed, ".gitignore"), "node_modules\ndist\ndist-server\ndata\n.rootclaw-update-backup\n");
  writeFileSync(join(seed, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n");
  writeFileSync(join(seed, "build.mjs"), BUILD);
  writeFileSync(join(seed, "server.mjs"), SERVER);
  const v100 = release(seed, "1.0.0");
  git(base, "clone", "-q", remote, clone);
  for (const args of [["install", "--frozen-lockfile"], ["build"], ["build:server"]]) execFileSync("pnpm", args, { cwd: clone, stdio: "ignore" });
  const v110 = release(seed, "1.1.0");

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  type Reply = { pid?: number; phase?: string; error?: string; log?: string[]; version?: string };
  const get = async (path: string): Promise<Reply | null> => { try { return (await (await fetch(url + path)).json()) as Reply; } catch { return null; } };
  const env = (launcher: boolean, extra: NodeJS.ProcessEnv = {}) => {
    const { INVOCATION_ID: _i, pm_id: _p, ROOTCLAW_LAUNCHER: _l, ...rest } = process.env;
    return { ...rest, PORT: String(port), E2E_APPLIER: pathToFileURL(join(import.meta.dirname, "update-apply.ts")).href, ...(launcher ? { ROOTCLAW_LAUNCHER: "cli" } : {}), ...extra };
  };
  const evidence: string[] = [];
  const note = (line: string) => { evidence.push(line); console.log(`[e2e] ${line}`); };

  // 1. Under the launcher. The real disk check refuses first on this nearly full box, then the run goes ahead without it.
  let child: ChildProcess | undefined;
  let realDisk = true;
  const supervised = superviseServer(() => (child = spawn(process.execPath, [join(clone, "dist-server", "index.js")], { env: env(true, realDisk ? { E2E_REAL_DISK_CHECK: "1" } : {}), stdio: "ignore" })), { signals: { on: () => process, off: () => process } });
  await expect.poll(() => get("/version"), { timeout: 15_000 }).toMatchObject({ version: "1.0.0", mode: "launcher" });
  const firstPid = (await get("/version"))!.pid;
  expect(await get("/apply?to=1.1.0")).toEqual({ started: true });
  await expect.poll(async () => (await get("/status"))?.phase, { timeout: 30_000 }).toMatch(/failed|restarting|done/);
  const disk = (await get("/status")) as { error?: string };
  note(`real disk check on this box: ${disk.error ?? "passed"}`);
  if (/Not enough free/.test(disk.error ?? "")) {
    realDisk = false;
    // Restart by hand through the same exit code so the next server skips the disk check.
    child!.kill("SIGTERM");
  }

  // 2. A real update: fetch, fast-forward, install, build, exit 75, the launcher starts the new build.
  const supervised2 = realDisk ? supervised : superviseServer(() => (child = spawn(process.execPath, [join(clone, "dist-server", "index.js")], { env: env(true), stdio: "ignore" })), { signals: { on: () => process, off: () => process } });
  if (!realDisk) await supervised;
  await expect.poll(() => get("/version"), { timeout: 15_000 }).toMatchObject({ version: "1.0.0" });
  expect(await get("/apply?to=1.1.0")).toEqual({ started: true });
  await expect.poll(() => get("/version"), { timeout: 60_000, interval: 200 }).toMatchObject({ version: "1.1.0" });
  const updated = (await get("/version"))!;
  expect(updated.pid).not.toBe(firstPid);
  expect(await get("/status")).toMatchObject({ phase: "done", from: "1.0.0", to: "1.1.0", current: "1.1.0", restart: "auto" });
  expect(git(clone, "rev-parse", "HEAD")).toBe(v110);
  expect(git(clone, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(readFileSync(join(clone, "dist", "index.html"), "utf8")).toBe("web 1.1.0");
  note(`updated v1.0.0 (${v100.slice(0, 8)}) -> v1.1.0 (${v110.slice(0, 8)}); server pid ${firstPid} -> ${updated.pid} via exit 75 + server-launcher`);
  note(`status log tail: ${JSON.stringify((await get("/status"))?.log?.slice(-6))}`);

  // 3. A broken release: the web build fails after emptying dist; the commit, dist and dependencies come back.
  const v120 = release(seed, "1.2.0", { "break-build": "1" });
  expect(await get("/apply?to=1.2.0")).toEqual({ started: true });
  await expect.poll(async () => (await get("/status"))?.phase, { timeout: 60_000, interval: 200 }).toBe("failed");
  const failed = (await get("/status"))!;
  expect(failed).toMatchObject({ phase: "failed", rolledBack: true, to: "1.2.0", current: "1.1.0", error: "Building the web app (pnpm build) failed (exit 1)." });
  expect(failed.log).toContain("vite: forced build failure");
  expect(git(clone, "rev-parse", "HEAD")).toBe(v110);
  expect(git(clone, "status", "--porcelain", "--untracked-files=no")).toBe("");
  expect(readFileSync(join(clone, "dist", "index.html"), "utf8")).toBe("web 1.1.0");
  expect(existsSync(join(clone, "dist", "partial.js"))).toBe(false);
  expect(existsSync(join(clone, BACKUP_DIR))).toBe(false);
  expect(await get("/version")).toMatchObject({ version: "1.1.0", pid: updated.pid });
  note(`v1.2.0 (${v120.slice(0, 8)}) build failed -> rolled back: HEAD ${v110.slice(0, 8)}, dist "web 1.1.0", same pid ${updated.pid}`);

  // 4. A dirty tree is refused before anything moves.
  writeFileSync(join(clone, "build.mjs"), BUILD + "// local edit\n");
  const v130 = release(seed, "1.3.0", { "break-build": null });
  expect(await get("/apply?to=1.3.0")).toEqual({ started: true });
  await expect.poll(async () => (await get("/status"))?.phase, { timeout: 15_000 }).toBe("failed");
  expect((await get("/status"))!.error).toMatch(/uncommitted changes/);
  expect(git(clone, "rev-parse", "HEAD")).toBe(v110);
  git(clone, "checkout", "--", "build.mjs");
  note("dirty tree refused, HEAD unchanged");

  // Only exit code 75 restarts: a killed server ends the launcher.
  child!.kill("SIGTERM");
  expect(await supervised2).toBe(1);

  // 5. A bare `node dist-server/index.js` with nothing to restart it: installs and says to restart by hand.
  const bare = spawn(process.execPath, [join(clone, "dist-server", "index.js")], { env: env(false), stdio: "ignore" });
  try {
    await expect.poll(() => get("/version"), { timeout: 15_000 }).toMatchObject({ version: "1.1.0", mode: "none" });
    expect(await get("/apply?to=1.3.0")).toEqual({ started: true });
    await expect.poll(async () => (await get("/status"))?.phase, { timeout: 60_000, interval: 200 }).toBe("done");
    expect(await get("/status")).toMatchObject({ restart: "manual", to: "1.3.0", current: "1.1.0" });
    expect(await get("/version")).toMatchObject({ version: "1.1.0", pid: bare.pid });
    expect(git(clone, "rev-parse", "HEAD")).toBe(v130);
    expect(readFileSync(join(clone, "dist", "index.html"), "utf8")).toBe("web 1.3.0");
    note(`plain node: v1.3.0 (${v130.slice(0, 8)}) installed and built, server kept running v1.1.0 (pid ${bare.pid}), status restart=manual`);
  } finally {
    bare.kill("SIGTERM");
  }
  writeFileSync(join(base, "evidence.txt"), evidence.join("\n"));
});
