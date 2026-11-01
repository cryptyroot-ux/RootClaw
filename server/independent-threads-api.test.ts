// Independent threads of one bot on the native engine (audit COV1): the verification server's fake OpenAI-compatible
// provider holds each thread's turn until <dataDir>/<thread>.gate exists, so a test decides when each thread settles.
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-rootclaw.ts";
import { FAKE_OPENAI_MODEL } from "./testing/fake-openai-chat.ts";

const OTHER_MODEL = "fixture-model-2";
const LATER_MODEL = "fixture-model-3";

describe("independent bot threads through an isolated HTTP fixture (native engine)", () => {
  let fixture: VerificationServer;
  let evidence: unknown[];

  const api = async (method: string, path: string, body?: unknown, fromApp = false) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", ...(fromApp ? { origin: fixture.info.url } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, status: result.status });
    return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]);
    evidence.push({ command: args, result });
    return result as any;
  };
  const folderOf = (request: any): string | undefined => {
    const system = (request.messages as any[] | undefined)?.find((message) => message.role === "system")?.content;
    const match = /"currentWorkingFolder":\s*"([^"]+)"/.exec(typeof system === "string" ? system : JSON.stringify(system ?? ""));
    return match ? basename(JSON.parse(`"${match[1]}"`)) : undefined;
  };
  const requestsOf = (threadId: string) => fixture.fakeChat.requests.filter((request: any) => request.stream === true && folderOf(request) === threadId) as any[];
  const started = async (threadId: string) => {
    await expect.poll(() => requestsOf(threadId).length, { timeout: 15_000 }).toBeGreaterThan(0);
    return requestsOf(threadId)[0];
  };
  const finish = (threadId: string) => writeFileSync(join(fixture.info.dataDir, `${threadId}.gate`), "finish this isolated turn");
  const botState = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId);
  const taskOf = async (botId: string, threadId: string) => (await botState(botId)).tasks.find((task: any) => task.threadId === threadId);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];

  beforeEach(async () => {
    evidence = [];
    fixture = await launchVerificationServer();
    fixture.fakeChat.set({ mode: "slow", gates: fixture.info.dataDir, models: [FAKE_OPENAI_MODEL, OTHER_MODEL, LATER_MODEL] });
  }, 30_000);

  afterEach(async () => {
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.independent-threads.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence }, null, 2));
    console.info(JSON.stringify({ ...fixture.info, evidencePath }));
    await fixture.close();
  });

  it("keeps A and B independent across selection, models, approvals, and stopping A", async () => {
    const created = await api("POST", "/api/bots", { name: "Independent fixture", modelSelection: { instanceId: "openaiCompat", model: FAKE_OPENAI_MODEL } }, true);
    expect(created.status).toBe(201);
    const botId = created.body.bot.id as string;
    const taskA = created.body.bot.threadId as string;
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${taskA}`, { approvalMode: "ask" }, true)).status).toBe(200);
    // A asks for a shell command at once (matched on the end of its own message: B's context names A's thread); under Ask it waits on the person's card.
    fixture.fakeChat.set({ routes: [{ match: "ONLY_A\\s*$", mode: "happy", toolCalls: [{ name: "shell", input: { command: "ls -la ./dist" } }] }] });
    expect((await api("POST", `/api/bots/${botId}/messages`, { threadId: taskA, text: "ONLY_A" }, true)).status).toBe(202);
    const launchedA = await started(taskA);

    const second = await api("POST", `/api/bots/${botId}/tasks`, { title: "Independent B" }, true);
    expect(second.status).toBe(201);
    const taskB = second.body.task.threadId as string;
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${taskB}`, { modelSelection: { instanceId: "openaiCompat", model: OTHER_MODEL } }, true)).status).toBe(200);
    // Raising permissions needs the trusted app's same-origin request.
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${taskB}`, { approvalMode: "auto" })).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${taskB}`, { approvalMode: "auto" }, true)).status).toBe(200);
    expect((await api("POST", `/api/bots/${botId}/messages`, { threadId: taskB, text: "ONLY_B" }, true)).status).toBe(202);
    const launchedB = await started(taskB);
    expect(launchedA.model).toBe(FAKE_OPENAI_MODEL);
    expect(launchedB.model).toBe(OTHER_MODEL);
    // Each provider turn ends on its own thread's words (the "recent work" context deliberately names other threads).
    expect(JSON.stringify(launchedA.messages.at(-1))).toContain("ONLY_A");
    expect(JSON.stringify(launchedA.messages.at(-1))).not.toContain("ONLY_B");
    expect(launchedB.messages.filter((message: any) => message.role !== "system").map((message: any) => JSON.stringify(message.content)).join("\n").split("Your recent work")[0]).not.toContain("ONLY_A");

    const select = async (threadId: string) => expect((await api("POST", `/api/bots/${botId}/tasks/${threadId}?messages=0`, {}, true)).status).toBe(200);
    await select(taskA);
    await select(taskB);
    const busy = async () => (await botState(botId)).tasks.filter((task: any) => task.busy).map((task: any) => task.threadId);
    await expect.poll(busy).toEqual(expect.arrayContaining([taskA, taskB]));
    // A is already on its approval card here (the original fake CLI asked later), so waiting reports the person, not a timeout.
    expect((await control(["wait", "--bot", botId, "--task", taskA, "--timeout", "1"])).status).toBe("needs-user");
    expect((await control(["wait", "--bot", botId, "--task", taskB, "--timeout", "1"])).status).toBe("timed-out");
    const changeBusy = await api("PATCH", `/api/bots/${botId}/tasks/${taskA}`, { modelSelection: { instanceId: "openaiCompat", model: OTHER_MODEL } }, true);
    expect(changeBusy.status).toBe(409);

    await expect.poll(async () => (await taskOf(botId, taskA))?.activity, { timeout: 15_000 }).toBe("waiting-on-you");
    expect((await taskOf(botId, taskB))?.activity).toBe("working");
    const card = (await messages(taskA)).findLast((message) => message.card?.requestId && !message.card.answered)?.card;
    expect(card).toBeDefined();
    // B's thread cannot answer A's card.
    expect(await api("POST", `/api/bots/${botId}/respond`, { threadId: taskB, requestId: card.requestId, behavior: "allow" }, true))
      .toMatchObject({ status: 200, body: { outcome: "unavailable" } });
    expect((await taskOf(botId, taskA))?.activity).toBe("waiting-on-you");
    expect((await messages(taskA)).find((message) => message.card?.requestId === card.requestId)?.card.answered).toBeUndefined();
    expect((await messages(taskB)).some((message) => message.card)).toBe(false);
    expect(requestsOf(taskA)).toHaveLength(1);
    // After the approved command, A's next round waits on its own gate, so A is still running when it is stopped.
    fixture.fakeChat.set({ routes: [{ match: "ONLY_A\\s*$", mode: "slow" }] });
    expect((await api("POST", `/api/bots/${botId}/respond`, { threadId: taskA, requestId: card.requestId, behavior: "allow" }, true)).status).toBe(200);
    await expect.poll(async () => (await messages(taskA)).some((message) => message.card?.requestId === card.requestId && message.card.answered), { timeout: 15_000 }).toBe(true);

    await expect.poll(() => requestsOf(taskA).length, { timeout: 15_000 }).toBeGreaterThan(1);
    expect((await taskOf(botId, taskA))?.busy).toBe(true);
    await control(["interrupt", "--bot", botId, "--task", taskA]);
    await expect.poll(async () => (await taskOf(botId, taskA))?.busy, { timeout: 15_000 }).toBe(false);
    expect((await taskOf(botId, taskB))?.busy).toBe(true);
    expect((await control(["wait", "--bot", botId, "--task", taskA, "--timeout", "1"])).status).toBe("settled");
    finish(taskB);
    expect((await control(["wait", "--bot", botId, "--task", taskB, "--timeout", "10"])).status).toBe("settled");
    const messagesA = await messages(taskA);
    const messagesB = await messages(taskB);
    expect(JSON.stringify(messagesA)).not.toContain("ONLY_B");
    expect(JSON.stringify(messagesB)).not.toContain("ONLY_A");
    expect(messagesB.some((message) => message.role === "bot" && message.text?.includes("ONLY_B"))).toBe(true);
    expect(requestsOf(taskA).every((request) => request.model === FAKE_OPENAI_MODEL)).toBe(true);
    expect(requestsOf(taskB).every((request) => request.model === OTHER_MODEL)).toBe(true);

    const userA = messagesA.find((message) => message.role === "user");
    expect((await api("POST", `/api/bots/${botId}/messages/${userA.id}/edit`, { threadId: taskB, text: "wrong task" }, true)).status).toBe(404);
    expect((await api("POST", `/api/bots/${botId}/active-branch`, { threadId: taskB, messageId: userA.id }, true)).status).toBe(404);

    // The bot-level model change applies to the selected thread (A) and the default, never to B's own choice.
    await select(taskA);
    expect((await api("PATCH", `/api/bots/${botId}`, { modelSelection: { instanceId: "openaiCompat", model: LATER_MODEL } }, true)).status).toBe(200);
    const final = await botState(botId);
    expect(final.tasks.find((task: any) => task.threadId === taskA).modelSelection.model).toBe(LATER_MODEL);
    expect(final.tasks.find((task: any) => task.threadId === taskB).modelSelection.model).toBe(OTHER_MODEL);
  }, 60_000);

  it("replaces the final worked thread with blank context but refuses to delete it while running", async () => {
    const created = await api("POST", "/api/bots", { name: "Last thread fixture", modelSelection: { instanceId: "openaiCompat", model: FAKE_OPENAI_MODEL } }, true);
    expect(created.status).toBe(201);
    const botId = created.body.bot.id as string;
    const threadId = created.body.bot.threadId as string;
    expect((await api("POST", `/api/bots/${botId}/messages`, { threadId, text: "LAST_THREAD_WORK" }, true)).status).toBe(202);
    await started(threadId);
    expect((await api("DELETE", `/api/bots/${botId}/tasks/${threadId}`, undefined, true)).status).toBe(409);
    finish(threadId);
    expect((await control(["wait", "--bot", botId, "--task", threadId, "--timeout", "15"])).status).toBe("settled");
    const before = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(before.tasks).toHaveLength(1);
    expect(before.messages.some((message: any) => message.role === "user" && message.text === "LAST_THREAD_WORK")).toBe(true);
    const artifact = join(fixture.info.dataDir, "task-workspaces", botId, threadId, "result.txt");
    writeFileSync(artifact, "Retain generated project files");

    const deleted = await api("DELETE", `/api/bots/${botId}/tasks/${threadId}`, undefined, true);
    expect(deleted.status).toBe(200);
    const fresh = deleted.body.bot;
    expect(fresh.tasks).toHaveLength(1);
    expect(fresh.threadId).not.toBe(threadId);
    expect(fresh.tasks[0]).toMatchObject({ threadId: fresh.threadId, title: "New thread", busy: false });
    expect(fresh.messages).toEqual([]);
    expect(fresh.modelSelection).toEqual(before.modelSelection);
    expect(readFileSync(artifact, "utf8")).toBe("Retain generated project files");
    expect((await api("DELETE", `/api/bots/${botId}/tasks/${threadId}`, undefined, true)).status).toBe(404);
    const loaded = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId);
    expect(loaded.threadId).toBe(fresh.threadId);
    expect(loaded.messages).toEqual([]);
    finish(fresh.threadId);
    expect((await api("POST", `/api/bots/${botId}/messages`, { threadId: fresh.threadId, text: "NEW_THREAD_WORK" }, true)).status).toBe(202);
    expect((await control(["wait", "--bot", botId, "--task", fresh.threadId, "--timeout", "15"])).status).toBe("settled");
    const messages = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === botId).messages;
    expect(messages.some((message: any) => message.text === "NEW_THREAD_WORK")).toBe(true);
    expect(messages.some((message: any) => message.text === "LAST_THREAD_WORK")).toBe(false);
    evidence.push({ deletedThreadId: threadId, replacementThreadId: fresh.threadId, blankReplacement: true, artifactRetained: true });
  }, 30_000);
});
