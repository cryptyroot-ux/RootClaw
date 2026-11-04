import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createNetworkProvider, executeNetworkTool, networkToolCommandScope } from "./network-tools.ts";
import { createProcessProvider, executeProcessTool, processToolCommandScope } from "./process-tools.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temporaryCommands() {
  const root = mkdtempSync(join(tmpdir(), "rootclaw-native-diagnostics-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const marker = join(root, "executed-marker");
  const argumentsFile = join(root, "arguments.ndjson");
  const grepArgumentsFile = join(root, "grep-arguments.ndjson");
  const commandsFile = join(root, "commands.ndjson");
  const previousPath = process.env.PATH;
  const previousArgumentsFile = process.env.NATIVE_DIAGNOSTIC_ARGS;
  const previousGrepArgumentsFile = process.env.NATIVE_DIAGNOSTIC_GREP_ARGS;
  const previousCommandsFile = process.env.NATIVE_DIAGNOSTIC_COMMANDS;
  process.env.PATH = [bin, previousPath].filter(Boolean).join(delimiter);
  process.env.NATIVE_DIAGNOSTIC_ARGS = argumentsFile;
  process.env.NATIVE_DIAGNOSTIC_GREP_ARGS = grepArgumentsFile;
  process.env.NATIVE_DIAGNOSTIC_COMMANDS = commandsFile;
  cleanups.push(() => {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousArgumentsFile === undefined) delete process.env.NATIVE_DIAGNOSTIC_ARGS; else process.env.NATIVE_DIAGNOSTIC_ARGS = previousArgumentsFile;
    if (previousGrepArgumentsFile === undefined) delete process.env.NATIVE_DIAGNOSTIC_GREP_ARGS; else process.env.NATIVE_DIAGNOSTIC_GREP_ARGS = previousGrepArgumentsFile;
    if (previousCommandsFile === undefined) delete process.env.NATIVE_DIAGNOSTIC_COMMANDS; else process.env.NATIVE_DIAGNOSTIC_COMMANDS = previousCommandsFile;
  });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, bin, marker, argumentsFile, grepArgumentsFile, commandsFile };
}

function executable(bin: string, name: string, body: string): void {
  writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

function captured(path: string): Array<{ program: string; args: string[] }> {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { program: string; args: string[] });
}

async function withPlatform<T>(platform: NodeJS.Platform, action: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try { return await action(); }
  finally { Object.defineProperty(process, "platform", descriptor); }
}

function hostileValue(marker: string): string {
  return `host with spaces 'single' "double" $(touch ${marker}) \`touch ${marker}\`; touch ${marker} | cat`;
}

function recordArguments(program: string): string {
  return `import { appendFileSync } from "node:fs";
appendFileSync(process.env.NATIVE_DIAGNOSTIC_ARGS, JSON.stringify({ program: ${JSON.stringify(program)}, args: process.argv.slice(2) }) + "\\n");`;
}

function psOutput(filter: string): string {
  const output = `USER PID COMMAND\nroot 42 ${filter} worker\nroot 43 unrelated\n`;
  return `process.stdout.write(${JSON.stringify(output)});`;
}

