// One-click update of a git clone: fetch the latest release tag, install, rebuild, restart; on any failure, back to the old commit and build.
// Every command is a fixed argv run without a shell; the only outside input is the release version, which must look like semver.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { RESTART_EXIT_CODE } from "./restart.ts";

export type ApplyPhase = "idle" | "fetching" | "installing" | "building" | "restarting" | "done" | "failed";
const ACTIVE: readonly ApplyPhase[] = ["fetching", "installing", "building", "restarting"];
export const isActivePhase = (phase: ApplyPhase) => ACTIVE.includes(phase);

/** `restart`: "auto" when a launcher or supervisor starts the server again; "manual" when nothing would. */
export interface ApplyStatus {
  phase: ApplyPhase;
  from?: string;
  to?: string;
  /** The version this server runs now. */
  current: string;
  error?: string;
  rolledBack?: boolean;
  restart?: "auto" | "manual";
  log: string[];
  startedAt?: number;
  finishedAt?: number;
  /** Set from a finished build until the new version has stayed up: what the launcher needs to go back if it does not start. */
  boot?: BootWatch;
}

export interface BootWatch { root: string; prev: string; branch: string | null; attempts: number }

/** A start the applier refuses before touching anything; the route answers it with 409 and this message. */
export class ApplyRefused extends Error {}

/** Who starts this server again after it exits with RESTART_EXIT_CODE. */
export type RestartMode = "launcher" | "systemd" | "pm2" | "none";

/** `rootclaw serve` marks its child (server/cli.ts) and starts it again on exit code 75; systemd runs a service's main process
 * under PID 1 with INVOCATION_ID set; pm2 sets pm_id. A bare `node dist-server/index.js` has none of these. */
export function restartMode(env: NodeJS.ProcessEnv = process.env, ppid = process.ppid): RestartMode {
  if (env.ROOTCLAW_LAUNCHER === "cli") return "launcher";
  if (env.INVOCATION_ID && ppid === 1) return "systemd";
  if (env.pm_id !== undefined) return "pm2";
  return "none";
}

export const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOG_LINES = 40;
const LINE_MAX = 300;
const GIB = 1024 ** 3;
/** Headroom for pnpm install and both builds on top of the copy of the old build; the VPS this shipped for ran out at 95%. */
export const MIN_FREE_BYTES = 2 * GIB;
export const MIN_FREE_INODES = 20_000;
export const TIMEOUTS = { git: 60_000, fetch: 5 * 60_000, install: 15 * 60_000, build: 30 * 60_000, buildServer: 15 * 60_000 };
const BUILD_DIRS = ["dist", "dist-server"] as const;
export const BACKUP_DIR = ".rootclaw-update-backup";
/** The build the update replaced, kept until the new version has started and stayed up (BootWatch). */
export const PREVIOUS_DIR = ".rootclaw-update-previous";
export const STATUS_FILE = "update-apply.json";
/** Failed starts of a new version before the launcher goes back to the previous one. */
export const BOOT_ATTEMPTS = 2;
/** A new version that stays up this long after it starts listening counts as started. */
export const HEALTHY_AFTER_MS = 30_000;
/** Ctrl+C and a stop request end the server this way; they are not a failed start. A death by signal (no exit code) is. */
const STOP_CODES = new Set<number | null>([0, RESTART_EXIT_CODE, 130, 143]);

export interface RunResult { code: number | null; output: string }
export type Runner = (command: string, args: readonly string[], options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; onLine: (line: string) => void }) => Promise<RunResult>;

/** Variables a build needs; everything else (API keys, passwords) stays out of the commands' environment. */
const PASS_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TERM|TMPDIR|TEMP|TMP|TZ|XDG_\w+|COREPACK_\w+|PNPM_\w+|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|SSL_CERT_\w+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSH_AUTH_SOCK|GIT_SSH|GIT_SSH_COMMAND|npm_config_\w+)$/;
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|PRIVATE/i;
/** Names that look secret but hold a path git needs: the ssh agent's socket. */
const NOT_SECRET = /^SSH_AUTH_SOCK$/;
const secretName = (key: string) => SECRET_NAME.test(key) && !NOT_SECRET.test(key);

