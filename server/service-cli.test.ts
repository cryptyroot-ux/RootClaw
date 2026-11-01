import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runServiceCommand, serviceServeArgs } from "./service-cli.ts";
import { removeTempDir } from "./testing/cleanup.ts";

describe("rootclaw service", () => {
  let dir: string;
  const out: string[] = [];
  const err: string[] = [];
  const io = { log: (l: string) => out.push(l), error: (l: string) => err.push(l) };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rootclaw-service-"));
    out.length = 0;
    err.length = 0;
  });
  afterEach(() => removeTempDir(dir));

  it("repeats the serve options, one access mode at a time", () => {
    expect(serviceServeArgs({ port: 8799, dataDir: "/d", domain: "a.example.com", tunnel: true, label: "x" })).toEqual(["--port", "8799", "--data-dir", "/d", "--no-pair", "--domain", "a.example.com", "--label", "x"]);
    expect(serviceServeArgs({ port: 1, dataDir: "/d", tailscale: true })).toEqual(["--port", "1", "--data-dir", "/d", "--no-pair", "--tailscale"]);
  });

  it("writes the unit next to the data and prints how to install it; refuses an npx cache", () => {
    const code = runServiceCommand({ action: "install", dataDir: dir, port: 8799, domain: "rootclaw.example.com", script: "/usr/lib/node_modules/rootclaw/cli.js", node: "/usr/bin/node", platform: "linux", home: "/home/rootclaw", user: "rootclaw" }, io);
    expect(code).toBe(0);
    const unit = readFileSync(join(dir, "rootclaw.service"), "utf8");
    expect(unit).toContain("--domain rootclaw.example.com");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(out.join("\n")).toContain("sudo systemctl enable --now rootclaw");
    expect(out.join("\n")).toContain("no setcap is needed");

    out.length = 0;
    const refused = runServiceCommand({ action: "install", dataDir: join(dir, "x"), port: 8799, script: "/home/rootclaw/.npm/_npx/deadbeef/node_modules/rootclaw/cli.js", node: "/usr/bin/node", platform: "linux" }, io);
    expect(refused).toBe(1);
    expect(err.join("\n")).toMatch(/node dist-server\/rootclaw\.js service install/);
    expect(existsSync(join(dir, "x", "rootclaw.service"))).toBe(false);
  });

  it("writes a launchd agent on macOS and explains uninstall on both", () => {
    expect(runServiceCommand({ action: "install", dataDir: dir, port: 8799, tunnel: true, script: "/opt/homebrew/lib/node_modules/rootclaw/cli.js", node: "/opt/homebrew/bin/node", platform: "darwin", home: "/Users/rootclaw" }, io)).toBe(0);
    expect(readFileSync(join(dir, "com.rootclaw.serve.plist"), "utf8")).toContain("<string>--tunnel</string>");
    expect(out.join("\n")).toContain("launchctl bootstrap");
    out.length = 0;
    expect(runServiceCommand({ action: "uninstall", dataDir: dir, port: 8799, script: "/x", node: "/n", platform: "linux" }, io)).toBe(0);
    expect(out.join("\n")).toContain("sudo systemctl disable --now rootclaw");
    expect(runServiceCommand({ action: "install", dataDir: dir, port: 8799, script: "/x", node: "/n", platform: "win32" }, io)).toBe(1);
  });

  it("--sentinel writes the scan's own schedule into its own folder, not the data dir, and only prints how to install it", () => {
    const sentinelOut = join(dir, "sentinel-state");
    const dataDir = join(dir, "data");
    const base = { action: "install" as const, dataDir, port: 8799, sentinel: true, sentinelOut, script: "/usr/lib/node_modules/rootclaw/cli.js", node: "/usr/bin/node", exists: () => false };
    expect(runServiceCommand({ ...base, platform: "darwin", home: "/Users/rootclaw" }, io)).toBe(0);
    const plist = readFileSync(join(sentinelOut, "com.rootclaw.sentinel.plist"), "utf8");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).not.toContain("ELECTRON_RUN_AS_NODE");
    expect(plist).toContain(`<string>${sentinelOut}</string>`);
    expect(out.join("\n")).toContain("rootclaw sentinel --check-install");
    expect(existsSync(dataDir)).toBe(false);
    expect(out.join("\n")).toContain("launchctl bootstrap gui/$(id -u) /Users/rootclaw/Library/LaunchAgents/com.rootclaw.sentinel.plist");
    expect(out.join("\n")).toContain(`issues: ${join(sentinelOut, "issues.jsonl")}`);

    out.length = 0;
    expect(runServiceCommand({ ...base, platform: "linux", home: "/home/rootclaw" }, io)).toBe(0);
    expect(readFileSync(join(sentinelOut, "rootclaw-sentinel.service"), "utf8")).toContain("sentinel --once --data-dir");
    expect(readFileSync(join(sentinelOut, "rootclaw-sentinel.timer"), "utf8")).toContain("OnUnitActiveSec=120s");
    expect(out.join("\n")).toContain("systemctl --user enable --now rootclaw-sentinel.timer");
    expect(existsSync(dataDir)).toBe(false);

    out.length = 0;
    expect(runServiceCommand({ ...base, action: "uninstall", platform: "linux", home: "/home/rootclaw" }, io)).toBe(0);
    expect(out.join("\n")).toContain("systemctl --user disable --now rootclaw-sentinel.timer");

    // Windows gets a schtasks line, with the platform's own folder as --out
    expect(runServiceCommand({ ...base, sentinelOut: undefined, platform: "win32", dataDir: "C:\\Users\\rootclaw\\.rootclaw", home: "C:\\Users\\rootclaw", env: {} }, io)).toBe(1);
    expect(err.join("\n")).toContain('schtasks /Create /SC MINUTE /MO 2 /TN "RootClaw Sentinel" /TR "\\"/usr/bin/node\\" \\"/usr/lib/node_modules/rootclaw/cli.js\\" \\"sentinel\\"');
    expect(err.join("\n")).toContain("\\\"--out\\\" \\\"C:\\Users\\rootclaw\\AppData\\Local\\rootclaw-sentinel\\\"");
  });

  // Simulates a Linux install with the host's paths; on Windows those are backslash paths no Linux unit has.
  it.skipIf(process.platform === "win32")("--sentinel refuses an output folder the scan itself would refuse, before writing anything", () => {
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);
    const base = { action: "install" as const, dataDir, port: 8799, sentinel: true, script: "/usr/lib/node_modules/rootclaw/cli.js", node: "/usr/bin/node", exists: () => false };
    // XDG_STATE_HOME pointing into the data dir makes the default land there
    expect(runServiceCommand({ ...base, platform: "linux", home: join(dir, "home"), env: { XDG_STATE_HOME: join(dataDir, "state") } }, io)).toBe(1);
    expect(err.join("\n")).toContain("refusing to write issues inside the data dir");
    expect(existsSync(join(dataDir, "state"))).toBe(false);
    // a path no unit file can hold
    err.length = 0;
    expect(runServiceCommand({ ...base, platform: "linux", home: join(dir, "home"), sentinelOut: join(dir, "out"), dataDir: `${dataDir}\nExecStartPre=/bin/true` }, io)).toBe(1);
    expect(err.join("\n")).toContain("line break or NUL");
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("--sentinel prefers the installed app's own CLI over a checkout, which an update or Node upgrade would strand", () => {
    const sentinelOut = join(dir, "sentinel-state");
    const app = "/Applications/RootClaw.app/Contents";
    const checkout = { action: "install" as const, dataDir: join(dir, "data"), port: 8799, sentinel: true, sentinelOut, script: "/src/RootClaw/server/rootclaw.ts", node: "/home/rootclaw/.nvm/versions/node/v24.0.0/bin/node", platform: "darwin" as const, home: "/Users/rootclaw" };
    expect(runServiceCommand({ ...checkout, exists: (path) => path.startsWith(app), hasSentinel: () => true }, io)).toBe(0);
    const plist = readFileSync(join(sentinelOut, "com.rootclaw.sentinel.plist"), "utf8");
    expect(plist).toContain(`<string>${app}/MacOS/RootClaw</string>`);
    expect(plist).toContain(`<string>${app}/Resources/server/rootclaw.js</string>`);
    expect(plist).toContain("<key>ELECTRON_RUN_AS_NODE</key>");
    expect(plist).not.toContain("rootclaw.ts");
    expect(out.join("\n")).toContain("runs the desktop app's own CLI");

    // an installed app from before Sentinel, or none: the checkout it was run
    // from, with a warning that it can move
    out.length = 0;
    expect(runServiceCommand({ ...checkout, exists: (path) => path.startsWith(app), hasSentinel: () => false }, io)).toBe(0);
    expect(readFileSync(join(sentinelOut, "com.rootclaw.sentinel.plist"), "utf8")).not.toContain("ELECTRON_RUN_AS_NODE");
    out.length = 0;
    expect(runServiceCommand({ ...checkout, exists: () => false }, io)).toBe(0);
    expect(readFileSync(join(sentinelOut, "com.rootclaw.sentinel.plist"), "utf8")).toContain("<string>--experimental-strip-types</string>");
    expect(out.join("\n")).toContain("if either moves (a new checkout, a Node upgrade), run this again");
  });
});
