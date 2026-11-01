import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_TASKS, type EngineTask } from "./tasks.ts";
import { installRequestBudget, isInfraError, orchestrationReport, redact, runOne, summarize, type RunRow } from "./run-engine-tasks.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function seed(task: EngineTask, overlay: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `engine-task-test-${task.id}-`));
  dirs.push(dir);
  for (const [name, text] of Object.entries({ ...task.files, ...overlay })) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
  return dir;
}

describe("engine eval tasks", () => {
  it("has the five basic and ten hard tasks, with unique ids", () => {
    expect(ENGINE_TASKS.filter((task) => (task.suite ?? "basic") === "basic").map((task) => task.id)).toEqual(["fix-function", "bug-from-log", "rename-symbol", "create-file", "csv-transform"]);
    expect(ENGINE_TASKS.filter((task) => task.suite === "hard").map((task) => task.id)).toEqual(["multi-refactor", "failing-test", "apply-diff",
      "long-context", "parallel-reads", "web-lookup", "skill-use", "async-bug", "cli-flag", "ini-to-json"]);
    expect(new Set(ENGINE_TASKS.map((task) => task.id)).size).toBe(ENGINE_TASKS.length);
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

  it("tells provider failures from task failures, and leaves infra runs out of the success rate", () => {
    expect(isInfraError("upstream HTTP 429: rate limited")).toBe(true);
    expect(isInfraError("Provider returned error (503)")).toBe(true);
    expect(isInfraError("One or more tool operations failed or were denied.")).toBe(false);
    const row = (pass: boolean, infra?: boolean): RunRow => ({ task: pass ? "a" : infra ? "b" : "c", mode: "off", pass, why: "", rounds: 1, input: 1, output: 1, ms: 1, stopReason: null, capped: false, tools: [], ...(infra ? { infra } : {}) });
    expect(summarize([row(true), row(false, true), row(false)])).toContain("success OFF 1/2");
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

  it("orchestration-report: records calls per round, requests by kind and total calls", async () => {
    const real = globalThis.fetch;
    const script = [["read_file", "list_dir"], ["glob"], []];
    let chats = 0;
    const server = createServer(async (request, response) => {
      if (request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
      if (request.url !== "/v1/chat/completions") { response.end("ok"); return; }
      for await (const _part of request) { /* drain */ }
      const names = script[chats++] ?? [];
      const delta = names.length
        ? { content: null, tool_calls: names.map((name, index) => ({ index, id: `c${chats}_${index}`, type: "function", function: { name, arguments: name === "glob" ? '{"pattern":"*"}' : name === "read_file" ? '{"path":"a.txt"}' : "{}" } })) }
        : { content: "Done." };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: names.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { OpenAICompatDriver } = await import("../../server/drivers/openai-compat.ts");
    const { setRunRecorder } = await import("../../server/drivers/openai-chat.ts");
    const { createRunStore } = await import("../../server/run-store.ts");
    const dataDir = mkdtempSync(join(tmpdir(), "engine-eval-runs-test-"));
    dirs.push(dataDir);
    const runs = createRunStore({ dataDir });
    setRunRecorder(runs);
    const task: EngineTask = { id: "orchestration-report", prompt: "look around", files: { "a.txt": "a\n" }, solution: {}, check: () => ({ pass: true, why: "ok" }) };
    try {
      const budget = installRequestBudget(10);
      const instance = await OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "eval", enabled: true,
        config: { url: `${origin}/v1`, apiKeyEnv: "FIXTURE_EVAL_KEY" }, environment: { FIXTURE_EVAL_KEY: "fixture-eval-credential-3c8f" } });
      await instance.refreshModels!();
      await fetch(`${origin}/health`);
      const row = await runOne(instance, runs, task, "off", "m", 12);
      await instance.dispose();
      expect(row.pass).toBe(true);
      expect(row.callsPerRound).toEqual([2, 1, 0]);
      const report = orchestrationReport([row], budget);
      expect(report.requestsByKind.chat + report.requestsByKind.models + report.requestsByKind.other).toBe(budget.sent);
      expect(report.requestsByKind.chat).toBe(3);
      expect(report.requestsByKind.other).toBe(1);
      expect(report.totalCalls).toBe(row.tools.length);
      expect(report).toMatchObject({ totalCalls: 3, totalRounds: 3, callsPerRound: 1 });
      expect(budget.log.every((line) => /^\d+ (\d{3}|ERR) /.test(line))).toBe(true);
      expect(summarize([row])).toContain("calls/round 1.00 (3 calls over 3 rounds)");
    } finally {
      globalThis.fetch = real;
      setRunRecorder(null);
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
