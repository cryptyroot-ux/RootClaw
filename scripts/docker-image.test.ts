import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { cloudHomeConfiguration } from "../server/cloud-home.ts";
import { cloudHomeChildEnvironments } from "../server/cloud-home-start.ts";

// The published images: the self-hosted server (the default target) and the
// Cloud home. A pull downloads every layer whose digest changed, and a layer's
// digest changes when anything beneath it does.
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

interface Step { op: string; args: string }
interface Stage { name: string; from: string; steps: Step[] }

function stages(text: string): Stage[] {
  const all: Stage[] = [];
  let pending = "";
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line) || (!pending && !line.trim())) continue;
    pending += line.endsWith("\\") ? `${line.slice(0, -1)} ` : line;
    if (line.endsWith("\\")) continue;
    const [, op, args] = /^\s*(\S+)\s*([\s\S]*)$/.exec(pending)!;
    pending = "";
    if (op.toUpperCase() === "FROM") {
      const [, from, name] = /^(\S+)(?:\s+AS\s+(\S+))?$/i.exec(args.trim())!;
      all.push({ name: name ?? `#${all.length}`, from, steps: [] });
    } else all.at(-1)?.steps.push({ op: op.toUpperCase(), args: args.trim() });
  }
  return all;
}

const all = stages(dockerfile);
/** Every instruction a target's image is built from, its parents' first. */
function chain(target: string): Step[] {
  const stage = all.find(s => s.name === target);
  if (!stage) throw new Error(`the Dockerfile has no ${target} stage`);
  return [...(all.some(s => s.name === stage.from) ? chain(stage.from) : []), ...stage.steps];
}
const shipped = () => all.filter(s => s.name !== "build" && s.name !== "edge").flatMap(s => s.steps);
const npmInstall = (step: Step) => step.op === "RUN" && /\bnpm install\b/.test(step.args);
const browserRun = () => chain("runtime").find(step => step.op === "RUN" && step.args.includes("agent-browser install"))!;

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("container images", () => {
  it("keeps the self-hosted server the default target, and Cloud home a target of the same file", () => {
    expect(all.at(-1)!.name).toBe("server");
    expect(all.find(s => s.name === "cloud-home")!.from).toBe("runtime");
    expect(all.find(s => s.name === "server")!.from).toBe("runtime");
    // the build arg docker-compose.yml passes keeps its name and empty default
    expect(chain("server")).toContainEqual({ op: "ARG", args: 'ENGINES=""' });
  });

  it("puts the browser and the tools beneath the per-commit app files, so a code change leaves them as they were", () => {
    for (const target of ["server", "cloud-home"]) {
      const steps = chain(target);
      const heavy = steps.flatMap((step, i) => (npmInstall(step) ? [i] : []));
      const app = steps.flatMap((step, i) => (step.op === "COPY" && !step.args.includes("--from=edge") ? [i] : []));
      // agent-browser + Chrome, then pnpm in the Cloud home's tools layer or the server's opt-in ENGINES step, then
      // the app files (and the Cloud home's Caddyfile)
      expect(heavy, target).toHaveLength(2);
      const fromBuild = steps.flatMap((step, i) => (step.op === "COPY" && step.args.includes("--from=build") ? [i] : []));
      expect(fromBuild, target).toHaveLength(4);
      expect(Math.max(...heavy), target).toBeLessThan(Math.min(...app));
      // The Data engine's native tree (DuckDB, resvg) changes on a version bump,
      // not per commit, so it is copied before the per-commit app files.
      const native = steps.findIndex(step => step.op === "COPY" && step.args.includes("/dist-native/duckdb/"));
      expect(native, target).toBeGreaterThan(-1);
      expect(native, target).toBeLessThan(Math.min(...fromBuild.filter(i => i !== native)));
    }
  });

  it("leaves no npm or compile cache in a layer: each install removes its own in the same step", () => {
    const installs = shipped().filter(npmInstall);
    expect(installs.length).toBeGreaterThanOrEqual(3);
    for (const { args } of installs) {
      const cache = /--cache (\S+)/.exec(args)?.[1] ?? /\bHOME=(\S+) npm install\b/.exec(args)?.[1];
      expect(cache, args).toMatch(/^\/tmp\//);
      // Every `rm -rf` in the step counts: the Cloud home's tools layer clears apt's lists before its pnpm install.
      const removed = [...args.matchAll(/\brm -rf ([^;&|]+)/g)].flatMap((match) => match[1]!.trim().split(/\s+/));
      expect(removed, args).toEqual(expect.arrayContaining([cache, "/tmp/node-compile-cache"]));
    }
  });

  it("ships Caddy once, without its file capability, and the app files once, root's without a rewrite", () => {
    for (const { args } of shipped()) expect(args).not.toMatch(/\bch(own|mod) -R\b/);
    // modes are fixed where the files are built, in a stage that is not shipped
    const build = all.find(s => s.name === "build")!.steps.find(step => step.op === "RUN" && step.args.startsWith("pnpm build:server"))!;
    expect(build.args).toMatch(/ && chmod -R go-w dist dist-server skills$/);
    // a plain copy to a fresh inode drops the privileged-port capability and the 1001 owner
    expect(all.find(s => s.name === "edge")!.steps).toContainEqual({ op: "RUN", args: "cp /usr/bin/caddy /caddy" });
    const home = chain("cloud-home");
    expect(home.filter(step => step.args.includes("/usr/local/bin/caddy") && step.op === "COPY")).toEqual([
      { op: "COPY", args: "--from=edge /caddy /usr/local/bin/caddy" },
    ]);
    // pinned, so beneath the per-commit app files: a code change does not re-pull it
    expect(home.findIndex(step => step.args.startsWith("--from=edge "))).toBeLessThan(home.findIndex(step => step.args.includes("--from=build")));
    expect(home.filter(step => step.op === "RUN" && /\b(cp|mv)\b[^&]*caddy/.test(step.args))).toEqual([]);
    expect(home.filter(step => step.args.includes("--from=build")).map(step => step.args)).toEqual([
      "/src/dist-native/duckdb/linux-x64 ./duckdb", "/src/dist-server ./dist-server", "/src/dist ./dist", "/src/skills ./skills",
    ].map(path => `--from=build ${path}`));
    expect(chain("server").filter(step => step.args.includes("--from=build")).every(step => step.args.startsWith("--from=build --chown=rootclaw:rootclaw "))).toBe(true);
  });

  it("keeps each image's runtime contract", () => {
    const last = (steps: Step[], op: string) => steps.filter(step => step.op === op).at(-1)?.args;
    const server = chain("server");
    expect(last(server, "USER")).toBe("rootclaw");
    expect(last(server, "VOLUME")).toBe('["/data"]');
    expect(last(server, "CMD")).toBe('["node", "dist-server/server-launcher.js"]');
    expect(last(server, "HEALTHCHECK")).toContain("http://127.0.0.1:8799/api/health");
    const home = chain("cloud-home");
    expect(last(home, "USER")).toBe("root");
    expect(last(home, "VOLUME")).toBe('["/data"]');
    expect(last(home, "EXPOSE")).toBe("8080");
    expect(last(home, "CMD")).toBe('["node", "/app/dist-server/cloud-home-start.js"]');
    expect(last(home, "HEALTHCHECK")).toContain("http://127.0.0.1:8080/api/health");
    expect(last(chain("runtime"), "ENV")).toMatch(/^AGENT_BROWSER_EXECUTABLE_PATH=\/opt\/rootclaw-browser\/chrome .*NODE_ENV=production$/);
  });

  it("hands the Cloud home's server every setting the image's ENV gives it", () => {
    // The root supervisor passes the server an allow-listed environment; a setting the image sets but the list drops is
    // lost silently (ROOTCLAW_DUCKDB_DIR was: the server then found neither the 1Password SDK nor DuckDB in /app/duckdb).
    const image: Record<string, string> = {};
    for (const step of chain("cloud-home").filter(step => step.op === "ENV")) {
      for (const [, name, value] of step.args.matchAll(/(?:^|\s)([A-Z][A-Z0-9_]*)=(\S*)/g)) image[name] = value;
    }
    expect(image.ROOTCLAW_DUCKDB_DIR).toBe("/app/duckdb");
    const contract = { ROOTCLAW_CLOUD_ROLE: "home", ROOTCLAW_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", ROOTCLAW_CLOUD_ADMIN_URL: "https://cloud.example.test",
      ROOTCLAW_PUBLIC_URL: "https://rootclaw-u-1a2b3c4d5e6f.fly.dev", ROOTCLAW_CLOUD_BOOTSTRAP_SECRET: "S".repeat(43) };
    const { server } = cloudHomeChildEnvironments(cloudHomeConfiguration(contract)!, { ...image, ...contract }, "/data");
    // The launcher sets HOME, the ports and the data folder itself; everything else must come through unchanged.
    for (const name of Object.keys(image)) expect(server, name).toHaveProperty(name);
    expect(server.ROOTCLAW_DUCKDB_DIR).toBe("/app/duckdb");
  });

  it("never runs a build step with HOME on the volume, so nothing lands in what a fresh volume starts with", () => {
    for (const target of ["server", "cloud-home"]) {
      const steps = chain(target);
      const home = steps.findIndex(step => step.op === "ENV" && /(^|\s)HOME=\/data\b/.test(step.args));
      expect(home, target).toBeGreaterThan(-1);
      expect(steps.slice(home).filter(step => step.op === "RUN"), target).toEqual([]);
    }
  });

  it.skipIf(process.platform === "win32")("keeps only agent-browser's native binary, and refuses when the command is not one", () => {
    const { args } = browserRun();
    const start = args.indexOf("native=");
    const end = args.indexOf("&& agent-browser --version", start);
    expect(start).toBeGreaterThan(args.indexOf("agent-browser install"));
    expect(end).toBeGreaterThan(start);
    const prune = args.slice(start, end);
    const run = (target: string, elf = true) => {
      const root = mkdtempSync(join(tmpdir(), "rootclaw-agent-browser-"));
      temporaryDirectories.push(root);
      const bin = join(root, "lib/node_modules/agent-browser/bin");
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(root, "bin"));
      const names = ["agent-browser-darwin-arm64", "agent-browser-linux-arm64", "agent-browser-linux-musl-x64", "agent-browser-linux-x64", "agent-browser-win32-x64.exe", "agent-browser.js"];
      for (const name of names) writeFileSync(join(bin, name), name === "agent-browser-linux-x64" && elf ? "\x7fELF\x02\x01" : "#!/usr/bin/env node\n", { mode: 0o755 });
      symlinkSync(join(bin, target), join(root, "bin/agent-browser"));
      const result = spawnSync("sh", ["-c", prune], { env: { PATH: `${join(root, "bin")}:/usr/bin:/bin` }, encoding: "utf8" });
      return { status: result.status, left: readdirSync(bin).sort(), names };
    };
    expect(run("agent-browser-linux-x64")).toMatchObject({ status: 0, left: ["agent-browser-linux-x64", "agent-browser.js"] });
    // npm linking the JS wrapper instead must stop the build, not delete every native binary
    const wrapper = run("agent-browser.js");
    expect(wrapper.status).not.toBe(0);
    expect(wrapper.left).toEqual(wrapper.names);
    const script = run("agent-browser-linux-x64", false);
    expect(script.status).not.toBe(0);
    expect(script.left).toEqual(script.names);
  });

  it("keys the browser layer on the Chrome it installs, so a release rebuilds it", () => {
    const runtime = all.find(s => s.name === "runtime")!.steps;
    const declared = runtime.findIndex(step => step.op === "ARG" && step.args.startsWith("CHROME_CACHE_TAG="));
    // declared after the apt step, so a Chrome release rebuilds only the browser layer
    expect(declared).toBeGreaterThan(runtime.findIndex(step => step.op === "RUN" && step.args.startsWith("apt-get update")));
    expect(declared).toBeLessThan(runtime.indexOf(browserRun()));
    expect(browserRun().args).toContain("${CHROME_CACHE_TAG");
  });

  // RootClaw's engine is native: it talks to model providers over their APIs, so no image or compose default installs
  // an external engine CLI (Claude Code, Codex, Grok Build). ENGINES stays an opt-in, empty by default.
  it("installs no external engine CLI by default in any image or compose file", () => {
    const external = /claude-code|@openai\/codex|x\.ai\/cli|\bgrok\b/i;
    for (const target of ["server", "cloud-home"]) {
      const steps = chain(target);
      expect(steps.filter(step => step.op !== "ENV" && external.test(step.args)), target).toEqual([]);
      expect(steps.filter(step => step.op === "ARG" && /^(CLOUD_HOME_ENGINES|ENGINES_CACHE_TAG|GROK_VERSION)=/.test(step.args)), target).toEqual([]);
    }
    expect(chain("cloud-home").filter(step => step.op === "ARG" && step.args.startsWith("ENGINES="))).toEqual([]);
    const text = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
    for (const file of ["../deploy/local/Dockerfile", "../deploy/podman/Containerfile"]) {
      expect(text(file), file).toMatch(/^ARG ENGINES=""$/m);
      expect(text(file).split("\n").filter(line => !/^\s*#/.test(line) && external.test(line)), file).toEqual([]);
    }
    for (const file of ["../compose.yaml", "../deploy/docker-compose.yml", "../deploy/podman/compose.yaml"]) {
      expect(parse(text(file)).services.rootclaw.build.args.ENGINES, file).toBe("${ENGINES:-}");
    }
    for (const file of ["../.env.example", "../deploy/.env.example"]) expect(text(file), file).toMatch(/^ENGINES=$/m);
  });

  // An init collects browser processes whose parents exit, and Chrome gets the
  // shared memory RootClaw's desktop containers give it.
  it("runs every compose service of the server image with an init and Chrome's shared memory", () => {
    for (const file of ["../compose.yaml", "../deploy/docker-compose.yml", "../deploy/podman/compose.yaml"]) {
      const service = parse(readFileSync(new URL(file, import.meta.url), "utf8")).services.rootclaw;
      expect(service.init, file).toBe(true);
      expect(service.shm_size, file).toBe("512m");
    }
  });
});