export function commandEnv(env: NodeJS.ProcessEnv, nodeDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && PASS_ENV.test(key) && !secretName(key)) out[key] = value;
  // The same node runs pnpm's `#!/usr/bin/env node`, the scripts and the server; systemd's PATH may not have it at all.
  out.PATH = [nodeDir, out.PATH].filter(Boolean).join(delimiter);
  out.GIT_TERMINAL_PROMPT = "0";
  out.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  // docs/install.md builds with a 6 GB heap; keep an operator's own setting.
  if (!/max-old-space-size/.test(out.NODE_OPTIONS ?? "")) out.NODE_OPTIONS = [out.NODE_OPTIONS, "--max-old-space-size=6144"].filter(Boolean).join(" ");
  return out;
}

/** Credentials in URLs and the values of any secret-named variable never reach the log. */
export function redactor(env: NodeJS.ProcessEnv): (line: string) => string {
  const secrets = Object.entries(env).filter(([key, value]) => secretName(key) && typeof value === "string" && value.length >= 6).map(([, value]) => value as string);
  return (line) => {
    let out = line.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@");
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    return out.length > LINE_MAX ? `${out.slice(0, LINE_MAX)}…` : out;
  };
}

const running = new Set<ChildProcess>();
const stopGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already gone */ }
};

/** Stops every running update command with its whole process group. Runs on process exit while one is running, so a server
 * shutting down mid-update leaves no git or pnpm writing into the clone (the next start reads the update as interrupted). */
export function stopRunningCommands(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const child of running) stopGroup(child, signal);
}

