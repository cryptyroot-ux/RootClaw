import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BACKUP_DIR, commandEnv, createUpdateApplier, diskShortage, MIN_FREE_BYTES, MIN_FREE_INODES, redactor, resolvePnpm, restartMode, type RunResult, type Runner } from "./update-apply.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PREV = "1111111111111111111111111111111111111111";
const NEXT = "2222222222222222222222222222222222222222";

interface Clone {
  dirty?: string; branch?: string; tags?: string[]; ancestor?: boolean; shallow?: boolean; tagVersion?: string;
  fail?: (args: readonly string[]) => boolean;
}

/** A clone on disk (package.json, dist, dist-server) whose git and pnpm are played by `run`. */
function clone(spec: Clone = {}) {
  const root = mkdtempSync(join(tmpdir(), "rootclaw-apply-"));
  dirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), "");
  const write = (file: string, body: string) => { mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), body); };
  write("package.json", JSON.stringify({ version: "1.0.0" }));
  write("dist/index.html", "old web");
  write("dist-server/index.js", "old server");
  write("dist-server/rootclaw.js", "old cli");
  const calls: string[][] = [];
  const tags = spec.tags ?? ["v1.1.0"];
  const run = vi.fn<Runner>(async (command, args, { onLine }) => {
    const name = command.endsWith("pnpm") ? "pnpm" : command;
    calls.push([name, ...args]);
    const ok = (output = ""): RunResult => ({ code: 0, output });
    if (spec.fail?.([name, ...args])) { onLine(`${name} ${args.join(" ")}: broke`); return { code: 1, output: "" }; }
    if (name === "git") {
      const [sub] = args;
      if (sub === "status") return ok(spec.dirty ?? "");
      if (sub === "symbolic-ref") return spec.branch === "" ? { code: 128, output: "" } : ok(spec.branch ?? "main");
      if (sub === "rev-parse" && args[1] === "HEAD") return ok(PREV);
      if (sub === "rev-parse" && args[1] === "--is-shallow-repository") return ok(spec.shallow ? "true" : "false");
      if (sub === "rev-parse") {
        const ref = args.find((arg) => arg.startsWith("refs/tags/"))!.slice("refs/tags/".length).replace("^{commit}", "");
        return tags.includes(ref) ? ok(NEXT) : { code: 1, output: "" };
      }
      if (sub === "merge-base") return spec.ancestor === false ? { code: 1, output: "" } : ok();
      if (sub === "merge" || sub === "checkout" && args.includes(NEXT)) { write("package.json", JSON.stringify({ version: spec.tagVersion ?? "1.1.0" })); return ok(); }
      if (sub === "reset" || sub === "checkout") { write("package.json", JSON.stringify({ version: "1.0.0" })); return ok(); }
      return ok();
    }
    if (args.at(-1) === "build") { rmSync(join(root, "dist"), { recursive: true, force: true }); write("dist/index.html", "new web"); return ok(); }
    if (args.at(-1) === "build:server") { write("dist-server/index.js", "new server"); write("dist-server/rootclaw.js", "new cli"); return ok(); }
    return ok();
  });
  return { root, bin, run, calls, read: (file: string) => readFileSync(join(root, file), "utf8"), write };
}

function applier(c: ReturnType<typeof clone>, extra: Partial<Parameters<typeof createUpdateApplier>[0]> = {}) {
  return createUpdateApplier({
    root: c.root, current: "1.0.0", statusFile: join(c.root, "data", "update-apply.json"), restartMode: "launcher", restart: vi.fn(),
    run: c.run, env: { PATH: "" }, nodeDir: c.bin, diskCheck: () => null, restartDelayMs: 0, ...extra,
  });
}

async function settle(a: ReturnType<typeof createUpdateApplier>) {
  await vi.waitFor(() => { if (a.busy() && a.status().phase !== "restarting") throw new Error("still running"); }, { timeout: 5_000, interval: 5 });
  return a.status();
}