describe("native diagnostic argument handling", () => {
  it.skipIf(process.platform === "win32")("runs host diagnostics without a shell and filters process output in-process", async () => {
    const f = temporaryCommands();
    // An absolute Node shebang keeps the fake executable independent of command parsing.
    executable(f.bin, "nslookup", `${recordArguments("nslookup")}\nprocess.stdout.write("dns result\\n");`);
    const filter = hostileValue(f.marker);
    executable(f.bin, "ps", `${recordArguments("ps")}\n${psOutput(filter)}`);

    const network = await executeNetworkTool({ action: "dns", target: filter, timeout_ms: 5_000 }, undefined, f.root, new AbortController().signal);
    const processes = await executeProcessTool({ action: "list", filter, timeout_ms: 5_000 }, undefined, f.root, new AbortController().signal);

    expect(existsSync(f.marker)).toBe(false);
    expect(network.text).toContain("dns result");
    expect(processes.text).toContain(filter);
    expect(processes.text).not.toContain("unrelated");
    expect(captured(f.argumentsFile)).toEqual([
      { program: "nslookup", args: [filter] },
      { program: "ps", args: ["aux"] },
    ]);
  });

  it.skipIf(process.platform === "win32")("uses Windows-native argv and approval scopes for host diagnostics", async () => {
    const f = temporaryCommands();
    executable(f.bin, "ping", `${recordArguments("ping")}\nprocess.stdout.write("ping result\\n");`);
    executable(f.bin, "tasklist", `${recordArguments("tasklist")}\nprocess.stdout.write('"editor.exe","42"\\n"other.exe","43"\\n');`);
    executable(f.bin, "taskkill", recordArguments("taskkill"));
    executable(f.bin, "ps", recordArguments("ps"));
    executable(f.bin, "kill", recordArguments("kill"));

    const networkProvider = createNetworkProvider(undefined, f.root);
    const processProvider = createProcessProvider(undefined, f.root);
    const result = await withPlatform("win32", async () => {
      const pingScope = networkProvider.commandScope("network_tool", { action: "ping", target: "192.0.2.1", count: 2 });
      const listScope = processProvider.commandScope("process_tool", { action: "list", filter: "editor" });
      const killScope = processProvider.commandScope("process_tool", { action: "kill", pid: 42 });
      const network = await executeNetworkTool({ action: "ping", target: "192.0.2.1", count: 2 }, undefined, f.root, new AbortController().signal);
      const processes = await executeProcessTool({ action: "list", filter: "editor" }, undefined, f.root, new AbortController().signal);
      const killed = await executeProcessTool({ action: "kill", pid: 42 }, undefined, f.root, new AbortController().signal);
      return { pingScope, listScope, killScope, network, processes, killed };
    });

    expect(result.pingScope).toEqual({ command: "ping -n 2 -w 5000 192.0.2.1", cwd: f.root });
    expect(result.listScope).toEqual({ command: "tasklist /FO CSV /NH", cwd: f.root });
    expect(result.killScope).toEqual({ command: "taskkill /PID 42 /T", cwd: f.root });
    expect(result.network.text).toContain("ping result");
    expect(result.processes.text).toContain("editor.exe");
    expect(result.processes.text).not.toContain("other.exe");
    expect(result.killed.ok).toBe(true);
    expect(captured(f.argumentsFile)).toEqual([
      { program: "ping", args: ["-n", "2", "-w", "5000", "192.0.2.1"] },
      { program: "tasklist", args: ["/FO", "CSV", "/NH"] },
      { program: "taskkill", args: ["/PID", "42", "/T"] },
    ]);
  });

  it("selects Windows-native command scopes for host providers", async () => {
    const networkProvider = createNetworkProvider(undefined, "C:\\RootClaw");
    const processProvider = createProcessProvider(undefined, "C:\\RootClaw");
    const scopes = await withPlatform("win32", async () => ({
      ping: networkProvider.commandScope("network_tool", { action: "ping", target: "192.0.2.1", count: 2 }),
      list: processProvider.commandScope("process_tool", { action: "list", filter: "editor" }),
      kill: processProvider.commandScope("process_tool", { action: "kill", pid: 42 }),
    }));

    expect(scopes).toEqual({
      ping: { command: "ping -n 2 -w 5000 192.0.2.1", cwd: "C:\\RootClaw" },
      list: { command: "tasklist /FO CSV /NH", cwd: "C:\\RootClaw" },
      kill: { command: "taskkill /PID 42 /T", cwd: "C:\\RootClaw" },
    });
  });

  it.skipIf(process.platform === "win32")("quotes command-string backend arguments before Bash interprets them", async () => {
    const f = temporaryCommands();
    executable(f.bin, "curl", `${recordArguments("curl")}\nprocess.stdout.write("curl result\\n");`);
    const filter = hostileValue(f.marker);
    executable(f.bin, "ps", `${recordArguments("ps")}\n${psOutput(filter)}`);
    executable(f.bin, "grep", `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
appendFileSync(process.env.NATIVE_DIAGNOSTIC_GREP_ARGS, JSON.stringify(args) + "\\n");
const invert = args.includes("-v");
const pattern = args.at(-1) ?? "";
const lines = [];
for await (const line of createInterface({ input: process.stdin })) lines.push(line);
const matched = lines.filter((line) => line.toLowerCase().includes(pattern.toLowerCase()));
const output = invert ? lines.filter((line) => !line.toLowerCase().includes(pattern.toLowerCase())) : matched;
if (output.length) process.stdout.write(output.join("\\n") + "\\n");
process.exitCode = output.length ? 0 : 1;`);
    executable(f.bin, "container", `import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const command = process.argv.at(-1);
appendFileSync(process.env.NATIVE_DIAGNOSTIC_COMMANDS, JSON.stringify(command) + "\\n");
const result = spawnSync("/bin/bash", ["-c", command], { encoding: "utf8", env: process.env });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);`);
    const computer = { kind: "local-vm" as const, containerName: "fixture", runtime: "container" as const };

    const network = await executeNetworkTool({ action: "curl", target: filter, timeout_ms: 5_000 }, computer, undefined, new AbortController().signal);
    const processes = await executeProcessTool({ action: "list", filter, timeout_ms: 5_000 }, computer, undefined, new AbortController().signal);

    expect(existsSync(f.marker)).toBe(false);
    expect(network.text).toContain("curl result");
    expect(processes.text).toContain(filter);
    expect(captured(f.argumentsFile)).toEqual([
      { program: "curl", args: ["-sS", "-L", "--max-time", "30", filter] },
      { program: "ps", args: ["aux"] },
    ]);
    const grepArguments = readFileSync(f.grepArgumentsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(grepArguments).toContainEqual(["-F", "-i", "--", filter]);
    const commands = readFileSync(f.commandsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string);
    expect(commands).toEqual([
      networkToolCommandScope({ action: "curl", target: filter })?.command,
      processToolCommandScope({ action: "list", filter })?.command,
    ]);
  });

  it("rejects invalid arguments before invoking host executables", async () => {
    const f = temporaryCommands();
    executable(f.bin, "nslookup", recordArguments("nslookup"));
    executable(f.bin, "kill", recordArguments("kill"));
    const signal = new AbortController().signal;

    await expect(executeNetworkTool({ action: "dns", target: "   " }, undefined, f.root, signal))
      .rejects.toThrow(/non-empty "target"/);
    await expect(executeProcessTool({ action: "kill", pid: 0 }, undefined, f.root, signal))
      .rejects.toThrow(/positive integer "pid"/);

    expect(existsSync(f.argumentsFile)).toBe(false);
  });

  it("returns direct unavailable-backend errors without launching host executables", async () => {
    const f = temporaryCommands();
    executable(f.bin, "nslookup", recordArguments("nslookup"));
    executable(f.bin, "ps", recordArguments("ps"));
    const signal = new AbortController().signal;

    const network = await executeNetworkTool({ action: "dns", target: "localhost" }, undefined, undefined, signal);
    const processes = await executeProcessTool({ action: "list" }, undefined, undefined, signal);

    expect(network.ok).toBe(false);
    expect(network.text).toContain("No backend available");
    expect(processes.ok).toBe(false);
    expect(processes.text).toContain("No backend available");
    expect(existsSync(f.argumentsFile)).toBe(false);
  });
});
