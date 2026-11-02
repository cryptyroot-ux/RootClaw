// Direct terminal execution inside the bot's Cua container (VPS or Local VM).
// Runs `docker exec -u cua ... /bin/bash -lc '<command>'` and returns exit code,
// stdout and stderr as text. Replaces slow terminal-typing + screenshot-reading.
// VPS: `docker -H ssh://<alias> exec ...`; Local VM: `<runtime> exec ...`.
// Output is capped at 64 KiB per stream (128 KiB total); default timeout 60s, max 120s.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { DATA_DIR } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { prepareVpsSsh } from "../vps-ssh.ts";
import { vpsDockerArgs } from "../vps-computer.ts";
import { DISPLAY } from "../container-computer.ts";
import type { ChatToolCallView, ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";

export const COMPUTER_EXEC_TOOL = "computer_exec";
const DEFAULT_CWD = "/home/cua/workspace";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_COMMAND_CHARS = 4_000;
const STREAM_CAP_BYTES = 64 * 1024;
const TOTAL_CAP_BYTES = 128 * 1024;
const TRUNCATED = "[output truncated]";

const str = (description: string) => ({ type: "string", description });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });

export const computerExecDefinitions = (): ChatToolDefinition[] => [
  {
    type: "function",
    function: {
      name: COMPUTER_EXEC_TOOL,
      description:
        "Run a shell command inside the bot's Cua container (VPS or Local VM) as the desktop user, starting in " +
        `${DEFAULT_CWD}, and return the exit code, stdout and stderr as text. Use this for all command-line work: ` +
        "pip install, running scripts, generating or converting files, checking that a file exists. Do not type commands " +
        "into a terminal window and read screenshots: that is slow and unreliable. GUI programs you start appear on the " +
        "desktop. Only available while you have a VPS or Local VM desktop.",
      parameters: {
        type: "object",
        properties: {
          command: { ...str("The shell command to run, for example: pip install --user requests && python3 make_report.py"), maxLength: MAX_COMMAND_CHARS },
          cwd: str(`Folder to run in (default: ${DEFAULT_CWD}).`),
          timeout_ms: int("Kill the command after this many milliseconds (default 60000, max 120000).", {
            minimum: 1000,
            maximum: MAX_TIMEOUT_MS,
          }),
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

export function computerExecToolView(_name: string, args: Record<string, unknown>): ChatToolCallView {
  return { title: COMPUTER_EXEC_TOOL, input: args, ask: true };
}

export function computerExecCommandScope(args: Record<string, unknown>): { command: string; cwd: string } | undefined {
  if (typeof args.command !== "string" || !args.command.trim()) return undefined;
  return { command: args.command, cwd: typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : DEFAULT_CWD };
}

export function validateComputerExecArgs(args: Record<string, unknown>): void {
  if (typeof args.command !== "string" || !args.command.trim()) {
    throw new Error("computer_exec needs a non-empty \"command\".");
  }
  if (args.command.length > MAX_COMMAND_CHARS) {
    throw new Error(`computer_exec command is too long (${args.command.length} chars, max ${MAX_COMMAND_CHARS}).`);
  }
  if (args.cwd !== undefined && typeof args.cwd !== "string") {
    throw new Error("computer_exec \"cwd\" must be a string.");
  }
  if (args.timeout_ms !== undefined) {
    const ms = Number(args.timeout_ms);
    if (!Number.isFinite(ms) || ms < 1000 || ms > MAX_TIMEOUT_MS) {
      throw new Error(`computer_exec "timeout_ms" must be between 1000 and ${MAX_TIMEOUT_MS}.`);
    }
  }
}

type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

function captureStream(
  stream: NodeJS.ReadableStream,
  cap: number,
): Promise<{ text: string; dropped: number }> {
  return new Promise((resolve) => {
    let text = "";
    let dropped = 0;
    stream.on("data", (chunk: Buffer) => {
      if (text.length >= cap) { dropped += chunk.length; return; }
      const room = cap - text.length;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      text += part.toString("utf8");
      dropped += chunk.length - part.length;
    });
    stream.on("end", () => resolve({ text, dropped }));
  });
}

function runExec(
  cmd: string,
  spawnArgs: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  nodeTimeoutMs: number,
  signal: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, spawnArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killed = false;

    const stop = () => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };

    const timer = setTimeout(() => stop(), nodeTimeoutMs);
    timer.unref?.();

    const onAbort = () => stop();
    if (signal.aborted) { onAbort(); }
    else { signal.addEventListener("abort", onAbort, { once: true }); }

    const stdoutPromise = captureStream(child.stdout!, STREAM_CAP_BYTES);
    const stderrPromise = captureStream(child.stderr!, STREAM_CAP_BYTES);

    child.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ code: null, stdout: "", stderr: `failed to start: ${error.message}`, timedOut: false });
    });

    child.once("close", async (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const { text: stdout, dropped: stdoutDropped } = await stdoutPromise;
      const { text: stderr, dropped: stderrDropped } = await stderrPromise;

      let out = stdout;
      let err = stderr;
      if (stdoutDropped) out += `\n${TRUNCATED} (${stdoutDropped} more bytes of stdout not captured)`;
      if (stderrDropped) err += `\n${TRUNCATED} (${stderrDropped} more bytes of stderr not captured)`;

      // Enforce total cap.
      const total = Buffer.byteLength(out) + Buffer.byteLength(err);
      if (total > TOTAL_CAP_BYTES) {
        const over = total - TOTAL_CAP_BYTES;
        if (err.length > over) {
          err = err.slice(0, err.length - over) + `\n${TRUNCATED}`;
        } else if (out.length > over) {
          out = out.slice(0, out.length - over) + `\n${TRUNCATED}`;
        }
      }

      resolve({ code: code ?? null, stdout: out, stderr: err, timedOut: killed });
    });
  });
}

