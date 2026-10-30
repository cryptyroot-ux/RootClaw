import { describe, expect, it } from "vitest";

import {
  checkSentinelInstall, launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer,
  sentinelUnitCommand, serviceCommand, servicePlan, shippedSentinelCli, systemdUnit, unstableInstallWarning, type ServiceSpec,
} from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/rootclaw/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/rootclaw/.rootclaw", "--domain", "rootclaw.example.com", "--no-pair"],
  dataDir: "/home/rootclaw/.rootclaw",
  user: "rootclaw",
  home: "/home/rootclaw",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/rootclaw/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/RootClaw/server/rootclaw.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=RootClaw (agentada)");
    expect(unit).toContain("User=rootclaw");
    expect(unit).toContain("Environment=ROOTCLAW_DATA_DIR=/home/rootclaw/.rootclaw");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/rootclaw/cli.js serve --port 8799 --data-dir /home/rootclaw/.rootclaw --domain rootclaw.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/rootclaw/.rootclaw"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    expect(systemdUnit({ ...spec, dataDir: "/home/rootclaw/My Data", serveArgs: ["--data-dir", "/home/rootclaw/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/rootclaw/cli.js serve --data-dir "/home/rootclaw/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/rootclaw", dataDir: "/Users/rootclaw/.rootclaw" });
    expect(plist).toContain("<string>com.rootclaw.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>rootclaw.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/rootclaw/.rootclaw/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/rootclaw/.npm/_npx/abc123/node_modules/rootclaw/cli.js")).toMatch(/npm install -g rootclaw/);
    expect(unstableInstallWarning("/usr/lib/node_modules/rootclaw/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/rootclaw/.rootclaw");
    expect(linux?.installed).toBe("/etc/systemd/system/rootclaw.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now rootclaw");
    const mac = servicePlan("darwin", "/Users/rootclaw/.rootclaw", "/Users/rootclaw");
    expect(mac?.installed).toBe("/Users/rootclaw/Library/LaunchAgents/com.rootclaw.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });

  it("renders Sentinel as a launchd agent on an interval, under its own label, logging outside the data dir", () => {
    const out = "/Users/rootclaw/Library/Application Support/rootclaw-sentinel";
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/rootclaw/cli.js", dataDir: "/Users/rootclaw/.rootclaw", home: "/Users/rootclaw", out };
    expect(sentinelCommand(sentinel)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/rootclaw/cli.js", "sentinel", "--once", "--data-dir", "/Users/rootclaw/.rootclaw", "--out", out]);
    expect(sentinelCommand({ ...sentinel, script: "/srv/RootClaw/server/rootclaw.ts" })[1]).toBe("--experimental-strip-types");
    const plist = sentinelLaunchdPlist(sentinel);
    expect(plist).toContain("<string>com.rootclaw.sentinel</string>");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>120</integer>");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<string>${out}/sentinel.log</string>`);
    expect(plist).not.toContain(".rootclaw/logs");
    const mac = sentinelServicePlan("darwin", out, "/Users/rootclaw");
    expect(mac?.files).toEqual([{ name: "com.rootclaw.sentinel.plist", installed: "/Users/rootclaw/Library/LaunchAgents/com.rootclaw.sentinel.plist" }]);
    // a path with a space is one argument in the printed commands
    expect(mac?.activate[0]).toBe("mkdir -p /Users/rootclaw/Library/LaunchAgents && cp '/Users/rootclaw/Library/Application Support/rootclaw-sentinel/com.rootclaw.sentinel.plist' /Users/rootclaw/Library/LaunchAgents/com.rootclaw.sentinel.plist");
    expect(mac?.deactivate[0]).toBe("launchctl bootout gui/$(id -u)/com.rootclaw.sentinel");
  });

  it("renders Sentinel as a systemd user timer, with no root", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/rootclaw/cli.js", dataDir: "/home/rootclaw/My Data", home: "/home/rootclaw", out: "/home/rootclaw/.local/state/rootclaw-sentinel" };
    const unit = sentinelSystemdService(sentinel);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/rootclaw/cli.js sentinel --once --data-dir "/home/rootclaw/My Data" --out /home/rootclaw/.local/state/rootclaw-sentinel');
    expect(unit).not.toContain("User=");
    expect(sentinelSystemdTimer()).toContain("OnUnitActiveSec=120s");
    expect(sentinelSystemdTimer()).toContain("WantedBy=timers.target");
    const linux = sentinelServicePlan("linux", sentinel.out, "/home/rootclaw");
    expect(linux?.files.map((file) => file.installed)).toEqual(["/home/rootclaw/.config/systemd/user/rootclaw-sentinel.service", "/home/rootclaw/.config/systemd/user/rootclaw-sentinel.timer"]);
    expect(linux?.activate[0]).toContain("cp /home/rootclaw/.local/state/rootclaw-sentinel/rootclaw-sentinel.service");
    expect(linux?.activate.join("\n")).toContain("systemctl --user enable --now rootclaw-sentinel.timer");
    expect(linux?.activate.join("\n")).not.toContain("sudo");
    expect(sentinelServicePlan("win32", "C:\\x")).toBeNull();
  });

  it("finds the CLI the installed desktop app ships, and runs it as Node", () => {
    const app = "/Applications/RootClaw.app/Contents";
    const present = new Set([`${app}/MacOS/RootClaw`, `${app}/Resources/server/rootclaw.js`]);
    expect(shippedSentinelCli("darwin", "/Users/rootclaw", (path) => present.has(path))).toEqual({ node: `${app}/MacOS/RootClaw`, script: `${app}/Resources/server/rootclaw.js` });
    const user = "/Users/rootclaw/Applications/RootClaw.app/Contents";
    expect(shippedSentinelCli("darwin", "/Users/rootclaw", (path) => path.startsWith(user))?.script).toBe(`${user}/Resources/server/rootclaw.js`);
    expect(shippedSentinelCli("linux", "/home/rootclaw", (path) => path.startsWith("/opt/RootClaw/"))).toEqual({ node: "/opt/RootClaw/rootclaw", script: "/opt/RootClaw/resources/server/rootclaw.js" });
    // an app with its script missing, or one released before Sentinel, is no CLI for it
    expect(shippedSentinelCli("darwin", "/Users/rootclaw", (path) => path.endsWith("MacOS/RootClaw"))).toBeNull();
    expect(shippedSentinelCli("darwin", "/Users/rootclaw", (path) => present.has(path), () => false)).toBeNull();
    expect(shippedSentinelCli("win32", "C:\\Users\\rootclaw", () => true)).toBeNull();

    const spec = { node: `${app}/MacOS/RootClaw`, script: `${app}/Resources/server/rootclaw.js`, dataDir: "/Users/rootclaw/.rootclaw", home: "/Users/rootclaw", out: "/tmp/s", electronRunAsNode: true };
    expect(sentinelLaunchdPlist(spec)).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>");
    expect(sentinelSystemdService(spec)).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(sentinelLaunchdPlist({ ...spec, electronRunAsNode: false })).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("keeps every path one quoted value in the systemd unit, and refuses one no unit can hold", () => {
    const spec = { node: "/usr/bin/node", script: "/srv/rootclaw/cli.js", dataDir: "/home/rootclaw/100% $HOME\\", home: "/home/my rootclaw", out: "/home/my rootclaw/.local/state/rootclaw-sentinel" };
    const unit = sentinelSystemdService(spec);
    expect(unit).toContain('Environment="HOME=/home/my rootclaw"');
    // % is no specifier, $ no variable, and the trailing backslash no continuation
    expect(unit).toContain('"/home/rootclaw/100%% $$HOME\\\\"');
    expect(sentinelUnitCommand(unit)).toEqual({ node: "/usr/bin/node", script: "/srv/rootclaw/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService({ ...spec, script: "/srv/100% $x/cli.js" }))?.script).toBe("/srv/100% $x/cli.js");
    for (const bad of ["/home/rootclaw\n[Service]\nExecStartPre=/bin/true", "/home/rootclaw\r", "/home/\0rootclaw"]) {
      expect(() => sentinelSystemdService({ ...spec, home: bad })).toThrow(/line break or NUL/);
      expect(() => sentinelLaunchdPlist({ ...spec, dataDir: bad })).toThrow(/line break or NUL/);
    }
  });

  it("reads back what an installed unit runs, and calls it stale when either path is gone", () => {
    const spec = { node: "/opt/node & co/bin/node", script: "/srv/rootclaw/cli.js", dataDir: "/home/rootclaw/My Data", home: "/home/rootclaw", out: "/home/rootclaw/.local/state/rootclaw-sentinel" };
    expect(sentinelUnitCommand(sentinelLaunchdPlist(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/rootclaw/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/rootclaw/cli.js" });
    expect(sentinelUnitCommand("[Service]\nType=oneshot\n")).toBeNull();

    const unit = "/home/rootclaw/.config/systemd/user/rootclaw-sentinel.service";
    const timer = "/home/rootclaw/.config/systemd/user/rootclaw-sentinel.timer";
    const files = new Map([[unit, sentinelSystemdService(spec)]]);
    const fs = (present: string[]) => ({ exists: (path: string) => files.has(path) || present.includes(path), read: (path: string) => files.get(path)! });
    expect(checkSentinelInstall("linux", "/home/rootclaw", fs([spec.node, spec.script, timer]))).toMatchObject({ status: "ok", unit });
    expect(checkSentinelInstall("linux", "/home/rootclaw", fs([spec.node, timer]))).toMatchObject({ status: "stale", missing: ["/srv/rootclaw/cli.js"] });
    // the service without its timer never runs
    expect(checkSentinelInstall("linux", "/home/rootclaw", fs([spec.node, spec.script]))).toMatchObject({ status: "stale", missing: [timer] });
    expect(checkSentinelInstall("darwin", "/Users/rootclaw", fs([]))).toEqual({ status: "not_installed", unit: "/Users/rootclaw/Library/LaunchAgents/com.rootclaw.sentinel.plist" });
    files.set(unit, "garbage");
    expect(checkSentinelInstall("linux", "/home/rootclaw", fs([]))).toEqual({ status: "unreadable", unit });
    expect(checkSentinelInstall("win32", "C:\\Users\\rootclaw", fs([]))).toEqual({ status: "unsupported" });
  });
});
