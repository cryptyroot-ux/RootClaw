// Cut 03 AC-3: edits show what changed, so the model need not read the file back.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { executeWorkspaceTool, type WorkspaceToolsConfig } from "./workspace-tools.ts";

let root: string;
let config: WorkspaceToolsConfig;
const run = (name: string, args: Record<string, unknown>) => executeWorkspaceTool(name, args, config, new AbortController().signal);
const numbered = (count: number, label = "line") => Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n") + "\n";
const snippetLines = (text: string) => text.split("\n").filter((line) => /^\s*\d+\t/.test(line));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rootclaw-echo-"));
  config = { root };
});
afterEach(async () => { await removeTempDir(root); });

describe("edit_file echo", () => {
  it("keeps the old sentence and shows the new line with its number and 3 lines of context", async () => {
    writeFileSync(join(root, "a.txt"), numbered(20));
    const result = await run("edit_file", { path: "a.txt", old_string: "line 10\n", new_string: "changed ten\n" });
    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toBe("Edited a.txt: replaced 1 occurrence.");
    expect(result.text).toMatch(/^\s*10\tchanged ten$/m);
    expect(snippetLines(result.text).map((line) => Number(line.split("\t")[0]))).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(result.text).not.toContain("[…]");
  });

  it("shows every replaced occurrence with replace_all", async () => {
    writeFileSync(join(root, "a.txt"), `${numbered(30).replace("line 5\n", "x\n").replace("line 25\n", "x\n")}`);
    const result = await run("edit_file", { path: "a.txt", old_string: "x\n", new_string: "y\n", replace_all: true });
    expect(result.text.split("\n")[0]).toBe("Edited a.txt: replaced 2 occurrences.");
    expect(result.text).toMatch(/^\s*5\ty$/m);
    expect(result.text).toMatch(/^\s*25\ty$/m);
  });

  it("caps the snippet at 40 lines and 2 KB, marking the cut", async () => {
    writeFileSync(join(root, "big.txt"), numbered(10));
    const many = await run("edit_file", { path: "big.txt", old_string: "line 5\n", new_string: numbered(80, "new") });
    expect(snippetLines(many.text).length).toBeLessThanOrEqual(40);
    expect(many.text).toContain("[…]");
    writeFileSync(join(root, "wide.txt"), numbered(10));
    const wide = await run("edit_file", { path: "wide.txt", old_string: "line 5\n", new_string: `${"w".repeat(300)}\n`.repeat(20) });
    expect(Buffer.byteLength(wide.text.slice(wide.text.indexOf("\n") + 1))).toBeLessThanOrEqual(2048);
    expect(wide.text).toContain("[…]");
  });
});

describe("apply_patch echo", () => {
  it("shows a snippet per changed file", async () => {
    writeFileSync(join(root, "one.txt"), numbered(12));
    writeFileSync(join(root, "two.txt"), numbered(12));
    const patch = [
      "--- a/one.txt", "+++ b/one.txt", "@@ -4,3 +4,3 @@", " line 4", "-line 5", "+patched five", " line 6",
      "--- a/two.txt", "+++ b/two.txt", "@@ -8,3 +8,3 @@", " line 8", "-line 9", "+patched nine", " line 10",
      "",
    ].join("\n");
    const result = await run("apply_patch", { patch });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Patch applied:\n- one.txt (updated)\n- two.txt (updated)");
    expect(result.text).toMatch(/^\s*5\tpatched five$/m);
    expect(result.text).toMatch(/^\s*9\tpatched nine$/m);
    const one = result.text.indexOf("one.txt", result.text.indexOf("two.txt (updated)"));
    const two = result.text.indexOf("two.txt", one);
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
  });
});

describe("write_file echo", () => {
  it("shows the first 20 lines of a file of up to 200 lines", async () => {
    const result = await run("write_file", { path: "w.txt", content: numbered(150) });
    expect(result.text.split("\n")[0]).toBe("Created w.txt (1242 bytes, 151 lines).");
    expect(snippetLines(result.text).map((line) => Number(line.split("\t")[0]))).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(result.text).toMatch(/^\s*20\tline 20$/m);
    expect(result.text).toContain("[…]");
  });

  it("shows nothing more for a file over 200 lines", async () => {
    const result = await run("write_file", { path: "w.txt", content: numbered(300) });
    expect(snippetLines(result.text)).toEqual([]);
  });
});

describe("glob with no match", () => {
  it("names the pattern, says how to give alternatives, and lists the files that are there", async () => {
    writeFileSync(join(root, "count.js"), "x\n");
    writeFileSync(join(root, "words.txt"), "y\n");
    const result = await run("glob", { pattern: "**/*count*;**/*.test.js" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("No files match **/*count*;**/*.test.js. One pattern per call; give alternatives as {a,b}.");
    expect(result.text).toContain("Files here: count.js, words.txt");
  });

  it("caps the list of files that are there", async () => {
    for (let index = 0; index < 30; index++) writeFileSync(join(root, `f${String(index).padStart(2, "0")}.txt`), "x\n");
    const result = await run("glob", { pattern: "*.md" });
    expect(result.text.split("Files here: ")[1]!.split(", ")).toHaveLength(21);
    expect(result.text).toMatch(/, … \(30 files\)$/);
  });
});
