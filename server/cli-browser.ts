import type { CliIo, CliOptions } from "./cli.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const consoleIo = (): CliIo => ({
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  ask: async () => "",
});

export async function runBrowser(options: CliOptions, io: CliIo = consoleIo()): Promise<number> {
  const { browserEngineStatus, describeBrowserEngine, ensureChrome, installAgentBrowserBinary, resolveAgentBrowserBinary } = await import("./browser-engine.ts");
  const status = browserEngineStatus({ dataDir: options.dataDir });
  if (options.browserAction === "status") {
    io.log(describeBrowserEngine(status, status.kind === "ready" ? new (await import("./browser/chrome/launcher.ts")).ChromeLauncher({ dataDir: options.dataDir }).describe() : undefined));
    if (status.kind !== "ready" && status.installable) io.log("install it with:  rootclaw browser install");
    return status.kind === "ready" ? 0 : 1;
  }
  let binary = resolveAgentBrowserBinary({ dataDir: options.dataDir });
  if (binary) {
    io.log(`agent-browser is already here: ${binary}`);
  } else {
    if (status.kind !== "ready" && !status.installable) {
      io.error(status.reason);
      return 1;
    }
    try {
      binary = await installAgentBrowserBinary({ dataDir: options.dataDir, log: io.log });
    } catch (error) {
      io.error(`could not install agent-browser: ${message(error)}`);
      return 1;
    }
    io.log(`installed ${binary}`);
  }
  try {
    await ensureChrome(binary, { withDeps: options.withDeps === true, log: io.log });
  } catch (error) {
    io.error(`Chrome is not ready: ${message(error)}`);
    if (process.platform === "linux" && !options.withDeps) io.error("on Linux, install Chrome's system libraries with `sudo rootclaw browser install --with-deps`, then retry `rootclaw browser install` as the user running serve");
    return 1;
  }
  io.log("browser installed for this user and data directory; run serve as the same user, then enable it under Settings → Computers and per bot");
  if (process.platform === "linux" && options.withDeps) io.log("if serve runs as another user, run `rootclaw browser install` from that user's login shell too");
  return 0;
}