describe("one-click update of a git clone", () => {
  it("fetches the release tag, fast-forwards main, installs, builds and asks for a restart", async () => {
    const c = clone();
    const restart = vi.fn();
    const a = applier(c, { restart });
    expect(a.start("1.1.0")).toBe(true);
    const status = await settle(a);
    expect(status).toMatchObject({ phase: "restarting", from: "1.0.0", to: "1.1.0", restart: "auto" });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    expect(c.calls.map((call) => call.slice(0, 2).join(" "))).toEqual([
      "git status", "git rev-parse", "git symbolic-ref", "git rev-parse", "git fetch", "git rev-parse", "git rev-parse", "git merge-base", "git merge",
      "pnpm install", "pnpm build", "pnpm build:server",
    ]);
    expect(c.calls).toContainEqual(["git", "fetch", "--tags", "--no-recurse-submodules", "origin"]);
    expect(c.calls).toContainEqual(["git", "merge", "--ff-only", "--quiet", NEXT]);
    expect(c.calls).toContainEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(c.read("dist/index.html")).toBe("new web");
    expect(existsSync(join(c.root, BACKUP_DIR))).toBe(false);
    // The status survives the restart: the new server confirms it runs the version it was asked for.
    expect(createUpdateApplier({ root: c.root, current: "1.1.0", statusFile: join(c.root, "data", "update-apply.json"), restartMode: "launcher", restart: vi.fn() }).status())
      .toMatchObject({ phase: "done", to: "1.1.0", current: "1.1.0", restart: "auto" });
  });

  it("refuses a clone with uncommitted changes before touching anything", async () => {
    const c = clone({ dirty: " M server/index.ts" });
    const a = applier(c);
    a.start("1.1.0");
    const status = await settle(a);
    expect(status.phase).toBe("failed");
    expect(status.error).toMatch(/uncommitted changes/);
    expect(status.rolledBack).toBe(false);
    expect(c.calls).toEqual([["git", "status", "--porcelain", "--untracked-files=no"]]);
  });

  it("refuses another branch, a clone ahead of the tag, and a missing disk", async () => {
    for (const [spec, message, disk] of [
      [{ branch: "feature" }, /on branch feature, not main/, null],
      [{ ancestor: false }, /commits that are not in v1\.1\.0/, null],
      [{}, /Not enough free disk/, "Not enough free disk space"],
    ] as const) {
      const c = clone(spec);
      const a = applier(c, { diskCheck: () => disk });
      a.start("1.1.0");
      const status = await settle(a);
      expect(status.error).toMatch(message);
      expect(c.calls.some((call) => call[1] === "merge" || call[0] === "pnpm")).toBe(false);
    }
  });

  it("picks the v-prefixed tag, then the bare one, and says so when the release has neither", async () => {
    const bare = clone({ tags: ["1.1.0"] });
    const a = applier(bare);
    a.start("1.1.0");
    expect((await settle(a)).phase).toBe("restarting");
    expect(bare.calls).toContainEqual(["git", "rev-parse", "--verify", "refs/tags/1.1.0^{commit}"]);

    const none = clone({ tags: [] });
    const b = applier(none);
    b.start("1.1.0");
    expect((await settle(b)).error).toMatch(/no tag v1\.1\.0/);
  });

  it("checks out a detached clone at the tag, and unshallows a shallow one", async () => {
    const c = clone({ branch: "", shallow: true });
    const a = applier(c);
    a.start("1.1.0");
    expect((await settle(a)).phase).toBe("restarting");
    expect(c.calls).toContainEqual(["git", "checkout", "--quiet", "--detach", NEXT]);
    expect(c.calls).toContainEqual(["git", "fetch", "--tags", "--no-recurse-submodules", "--unshallow", "origin"]);
  });

  it("rolls back the commit, the old build and the dependencies when the build fails", async () => {
    const c = clone({ fail: (call) => call.join(" ") === "pnpm build:server" });
    const restart = vi.fn();
    const a = applier(c, { restart });
    a.start("1.1.0");
    const status = await settle(a);
    expect(status).toMatchObject({ phase: "failed", rolledBack: true, error: "Building the server (pnpm build:server) failed (exit 1)." });
    expect(c.calls).toContainEqual(["git", "reset", "--hard", "--quiet", PREV]);
    expect(c.calls.filter((call) => call.join(" ") === "pnpm install --frozen-lockfile")).toHaveLength(2);
    // Never a half-built dist: the web build had already replaced dist, and the old one is back.
    expect(c.read("dist/index.html")).toBe("old web");
    expect(c.read("dist-server/index.js")).toBe("old server");
    expect(c.read("package.json")).toContain("1.0.0");
    expect(existsSync(join(c.root, BACKUP_DIR))).toBe(false);
    expect(restart).not.toHaveBeenCalled();
    expect(a.busy()).toBe(false);
  });

  it("rolls back when the tag's package.json is not the release version", async () => {
    const c = clone({ tagVersion: "1.0.9" });
    const a = applier(c);
    a.start("1.1.0");
    expect(await settle(a)).toMatchObject({ phase: "failed", rolledBack: true });
    expect(c.calls).toContainEqual(["git", "reset", "--hard", "--quiet", PREV]);
    expect(c.calls.some((call) => call[0] === "pnpm")).toBe(false);
  });

  it("says when rolling back also failed", async () => {
    const c = clone({ fail: (call) => call[1] === "build" || call[1] === "reset" });
    const a = applier(c);
    a.start("1.1.0");
    const status = await settle(a);
    expect(status.rolledBack).toBe(false);
    expect(status.error).toMatch(/Rolling back also failed: Resetting to the previous commit failed/);
  });

  it("runs one update at a time and takes only a release version", async () => {
    const c = clone();
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const run: Runner = async (command, args, options) => { if (args[0] === "fetch") await gate; return c.run(command, args, options); };
    const a = applier(c, { run });
    expect(a.start("1.1.0")).toBe(true);
    expect(a.busy()).toBe(true);
    expect(a.start("1.1.0")).toBe(false);
    expect(() => createUpdateApplier({ root: c.root, current: "1", statusFile: null, restartMode: "none", restart: vi.fn() }).start("1.1.0; rm -rf /")).toThrow(/Not a release version/);
    release();
    await settle(a);
    expect(c.calls.filter((call) => call[1] === "fetch")).toHaveLength(1);
  });

  it("finishes without a restart where nothing would start RootClaw again", async () => {
    const c = clone();
    const restart = vi.fn();
    const a = applier(c, { restartMode: "none", restart });
    a.start("1.1.0");
    expect(await settle(a)).toMatchObject({ phase: "done", restart: "manual" });
    expect(a.busy()).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });

  it("reads an interrupted or unconfirmed update as failed after a restart", () => {
    const c = clone();
    const file = join(c.root, "data", "update-apply.json");
    c.write("data/update-apply.json", JSON.stringify({ phase: "restarting", from: "1.0.0", to: "1.1.0", current: "1.0.0", log: [] }));
    expect(createUpdateApplier({ root: c.root, current: "1.0.0", statusFile: file, restartMode: "launcher", restart: vi.fn() }).status())
      .toMatchObject({ phase: "failed", error: expect.stringMatching(/still runs v1\.0\.0, not v1\.1\.0/) });
    c.write("data/update-apply.json", JSON.stringify({ phase: "building", to: "1.1.0", current: "1.0.0", log: [] }));
    expect(createUpdateApplier({ root: c.root, current: "1.0.0", statusFile: file, restartMode: "launcher", restart: vi.fn() }).status())
      .toMatchObject({ phase: "failed", error: expect.stringMatching(/interrupted/) });
  });
});

