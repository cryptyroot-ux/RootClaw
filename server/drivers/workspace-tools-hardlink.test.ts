import { afterEach, describe, expect, it } from "vitest";
import { linkSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeWorkspaceTool } from "./workspace-tools.ts";

const signal = () => new AbortController().signal;
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const run = (name: string, args: Record<string, unknown>, root: string) =>
  executeWorkspaceTool(name, args, { root }, signal()).catch((error: Error) => ({ ok: false, text: error.message }));

function hardlinkedSecret() {
  const root = temp("ws-"), outside = temp("out-");
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
  linkSync(join(outside, "secret.txt"), join(root, "hl.txt"));
  writeFileSync(join(root, "own.txt"), "INSIDE-OUTSIDE-SECRET-NAME\n");
  return { root, outside };
}

describe("hardlinks out of the workspace (audit N01d)", () => {
  afterEach(() => { delete process.env.ROOTCLAW_NO_RG; });

  it("read_file refuses a hardlinked file", async () => {
    const { root } = hardlinkedSecret();
    const result = await run("read_file", { path: "hl.txt" }, root);
    expect(result.ok).toBe(false);
    expect(result.text).not.toContain("OUTSIDE-SECRET");
    expect(result.text).toMatch(/hard link/);
  });

  for (const engine of ["ripgrep", "builtin"] as const) {
    it(`grep (${engine}) skips a hardlinked file and still searches the rest`, async () => {
      if (engine === "builtin") process.env.ROOTCLAW_NO_RG = "1";
      const { root } = hardlinkedSecret();
      const all = await run("grep", { pattern: "OUTSIDE-SECRET", path: "." }, root);
      expect(all.text).not.toMatch(/^hl\.txt:/m);
      expect(all.text).toContain("own.txt:1:");
      const direct = await run("grep", { pattern: "OUTSIDE", path: "hl.txt" }, root);
      expect(direct.text).not.toContain("OUTSIDE-SECRET");
    });
  }

  it("edit_file and apply_patch cannot read the outside file through the link, and leave it untouched", async () => {
    const { root, outside } = hardlinkedSecret();
    const edit = await run("edit_file", { path: "hl.txt", old_string: "OUTSIDE-SECRET", new_string: "X" }, root);
    expect(edit.ok).toBe(false);
    expect(edit.text).not.toContain("OUTSIDE-SECRET");
    const patch = await run("apply_patch", { patch: "--- a/hl.txt\n+++ b/hl.txt\n@@ -1 +1 @@\n-OUTSIDE-SECRET\n+X\n" }, root);
    expect(patch.ok).toBe(false);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("OUTSIDE-SECRET\n");
  });

  it("write_file replaces the link in the workspace instead of writing through it", async () => {
    const { root, outside } = hardlinkedSecret();
    const result = await run("write_file", { path: "hl.txt", content: "PWNED\n" }, root);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("OUTSIDE-SECRET\n");
    expect(readFileSync(join(root, "hl.txt"), "utf8")).toBe("PWNED\n");
  });

  it("still reads an ordinary file", async () => {
    const { root } = hardlinkedSecret();
    expect((await run("read_file", { path: "own.txt" }, root)).text).toContain("INSIDE-OUTSIDE-SECRET-NAME");
  });
});
