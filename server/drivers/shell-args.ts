/** Quote one argument for a POSIX shell command string. */
export function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Render an executable and argv as a shell command without interpreting any argument content. */
export function commandForPosixShell(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quotePosixShellArg).join(" ");
}
