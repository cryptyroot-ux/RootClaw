// Runs ENGINE_TASKS through a real native driver turn with the workspace tools, flag off and plan+verify on,
// under a hard HTTP request budget (retries included). Usage:
//   node --experimental-strip-types evals/engine-tasks/run-engine-tasks.ts --provider ollama --model beam \
//     [--key-env OLLAMA_API_KEY] [--url <base>] [--max-requests 40] [--round-cap 12] [--task id]... [--models-file f.json]
// Writes a JSON report under evals/reports/runs/ (gitignored); never writes keys.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_TASKS, type EngineTask } from "./tasks.ts";

export interface RunRow {
  task: string; mode: "off" | "plan+verify"; pass: boolean; why: string; rounds: number; input: number; output: number;
  ms: number; stopReason: string | null; capped: boolean; plan?: unknown; verify?: unknown; tools: string[];
}

const arg = (name: string, fallback?: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : fallback; };
const args = (name: string) => process.argv.flatMap((value, index) => process.argv[index - 1] === `--${name}` ? [value] : []);

/** Counts every outgoing HTTP request; past the budget no request is sent. */
export function installRequestBudget(max: number, modelsFile?: string) {
  const real = globalThis.fetch;
  const state = { sent: 0, refused: 0, log: [] as string[] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (modelsFile && /\/models(\?|$)/.test(url)) return new Response(readFileSync(modelsFile, "utf8"), { status: 200, headers: { "content-type": "application/json" } });
    if (state.sent >= max) { state.refused++; throw new Error(`eval request budget of ${max} reached`); }
    state.sent++;
    try {
      const response = await real(input, init);
      state.log.push(`${state.sent} ${response.status} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
      return response;
    } catch (error) { state.log.push(`${state.sent} ERR ${(error as Error).message}`); throw error; }
  }) as typeof fetch;
  return state;
}

async function main() {
  const provider = arg("provider", "ollama")!;
  const model = arg("model")!;
  if (!model) throw new Error("--model is required");
  const keyEnv = arg("key-env", provider === "ollama" ? "OLLAMA_API_KEY" : "OPENAI_COMPAT_API_KEY")!;
  const budget = installRequestBudget(Number(arg("max-requests", "40")), arg("models-file"));
  const roundCap = Number(arg("round-cap", "12"));
  const wanted = new Set(args("task"));
  const tasks = ENGINE_TASKS.filter((task) => !wanted.size || wanted.has(task.id));
  const { setRunRecorder } = await import("../../server/drivers/openai-chat.ts");
  const { createRunStore } = await import("../../server/run-store.ts");
  const runs = createRunStore({ dataDir: mkdtempSync(join(tmpdir(), "engine-eval-runs-")) });
  setRunRecorder(runs);
  const environment = { [keyEnv]: process.env[keyEnv] ?? "" };
  const instance = provider === "ollama"
    ? await (await import("../../server/drivers/api-providers.ts")).OllamaCloudDriver.create({ instanceId: randomUUID(), displayName: "eval", enabled: true,
      config: { ...(await import("../../server/drivers/api-providers.ts")).OllamaCloudDriver.defaultConfig(), apiKeyEnv: keyEnv, ...(arg("url") ? { url: arg("url") } : {}) }, environment })
    : await (await import("../../server/drivers/openai-compat.ts")).OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "eval", enabled: true,
      config: { url: arg("url")!, apiKeyEnv: keyEnv }, environment });
  const rows: RunRow[] = [];
  for (const task of tasks) {
    for (const mode of ["off", "plan+verify"] as const) {
      if (budget.sent >= Number(arg("max-requests", "40"))) break;
      rows.push(await runOne(instance, runs, task, mode, model, roundCap));
      const row = rows.at(-1)!;
      console.log(`${row.task.padEnd(14)} ${row.mode.padEnd(11)} ${row.pass ? "PASS" : "FAIL"} rounds=${row.rounds} in=${row.input} out=${row.output} ${(row.ms / 1000).toFixed(1)}s ${row.stopReason ?? ""}${row.capped ? " (round cap)" : ""} | requests so far ${budget.sent}${row.pass ? "" : ` | ${row.why}`}`);
    }
    if (budget.sent >= Number(arg("max-requests", "40"))) { console.log(`request budget reached after ${task.id}; stopping`); break; }
  }
  await instance.dispose();
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "reports", "runs");
  mkdirSync(out, { recursive: true });
  const file = join(out, `engine-tasks-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ provider, model, roundCap, requests: budget.sent, refused: budget.refused, requestLog: budget.log, rows }, null, 2));
  console.log(summarize(rows));
  console.log(`requests sent: ${budget.sent}, refused by budget: ${budget.refused}; report: ${file}`);
}

