import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { FAKE_OPENAI_MODEL, startFakeOpenAiChat, type FakeOpenAiChat } from "../../server/testing/fake-openai-chat.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import type { Scenario, Step } from "../types.ts";
import { buildScriptedPlan } from "../providers/mock/scripted-plan.ts";
import { BaseWorld, type WorldContext } from "./base-world.ts";
import { waitUntil } from "./api.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CAPABILITY_KEY = "local-vm-eval-capability";

/** The VM bridge execs this runtime name and speaks MCP on its stdin. */
const FAKE_PODMAN = `#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const { existsSync } = require('node:fs');
const TOOLS = [
  { name: 'screenshot', description: 'Capture the VM screen', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'click', description: 'Click at a point', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } },
  { name: 'type_text', description: 'Type text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'open_url', description: 'Open a URL in the VM browser', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-vm', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: existsSync(__dirname + '/empty-tools') ? [] : TOOLS };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'fake vm ran ' + String(request.params?.name) }] };
  else result = { content: [{ type: 'text', text: 'unsupported call' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;

/** The Local VM world: the real server with the container boundary replaced
 * by the in-repo VM fixture (no Podman, no network), exactly the proven
 * group-local-vm recipe. This is the only world where the lazy computer
 * claim seam can be driven end to end. */
export class LocalVmWorld extends BaseWorld {
  private child: ChildProcess | undefined;
  private fake: FakeOpenAiChat | undefined;
  private fixtureHome = "";
  private stateFile = "";
  private dumpFile = "";
  private planPath = "";
  private base = "";
  private stderr = "";
  private computers = new Map<string, { url: string; token: string }>();

  override async boot(scenario: Scenario): Promise<void> {
    this.fixtureHome = mkdtempSync(join(tmpdir(), "rootclaw-evals-vm-"));
    this.stateFile = join(this.fixtureHome, "vm.json");
    this.dumpFile = join(this.fixtureHome, "dump.json");
    const data = join(this.fixtureHome, "data");
    const ui = join(this.fixtureHome, "static");
    this.planPath = join(data, "room-plan.json");
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>evals</title>");
    writeFileSync(join(ui, "assets", "eval.css"), "body{}");
    mkdirSync(data, { recursive: true });
    this.vmState({});
    const fakebin = join(this.fixtureHome, "fakebin");
    mkdirSync(fakebin);
    writeFileSync(join(fakebin, "podman"), FAKE_PODMAN, { mode: 0o700 });
    chmodSync(join(fakebin, "podman"), 0o700);
    this.fake = await startFakeOpenAiChat({ FAKE_CHAT_DUMP: this.dumpFile, FAKE_CHAT_ROOM_PLAN: this.planPath });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      features: { smartSetupChoices: false },
      openaiCompat: { url: this.fake.url, key: "fixture-only", model: FAKE_OPENAI_MODEL },
      defaultModelSelection: { instanceId: "openaiCompat", model: FAKE_OPENAI_MODEL },
      instances: { openaiCompat: { driver: "openai-compat", displayName: "Eval fixture" } },
    }));
    const port = await freePortBlock([0, 1]);
    const hooks = pathToFileURL(join(ROOT, "server", "testing", "group-local-vm-hooks.mjs")).href;
    const env: NodeJS.ProcessEnv = {
      PATH: [fakebin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      ROOTCLAW_EXTRA_PATH: fakebin,
      ROOTCLAW_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY,
      HOME: this.fixtureHome,
      USERPROFILE: this.fixtureHome,
      ROOTCLAW_DATA_DIR: data,
      APPDATA: join(this.fixtureHome, "appdata"),
      LOCALAPPDATA: join(this.fixtureHome, "localappdata"),
      TEMP: this.fixtureHome,
      TMP: this.fixtureHome,
      TMPDIR: this.fixtureHome,
      ROOTCLAW_PORT: String(port),
      ROOTCLAW_WEBHOOK_PORT: String(port + 1),
      ROOTCLAW_STATIC_DIR: ui,
      ROOTCLAW_TEST_VM_STATE: this.stateFile,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const child = this.child = spawn(process.execPath, ["--experimental-strip-types", "--import", hooks, join(ROOT, "server", "index.ts")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stderr?.on("data", (chunk) => (this.stderr += chunk));
    const base = this.base = "http://127.0.0.1:" + port;
    await waitUntil(
      "VM fixture server to come up",
      async () => {
        // exitCode stays null for a child killed by a signal; either way
        // the boot is over and the captured stderr says why
        if (child.exitCode !== null || child.signalCode !== null) {
          const how = child.signalCode !== null ? " (killed by " + child.signalCode + ")" : "";
          throw new Error("server exited" + how + ": " + this.stderr.slice(-2000));
        }
        try {
          return (await fetch(base + "/api/health")).ok;
        } catch {
          return false;
        }
      },
      (up) => up,
      20_000,
    );
    // eval-gates lives under the server's ROOTCLAW_DATA_DIR so installSkill's
    // <dataRoot>/skills target is the directory index.ts hot-loads user
    // skills from; anywhere else and installed skills never reach the prompt.
    await this.initBase(base, this.planPath + ".evidence.jsonl", join(data, "eval-gates"));
    for (const bot of scenario.bots) {
      const created = await this.api.post("/api/bots", { name: bot.name });
      if (created.status >= 300) throw new Error("bot create failed: " + JSON.stringify(created.body));
      this.bots.set(bot.key, { id: created.body.bot.id, threadId: created.body.bot.threadId });
      const patch: Record<string, unknown> = {};
      if (bot.computer !== undefined) patch.computer = bot.computer;
      if (bot.browser !== undefined) patch.browser = bot.browser;
      if (Object.keys(patch).length > 0) {
        const response = await this.api.patch("/api/bots/" + created.body.bot.id, patch);
        if (response.status >= 300) throw new Error("bot patch failed: " + JSON.stringify(response.body));
      }
    }
    const plan = buildScriptedPlan(scenario, (ref) => this.botId(ref), (gate) => this.gatePath(gate));
    writeFileSync(this.planPath, JSON.stringify(plan));
  }

  private vmState(state: Record<string, unknown>): void {
    writeFileSync(this.stateFile, JSON.stringify(state));
  }

  /** The fake engine dumps once per process; reads must tolerate a torn
   * partial write, and every read consumes the file so the next dump is
   * unambiguous. */
  private async readDump(timeoutMs: number): Promise<any> {
    const dump = await waitUntil(
      "engine dump",
      () => {
        if (!existsSync(this.dumpFile)) return null;
        try {
          return JSON.parse(readFileSync(this.dumpFile, "utf8"));
        } catch {
          return null;
        }
      },
      (value) => value !== null,
      timeoutMs,
    );
    rmSync(this.dumpFile, { force: true });
    return dump;
  }

  protected override async runWorldStep(step: Step, ctx: WorldContext): Promise<string> {
    switch (step.kind) {
      case "setVmState": {
        this.vmState(step.state);
        return "vm state set: " + JSON.stringify(step.state);
      }
      case "consumeDump": {
        await this.readDump(step.timeoutMs ?? 20_000);
        return "engine dump consumed";
      }
      case "captureComputer": {
        const dump = await this.readDump(20_000);
        const computer = dump?.mcpConfig?.mcpServers?.computer;
        if (!computer) throw new Error("no computer mount in dump: " + JSON.stringify(dump?.mcpConfig ?? null));
        const bot = this.bots.get(step.bot);
        if (bot === undefined) throw new Error("no bot " + step.bot);
        const minted = await fetch(this.base + "/api/testing/internal-capability", {
          method: "POST",
          headers: { "content-type": "application/json", "x-rootclaw-test-capability": CAPABILITY_KEY },
          body: JSON.stringify({ botId: bot.id, threadId: bot.threadId, kind: "computer" }),
        });
        const body = await minted.json() as { token?: string; error?: string };
        if (!minted.ok || !body.token) throw new Error("capability mint failed: " + JSON.stringify(body));
        this.computers.set(step.bot, {
          url: this.base + "/api/internal/computer-control?botId=" + encodeURIComponent(bot.id),
          token: body.token,
        });
        return "computer gate captured for " + step.bot;
      }
      case "pollComputerGate": {
        const computer = this.computers.get(step.bot);
        if (computer === undefined) throw new Error("no captured computer for " + step.bot);
        const response = await fetch(computer.url, { headers: { authorization: "Bearer " + computer.token } });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        ctx.observations[step.saveAs] = { httpStatus: response.status, ...body };
        return "gate answered " + response.status + ": " + JSON.stringify(body);
      }
      default:
        throw new Error("step " + step.kind + " is not available in the localVm world");
    }
  }

  override async close(): Promise<void> {
    try {
      this.vmState({});
    } catch {
    }
    if (this.child !== undefined) await waitForExit(this.child, { signal: "SIGTERM" });
    await this.fake?.stop();
    await removeTempDir(this.fixtureHome);
  }
}
