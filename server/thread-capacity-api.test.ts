// Per-bot thread capacity on the native engine (audit COV1): the verification server's fake OpenAI-compatible
// provider holds each thread's turn until <dataDir>/<thread>.gate exists, so a test decides when every slot frees.
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-rootclaw.ts";
import { FAKE_OPENAI_MODEL } from "./testing/fake-openai-chat.ts";
import { openSse } from "./testing/sse.ts";

describe("per-bot thread capacity through an isolated HTTP fixture (native engine)", () => {
  let fixture: VerificationServer;
  let evidence: unknown[];

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, status: result.status });
    return result;
  };
  const botState = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId);
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=50`)).body.messages as any[];
  const userTexts = async (threadId: string) => (await messages(threadId)).filter((message) => message.role === "user");
  /** The thread a provider request came from: the working folder its system prompt names. */
  const folderOf = (request: any): string | undefined => {
    const system = (request.messages as any[] | undefined)?.find((message) => message.role === "system")?.content;
    const match = /"currentWorkingFolder":\s*"([^"]+)"/.exec(typeof system === "string" ? system : JSON.stringify(system ?? ""));
    return match ? basename(JSON.parse(`"${match[1]}"`)) : undefined;
  };
  /** Turns the provider was asked to start for a thread (streamed requests that end on the person's words). */
  const turnsOf = (threadId: string) => fixture.fakeChat.requests
    .filter((request: any) => request.stream === true && request.messages?.at(-1)?.role === "user" && folderOf(request) === threadId);
  const started = async (threadId: string) => {
    await expect.poll(() => turnsOf(threadId).length, { timeout: 15_000 }).toBeGreaterThan(0);
    return turnsOf(threadId)[0] as any;
  };
  const finish = (threadId: string) => writeFileSync(join(fixture.info.dataDir, `${threadId}.gate`), "finish this isolated turn");
  const busyThreads = async (botId: string) => (await botState(botId)).tasks.filter((task: any) => task.busy).map((task: any) => task.threadId) as string[];
  const send = (botId: string, threadId: string, text: string, sendId?: string) => api("POST", `/api/bots/${botId}/messages`, { threadId, text, sendId });
  const limit = async (maxConcurrentPerBot: number) => {
    const result = await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot } });
    expect(result.status).toBe(200);
    expect(result.body.threads).toEqual({ maxConcurrentPerBot });
  };
  const botWithThreads = async (count: number) => {
    const created = await api("POST", "/api/bots", { name: "Capacity fixture", modelSelection: { instanceId: "openaiCompat", model: FAKE_OPENAI_MODEL } });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const threads = [bot.threadId as string];
    for (let i = 1; i < count; i++) {
      const createdTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: `Capacity thread ${i + 1}` });
      expect(createdTask.status).toBe(201);
      threads.push(createdTask.body.task.threadId);
    }
    return { botId: bot.id as string, threads };
  };

  beforeEach(async () => {
    evidence = [];
    fixture = await launchVerificationServer();
    fixture.fakeChat.set({ mode: "slow", gates: fixture.info.dataDir });
  }, 30_000);

  afterEach(async () => {
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.capacity.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, requests: evidence }, null, 2));
    console.info(JSON.stringify({ ...fixture.info, evidencePath }));
    await fixture.close();
  });

  it("defaults to three, runs ten turns at once after raising the limit, and safely queues and cancels overflow", async () => {
    expect((await api("GET", "/api/config")).body.threads).toEqual({ maxConcurrentPerBot: 3 });
    for (const maxConcurrentPerBot of [0, 17, 1.5, "2", null]) {
      expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot } })).status).toBe(400);
    }
    expect((await api("GET", "/api/config")).body.threads.maxConcurrentPerBot).toBe(3);
    const { botId, threads } = await botWithThreads(12);
    const firstThree = await Promise.all(threads.slice(0, 3).map((threadId, i) => send(botId, threadId, `ACTIVE_${i}`)));
    expect(firstThree.map((result) => result.status)).toEqual([202, 202, 202]);
    expect(firstThree.every((result) => !result.body.queued)).toBe(true);
    await Promise.all(threads.slice(0, 3).map(started));
    expect(await busyThreads(botId)).toHaveLength(3);
    const fourth = await send(botId, threads[3]!, "FOURTH_AFTER_RAISE", "capacity_default_fourth");
    expect(fourth.status).toBe(202);
    expect(fourth.body).toMatchObject({ queued: true, reason: "capacity", threadId: threads[3] });
    expect(await userTexts(threads[3]!)).toEqual([]);
    expect(turnsOf(threads[3]!)).toEqual([]);

    await limit(10);
    await started(threads[3]!);
    const rest = await Promise.all(threads.slice(4, 10).map((threadId, i) => send(botId, threadId, `ACTIVE_${i + 4}`)));
    expect(rest.every((result) => result.status === 202 && !result.body.queued)).toBe(true);
    const launched = await Promise.all(threads.slice(0, 10).map(started));
    // Ten turns held open at once, each from its own thread's folder, each on the selected model.
    expect(new Set(launched.map(folderOf)).size).toBe(10);
    expect(launched.every((request) => request.model === FAKE_OPENAI_MODEL)).toBe(true);
    expect(await busyThreads(botId)).toHaveLength(10);

    const overflow = await send(botId, threads[10]!, "ELEVENTH_WAITING", "capacity_eleventh_retry");
    expect(overflow.status).toBe(202);
    expect(overflow.body).toMatchObject({ queued: true, reason: "capacity", threadId: threads[10], queueId: expect.any(String) });
    expect((await send(botId, threads[10]!, "ELEVENTH_WAITING", "capacity_eleventh_retry")).body).toEqual(overflow.body);
    expect((await send(botId, threads[10]!, "CONFLICTING_RETRY", "capacity_eleventh_retry")).status).toBe(409);
    expect(await userTexts(threads[10]!)).toEqual([]);
    expect(turnsOf(threads[10]!)).toEqual([]);
    const cancelled = await send(botId, threads[11]!, "TWELFTH_CANCELLED", "capacity_twelfth_cancel");
    expect(cancelled.body).toMatchObject({ queued: true, reason: "capacity" });
    expect((await api("DELETE", `/api/bots/${botId}/queue/${cancelled.body.queueId}`, { threadId: threads[10] })).status).toBe(404);
    expect((await api("DELETE", `/api/bots/${botId}/queue/${cancelled.body.queueId}`, { threadId: threads[11] })).status).toBe(200);

    const other = await botWithThreads(1);
    expect((await send(other.botId, other.threads[0]!, "OTHER_BOT_INDEPENDENT")).body.queued).toBeUndefined();
    await started(other.threads[0]!);
    expect(await busyThreads(other.botId)).toEqual(other.threads);
    expect(await busyThreads(botId)).toHaveLength(10);

    finish(threads[0]!);
    await started(threads[10]!);
    await expect.poll(() => busyThreads(botId)).toHaveLength(10);
    const drained = await userTexts(threads[10]!);
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ text: "ELEVENTH_WAITING", sendId: "capacity_eleventh_retry", queueId: overflow.body.queueId });
    expect(await userTexts(threads[11]!)).toEqual([]);
    expect(turnsOf(threads[11]!)).toEqual([]);
    for (const threadId of [...threads.slice(1, 11), ...other.threads]) finish(threadId);
    await expect.poll(() => busyThreads(botId), { timeout: 15_000 }).toEqual([]);
    await expect.poll(() => busyThreads(other.botId), { timeout: 15_000 }).toEqual([]);
    expect(turnsOf(threads[11]!)).toEqual([]);
  }, 90_000);

  it("dispatches routines into a free slot without waiting for whole-bot idle", async () => {
    await limit(2);
    const { botId, threads } = await botWithThreads(2);
    expect((await send(botId, threads[0]!, "HOLD_ONE_SLOT")).body.queued).toBeUndefined();
    await started(threads[0]!);
    expect(await busyThreads(botId)).toEqual([threads[0]]);
    const created = await api("POST", "/api/routines", {
      name: "Slot dispatch probe", prompt: "Write the scheduled digest.", target: "bot", botId, runOn: "rootclaw", enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    expect(created.status).toBe(201);
    const routineId = created.body.routine.id;
    const runState = async (id: string) => (await api("GET", "/api/routines")).body.runs.find((run: any) => run.id === id);
    try {
      const first = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
      await expect.poll(async () => (await runState(first.id))?.status, { timeout: 15_000 }).toBe("running");
      const firstRun = await runState(first.id);
      expect(firstRun.threadId).toBeTruthy();
      expect(firstRun.threadId).not.toBe(threads[0]);
      await started(firstRun.threadId);
      expect(await busyThreads(botId)).toHaveLength(2);
      expect((await botState(botId)).busy).toBe(true);
      const second = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect((await runState(second.id))?.status).toBe("queued");
      finish(threads[0]!);
      await expect.poll(async () => (await runState(second.id))?.status, { timeout: 15_000 }).toBe("running");
      const secondRun = await runState(second.id);
      expect(secondRun.threadId).not.toBe(firstRun.threadId);
      await started(secondRun.threadId);
    } finally {
      for (const threadId of await busyThreads(botId)) finish(threadId);
      await expect.poll(async () => (await busyThreads(botId)).length, { timeout: 15_000 }).toBe(0);
      await api("DELETE", `/api/routines/${routineId}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
    }
  }, 90_000);

  it("runs the person's message in the main chat at once while task threads hold every slot", async () => {
    await limit(1);
    const { botId, threads: [main, task] } = await botWithThreads(2);
    expect((await send(botId, main!, "MAIN_WARM_UP")).body.queued).toBeUndefined();
    await started(main!);
    finish(main!);
    await expect.poll(() => busyThreads(botId), { timeout: 10_000 }).toEqual([]);
    const created = await api("POST", "/api/routines", {
      name: "Slot holder", prompt: "Write the scheduled digest.", target: "bot", botId, runOn: "rootclaw", enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    expect(created.status).toBe(201);
    const routineId = created.body.routine.id;
    try {
      const run = (await api("POST", `/api/routines/${routineId}/run`)).body.run;
      await expect.poll(async () => (await api("GET", "/api/routines")).body.runs.find((entry: any) => entry.id === run.id)?.status, { timeout: 15_000 }).toBe("running");
      expect(await busyThreads(botId)).toHaveLength(1);
      expect((await send(botId, task!, "TASK_THREAD_WAITS")).body).toMatchObject({ queued: true, reason: "capacity", threadId: task });
      const direct = await send(botId, main!, "MAIN_CHAT_RUNS");
      expect(direct.status).toBe(202);
      expect(direct.body.queued).toBeUndefined();
      await expect.poll(() => busyThreads(botId), { timeout: 10_000 }).toContain(main);
      expect(await busyThreads(botId)).not.toContain(task);
      expect(turnsOf(task!)).toEqual([]);
    } finally {
      for (const threadId of await busyThreads(botId)) finish(threadId);
      await api("DELETE", `/api/routines/${routineId}`).catch(() => undefined);
      await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
    }
  }, 60_000);

  it("restores cancellable queued receipts from a fresh snapshot and broadcasts complete queue changes", async () => {
    await limit(1);
    const { botId, threads: [active, waiting, cancelled, deleted] } = await botWithThreads(4);
    expect((await send(botId, active!, "ACTIVE_DURING_RELOAD")).body.queued).toBeUndefined();
    await started(active!);
    const events = await openSse(`${fixture.info.url}/api/events`);
    try {
      const queued = await send(botId, waiting!, "RESTORE_AFTER_RELOAD", "reload_queue_receipt");
      expect(queued.body).toMatchObject({ queued: true, reason: "capacity", threadId: waiting });
      const receipt = { queueId: queued.body.queueId, text: "RESTORE_AFTER_RELOAD", reason: "capacity" };
      expect((await api("GET", "/api/bots?messages=0")).body.botQueuedMessages).toEqual({ [waiting!]: [receipt] });
      const enqueued = await events.until((frame) => frame.kind === "bot.queued" && frame.queues[waiting!]?.[0]?.queueId === receipt.queueId);
      expect(enqueued.queues).toEqual({ [waiting!]: [receipt] });
      const cancelReceipt = (await send(botId, cancelled!, "CANCEL_AFTER_RELOAD")).body;
      const restored = (await api("GET", "/api/bots")).body.botQueuedMessages;
      expect(restored[cancelled!]).toEqual([{ queueId: cancelReceipt.queueId, text: "CANCEL_AFTER_RELOAD", reason: "capacity" }]);
      expect((await api("DELETE", `/api/bots/${botId}/queue/${restored[cancelled!][0].queueId}`, { threadId: waiting })).status).toBe(404);
      expect((await api("DELETE", `/api/bots/${botId}/queue/${restored[cancelled!][0].queueId}`, { threadId: cancelled })).status).toBe(200);
      const removed = await events.until((frame) => frame.kind === "bot.queued" && frame.seq > enqueued.seq + 1 && !frame.queues[cancelled!]);
      expect(removed.queues).toEqual({ [waiting!]: [receipt] });
      expect((await api("GET", "/api/bots")).body.botQueuedMessages).toEqual({ [waiting!]: [receipt] });

      await send(botId, deleted!, "DELETE_QUEUED_TASK");
      const beforeDelete = await events.until((frame) => frame.kind === "bot.queued" && frame.queues[deleted!]?.length);
      expect((await api("DELETE", `/api/bots/${botId}/tasks/${deleted}`)).status).toBe(200);
      expect((await events.until((frame) => frame.kind === "bot.queued" && frame.seq > beforeDelete.seq && !frame.queues[deleted!])).queues).toEqual({ [waiting!]: [receipt] });
      expect((await api("GET", "/api/bots")).body.botQueuedMessages).toEqual({ [waiting!]: [receipt] });

      finish(active!);
      await started(waiting!);
      expect((await events.until((frame) => frame.kind === "bot.queued" && frame.seq > beforeDelete.seq && Object.keys(frame.queues).length === 0)).queues).toEqual({});
      expect((await api("GET", "/api/bots")).body.botQueuedMessages).toEqual({});
      expect(await userTexts(waiting!)).toEqual([expect.objectContaining({ text: receipt.text, queueId: receipt.queueId })]);
      expect(await userTexts(cancelled!)).toEqual([]);
      expect(turnsOf(cancelled!)).toEqual([]);
      expect(turnsOf(deleted!)).toEqual([]);
      finish(waiting!);
      await expect.poll(() => busyThreads(botId)).toEqual([]);
      evidence.push({ queueEvents: events.frames.filter((frame) => frame.kind === "bot.queued") });
    } finally { events.close(); }
  }, 45_000);

  it("drains FIFO when raised or a turn finishes, and preserves active work when lowered", async () => {
    await limit(1);
    const { botId, threads: [first, second, third, fourth] } = await botWithThreads(4);
    expect((await send(botId, first!, "FIRST_HOLDS_SLOT")).body.queued).toBeUndefined();
    await started(first!);
    expect(await busyThreads(botId)).toEqual([first]);
    const queued: string[] = [];
    for (const [index, threadId] of [second!, third!, fourth!].entries()) {
      const result = await send(botId, threadId, `FIFO_${index + 1}`, `capacity_fifo_send_${index + 1}`);
      expect(result.body).toMatchObject({ queued: true, reason: "capacity" });
      queued.push(result.body.queueId);
      expect(await userTexts(threadId)).toEqual([]);
      expect(turnsOf(threadId)).toEqual([]);
    }

    await limit(2);
    await started(second!);
    await expect.poll(() => busyThreads(botId)).toHaveLength(2);
    expect(turnsOf(third!)).toEqual([]);
    expect(turnsOf(fourth!)).toEqual([]);

    // Lowering the limit stops nothing that already runs: both turns keep their open provider requests.
    await limit(1);
    expect((await busyThreads(botId)).sort()).toEqual([first, second].sort());
    finish(second!);
    await expect.poll(() => busyThreads(botId)).toEqual([first]);
    expect(turnsOf(third!)).toEqual([]);
    expect(await userTexts(third!)).toEqual([]);

    finish(first!);
    const launchedThird = fixture.fakeChat.requests.indexOf(await started(third!));
    await expect.poll(() => busyThreads(botId)).toEqual([third]);
    expect(turnsOf(fourth!)).toEqual([]);
    finish(third!);
    const launchedFourth = fixture.fakeChat.requests.indexOf(await started(fourth!));
    await expect.poll(() => busyThreads(botId)).toEqual([fourth]);
    expect(fixture.fakeChat.requests.indexOf(turnsOf(second!)[0])).toBeLessThan(launchedThird);
    expect(launchedThird).toBeLessThan(launchedFourth);
    finish(fourth!);
    await expect.poll(() => busyThreads(botId)).toEqual([]);
    for (const [index, threadId] of [second!, third!, fourth!].entries()) {
      const userMessages = await userTexts(threadId);
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]).toMatchObject({ text: `FIFO_${index + 1}`, queueId: queued[index] });
    }
    evidence.push({ fifoThreadOrder: [second, third, fourth] });
  }, 60_000);

  it("counts an approval wait against the slot and keeps queued work waiting until the turn ends", async () => {
    await limit(1);
    const { botId, threads: [first, second] } = await botWithThreads(2);
    expect((await api("PATCH", `/api/bots/${botId}/tasks/${first}`, { approvalMode: "ask" })).status).toBe(200);
    // This turn asks for a shell command at once; under Ask it waits on the person's card, holding its slot.
    // Anchored to the person's words: other threads' prompts quote this message under "Your recent work".
    fixture.fakeChat.set({ routes: [{ match: "APPROVAL_HOLDS_SLOT\\s*$", mode: "happy", toolCalls: [{ name: "shell", input: { command: "ls -la ./dist" } }] }] });
    expect((await send(botId, first!, "APPROVAL_HOLDS_SLOT")).body.queued).toBeUndefined();
    await expect.poll(async () => (await botState(botId)).tasks.find((task: any) => task.threadId === first).activity, { timeout: 15_000 }).toBe("waiting-on-you");
    expect(await busyThreads(botId)).toEqual([first]);
    const waiting = await send(botId, second!, "FIFO_AFTER_APPROVAL", "capacity_after_approval");
    expect(waiting.body).toMatchObject({ queued: true, reason: "capacity" });
    expect(turnsOf(second!)).toEqual([]);
    const card = (await messages(first!)).findLast((message) => message.card?.requestId && !message.card.answered)?.card;
    expect(card).toBeDefined();
    expect((await api("POST", `/api/bots/${botId}/respond`, { threadId: first, requestId: card.requestId, behavior: "allow" })).status).toBe(200);
    await started(second!);
    await expect.poll(() => busyThreads(botId)).toEqual([second]);
    expect(await userTexts(second!)).toEqual([expect.objectContaining({ text: "FIFO_AFTER_APPROVAL", queueId: waiting.body.queueId })]);
    finish(second!);
    await expect.poll(() => busyThreads(botId)).toEqual([]);
    // The queued turn held its slot on its own gate; it never ran the first turn's scripted tool call.
    expect(fixture.fakeChat.requests.filter((request: any) => folderOf(request) === second && request.messages?.at(-1)?.role === "tool")).toEqual([]);
    expect(existsSync(join(fixture.info.dataDir, `${first}.gate`))).toBe(false);
  }, 45_000);
});
