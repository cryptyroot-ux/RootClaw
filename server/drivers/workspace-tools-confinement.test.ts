import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkspaceTool, sandboxedShell } from "./workspace-tools.ts";

const signal = () => new AbortController().signal;
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

describe("file tools under a symlink swap (audit N01)", () => {
  const flippers: ReturnType<typeof spawn>[] = [];
  afterEach(() => { for (const child of flippers.splice(0)) child.kill("SIGKILL"); });
  const flip = (root: string, name: string, target: string) => {
    const child = spawn("bash", ["-c", `cd ${root}; while :; do echo inside > ${name}.n; mv -f ${name}.n ${name}; ln -sfn ${target} ${name}.l; mv -Tf ${name}.l ${name}; done`], { stdio: "ignore" });
    flippers.push(child);
  };

  it("read_file never returns a file outside the workspace", async () => {
    const root = temp("ws-"), outside = temp("out-");
    writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
    flip(root, "a", join(outside, "secret.txt"));
    for (const end = Date.now() + 2_500; Date.now() < end;) {
      const result = await executeWorkspaceTool("read_file", { path: "a" }, { root }, signal()).catch((error: Error) => ({ ok: false, text: error.message }));
      expect(result.text).not.toContain("OUTSIDE-SECRET");
    }
  });

  it("write_file never writes through a link to outside the workspace", async () => {
    const root = temp("ws-"), outside = temp("out-");
    writeFileSync(join(outside, "victim.txt"), "original\n");
    flip(root, "b", join(outside, "victim.txt"));
    for (const end = Date.now() + 2_500; Date.now() < end;) {
      await executeWorkspaceTool("write_file", { path: "b", content: "PWNED\n" }, { root }, signal()).catch(() => undefined);
      expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("original\n");
    }
  });

  it("still reads and writes through a link that stays inside the workspace", async () => {
    const root = temp("ws-");
    writeFileSync(join(root, "real.txt"), "one\n");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    expect((await executeWorkspaceTool("read_file", { path: "link.txt" }, { root }, signal())).text).toContain("one");
    await executeWorkspaceTool("write_file", { path: "link.txt", content: "two\n" }, { root }, signal());
    expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("two\n");
  });
});

describe("shell without an OS sandbox (audit N02)", () => {
  afterEach(() => { delete process.env.ROOTCLAW_SHELL_SANDBOX; });
  it("refuses to run in a confined workspace when no sandbox can start, unless turned off explicitly", async () => {
    const { execFileSync } = await import("node:child_process");
    const script = `const m = await import(${JSON.stringify(new URL("./workspace-tools.ts", import.meta.url).pathname)});
      const r = await m.executeWorkspaceTool("shell", { command: "/usr/bin/echo RAN" }, { root: ${JSON.stringify(temp("ws-"))} }, new AbortController().signal);
      console.log(JSON.stringify(r));`;
    const run = (extra: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      { env: { ...process.env, PATH: "/nonexistent", ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").at(-1)!);
    const refused = run({});
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/OS sandbox is required/);
    expect(refused.text).not.toContain("RAN");
    const optedOut = run({ ROOTCLAW_SHELL_SANDBOX: "off" });
    expect(optedOut.text).toContain("RAN");
    expect(optedOut.text).toContain("no OS sandbox");
  });
});

describe("bubblewrap mounts (audit N03)", () => {
  it("never mounts / or a top-level folder from PATH", () => {
    const args = sandboxedShell("true", "/tmp", ["/tmp"], "bwrap", { env: { HOME: "/home/u", PATH: "/usr/bin:/:/home:/srv:/home/u/bin" } }).args;
    const readOnly = args.flatMap((arg, i) => arg === "--ro-bind" ? [args[i + 1]] : []);
    expect(readOnly).not.toContain("/");
    expect(readOnly).not.toContain("/home");
    expect(readOnly).not.toContain("/srv");
  });
});