/** spawn without a shell; on timeout the whole process group is stopped, since pnpm runs its scripts in children. */
export const spawnRunner: Runner = (command, args, { cwd, timeoutMs, env, onLine }) => new Promise((done) => {
  let output = "";
  let partial = "";
  const posix = process.platform !== "win32";
  const child = spawn(command, [...args], { cwd, env, shell: false, detached: posix, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const take = (chunk: Buffer) => {
    const text = partial + chunk.toString("utf8");
    const lines = text.split(/\r?\n|\r/);
    partial = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) { onLine(line); output = (output + line + "\n").slice(-20_000); }
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  const kill = (signal: NodeJS.Signals) => stopGroup(child, signal);
  if (!running.size) process.on("exit", stopRunningCommands);
  running.add(child);
  const forget = () => { running.delete(child); if (!running.size) process.off("exit", stopRunningCommands); };
  const timer = setTimeout(() => {
    onLine(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);
  child.once("error", (error) => { clearTimeout(timer); forget(); onLine(error.message); done({ code: null, output }); });
  child.once("close", (code) => {
    clearTimeout(timer);
    forget();
    if (partial.trim()) onLine(partial);
    done({ code, output });
  });
});

/** pnpm on PATH or beside this node (corepack's shim); else corepack itself; null when neither exists. */
export function resolvePnpm(env: NodeJS.ProcessEnv, nodeDir: string, exists: (path: string) => boolean = existsSync): { command: string; prefix: string[] } | null {
  const dirs = [nodeDir, ...(env.PNPM_HOME ? [env.PNPM_HOME] : []), ...(env.PATH ?? "").split(delimiter).filter(Boolean)];
  for (const dir of dirs) if (exists(join(dir, "pnpm"))) return { command: join(dir, "pnpm"), prefix: [] };
  for (const dir of dirs) if (exists(join(dir, "corepack"))) return { command: join(dir, "corepack"), prefix: ["pnpm"] };
  return null;
}

function dirBytes(path: string): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  if (existsSync(path)) walk(path);
  return total;
}

const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

/** Room for the copy of the old build plus MIN_FREE_BYTES; null when there is enough. */
export function diskShortage(root: string, statfs: (path: string) => { bavail: number | bigint; bsize: number | bigint; ffree: number | bigint; files: number | bigint } = statfsSync, sizeOf: (path: string) => number = dirBytes): string | null {
  const stats = statfs(root);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const backup = BUILD_DIRS.reduce((sum, dir) => sum + sizeOf(join(root, dir)), 0);
  const need = MIN_FREE_BYTES + backup;
  if (free < need) return `Not enough free disk space to build the update: ${gb(free)} free, about ${gb(need)} needed. Free some space (for example \`pnpm store prune\`, old logs or backups) and try again.`;
  if (Number(stats.files) > 0 && Number(stats.ffree) < MIN_FREE_INODES) return `Not enough free inodes to build the update: ${Number(stats.ffree)} left, at least ${MIN_FREE_INODES} needed. Delete unused files (for example \`pnpm store prune\`) and try again.`;
  return null;
}

export interface ApplierOptions {
  /** The clone root (the folder holding .git, dist and dist-server). */
  root: string;
  current: string;
  /** Where the status survives the restart; null keeps it in memory only. */
  statusFile: string | null;
  restartMode: RestartMode;
  /** Exit so the launcher or supervisor starts the new build (index.ts: RESTART_EXIT_CODE via the graceful shutdown). */
  restart: () => void;
  run?: Runner;
  env?: NodeJS.ProcessEnv;
  nodeDir?: string;
  diskCheck?: (root: string) => string | null;
  now?: () => number;
  /** Delay before restart so the "restarting" status reaches the page first. */
  restartDelayMs?: number;
  /** How long a freshly updated server must stay up before the previous build is let go (HEALTHY_AFTER_MS). */
  healthyAfterMs?: number;
}

class StepFailed extends Error {}

export function createUpdateApplier(options: ApplierOptions) {
  const run = options.run ?? spawnRunner;
  const env = options.env ?? process.env;
  const nodeDir = options.nodeDir ?? dirname(process.execPath);
  const now = options.now ?? Date.now;
  const diskCheck = options.diskCheck ?? ((root: string) => diskShortage(root));
  const childEnv = commandEnv(env, nodeDir);
  const redact = redactor(env);
  const root = options.root;
  let status: ApplyStatus = resume();
  let running = false;

  function resume(): ApplyStatus {
    const fresh: ApplyStatus = { phase: "idle", current: options.current, log: [] };
    if (!options.statusFile || !existsSync(options.statusFile)) return fresh;
    try {
      const saved = JSON.parse(readFileSync(options.statusFile, "utf8")) as ApplyStatus;
      const log = Array.isArray(saved.log) ? saved.log.slice(-LOG_LINES) : [];
      const next: ApplyStatus = { ...saved, current: options.current, log };
      if (saved.phase === "restarting") {
        Object.assign(next, saved.to === options.current
          ? { phase: "done", finishedAt: now() }
          : { phase: "failed", error: `RootClaw restarted but still runs v${options.current}, not v${saved.to}. Check the server log.`, finishedAt: now() });
      } else if (isActivePhase(saved.phase)) {
        Object.assign(next, { phase: "failed", error: "The update was interrupted (the server stopped while it ran). Run `git status` in the RootClaw folder before trying again.", finishedAt: now() });
      }
      if (saved.boot && saved.to !== options.current) delete next.boot;
      save(next);
      return next;
    } catch {
      return fresh;
    }
  }

  function save(next: ApplyStatus) {
    if (!options.statusFile) return;
    try {
      mkdirSync(dirname(options.statusFile), { recursive: true });
      writeFileSync(options.statusFile, JSON.stringify(next), { mode: 0o600 });
    } catch { /* the status still lives in memory */ }
  }

  const set = (patch: Partial<ApplyStatus>) => { status = { ...status, ...patch }; save(status); };
  const log = (line: string) => { status = { ...status, log: [...status.log, redact(line)].slice(-LOG_LINES) }; };

  async function step(command: string, args: readonly string[], timeoutMs: number, what: string): Promise<string> {
    log(`$ ${[command.split(/[\\/]/).pop(), ...args].join(" ")}`);
    const result = await run(command, args, { cwd: root, timeoutMs, env: childEnv, onLine: log });
    if (result.code !== 0) throw new StepFailed(`${what} failed${result.code === null ? "" : ` (exit ${result.code})`}.`);
    return result.output.trim();
  }
  const git = (args: readonly string[], what: string, timeoutMs = TIMEOUTS.git) => step("git", args, timeoutMs, what);
  const gitOk = async (args: readonly string[]) => (await run("git", args, { cwd: root, timeoutMs: TIMEOUTS.git, env: childEnv, onLine: () => {} })).code === 0;

  async function apply(latest: string) {
    const pnpm = resolvePnpm(childEnv, nodeDir);
    const backup = join(root, BACKUP_DIR);
    let prev: string | null = null;
    let branch: string | null = null;
    let moved = false;
    let installed = false;
    let backedUp = false;
    try {
      if (!pnpm) throw new StepFailed("pnpm was not found on PATH or beside node. Install it (`corepack enable`) and try again.");
      const dirty = await git(["status", "--porcelain", "--untracked-files=no"], "Reading git status");
      if (dirty) throw new StepFailed("This RootClaw folder has uncommitted changes to tracked files, so the update would overwrite them. Commit or stash them (`git status` lists them) and try again.");
      const short = diskCheck(root);
      if (short) throw new StepFailed(short);
      prev = await git(["rev-parse", "HEAD"], "Reading the current commit");
      branch = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, timeoutMs: TIMEOUTS.git, env: childEnv, onLine: () => {} })).output.trim() || null;
      if (branch && branch !== "main") throw new StepFailed(`This clone is on branch ${branch}, not main. Switch to main (or update by hand) and try again.`);
      const shallow = (await git(["rev-parse", "--is-shallow-repository"], "Reading the clone")) === "true";
      await git(["fetch", "--tags", "--no-recurse-submodules", ...(shallow ? ["--unshallow"] : []), "origin"], "Fetching from origin", TIMEOUTS.fetch);
      const tag = await releaseTag(latest);
      const target = await git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], "Reading the release tag");
      if (!(await gitOk(["merge-base", "--is-ancestor", "HEAD", target]))) {
        throw new StepFailed(`This clone has commits that are not in ${tag}, so it cannot move there without losing them. Update by hand.`);
      }
      if (branch) await git(["merge", "--ff-only", "--quiet", target], `Fast-forwarding main to ${tag}`);
      else await git(["checkout", "--quiet", "--detach", target], `Checking out ${tag}`);
      moved = true;
      const version = readVersion();
      if (version !== latest) throw new StepFailed(`${tag} says it is version ${version ?? "unknown"}, not ${latest}.`);

      set({ phase: "installing" });
      installed = true;
      await step(pnpm.command, [...pnpm.prefix, "install", "--frozen-lockfile"], TIMEOUTS.install, "pnpm install");

      set({ phase: "building" });
      rmSync(backup, { recursive: true, force: true });
      mkdirSync(backup, { recursive: true });
      for (const dir of BUILD_DIRS) if (existsSync(join(root, dir))) cpSync(join(root, dir), join(backup, dir), { recursive: true, verbatimSymlinks: true });
      backedUp = true;
      log("the current build is saved; it comes back if the new one fails");
      await step(pnpm.command, [...pnpm.prefix, "build"], TIMEOUTS.build, "Building the web app (pnpm build)");
      await step(pnpm.command, [...pnpm.prefix, "build:server"], TIMEOUTS.buildServer, "Building the server (pnpm build:server)");
      for (const file of ["dist/index.html", "dist-server/index.js", "dist-server/rootclaw.js"]) {
        if (!existsSync(join(root, file))) throw new StepFailed(`The build finished without ${file}.`);
      }
      // The old build stays beside the new one until the new version has started (BootWatch, recoverFailedUpdate).
      rmSync(join(root, PREVIOUS_DIR), { recursive: true, force: true });
      renameSync(backup, join(root, PREVIOUS_DIR));
      backedUp = false;
      const boot: BootWatch = { root, prev, branch, attempts: 0 };

      const auto = options.restartMode !== "none";
      log(auto ? `built v${latest}; restarting (${options.restartMode})` : `built v${latest}; nothing here restarts RootClaw by itself`);
      // Only `rootclaw serve` goes back by itself when the new version does not start; elsewhere say how.
      if (options.restartMode !== "launcher") log(byHand(latest, boot));
      if (!auto) {
        set({ phase: "done", restart: "manual", finishedAt: now(), boot });
        return;
      }
      set({ phase: "restarting", restart: "auto", boot });
      setTimeout(() => options.restart(), options.restartDelayMs ?? 1_500).unref?.();
    } catch (error) {
      const reason = error instanceof StepFailed ? error.message : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
      log(reason);
      const problems = moved || backedUp ? await rollback({ prev, branch, moved, installed, backedUp, backup, pnpm }) : [];
      set({
        phase: "failed",
        error: problems.length ? `${reason} Rolling back also failed: ${problems.join(" ")}` : reason,
        rolledBack: (moved || backedUp) && !problems.length,
        finishedAt: now(),
      });
    }
  }

  async function releaseTag(latest: string): Promise<string> {
    for (const tag of [`v${latest}`, latest]) if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`])) return tag;
    throw new StepFailed(`origin has no tag v${latest}. Check that origin is https://github.com/cryptyroot-ux/RootClaw.`);
  }

  function readVersion(): string | null {
    try { return String((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version ?? "") || null; } catch { return null; }
  }

  async function rollback(state: { prev: string | null; branch: string | null; moved: boolean; installed: boolean; backedUp: boolean; backup: string; pnpm: { command: string; prefix: string[] } | null }): Promise<string[]> {
    const problems: string[] = [];
    log("rolling back");
    if (state.moved && state.prev) {
      try {
        if (state.branch) await git(["reset", "--hard", "--quiet", state.prev], "Resetting to the previous commit");
        else await git(["checkout", "--quiet", "--force", "--detach", state.prev], "Checking out the previous commit");
      } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
    }
    if (state.backedUp) {
      for (const dir of BUILD_DIRS) {
        try {
          const saved = join(state.backup, dir);
          if (!existsSync(saved)) continue;
          rmSync(join(root, dir), { recursive: true, force: true });
          renameSync(saved, join(root, dir));
        } catch (error) { problems.push(`Restoring ${dir}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (!problems.length) rmSync(state.backup, { recursive: true, force: true });
    }
    if (state.installed && state.pnpm && !problems.length) {
      try { await step(state.pnpm.command, [...state.pnpm.prefix, "install", "--frozen-lockfile"], TIMEOUTS.install, "Reinstalling the previous dependencies"); }
      catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
    }
    if (!problems.length) log(`rolled back to ${state.prev?.slice(0, 12) ?? "the previous build"}`);
    return problems;
  }

  return {
    status: (): ApplyStatus => ({ ...status, current: options.current }),
    /** The server listens: a new version that stays up healthyAfterMs from now no longer needs the way back. */
    listening() {
      const boot = status.boot;
      if (!boot) return;
      setTimeout(() => {
        if (!status.boot) return;
        rmSync(join(boot.root, PREVIOUS_DIR), { recursive: true, force: true });
        set({ boot: undefined });
      }, options.healthyAfterMs ?? HEALTHY_AFTER_MS).unref?.();
    },
    busy: () => running,
    /** Starts the update in the background; false when one is already running. */
    /** Throws ApplyRefused when it will not start at all. */
    start(latest: string): boolean {
      if (running) return false;
      if (!RELEASE_VERSION.test(latest)) throw new ApplyRefused(`"${latest}" is not a release version RootClaw can install.`);
      if (existsSync(join(root, BACKUP_DIR))) {
        throw new ApplyRefused(`A saved build from an earlier update that could not be rolled back is still in ${join(root, BACKUP_DIR)}. Check the RootClaw folder (git status, dist, dist-server), restore what you need from that folder, then remove it and try again.`);
      }
      if (status.boot) throw new ApplyRefused(`v${status.to} is installed but has not finished starting yet. Restart RootClaw (or wait a minute) and try again.`);
      running = true;
      status = { phase: "fetching", from: options.current, to: latest, current: options.current, log: [], startedAt: now() };
      save(status);
      void apply(latest).finally(() => { if (status.phase !== "restarting") running = false; });
      return true;
    },
  };
}

export type UpdateApplier = ReturnType<typeof createUpdateApplier>;

const byHand = (to: string | undefined, boot: BootWatch) =>
  `If v${to} does not start, go back with: git reset --hard ${boot.prev}, move dist and dist-server back from ${PREVIOUS_DIR}, then pnpm install --frozen-lockfile.`;

export interface RecoverDeps { run?: Runner; env?: NodeJS.ProcessEnv; nodeDir?: string; log?: (line: string) => void }

/**
 * The `rootclaw serve` launcher (server/cli.ts serveUntilStopped) calls this when its server ended any way but a stop or a restart.
 * While a new version waits to prove it starts (BootWatch), the first failed start gets another try; the second puts the
 * previous commit, build and dependencies back. True when the launcher should start the server again.
 */
export async function recoverFailedUpdate(dataDir: string, code: number | null, deps: RecoverDeps = {}): Promise<boolean> {
  if (STOP_CODES.has(code)) return false;
  const file = join(dataDir, STATUS_FILE);
  let saved: ApplyStatus;
  try { saved = JSON.parse(readFileSync(file, "utf8")) as ApplyStatus; } catch { return false; }
  const boot = saved.boot;
  if (!boot?.root || !boot.prev) return false;
  const env = deps.env ?? process.env;
  const nodeDir = deps.nodeDir ?? dirname(process.execPath);
  const say = deps.log ?? ((line: string) => console.log(line));
  const write = (next: ApplyStatus) => { try { writeFileSync(file, JSON.stringify(next), { mode: 0o600 }); } catch { /* the launcher still decides */ } };
  const attempts = boot.attempts + 1;
  if (attempts < BOOT_ATTEMPTS) {
    write({ ...saved, boot: { ...boot, attempts } });
    say(`\nRootClaw v${saved.to} stopped while starting (exit ${code}); trying once more…`);
    return true;
  }
  say(`\nRootClaw v${saved.to} stopped while starting again; going back to v${saved.from}…`);
  const run = deps.run ?? spawnRunner;
  const childEnv = commandEnv(env, nodeDir);
  const redact = redactor(env);
  const log = [...(saved.log ?? [])];
  const onLine = (line: string) => { const clean = redact(line); log.push(clean); say(clean); };
  const problems: string[] = [];
  const exec = async (command: string, args: readonly string[], what: string, timeoutMs: number) => {
    onLine(`$ ${[command.split(/[\\/]/).pop(), ...args].join(" ")}`);
    if ((await run(command, args, { cwd: boot.root, timeoutMs, env: childEnv, onLine })).code !== 0) throw new Error(`${what} failed.`);
  };
  try {
    await exec("git", boot.branch ? ["reset", "--hard", "--quiet", boot.prev] : ["checkout", "--quiet", "--force", "--detach", boot.prev], "Going back to the previous commit", TIMEOUTS.git);
    const previous = join(boot.root, PREVIOUS_DIR);
    for (const dir of BUILD_DIRS) {
      if (!existsSync(join(previous, dir))) continue;
      rmSync(join(boot.root, dir), { recursive: true, force: true });
      renameSync(join(previous, dir), join(boot.root, dir));
    }
    rmSync(previous, { recursive: true, force: true });
    const pnpm = resolvePnpm(childEnv, nodeDir);
    if (!pnpm) throw new Error("pnpm was not found to reinstall the previous dependencies.");
    await exec(pnpm.command, [...pnpm.prefix, "install", "--frozen-lockfile"], "Reinstalling the previous dependencies", TIMEOUTS.install);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const { boot: _done, ...rest } = saved;
  const failed = `v${saved.to} was installed but stopped while starting, twice.`;
  write({
    ...rest, phase: "failed", rolledBack: !problems.length, finishedAt: Date.now(), log: log.slice(-LOG_LINES),
    error: problems.length ? `${failed} Going back failed: ${problems.join(" ")} ${byHand(saved.to, boot).replace(/^If v\S+ does not start, go/, "Go")}` : failed,
  });
  say(problems.length ? `Going back failed: ${problems.join(" ")}` : `RootClaw went back to v${saved.from}; starting it again.`);
  return !problems.length;
}