type Instance = Awaited<ReturnType<typeof import("../../server/drivers/openai-compat.ts").OpenAICompatDriver.create>>;
type Runs = ReturnType<typeof import("../../server/run-store.ts").createRunStore>;

async function runOne(instance: Instance, runs: Runs, task: EngineTask, mode: RunRow["mode"], model: string, roundCap: number): Promise<RunRow> {
  const dir = mkdtempSync(join(tmpdir(), `engine-task-${task.id}-`));
  for (const [name, text] of Object.entries(task.files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
  const threadId = randomUUID();
  const started = Date.now();
  let rounds = 0;
  let capped = false;
  let turnId = "";
  const done = new Promise<{ stopReason?: string | null }>((resolve) => {
    const stop = instance.adapter.onEvent((event) => {
      if (event.threadId !== threadId) return;
      if (event.type === "thread.token-usage.updated" && ++rounds >= roundCap && !capped) {
        capped = true;
        void instance.adapter.interruptTurn(threadId, turnId);
      }
      if (event.type === "turn.completed") { stop(); resolve(event as { stopReason?: string | null }); }
    });
  });
  turnId = (await instance.adapter.sendTurn({ threadId, text: task.prompt, model, cwd: dir, approvalMode: "full",
    system: "You are a careful software engineer working in the given folder with workspace tools. Verify your work before answering.",
    planVerify: { mode: mode === "off" ? "off" : "plan+verify", maxVerifyRetries: 1 } })).turnId;
  const completed = await done;
  const run = runs.get(turnId);
  const result = task.check(dir);
  rmSync(dir, { recursive: true, force: true });
  return { task: task.id, mode, pass: result.pass, why: result.why, rounds: run?.rounds ?? rounds, input: run?.usage?.input ?? 0, output: run?.usage?.output ?? 0,
    ms: Date.now() - started, stopReason: completed.stopReason ?? null, capped, plan: run?.plan, verify: run?.verify, tools: run?.tools.map((tool) => tool.name) ?? [] };
}

export function summarize(rows: RunRow[]): string {
  const lines = ["| task | OFF | ON | OFF tokens (in/out) | ON tokens (in/out) | OFF rounds | ON rounds |", "|---|---|---|---|---|---|---|"];
  const tasks = [...new Set(rows.map((row) => row.task))];
  const cell = (row?: RunRow) => row ? (row.pass ? "pass" : "FAIL") : "-";
  for (const task of tasks) {
    const off = rows.find((row) => row.task === task && row.mode === "off");
    const on = rows.find((row) => row.task === task && row.mode === "plan+verify");
    lines.push(`| ${task} | ${cell(off)} | ${cell(on)} | ${off ? `${off.input}/${off.output}` : "-"} | ${on ? `${on.input}/${on.output}` : "-"} | ${off?.rounds ?? "-"} | ${on?.rounds ?? "-"} |`);
  }
  const paired = tasks.filter((task) => rows.some((row) => row.task === task && row.mode === "off") && rows.some((row) => row.task === task && row.mode === "plan+verify"));
  const sum = (mode: RunRow["mode"]) => rows.filter((row) => row.mode === mode && paired.includes(row.task)).reduce((total, row) => total + row.input + row.output, 0);
  const rate = (mode: RunRow["mode"]) => `${rows.filter((row) => row.mode === mode && row.pass).length}/${rows.filter((row) => row.mode === mode).length}`;
  lines.push("", `success OFF ${rate("off")}, ON ${rate("plan+verify")}; token ratio ON/OFF over ${paired.length} paired task(s): ${sum("off") ? (sum("plan+verify") / sum("off")).toFixed(2) : "n/a"}`);
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
}
