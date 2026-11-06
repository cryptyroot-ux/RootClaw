import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { backgroundJobs, realTarget, sandboxedShell, shellSandbox, stopBackgroundJobs, createWorkspacePaths, executeWorkspaceTool, parseUnifiedDiff, shellEnvironment, workspaceToolReadOnly, workspaceToolView, type WorkspaceToolsConfig } from "./workspace-tools.ts";
import { globToRegExp } from "./search-utils.ts";

// CI runners may lack bubblewrap; the shell fails closed there (audit N02), so these tests opt out explicitly.
if (shellSandbox() === null) process.env.ROOTCLAW_SHELL_SANDBOX = "off";

let base: string;
let root: string;
let config: WorkspaceToolsConfig;
const run = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => executeWorkspaceTool(name, args, config, signal);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ws-tools-"));
  root = join(base, "root");
  mkdirSync(root);
  config = { root };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("path safety", () => {
  it("canonicalizes an existing path the same way realpath does", () => {
    writeFileSync(join(root, "a.txt"), "one\n");
    expect(realTarget(join(root, "a.txt"))).toBe(realpathSync(join(root, "a.txt")));
    expect(realTarget(root)).toBe(realpathSync(root));
  });
  it("keeps a dangling target inside a realpath'd workspace", () => {
    const linked = join(base, "linked");
    symlinkSync(root, linked);
    const dangling = realTarget(join(linked, "later.txt"));
    expect(dangling.startsWith(realpathSync(root))).toBe(true);
    expect(dangling.endsWith("later.txt")).toBe(true);
  });
  it("refuses traversal and absolute paths outside the root", async () => {
    writeFileSync(join(base, "secret.txt"), "s");
    expect((await run("read_file", { path: "../secret.txt" })).ok).toBe(false);
    expect((await run("read_file", { path: join(base, "secret.txt") })).text).toMatch(/outside the workspace/);
    expect((await run("write_file", { path: "../x.txt", content: "x" })).ok).toBe(false);
    expect(existsSync(join(base, "x.txt"))).toBe(false);
  });
  it("refuses a symlink that leads out, for reads and writes", async () => {
    mkdirSync(join(base, "outside"));
    writeFileSync(join(base, "outside", "f.txt"), "out");
    symlinkSync(join(base, "outside"), join(root, "link"));
    expect((await run("read_file", { path: "link/f.txt" })).text).toMatch(/symbolic link/);
    expect((await run("write_file", { path: "link/new.txt", content: "x" })).ok).toBe(false);
  });
  it("allows read roots read-only and write roots for writes", async () => {
    const skills = join(base, "skills");
    mkdirSync(skills);
    writeFileSync(join(skills, "SKILL.md"), "# skill");
    symlinkSync(skills, join(root, "skills"));
    config = { root, readRoots: [skills] };
    expect((await run("read_file", { path: "skills/SKILL.md" })).ok).toBe(true);
    expect((await run("read_file", { path: join(skills, "SKILL.md") })).ok).toBe(true);
    expect((await run("write_file", { path: join(skills, "SKILL.md"), content: "x" })).text).toMatch(/read-only/);
    config = { root, writeRoots: [skills] };
    expect((await run("write_file", { path: join(skills, "n.md"), content: "x" })).ok).toBe(true);
  });
  it("resolves read roots through a symlinked configured store path", async () => {
    const store = join(base, "attachment-store");
    const linkedStore = join(base, "linked-attachment-store");
    mkdirSync(store);
    writeFileSync(join(store, "report.txt"), "synthetic linked-store attachment");
    symlinkSync(store, linkedStore);
    config = { root, readRoots: [linkedStore] };

    expect((await run("read_file", { path: join(linkedStore, "report.txt") })).text)
      .toContain("synthetic linked-store attachment");
    expect((await run("write_file", { path: join(linkedStore, "report.txt"), content: "overwrite" })).text)
      .toMatch(/read-only/);
  });
  it("unrestricted lifts confinement", () => {
    expect(createWorkspacePaths({ root, unrestricted: true }).resolve("/etc/hosts", "read")).toBe(resolve("/etc/hosts"));
  });
});

