import { describe, expect, it } from "vitest";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import { deferTools, LOAD_TOOLS_TOOL, loadToolsResult, resetLoadedTools, toolSummary } from "./tool-loading.ts";

const def = (name: string, description = `${name} does a thing. More detail here.`): ChatToolDefinition =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties: {} } } });
const names = (defs: ChatToolDefinition[]) => defs.map((d) => d.function.name);

describe("lazy tool schemas", () => {
  it("holds RootClaw's own tools behind load_tools and keeps the rest", () => {
    resetLoadedTools();
    const defs = [def("shell"), def("agents_a"), def("agents_b"), def("data_data_sql"), def("agents_c"), def("github_issue")];
    const lazy = deferTools(defs, "t1")!;
    expect(names(defs)).toEqual(["shell", "github_issue", LOAD_TOOLS_TOOL]);
    expect(defs.at(-1)!.function.description).toContain("agents_a: agents_a does a thing.");
    expect(lazy.isDeferred("agents_b")).toBe(true);
  });

  it("loads by full or unprefixed name, reports unknown ones, and remembers per thread", () => {
    resetLoadedTools();
    const defs = [def("shell"), def("agents_a"), def("agents_b"), def("agents_coordinate_bots"), def("data_data_sql")];
    const lazy = deferTools(defs, "t2")!;
    const result = loadToolsResult({ names: ["coordinate_bots", "agents_a", "shell", "nope"] }, lazy);
    expect(result.text).toBe("Loaded agents_coordinate_bots, agents_a; call them now. Already available: shell. No such tool: nope.");
    expect(names(defs)).toEqual(["shell", "agents_coordinate_bots", "agents_a", LOAD_TOOLS_TOOL]);
    expect(defs.at(-1)!.function.description).not.toContain("agents_a:");
    // The next turn on the same thread starts with them loaded; too few left to be worth holding back.
    const next = [def("shell"), def("agents_a"), def("agents_b"), def("agents_coordinate_bots"), def("data_data_sql")];
    expect(deferTools(next, "t2")).toBeNull();
    expect(names(next)).toContain("agents_a");
    expect(loadToolsResult({}, lazy)).toMatchObject({ ok: false });
  });

  it("leaves small tool sets alone and summarizes in one short line", () => {
    resetLoadedTools();
    const defs = [def("shell"), def("agents_a")];
    expect(deferTools(defs, "t3")).toBeNull();
    expect(names(defs)).toEqual(["shell", "agents_a"]);
    expect(toolSummary("Read a file. Then more.")).toBe("Read a file.");
    expect(toolSummary("x".repeat(200)).length).toBeLessThanOrEqual(64);
  });
});
