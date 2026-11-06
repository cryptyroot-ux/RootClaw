// The fake Claude CLI in `slow` mode holds the turn behind a gate; the test drives the broker directly, as the permission proxy does. POSIX-gated.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { FAKE_OPENAI_MODEL, startFakeOpenAiChat, type FakeOpenAiChat } from "./testing/fake-openai-chat.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let finishGate = "";
let fakeChat: FakeOpenAiChat | undefined;

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const getBot = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: { id: string }) => b.id === id);
const threadMessages = async (threadId: string): Promise<Array<{ kind: string; card?: { requestId?: string; answered?: string } }>> =>
  (await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? [];

posixOnly("a steered message does not lift the unattended mark on its own", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "rootclaw-steer-unattended-"));
    const data = join(home, ".rootclaw");
    mkdirSync(data, { recursive: true });
    finishGate = join(home, "finish.gate");
    fakeChat = await startFakeOpenAiChat({
      FAKE_CHAT_MODE: "slow",
      FAKE_CHAT_GATE: finishGate,
      FAKE_CHAT_TOOL_CALLS: JSON.stringify([
        { name: "shell", input: { command: "ls -la ./dist" } },
        { name: "shell", input: { command: "ls -la ./src" } },
      ]),
    });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      openaiCompat: { url: fakeChat.url, key: "fixture-only", model: FAKE_OPENAI_MODEL },
      defaultModelSelection: { instanceId: "openaiCompat", model: FAKE_OPENAI_MODEL },
      instances: { openaiCompat: { driver: "openai-compat", displayName: "Fixture engine" } },
    }));
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        PATH: dirname(process.execPath),
        ROOTCLAW_DATA_DIR: data,
        ROOTCLAW_TEST_SEALED_PATH: "1",
        HOME: home,
        USERPROFILE: home,
        ROOTCLAW_PORT: String(port),
        ROOTCLAW_WEBHOOK_PORT: String(port + 1),
        // Under a deep HOME the broker falls back to os.tmpdir(); the child has to agree with this process about where that is.
        TMPDIR: tmpdir(),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 40_000);

  afterAll(async () => {
    if (finishGate) writeFileSync(finishGate, "finish");
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (fakeChat) await fakeChat.stop();
    if (home) await removeTempDir(home);
  });

  it("keeps asking after the turn POSTs into itself with no session", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    // auto mode ON: an attended turn would sail straight through
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      autoApprove: true,
      modelSelection: { instanceId: "openaiCompat", model: FAKE_OPENAI_MODEL },
    })).status).toBe(200);
    const hook = await api("POST", "/api/webhooks", {
      name: "Nightly build",
      prompt: "Handle the incoming build event",
      botId: bot.id,
      runOn: "rootclaw",
    });
    expect(hook.status).toBe(201);
    const delivered = await fetch(hook.body.credential.url, {
      method: "POST",
      headers: { authorization: `Bearer ${hook.body.credential.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "failed" }),
    });
    expect(delivered.status).toBe(202);
    const { runId } = (await delivered.json()) as { runId: string };

    // A webhook run works in a conversation of its own, out of the way: the turn names it when it POSTs into itself.
    let runThreadId = "";
    await expect.poll(async () => {
      const run = ((await api("GET", "/api/routines")).body.runs ?? []).find((r: { id: string }) => r.id === runId);
      runThreadId = run?.threadId ?? "";
      return Boolean(runThreadId);
    }, { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await getBot(bot.id))?.busy === true && (await getBot(bot.id))?.threadId !== runThreadId, {
      timeout: 20_000,
    }).toBe(true);
    await expect.poll(() => fakeChat!.requests.some((request) => request.stream === true), { timeout: 20_000 }).toBe(true);
    const firstCard = async () => (await threadMessages(runThreadId)).find((message: any) => message.kind === "options" && message.card?.requestId);
    await expect.poll(firstCard, { timeout: 20_000 }).toMatchObject({ card: { requestId: expect.any(String) } });
    const initial = await firstCard();
    const steer = await api("POST", `/api/bots/${bot.id}/messages`, { text: "continue", threadId: runThreadId });
    expect(steer.status).toBe(202);
    expect(steer.body.steered).toBe(true);

    const answer = await api("POST", `/api/threads/${runThreadId}/respond`, { requestId: initial!.card!.requestId, behavior: "allow" });
    expect(answer.status).toBe(200);
    await expect.poll(async () => (await threadMessages(runThreadId)).find((message: any) =>
      message.kind === "options" && message.card?.requestId !== initial!.card!.requestId), { timeout: 20_000 }).toMatchObject({
      kind: "options", card: { requestId: expect.any(String) },
    });
    const nextCard = (await threadMessages(runThreadId)).find((message: any) =>
      message.kind === "options" && message.card?.requestId !== initial!.card!.requestId);
    expect(nextCard?.card?.answered, "the steered turn auto-approved — the self-POST lifted the unattended mark").toBeUndefined();
    writeFileSync(finishGate, "finish");
    await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
  }, 60_000);
});