describe("exact read file grants", () => {
  let file: string;
  beforeEach(() => {
    const store = join(base, "store");
    mkdirSync(store);
    file = join(store, "report.txt");
    writeFileSync(file, "synthetic attachment\nSECOND needle\n");
    config = { root, readFiles: [{ path: file, canonicalPath: realpathSync(file) }] };
  });

  it("reads and greps the granted file without granting its parent or sibling", async () => {
    const read = await run("read_file", { path: file });
    expect(read.ok, read.text).toBe(true);
    expect(read.text).toContain("1\tsynthetic attachment");
    const grep = await run("grep", { path: file, pattern: "second", ignore_case: true, glob: "*.txt" });
    expect(grep).toEqual({ ok: true, text: `${file}:2:SECOND needle` });
    const sibling = join(dirname(file), "sibling.txt");
    writeFileSync(sibling, "private sibling");
    for (const path of [sibling, dirname(file)]) {
      expect((await run("read_file", { path })).ok).toBe(false);
      expect((await run("grep", { path, pattern: "." })).ok).toBe(false);
    }
  });

  it("denies writes and directory tools on the granted file", async () => {
    for (const [name, args] of [
      ["write_file", { path: file, content: "changed" }],
      ["edit_file", { path: file, old_string: "synthetic", new_string: "changed" }],
      ["multi_edit", { edits: [{ path: file, old_string: "synthetic", new_string: "changed" }] }],
      ["apply_patch", { patch: `--- ${file}\n+++ ${file}\n@@ -1 +1 @@\n-synthetic attachment\n+changed\n` }],
      ["glob", { path: file, pattern: "**/*" }],
      ["list_dir", { path: file }],
    ] as const) expect((await run(name, args)).ok, name).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("synthetic attachment\nSECOND needle\n");
  });

  it("does not turn a file replaced by a directory into a subtree grant", async () => {
    rmSync(file);
    mkdirSync(file);
    const child = join(file, "child.txt");
    writeFileSync(child, "private descendant");
    for (const path of [file, child]) {
      for (const name of ["read_file", "grep", "glob", "list_dir"]) {
        const result = await run(name, { path, pattern: ".*" });
        expect(result.ok, `${name}: ${result.text}`).toBe(false);
        expect(result.text).not.toContain("private descendant");
      }
      expect((await run("write_file", { path, content: "changed" })).ok).toBe(false);
    }
    expect(readFileSync(child, "utf8")).toBe("private descendant");
  });

  it("uses confined reads for grep and refuses hard links", async () => {
    linkSync(file, join(base, "another-name.txt"));
    for (const name of ["read_file", "grep"]) {
      const result = await run(name, { path: file, pattern: "synthetic" });
      expect(result.ok, result.text).toBe(false);
      expect(result.text).toMatch(/hard link/);
    }
  });

  it("rejects a pinned attachment replaced with an external symlink", async () => {
    const outside = join(base, "private.txt");
    writeFileSync(outside, "private replacement");
    rmSync(file);
    symlinkSync(outside, file);
    for (const name of ["read_file", "grep"]) {
      const result = await run(name, { path: file, pattern: "." });
      expect(result.ok).toBe(false);
      expect(result.text).not.toContain("private replacement");
    }
  });

  it.each(["read_file", "grep"])("rejects a pinned attachment swapped between resolution and open in %s", async (name) => {
    const outside = join(base, "private.txt");
    const secret = "EXTERNAL-DESCRIPTOR-CONTENTS";
    writeFileSync(outside, secret);
    const open = fs.openSync;
    const opening = vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (path === file) {
        rmSync(file);
        symlinkSync(outside, file);
      }
      return open(path, flags, mode);
    });
    syncBuiltinESMExports();
    try {
      const result = await run(name, { path: file, pattern: "EXTERNAL" });
      expect(realpathSync(file)).toBe(realpathSync(outside));
      expect(result.ok, result.text).toBe(false);
      expect(result.text).not.toContain(secret);
    } finally {
      opening.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("keeps a pinned attachment tied to its symlinked configured store path", async () => {
    const linked = join(base, "linked-store");
    symlinkSync(dirname(file), linked);
    const path = join(linked, "report.txt");
    config = { root, readFiles: [{ path, canonicalPath: realpathSync(path) }] };
    for (const name of ["read_file", "grep"]) {
      const result = await run(name, { path, pattern: "synthetic" });
      expect(result.ok, result.text).toBe(true);
      expect(result.text).toContain("synthetic attachment");
      expect((await run(name, { path: file, pattern: "synthetic" })).ok).toBe(false);
    }
    const replacement = join(base, "replacement-store");
    mkdirSync(replacement);
    writeFileSync(join(replacement, "report.txt"), "private replacement");
    rmSync(linked);
    symlinkSync(replacement, linked);
    for (const name of ["read_file", "grep"]) {
      const result = await run(name, { path, pattern: "." });
      expect(result.ok).toBe(false);
      expect(result.text).not.toContain("private replacement");
    }
  });
});

describe("file tools", () => {
  it("reads line ranges with numbers", async () => {
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
    const result = await run("read_file", { path: "a.txt", offset: 2, limit: 2 });
    expect(result.text).toContain("lines 2–3 of 4; next offset 4");
    expect(result.text).toContain("2\ttwo\n3\tthree");
    expect(result.text).not.toContain("four");
  });
  it("writes, then edits with a uniqueness check", async () => {
    expect((await run("write_file", { path: "d/b.ts", content: "let a = 1;\nlet a2 = 1;\n" })).ok).toBe(true);
    const dup = await run("edit_file", { path: "d/b.ts", old_string: "= 1;", new_string: "= 2;" });
    expect(dup.ok).toBe(false);
    expect(dup.text).toMatch(/occurs 2 times/);
    expect((await run("edit_file", { path: "d/b.ts", old_string: "let a = 1;", new_string: "let a = 3;" })).ok).toBe(true);
    expect((await run("edit_file", { path: "d/b.ts", old_string: "= 1;", new_string: "= 9;", replace_all: true })).ok).toBe(true);
    expect(readFileSync(join(root, "d/b.ts"), "utf8")).toBe("let a = 3;\nlet a2 = 9;\n");
    expect((await run("edit_file", { path: "d/b.ts", old_string: "missing", new_string: "x" })).text).toMatch(/not found/);
  });
  it("applies a unified diff with offset hunks, creates and deletes, all or nothing", async () => {
    writeFileSync(join(root, "m.txt"), "a\nb\nc\nd\ne\n");
    writeFileSync(join(root, "gone.txt"), "bye\n");
    const patch = [
      "--- a/m.txt", "+++ b/m.txt", "@@ -3,2 +3,2 @@", " c", "-d", "+D",
      "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+hello", "+world",
      "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye", "",
    ].join("\n");
    const result = await run("apply_patch", { patch });
    expect(result.ok, result.text).toBe(true);
    expect(readFileSync(join(root, "m.txt"), "utf8")).toBe("a\nb\nc\nD\ne\n");
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("hello\nworld\n");
    expect(existsSync(join(root, "gone.txt"))).toBe(false);
    const bad = await run("apply_patch", { patch: "--- a/m.txt\n+++ b/m.txt\n@@ -1 +1 @@\n-a\n+A\n--- a/m.txt\n+++ b/m.txt\n@@ -1 +1 @@\n-zzz\n+y\n" });
    expect(bad.ok).toBe(false);
    expect(readFileSync(join(root, "m.txt"), "utf8")).toBe("a\nb\nc\nD\ne\n");
  });
  it("parses headers with timestamps", () => {
    expect(parseUnifiedDiff("--- a/x\t2024\n+++ b/x\t2024\n@@ -1 +1 @@\n-a\n+b\n")[0]!.newPath).toBe("x");
  });
});

describe("search tools", () => {
  beforeEach(() => {
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const NEEDLE = 1;\n");
    writeFileSync(join(root, "src", "deep", "b.ts"), "const x = 'needle';\n");
    writeFileSync(join(root, "src", "c.md"), "NEEDLE in docs\n");
    writeFileSync(join(root, "node_modules", "pkg", "i.ts"), "NEEDLE\n");
  });
  for (const rg of [true, false]) {
    it(`greps with ${rg ? "ripgrep" : "the JS fallback"}`, async () => {
      if (!rg) process.env.ROOTCLAW_NO_RG = "1";
      try {
        const { ok, text } = await run("grep", { pattern: "NEEDLE", glob: "*.ts" });
        expect(ok).toBe(true);
        if (!rg) {
          expect(text).toBe("src/a.ts:1:export const NEEDLE = 1;");
        } else {
          expect(text).toContain("src/a.ts:1:export const NEEDLE = 1;");
          expect(text).not.toContain("c.md");
        }
        expect((await run("grep", { pattern: "needle", ignore_case: true, path: "src/deep" })).text).toContain("b.ts:1:");
      } finally { delete process.env.ROOTCLAW_NO_RG; }
    });
  }
  it("globs and lists", async () => {
    const found = (await run("glob", { pattern: "**/*.ts" })).text.split("\n").sort();
    expect(found).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(globToRegExp("src/*.{ts,md}").test("src/c.md")).toBe(true);
    const listing = (await run("list_dir", { depth: 2 })).text;
    expect(listing).toContain("src/");
    expect(listing).toContain("  a.ts (25 B)");
  });
});

describe("shell", () => {
  it("runs in the workspace with exit code and output", async () => {
    const result = await run("shell", { command: "pwd; echo err >&2; exit 3" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("exit code 3");
    // Git bash prints a POSIX pwd (`/tmp/.../root`); the workspace folder name is in both spellings.
    expect(result.text.replaceAll("\\", "/")).toContain(`${basename(dirname(root))}/${basename(root)}`);
    expect(result.text).toContain("err");
    expect((await run("shell", { command: "echo hi", cwd: "." })).ok).toBe(true);
    expect((await run("shell", { command: "true", cwd: ".." })).ok).toBe(false);
  });
  it("times out and kills on abort", async () => {
    const timed = await run("shell", { command: "sleep 30", timeout_ms: 1000 });
    expect(timed.text).toContain("timeout");
    const abort = new AbortController();
    const started = Date.now();
    const pending = run("shell", { command: "sleep 30" }, abort.signal);
    setTimeout(() => abort.abort(), 200);
    const stopped = await pending;
    expect(stopped.text).toContain("the turn was stopped");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it("starts in the background with a log", async () => {
    const result = await run("shell", { command: "echo bg-out", background: true });
    expect(result.text).toMatch(/pid \d+/);
    const log = /Output goes to (\S+)/.exec(result.text)![1]!;
    await expect.poll(() => {
      try { return readFileSync(join(root, log), "utf8"); } catch { return ""; }
    }, { timeout: 5_000 }).toContain("bg-out");
  });
  it("tracks background commands per conversation and stops their whole process groups", async () => {
    const scope = `thread-${Date.now()}`;
    config = { ...config, jobScope: scope };
    // The shell starts a grandchild and exits; the grandchild stays in the group, so it is still tracked and stopped.
    const started = await run("shell", { command: "sleep 60 & echo $! > child.pid; wait", background: true });
    const pid = Number(/pid (\d+)/.exec(started.text)![1]);
    await expect.poll(() => existsSync(join(root, "child.pid")) && readFileSync(join(root, "child.pid"), "utf8").trim() !== "").toBe(true);
    const grandchild = Number(readFileSync(join(root, "child.pid"), "utf8"));
    expect(backgroundJobs(scope)).toEqual([pid]);
    expect(stopBackgroundJobs(scope, 100)).toBe(1);
    const gone = (target: number) => { try { process.kill(target, 0); return false; } catch { return true; } };
    await expect.poll(() => gone(grandchild), { timeout: 5_000 }).toBe(true);
    await expect.poll(() => gone(pid), { timeout: 5_000 }).toBe(true);
    expect(backgroundJobs(scope)).toEqual([]);
  });
  it("caps background commands per conversation", async () => {
    const scope = `capped-${Date.now()}`;
    config = { ...config, jobScope: scope };
    try {
      for (let index = 0; index < 8; index++) expect((await run("shell", { command: "sleep 60", background: true })).ok).toBe(true);
      const refused = await run("shell", { command: "sleep 60", background: true });
      expect(refused).toMatchObject({ ok: false });
      expect(refused.text).toMatch(/Too many background commands/);
    } finally {
      stopBackgroundJobs(scope, 100);
    }
  });
  it("keeps code-loading variables out of the shell's environment", () => {
    const env = shellEnvironment(root, { PATH: "/bin", NODE_OPTIONS: "--require /tmp/x.js", LD_PRELOAD: "/tmp/x.so", DYLD_INSERT_LIBRARIES: "/tmp/x.dylib", BASH_ENV: "/tmp/x.sh" });
    expect(Object.keys(env).filter((key) => /NODE_OPTIONS|LD_|DYLD_|BASH_ENV/.test(key))).toEqual([]);
  });
  it("refuses to run a command in a read-only folder", async () => {
    const skills = mkdtempSync(join(tmpdir(), "ws-skills-"));
    config = { ...config, readRoots: [skills] };
    const result = await run("shell", { command: "touch planted", cwd: skills });
    expect(result).toMatchObject({ ok: false });
    expect(result.text).toMatch(/does not run in a read-only folder/);
    expect(existsSync(join(skills, "planted"))).toBe(false);
  });
  it.runIf(shellSandbox() !== null)("confines a confined shell's writes to the workspace under the OS sandbox", async () => {
    // Outside both the workspace and the temp folder (a test HOME may sit under the temp folder).
    const outside = mkdtempSync(join(process.cwd(), ".ws-outside-"));
    try {
      const inside = await run("shell", { command: "echo hi > inside.txt && cat inside.txt" });
      expect(inside).toMatchObject({ ok: true });
      expect(inside.text).not.toContain("no OS sandbox");
      const escaped = await run("shell", { command: `cd / && echo x > ${JSON.stringify(join(outside, "escaped.txt"))}` });
      expect(escaped, escaped.text).toMatchObject({ ok: false });
      expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
      // Nothing outside the workspace is readable, and there is no network unless the call asks for it.
      writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET");
      const read = await run("shell", { command: `cat ${JSON.stringify(join(outside, "secret.txt"))}; ls ~` });
      expect(read.text).not.toContain("OUTSIDE-SECRET");
      if (shellSandbox() === "bwrap") {
        const net = await run("shell", { command: "cat /sys/class/net/*/operstate 2>/dev/null | sort -u; ls /sys/class/net" });
        expect(net.text.trim().split(/\s+/)).not.toContain("eth0");
        const view = workspaceToolView("shell", { command: "npm i", network: true });
        expect(view?.title).toMatch(/network/);
      }
      // Full, unrestricted access is not sandboxed.
      config = { ...config, unrestricted: true };
      expect(await run("shell", { command: `echo x > ${JSON.stringify(join(outside, "allowed.txt"))}` })).toMatchObject({ ok: true });
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  describe("exact file shell mounts", () => {
    const heldFds: number[] = [];
    afterEach(() => { for (const fd of heldFds.splice(0)) fs.closeSync(fd); });
    function build(command: string, readFiles: NonNullable<WorkspaceToolsConfig["readFiles"]>) {
      const program = sandboxedShell(command, root, [root], "bwrap", { readFiles, env: { PATH: "/usr/bin", HOME: join(base, "home") } });
      heldFds.push(...(program.extraFds ?? []));
      return program;
    }
    function attachmentFds(canonicalPath: string) {
      return fs.readdirSync("/proc/self/fd").filter((fd) => {
        try { return fs.readlinkSync(`/proc/self/fd/${fd}`) === canonicalPath; } catch { return false; }
      });
    }
    function attachment() {
      const store = join(base, "store");
      const lexicalStore = join(base, "messages", "attachments");
      mkdirSync(store);
      mkdirSync(dirname(lexicalStore));
      symlinkSync(store, lexicalStore);
      const canonicalPath = join(store, "document.txt");
      writeFileSync(canonicalPath, "PINNED-ATTACHMENT");
      writeFileSync(join(store, "sibling.txt"), "SIBLING-SECRET");
      return { path: join(lexicalStore, "document.txt"), canonicalPath };
    }

    it("binds only the pinned canonical file read-only at its lexical message path", () => {
      const grant = attachment();
      const { args, extraFds } = build("true", [grant]);
      const mounts = args.flatMap((arg, index) => arg === "--ro-bind" || arg === "--bind" ? [args.slice(index, index + 3)] : []);
      expect(args.slice(args.indexOf("--ro-bind-fd"), args.indexOf("--ro-bind-fd") + 3)).toEqual(["--ro-bind-fd", "3", grant.path]);
      expect(extraFds).toHaveLength(1);
      expect(fs.fstatSync(extraFds[0]!).isFile()).toBe(true);
      expect(args).not.toContain(grant.canonicalPath);
      expect(mounts.filter(([, source]) => source!.startsWith(base))).toEqual([
        ["--bind", root, root],
      ]);
      const destination = args.indexOf(grant.path);
      expect(args.slice(0, destination).join(" ")).toContain(`--dir ${dirname(grant.path)}`);
    });

    it("numbers child descriptors in order when an earlier grant is stale", () => {
      const stale = attachment();
      const store = dirname(stale.canonicalPath);
      const lexical = dirname(stale.path);
      const second = { path: join(lexical, "second.txt"), canonicalPath: join(store, "second.txt") };
      const third = { path: join(lexical, "third.txt"), canonicalPath: join(store, "third.txt") };
      writeFileSync(second.canonicalPath, "SECOND");
      writeFileSync(third.canonicalPath, "THIRD");
      rmSync(stale.canonicalPath);
      const program = build(`cat ${JSON.stringify(second.path)} ${JSON.stringify(third.path)}`, [stale, second, third]);
      expect(program.args.flatMap((arg, index) => arg === "--ro-bind-fd" ? [[arg, program.args[index + 1], program.args[index + 2]]] : []))
        .toEqual([["--ro-bind-fd", "3", second.path], ["--ro-bind-fd", "4", third.path]]);
      expect(program.extraFds).toHaveLength(2);
      const result = spawnSync(program.file, program.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", ...program.extraFds] });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("SECONDTHIRD");
    });

    it.each(["store symlink", "file symlink", "directory", "missing"])("omits a grant replaced by %s", (replacement) => {
      const grant = attachment();
      expect(build("true", [grant]).args).toContain(grant.path);
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "document.txt"), "REPLACEMENT-SECRET");
      if (replacement === "store symlink") {
        rmSync(dirname(grant.path));
        symlinkSync(outside, dirname(grant.path));
      } else {
        rmSync(grant.canonicalPath);
        if (replacement === "file symlink") symlinkSync(join(outside, "document.txt"), grant.canonicalPath);
        if (replacement === "directory") {
          mkdirSync(grant.canonicalPath);
          writeFileSync(join(grant.canonicalPath, "descendant.txt"), "DESCENDANT-SECRET");
        }
      }
      const { args } = build("true", [grant]);
      const sources = args.flatMap((arg, index) => arg === "--ro-bind" || arg === "--bind" ? [args[index + 1]] : []);
      expect(sources.filter((source) => source!.startsWith(base))).toEqual([root]);
      expect(args).not.toContain(grant.path);
    });

    it.runIf(shellSandbox() === "bwrap")("holds the opened file when its canonical pathname is replaced before bubblewrap starts", () => {
      const grant = attachment();
      const program = build(`cat ${JSON.stringify(grant.path)}`, [grant]);
      const outside = join(base, "external.txt");
      writeFileSync(outside, "EXTERNAL-REPLACEMENT");
      fs.renameSync(grant.canonicalPath, join(base, "original.txt"));
      symlinkSync(outside, grant.canonicalPath);
      const result = spawnSync(program.file, program.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", ...(program.extraFds ?? [])] });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("PINNED-ATTACHMENT");
      expect(result.stdout).not.toContain("EXTERNAL-REPLACEMENT");
    });

    it.runIf(shellSandbox() === "bwrap")("passes attachment descriptors to background shells and releases the parent copies", async () => {
      const grant = attachment();
      config = { ...config, readFiles: [grant] };
      const started = await run("shell", { command: `cat ${JSON.stringify(grant.path)}`, background: true });
      expect(started.ok, started.text).toBe(true);
      expect(attachmentFds(grant.canonicalPath)).toEqual([]);
      const log = /Output goes to (\S+)/.exec(started.text)![1]!;
      await expect.poll(() => readFileSync(join(root, log), "utf8")).toBe("PINNED-ATTACHMENT");
      const foreground = await run("shell", { command: `cat ${JSON.stringify(grant.path)}` });
      expect(foreground.ok, foreground.text).toBe(true);
      expect(attachmentFds(grant.canonicalPath)).toEqual([]);
    });

    it.runIf(shellSandbox() === "bwrap").each([false, true])("releases descriptors when spawn throws (background=%s)", async (background) => {
      const grant = attachment();
      config = { ...config, readFiles: [grant] };
      const result = await run("shell", { command: "echo \0", background });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/null bytes/);
      expect(attachmentFds(grant.canonicalPath)).toEqual([]);
    });

    it.runIf(shellSandbox() === "bwrap")("releases descriptors on the background job-limit early return", async () => {
      const grant = attachment();
      const scope = `attachment-cap-${Date.now()}`;
      config = { ...config, readFiles: [grant], jobScope: scope };
      try {
        for (let index = 0; index < 8; index++) {
          expect((await run("shell", { command: "sleep 60", background: true })).ok).toBe(true);
        }
        const refused = await run("shell", { command: "true", background: true });
        expect(refused.ok).toBe(false);
        expect(refused.text).toMatch(/Too many background commands/);
        expect(attachmentFds(grant.canonicalPath)).toEqual([]);
      } finally { stopBackgroundJobs(scope, 100); }
    });

    it.runIf(process.platform === "linux")("releases already opened descriptors when command construction throws", () => {
      const grant = attachment();
      const grants = [grant];
      grants[Symbol.iterator] = function* () {
        yield grant;
        throw new Error("grant iteration failed");
      };
      expect(() => build("true", grants)).toThrow("grant iteration failed");
      expect(attachmentFds(grant.canonicalPath)).toEqual([]);
    });

    it.runIf(shellSandbox() === "bwrap")("confines a confined shell to the read-only attachment through WorkspaceToolsConfig", async () => {
      const grant = attachment();
      config = { ...config, readFiles: [grant] };
      const quoted = JSON.stringify(grant.path);
      const read = await run("shell", { command: `cat ${quoted}` });
      expect(read.ok, read.text).toBe(true);
      expect(read.text).toContain("PINNED-ATTACHMENT");
      for (const path of [join(dirname(grant.path), "sibling.txt"), grant.canonicalPath, join(grant.path, "descendant.txt")]) {
        expect((await run("shell", { command: `cat ${JSON.stringify(path)}` })).ok).toBe(false);
      }
      expect((await run("shell", { command: `echo changed > ${quoted}` })).ok).toBe(false);
      expect(readFileSync(grant.canonicalPath, "utf8")).toBe("PINNED-ATTACHMENT");
      rmSync(dirname(grant.path));
      symlinkSync(root, dirname(grant.path));
      writeFileSync(join(root, "document.txt"), "RETARGETED-SECRET");
      const stale = await run("shell", { command: `cat ${quoted}` });
      expect(stale.ok).toBe(false);
      expect(stale.text).not.toContain("RETARGETED-SECRET");
    });
  });
  describe("macOS shell read allowlist", () => {
    const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
    const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
    const build = (options: { readable?: readonly string[]; readFiles?: NonNullable<WorkspaceToolsConfig["readFiles"]>; env?: NodeJS.ProcessEnv } = {}) =>
      sandboxedShell("true", root, [root], "sandbox-exec", {
        readable: options.readable,
        readFiles: options.readFiles,
        env: options.env ?? { HOME: join(base, "home"), PATH: "/usr/bin:/bin", TMPDIR: join(base, "tmp") },
      }).args[1]!;
    const rule = (profile: string, operation: string) =>
      profile.split("\n").map((line) => line.trim()).find((line) => line.startsWith(`(${operation} `)) ?? "";

    it("allows approved roots and exact canonical files but not parents, siblings, or unrelated paths", () => {
      const store = join(base, "store");
      const lexicalStore = join(base, "messages", "attachments");
      mkdirSync(store);
      mkdirSync(dirname(lexicalStore));
      symlinkSync(store, lexicalStore);
      const canonical = join(store, "document.txt");
      writeFileSync(canonical, "PINNED-ATTACHMENT");
      const sibling = join(store, "sibling.txt");
      writeFileSync(sibling, "SIBLING-SECRET");
      const readRoot = join(base, "skills");
      mkdirSync(readRoot);
      const toolchain = join(base, "toolchain", "bin");
      mkdirSync(toolchain, { recursive: true });
      const outside = join(base, "outside");
      mkdirSync(outside);
      const hostFile = join(outside, "private.txt");
      writeFileSync(hostFile, "OUTSIDE-SECRET");
      const grant = { path: join(lexicalStore, "document.txt"), canonicalPath: realpathSync(canonical) };
      const profile = build({
        readable: [readRoot],
        readFiles: [grant],
        env: { HOME: join(base, "home"), PATH: `${toolchain}:/usr/bin:/bin`, TMPDIR: join(base, "tmp") },
      });
      const data = rule(profile, "allow file-read-data");

      expect(profile).toContain("(deny file-read* file-test-existence)");
      expect(data).toContain(subpath(realpathSync(root)));
      expect(data).toContain(subpath(realpathSync(readRoot)));
      expect(data).toContain(subpath(realpathSync(toolchain)));
      if (existsSync("/usr")) expect(data).toContain(subpath(realpathSync("/usr")));
      expect(data).toContain(literal(grant.canonicalPath));
      expect(data).not.toContain(literal(grant.path));
      expect(data).not.toContain(subpath(dirname(canonical)));
      expect(data).not.toContain(literal(dirname(canonical)));
      expect(data).not.toContain(literal(sibling));
      expect(data).not.toContain(literal(hostFile));
      expect(data).not.toContain(subpath(outside));
      expect(profile).not.toContain(subpath(dirname(canonical)));
      expect(profile).not.toContain("(allow file-read*");
      expect(profile).not.toContain('(subpath "/")');

      const metadata = profile.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("(allow file-read-metadata"));
      expect(metadata.length).toBeGreaterThan(0);
      expect(metadata.join("\n")).toContain(literal(dirname(canonical)));
      expect(metadata.join("\n")).not.toContain(subpath(dirname(canonical)));

      expect(profile).toContain("(deny file-write*)");
      const write = rule(profile, "allow file-write*");
      expect(write).toContain(subpath(realpathSync(root)));
      expect(write).toContain(literal("/dev/null"));
      expect(write).toContain(literal("/dev/tty"));
      expect(write).toContain('(regex #"^/dev/fd/")');
      expect(write).not.toContain(subpath(store));
      expect(write).not.toContain(literal(canonical));
    });

    it.each(["missing", "file symlink", "directory", "store symlink"] as const)("omits a grant replaced by %s", (replacement) => {
      const store = join(base, "store");
      const lexicalStore = join(base, "messages", "attachments");
      mkdirSync(store);
      mkdirSync(dirname(lexicalStore));
      symlinkSync(store, lexicalStore);
      const canonical = join(store, "document.txt");
      writeFileSync(canonical, "PINNED-ATTACHMENT");
      const grant = { path: join(lexicalStore, "document.txt"), canonicalPath: realpathSync(canonical) };
      expect(rule(build({ readFiles: [grant] }), "allow file-read-data")).toContain(literal(grant.canonicalPath));

      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "document.txt"), "REPLACEMENT-SECRET");
      if (replacement === "missing") rmSync(canonical);
      if (replacement === "file symlink") {
        rmSync(canonical);
        symlinkSync(join(outside, "document.txt"), canonical);
      }
      if (replacement === "directory") {
        rmSync(canonical);
        mkdirSync(canonical);
        writeFileSync(join(canonical, "descendant.txt"), "DESCENDANT-SECRET");
      }
      if (replacement === "store symlink") {
        rmSync(lexicalStore);
        symlinkSync(outside, lexicalStore);
      }

      const profile = build({ readFiles: [grant] });
      const data = rule(profile, "allow file-read-data");
      expect(data).not.toContain(literal(grant.canonicalPath));
      expect(data).not.toContain(literal(grant.path));
      expect(data).not.toContain(subpath(dirname(grant.canonicalPath)));
      expect(profile).not.toContain(subpath(dirname(grant.canonicalPath)));
      expect(profile).not.toContain(subpath(outside));
      expect(profile).not.toContain(literal(join(outside, "document.txt")));
    });

    it.runIf(process.platform === "darwin" && shellSandbox() === "sandbox-exec")("macOS shell confines reads to the pinned attachment", async () => {
      const store = join(base, "store");
      mkdirSync(store);
      const attachment = join(store, "document.txt");
      writeFileSync(attachment, "PINNED-ATTACHMENT");
      const sibling = join(store, "sibling.txt");
      writeFileSync(sibling, "SIBLING-SECRET");
      const outside = join(base, "outside");
      mkdirSync(outside);
      const hostFile = join(outside, "private.txt");
      writeFileSync(hostFile, "OUTSIDE-SECRET");
      writeFileSync(join(root, "workspace.txt"), "WORKSPACE-CONTENT");
      config = { ...config, readFiles: [{ path: attachment, canonicalPath: realpathSync(attachment) }] };

      const read = await run("shell", { command: `cat ${JSON.stringify(attachment)} ${JSON.stringify(join(root, "workspace.txt"))}` });
      expect(read.ok, read.text).toBe(true);
      expect(read.text).toContain("PINNED-ATTACHMENT");
      expect(read.text).toContain("WORKSPACE-CONTENT");

      for (const path of [sibling, hostFile]) {
        const denied = await run("shell", { command: `cat ${JSON.stringify(path)}` });
        expect(denied.ok, denied.text).toBe(false);
        expect(denied.text).not.toContain("SIBLING-SECRET");
        expect(denied.text).not.toContain("OUTSIDE-SECRET");
      }

      const write = await run("shell", { command: `echo changed > ${JSON.stringify(attachment)}` });
      expect(write.ok, write.text).toBe(false);
      expect(readFileSync(attachment, "utf8")).toBe("PINNED-ATTACHMENT");
    });
  });
  it("runs plainly, and says so, without an OS sandbox", () => {
    const plain = sandboxedShell("ls", "/w", ["/w"], null);
    expect(plain.args).toEqual(["-c", "ls"]);
    if (process.platform === "win32") expect(plain.file.toLowerCase()).toMatch(/bash(\.exe)?$/);
    else expect(plain.file).toBe("/bin/bash");
    const bwrap = sandboxedShell("ls", root, [root], "bwrap");
    expect(bwrap.file).toBe("bwrap");
    expect(bwrap.args).toEqual(expect.arrayContaining(["--unshare-net", "--die-with-parent", "--tmpfs", "/tmp", "--", "/bin/bash", "-c", "ls"]));
    // Never the whole filesystem (audit R06b); the network only when the call asks for it (R06c).
    expect(bwrap.args.join(" ")).not.toContain("--ro-bind / /");
    expect(sandboxedShell("ls", root, [root], "bwrap", { network: true }).args).not.toContain("--unshare-net");
    expect(sandboxedShell("ls", root, [root], "sandbox-exec").args[1]).toContain("(deny file-write*)");
  });
  it("keeps the server's secrets out of the environment", () => {
    const env = shellEnvironment(root, { PATH: "/bin", GH_TOKEN: "x", OPENAI_API_KEY: "y" });
    expect(env.PATH).toBe("/bin");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("approval view", () => {
  it("asks for shell and writes, never for reads", () => {
    expect(workspaceToolView("read_file", { path: "a" }).ask).toBe(false);
    expect(workspaceToolView("shell", { command: "ls" })).toMatchObject({ ask: true, title: "shell" });
    expect(workspaceToolView("write_file", { path: "a", content: "" }).ask).toBe(true);
    expect(workspaceToolReadOnly("grep")).toBe(true);
    expect(workspaceToolReadOnly("apply_patch")).toBe(false);
  });
});
