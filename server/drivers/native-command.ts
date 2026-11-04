import { spawn } from "node:child_process";

export interface NativeCommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  startError?: string;
}

/** Run a host diagnostic executable directly with argv; never invoke a shell. */
export function runNativeCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<NativeCommandOutput> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], {
      cwd,
      env: { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let startError: string | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => child.kill("SIGTERM");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { startError = error.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, ...(startError ? { startError } : {}) });
    });
  });
}

export function formatNativeCommandResult(output: NativeCommandOutput, failurePrefix: string): { ok: boolean; text: string } {
  if (output.startError) return { ok: false, text: `${failurePrefix} failed: ${output.startError}` };
  const lines = [`exit code ${output.code ?? "unknown"}`];
  if (output.timedOut) lines.push("The command was stopped: it ran past its time limit.");
  if (output.stdout) lines.push("--- stdout ---", output.stdout.trimEnd());
  if (output.stderr) lines.push("--- stderr ---", output.stderr.trimEnd());
  if (!output.stdout && !output.stderr) lines.push("(no output)");
  return { ok: output.code === 0 && !output.timedOut, text: lines.join("\n") };
}