describe("update commands", () => {
  it("passes no secrets to git or pnpm, and keeps them out of the log", () => {
    const env = { PATH: "/usr/bin", HOME: "/root", OPENROUTER_API_KEY: "sk-or-abcdef123", VPS_ROOT_PASSWORD: "hunter22hunter", NPM_TOKEN: "npm_abcdef", NODE_OPTIONS: "--max-old-space-size=4096" };
    const child = commandEnv(env, "/opt/node/bin");
    expect(child).toEqual({
      PATH: ["/opt/node/bin", "/usr/bin"].join(delimiter), HOME: "/root", NODE_OPTIONS: "--max-old-space-size=4096", GIT_TERMINAL_PROMPT: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    });
    expect(commandEnv({}, "/n").NODE_OPTIONS).toBe("--max-old-space-size=6144");
    const redact = redactor(env);
    expect(redact("fatal: https://user:ghp_x@github.com/a.git and sk-or-abcdef123 hunter22hunter")).toBe("fatal: https://***@github.com/a.git and [redacted] [redacted]");
    expect(redact("x".repeat(400))).toHaveLength(301);
  });

  it("finds pnpm beside node, on PATH, or through corepack", () => {
    const beside = join("/opt/node/bin", "pnpm");
    const onPath = join("/usr/bin", "pnpm");
    const corepack = join("/opt/node/bin", "corepack");
    expect(resolvePnpm({ PATH: "/usr/bin" }, "/opt/node/bin", (path) => path === beside)).toEqual({ command: beside, prefix: [] });
    expect(resolvePnpm({ PATH: "/usr/bin" }, "/opt/node/bin", (path) => path === onPath)).toEqual({ command: onPath, prefix: [] });
    expect(resolvePnpm({ PATH: "" }, "/opt/node/bin", (path) => path === corepack)).toEqual({ command: corepack, prefix: ["pnpm"] });
    expect(resolvePnpm({ PATH: "" }, "/opt/node/bin", () => false)).toBeNull();
  });

  it("wants room for the old build's copy plus headroom, and enough inodes", () => {
    const stats = (bytes: number, inodes: number) => () => ({ bavail: bytes, bsize: 1, ffree: inodes, files: 1_000_000 });
    expect(diskShortage("/r", stats(MIN_FREE_BYTES + 100, 50_000), () => 50)).toBeNull();
    expect(diskShortage("/r", stats(MIN_FREE_BYTES + 99, 50_000), () => 50)).toMatch(/Not enough free disk space/);
    expect(diskShortage("/r", stats(MIN_FREE_BYTES * 4, MIN_FREE_INODES - 1), () => 0)).toMatch(/inodes/);
  });

  it("knows who starts the server again", () => {
    expect(restartMode({ ROOTCLAW_LAUNCHER: "cli" }, 4242)).toBe("launcher");
    expect(restartMode({ INVOCATION_ID: "abc" }, 1)).toBe("systemd");
    // A shell inside a systemd service is not the service's main process.
    expect(restartMode({ INVOCATION_ID: "abc" }, 4242)).toBe("none");
    expect(restartMode({ pm_id: "0" }, 4242)).toBe("pm2");
    expect(restartMode({}, 4242)).toBe("none");
  });
});
