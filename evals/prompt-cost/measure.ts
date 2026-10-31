// Measures the prompt a real server sends for one "hello" turn, against the fake provider (no live model, no key).
// Usage: node --experimental-strip-types evals/prompt-cost/measure.ts [--json]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeOpenAiChat } from "../../server/testing/fake-openai-chat.ts";
import { countTokens, prepareTokenizer } from "../../server/drivers/tokenizer.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
await prepareTokenizer("gpt-4o");
const home = mkdtempSync(join(tmpdir(), "rc-prompt-cost-"));
const dump = join(home, "dump.json");
const fake = await startFakeOpenAiChat({ FAKE_CHAT_MODELS: JSON.stringify(["fixture-model"]), FAKE_CHAT_DUMP: dump, FAKE_CLAUDE_DUMP: dump });
const data = join(home, ".rootclaw");
mkdirSync(data, { recursive: true });
writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { fake: { driver: "openai-compat", displayName: "Fake", config: { url: fake.url, key: "fixture-only" } } } }));
const port = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "server", "index.ts")], {
  cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
  env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ROOTCLAW_PORT: String(port), ROOTCLAW_WEBHOOK_PORT: String(port + 1) },
});
let stderr = ""; child.stderr!.on("data", (c) => (stderr += c));
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
try {
  for (let i = 0; ; i++) { try { await api("GET", "/api/bots"); break; } catch { if (i > 300) throw new Error(`server did not start\n${stderr.slice(-2000)}`); await new Promise((r) => setTimeout(r, 200)); } }
  const created = await api("POST", "/api/bots", { name: "Cost probe", modelSelection: { instanceId: "fake", model: "fixture-model" } });
  if (created.status !== 201) throw new Error(`create bot: ${created.status} ${JSON.stringify(created.body)}`);
  await api("POST", `/api/bots/${created.body.bot.id}/messages`, { text: "hello" });
  for (let i = 0; !existsSync(dump); i++) { if (i > 300) throw new Error(`no request reached the fake\n${stderr.slice(-2000)}`); await new Promise((r) => setTimeout(r, 100)); }
  const request = JSON.parse(readFileSync(dump, "utf8")) as { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] };
  const t = (x: unknown) => countTokens(typeof x === "string" ? x : JSON.stringify(x), "gpt-4o");
  const system = request.messages.filter((m) => m.role === "system").reduce((n, m) => n + t(m.content), 0);
  const tools = request.tools ?? [];
  const perTool = Object.fromEntries(tools.map((tool) => [tool.function.name, t(tool)]).sort((a, b) => Number(b[1]) - Number(a[1])));
  const report = { total: t(request.messages) + t(tools), system, tools: t(tools), toolCount: tools.length, perTool };
  if (process.argv.includes("--loader")) process.stdout.write(JSON.stringify(tools.find((x) => x.function.name === "load_tools"), null, 1) + "\n");
  else if (process.argv.includes("--text")) process.stdout.write(request.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n----\n") + "\n");
  else console.log(JSON.stringify(report, null, 1));
} finally {
  child.kill("SIGTERM"); await fake.stop(); rmSync(home, { recursive: true, force: true });
}
