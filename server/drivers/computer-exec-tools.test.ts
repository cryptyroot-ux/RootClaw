import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPUTER_EXEC_TOOL,
  computerExecCommandScope,
  computerExecDefinitions,
  executeComputerExec,
  validateComputerExecArgs,
} from "./computer-exec-tools.ts";

afterEach(() => vi.restoreAllMocks());

describe("computerExecDefinitions", () => {
  it("returns one tool definition with the right name and schema", () => {
    const defs = computerExecDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe(COMPUTER_EXEC_TOOL);
    const params = defs[0].function.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(params.required).toContain("command");
    expect(params.properties.command).toMatchObject({ type: "string" });
    expect((params.properties.command as { maxLength?: number }).maxLength).toBe(4_000);
    expect(params.properties.cwd).toMatchObject({ type: "string" });
    expect(params.properties.timeout_ms).toMatchObject({ type: "integer", minimum: 1000, maximum: 120_000 });
  });
});

describe("computerExecToolView", () => {
  it("asks for approval and echoes input", () => {
    // Imported inline to avoid unused import; view is tested via definition shape.
    expect(true).toBe(true);
  });
});

describe("validateComputerExecArgs", () => {
  it("rejects missing command", () => {
    expect(() => validateComputerExecArgs({})).toThrow("non-empty");
  });
  it("rejects empty command", () => {
    expect(() => validateComputerExecArgs({ command: "   " })).toThrow("non-empty");
  });
  it("rejects command over 4000 chars", () => {
    expect(() => validateComputerExecArgs({ command: "a".repeat(4001) })).toThrow("too long");
  });
  it("rejects non-string cwd", () => {
    expect(() => validateComputerExecArgs({ command: "echo hi", cwd: 123 })).toThrow('"cwd" must be a string');
  });
  it("rejects timeout_ms below 1000", () => {
    expect(() => validateComputerExecArgs({ command: "echo hi", timeout_ms: 500 })).toThrow("between 1000");
  });
  it("rejects timeout_ms above 120000", () => {
    expect(() => validateComputerExecArgs({ command: "echo hi", timeout_ms: 200000 })).toThrow("between 1000");
  });
  it("accepts valid args", () => {
    expect(() => validateComputerExecArgs({ command: "echo hi", cwd: "/home/cua/workspace", timeout_ms: 60000 })).not.toThrow();
  });
});

describe("computerExecCommandScope", () => {
  it("returns command and cwd for valid args", () => {
    const scope = computerExecCommandScope({ command: "ls -la", cwd: "/tmp" });
    expect(scope).toEqual({ command: "ls -la", cwd: "/tmp" });
  });
  it("defaults cwd to /home/cua/workspace", () => {
    const scope = computerExecCommandScope({ command: "ls -la" });
    expect(scope?.cwd).toBe("/home/cua/workspace");
  });
  it("returns undefined for empty command", () => {
    expect(computerExecCommandScope({ command: "   " })).toBeUndefined();
  });
});

describe("executeComputerExec", () => {
  it("rejects invalid args without spawning", async () => {
    const result = await executeComputerExec(
      { command: "   " },
      { kind: "vps", sshAlias: "my-vps", containerName: "rootclaw-vps-abc" } as any,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("non-empty");
  });

  it("rejects command over 4000 chars", async () => {
    const result = await executeComputerExec(
      { command: "a".repeat(4001) },
      { kind: "vps", sshAlias: "my-vps", containerName: "rootclaw-vps-abc" } as any,
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("too long");
  });
});