/** Build the docker/podman exec argv for VPS or Local VM. */
function buildExecArgs(
  connection: { kind: "vps" | "local-vm"; sshAlias?: string; containerName: string; runtime?: "docker" | "podman" | "container" },
  command: string,
  cwd: string,
  timeoutSecs: number,
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const execArgs = [
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    `DISPLAY=${DISPLAY}`,
    "-w",
    cwd,
    connection.containerName,
    "/usr/bin/timeout",
    "-k",
    "2s",
    String(timeoutSecs),
    "/bin/bash",
    "-lc",
    command,
  ];

  // Ensure /usr/bin and /usr/local/bin are on PATH so `docker` (and `podman`) are found
  // even when augmentedPath() doesn't carry them in a sealed/service environment.
  const basePaths = ["/usr/bin", "/usr/local/bin", "/bin"];
  const augmented = augmentedPath();
  const envPaths = basePaths.filter((p) => !augmented.includes(p)).concat(augmented).join(":");

  if (connection.kind === "vps") {
    if (!connection.sshAlias) throw new Error("computer_exec VPS requires an sshAlias.");
    const ssh = prepareVpsSsh(DATA_DIR, augmentedPath());
    return {
      cmd: "docker",
      args: vpsDockerArgs(connection.sshAlias, ["exec", ...execArgs]),
      env: { ...process.env, PATH: envPaths, ...(ssh.path ? { PATH: ssh.path + ":" + envPaths } : {}) },
    };
  }

  const runtime = connection.runtime ?? "docker";
  return { cmd: runtime, args: ["exec", ...execArgs], env: { ...process.env, PATH: envPaths } };
}

export async function executeComputerExec(
  args: Record<string, unknown>,
  connection: { kind: "vps" | "local-vm"; sshAlias?: string; containerName: string; runtime?: "docker" | "podman" | "container" },
  signal: AbortSignal,
): Promise<ChatToolResult> {
  try {
    validateComputerExecArgs(args);
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
  const command = String(args.command);
  const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : DEFAULT_CWD;
  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
  // Node-side safety net slightly above the requested timeout.
  const nodeTimeoutMs = Math.min(MAX_TIMEOUT_MS + 5_000, timeoutMs + 5_000);
  const timeoutSecs = Math.max(1, Math.min(120, Math.round(timeoutMs / 1000)));

  const { cmd, args: spawnArgs, env } = buildExecArgs(connection, command, cwd, timeoutSecs);
  // `cwd` is the folder inside the container (passed via `docker exec -w`); the host-side
  // spawn cwd must be a folder that exists on this machine.
  const hostCwd = existsSync(cwd) ? cwd : "/tmp";

  let result: ExecResult;
  try {
    result = await runExec(cmd, spawnArgs, env, hostCwd, nodeTimeoutMs, signal);
  } catch (error) {
    return { ok: false, text: `computer_exec failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const lines: string[] = [];
  const exitCode = result.code ?? null;
  lines.push(exitCode === null ? "exit code (unknown)" : `exit code ${exitCode}`);
  if (result.timedOut) lines.push("The command was stopped: it ran past its time limit.");
  if (result.stdout) lines.push("--- stdout ---", result.stdout.replace(/\s+$/, ""));
  if (result.stderr) lines.push("--- stderr ---", result.stderr.replace(/\s+$/, ""));
  if (!result.stdout && !result.stderr && exitCode !== null) lines.push("(no output)");

  const text = lines.join("\n");
  const ok = exitCode === 0 && !result.timedOut;
  return { ok, text };
}
