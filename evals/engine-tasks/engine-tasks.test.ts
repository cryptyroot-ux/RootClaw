import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_TASKS, type EngineTask } from "./tasks.ts";
import { installRequestBudget, redact, summarize, type RunRow } from "./run-engine-tasks.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function seed(task: EngineTask, overlay: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `engine-task-test-${task.id}-`));
  dirs.push(dir);
  for (const [name, text] of Object.entries({ ...task.files, ...overlay })) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
  return dir;
}

describe("engine eval tasks", () => {
  it("has five tasks with unique ids", () => {
    expect(ENGINE_TASKS.map((task) => task.id)).toEqual(["fix-function", "bug-from-log", "rename-symbol", "create-file", "csv-transform"]);
  });

  for (const task of ENGINE_TASKS) {
    it(`${task.id}: the checker rejects the seeded state and accepts the known fix`, () => {
      expect(task.check(seed(task)).pass).toBe(false);
      expect(task.check(seed(task, task.solution))).toEqual({ pass: true, why: "ok" });
    });
  }

  it("rejects a fix that edits the protected file", () => {
    const task = ENGINE_TASKS.find((entry) => entry.id === "fix-function")!;
    expect(task.check(seed(task, { "stats.test.mjs": 'console.log("stats ok")\n' })).pass).toBe(false);
  });

  it("summarizes paired runs", () => {
    const row = (mode: RunRow["mode"], pass: boolean, input: number): RunRow => ({ task: "t", mode, pass, why: "", rounds: 2, input, output: 0, ms: 1, stopReason: "end_turn", capped: false, tools: [] });
    expect(summarize([row("off", true, 100), row("plan+verify", false, 150)])).toContain("success OFF 1/1, ON 0/1; token ratio ON/OFF over 1 paired task(s): 1.50");
  });

  it("sends no request past the budget", async () => {
    const real = globalThis.fetch;
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const budget = installRequestBudget(1);
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
      expect((await fetch(url)).status).toBe(200);
      await expect(fetch(url)).rejects.toThrow("budget of 1");
      expect(budget).toMatchObject({ sent: 1, refused: 1 });
    } finally {
      globalThis.fetch = real;
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("keeps redacted request and response bodies for a failure log", async () => {
    const real = globalThis.fetch;
    const secret = "sk-test-secret-123456";
    const server = createServer((_request, response) => response.end(`echo ${secret}`));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const budget = installRequestBudget(2, undefined, [secret]);
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`;
      expect(await (await fetch(url, { method: "POST", body: `{"key":"${secret}"}` })).text()).toBe(`echo ${secret}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(budget.exchanges).toEqual([{ n: 1, url: "/v1/chat", status: 200, request: '{"key":"[redacted]"}', response: "echo [redacted]" }]);
      expect(JSON.stringify(budget.exchanges)).not.toContain(secret);
    } finally {
      globalThis.fetch = real;
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("redacts bearer tokens and bounds long bodies", () => {
    expect(redact("Authorization: Bearer abcdefgh12345", [])).toBe("Authorization: Bearer [redacted]");
    expect(redact("x".repeat(200_010), []).endsWith("…[10 more chars]")).toBe(true);
  });
});
