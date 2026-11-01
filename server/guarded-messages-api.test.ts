// Guarded external messages on the native engine (audit COV1): the verification server's fake OpenAI-compatible
// provider holds each thread's turn until <dataDir>/<thread>.gate exists, so a test decides when a turn settles.
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-rootclaw.ts";
import { FAKE_OPENAI_MODEL } from "./testing/fake-openai-chat.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

type Bot = { id: string; activeTaskId: string };
type Message = { id: string; role: string; kind: string; text?: string; sendId?: string; steered?: boolean; turnTerminal?: boolean };
type Page = { messages: Message[]; activeLeafId: string | null };

describe("guarded external messages through an isolated runtime (native engine)", () => {
  let fixture: VerificationServer;
  let evidence: unknown[];

  const api = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, result });
    return result;
  };
  const folderOf = (request: any): string | undefined => {
    const system = (request.messages as any[] | undefined)?.find((message) => message.role === "system")?.content;
    const match = /"currentWorkingFolder":\s*"([^"]+)"/.exec(typeof system === "string" ? system : JSON.stringify(system ?? ""));
    return match ? basename(JSON.parse(`"${match[1]}"`)) : undefined;
  };
  /** Turns the provider was asked to start for a thread (streamed requests that end on the person's words). */
  const turnsOf = (threadId: string) => fixture.fakeChat.requests
    .filter((request: any) => request.stream === true && request.messages?.at(-1)?.role === "user" && folderOf(request) === threadId);
  const launched = async (threadId: string) => {
    await expect.poll(() => turnsOf(threadId).length, { timeout: 15_000 }).toBeGreaterThan(0);
  };
  const botState = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId);
  const threadBusy = async (bot: Bot, threadId: string) => Boolean((await botState(bot.id)).tasks.find((task: any) => task.threadId === threadId)?.busy);
  const newBot = async (): Promise<Bot> => {
    const created = await api("POST", "/api/bots", { name: "Guarded message fixture", modelSelection: { instanceId: "openaiCompat", model: FAKE_OPENAI_MODEL } });
    expect(created.status).toBe(201);
    const id = created.body.bot.id as string;
    const task = await api("POST", `/api/bots/${id}/tasks`, { title: "External guarded task" });
    expect(task.status).toBe(201);
    const activeTaskId = task.body.task.threadId;
    expect((await api("PATCH", `/api/bots/${id}/tasks/${activeTaskId}`, { approvalMode: "ask" })).status).toBe(200);
    return { id, activeTaskId };
  };
  const page = async (threadId: string): Promise<Page> => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body;
  const gate = (threadId: string) => join(fixture.info.dataDir, `${threadId}.gate`);
  const settled = async (bot: Bot, threadId: string) => {
    await expect.poll(() => threadBusy(bot, threadId), { timeout: 15_000 }).toBe(false);
  };
  const finish = async (bot: Bot, threadId = bot.activeTaskId) => {
    await launched(threadId);
    writeFileSync(gate(threadId), "finish the isolated fake turn");
    await settled(bot, threadId);
    rmSync(gate(threadId)); // A later turn on this thread waits for its own gate.
  };
  const normalSend = (bot: Bot, threadId: string, text: string) => api("POST", `/api/bots/${bot.id}/messages`, { threadId, text });
  const guarded = (bot: Bot, body: Record<string, unknown>) => api("POST", `/api/bots/${bot.id}/messages/guarded`, body);
  const payload = (bot: Bot, text: string, leaf: string | null = null) => ({ threadId: bot.activeTaskId, sendId: randomUUID(), text, expectedActiveLeafId: leaf });
  const noQueuedWork = async (threadId: string) => {
    const inventory = (await api("GET", "/api/bots?messages=0")).body;
    expect(inventory.botQueuedMessages?.[threadId] ?? []).toEqual([]);
  };
  const userTexts = async (threadId: string) => (await page(threadId)).messages.filter((message) => message.role === "user").map((message) => message.text);

  beforeEach(async () => {
    evidence = [];
    fixture = await launchVerificationServer();
    fixture.fakeChat.set({ mode: "slow", gates: fixture.info.dataDir });
  }, 30_000);

  afterEach(async () => {
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.guarded-messages.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, limitation: "Actual runtime and guarded HTTP route with fake provider only. No live accounts, paid calls or user data." }, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  });

  it("advertises the authenticated capability and rejects malformed, foreign and unauthenticated targets", async () => {
    expect((await api("GET", "/api/health")).body.capabilities).toMatchObject({ guardedMessages: 1 });
    const bot = await newBot(), input = payload(bot, "STRICT_GUARD_INPUT");
    for (const invalid of [
      { threadId: input.threadId, text: input.text, sendId: input.sendId },
      { ...input, sendId: "short" }, { ...input, expectedActiveLeafId: "../elsewhere" },
      { ...input, unrecognizedOption: true },
    ]) expect((await guarded(bot, invalid)).status).toBe(400);
    const foreign = await newBot();
    expect((await guarded(bot, { ...input, threadId: foreign.activeTaskId })).status).toBe(409);
    expect((await api("POST", `/api/bots/${bot.id}/messages/guarded`, input, { origin: "https://untrusted.example.test" })).status).toBe(403);
    expect((await api("POST", `/api/bots/${bot.id}/messages/guarded`, input, { "x-forwarded-for": "203.0.113.5" })).status).toBe(403);
    expect((await page(bot.activeTaskId)).messages).toEqual([]);
    expect((await page(foreign.activeTaskId)).messages).toEqual([]);
    expect(turnsOf(bot.activeTaskId)).toEqual([]);
    await noQueuedWork(bot.activeTaskId);
  });

  it("replays only the canonical receipt after a lost response, completion and stale leaf", async () => {
    const bot = await newBot(), input = payload(bot, "LOST_RECEIPT_MUST_NOT_REPEAT");
    // Lose the successful HTTP body after the server has durably accepted it.
    const lost = await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages/guarded`, {
      method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify(input),
    });
    expect(lost.status).toBe(202); await lost.body?.cancel();
    evidence.push({ lostSuccessfulBody: true, input });
    const retry = await guarded(bot, input);
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ ok: true, threadId: bot.activeTaskId, message: { sendId: input.sendId, text: input.text } });
    expect(retry.body.queued).toBeUndefined(); expect(retry.body.steered).toBeUndefined();
    await finish(bot);
    expect(turnsOf(bot.activeTaskId)).toHaveLength(1);
    const after = await page(bot.activeTaskId);
    expect(after.messages.filter(message => message.sendId === input.sendId)).toHaveLength(1);
    expect(after.messages.some(message => message.turnTerminal && message.role === "bot")).toBe(true);
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { approvalMode: "auto" })).status).toBe(200);
    const settledRetry = await guarded(bot, input);
    expect(settledRetry.status).toBe(202); expect(settledRetry.body.message.id).toBe(retry.body.message.id);
    expect((await guarded(bot, { ...input, text: "DIFFERENT_BODY_SAME_ID" })).status).toBe(409);
    expect((await page(bot.activeTaskId)).messages).toEqual(after.messages);
    expect(turnsOf(bot.activeTaskId)).toHaveLength(1);
    await noQueuedWork(bot.activeTaskId);
  }, 30_000);

  it("rejects a changed leaf and unsafe permissions without appending or dispatching", async () => {
    const bot = await newBot();
    expect((await normalSend(bot, bot.activeTaskId, "FIRST_NORMAL_TURN")).status).toBe(202);
    await finish(bot);
    const baseline = await page(bot.activeTaskId);
    expect(baseline.activeLeafId).not.toBeNull();
    const stale = await guarded(bot, payload(bot, "STALE_BRANCH_MUST_NOT_RUN"));
    expect(stale.status).toBe(409); expect(stale.body.code).toBe("guarded_branch");
    expect((await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { approvalMode: "auto" })).status).toBe(200);
    const unsafe = await guarded(bot, payload(bot, "AUTO_MUST_NOT_RUN", baseline.activeLeafId));
    expect(unsafe.status).toBe(409); expect(unsafe.body.code).toBe("guarded_permissions");
    expect((await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", alwaysAllow: ["Bash:fixture"] })).status).toBe(200);
    const remembered = await guarded(bot, payload(bot, "REMEMBERED_MUST_NOT_RUN", baseline.activeLeafId));
    expect(remembered.status).toBe(409); expect(remembered.body.code).toBe("guarded_permissions");
    expect((await page(bot.activeTaskId)).messages).toEqual(baseline.messages);
    expect(turnsOf(bot.activeTaskId)).toHaveLength(1);
    await noQueuedWork(bot.activeTaskId);
  }, 30_000);

  it("does not steer an active normal turn or queue behind exhausted capacity", async () => {
    const bot = await newBot();
    expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
    const sibling = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Guarded idle sibling", approvalMode: "ask" });
    expect(sibling.status).toBe(201);
    expect((await normalSend(bot, bot.activeTaskId, "NORMAL_TURN_OWNS_THE_THREAD")).status).toBe(202);
    await launched(bot.activeTaskId);
    const current = await page(bot.activeTaskId);
    const busy = await guarded(bot, payload(bot, "GUARDED_MUST_NOT_STEER", current.activeLeafId));
    expect(busy.status).toBe(409); expect(busy.body.code).toBe("guarded_busy");
    const blockedThread = sibling.body.task.threadId;
    const capacity = await guarded(bot, { ...payload(bot, "GUARDED_MUST_NOT_QUEUE"), threadId: blockedThread });
    expect(capacity.status).toBe(409); expect(capacity.body.code).toBe("guarded_busy");
    await noQueuedWork(bot.activeTaskId); await noQueuedWork(blockedThread);
    expect(await userTexts(bot.activeTaskId)).toEqual(["NORMAL_TURN_OWNS_THE_THREAD"]);
    expect((await page(bot.activeTaskId)).messages.some((message) => message.steered)).toBe(false);
    expect((await page(blockedThread)).messages).toEqual([]);
    await finish(bot);
    // The held turn saw only its own words: nothing was steered into its provider conversation.
    expect(fixture.fakeChat.requests.filter((request: any) => folderOf(request) === bot.activeTaskId)
      .some((request: any) => JSON.stringify(request.messages).includes("GUARDED_MUST_NOT_STEER"))).toBe(false);
    expect((await page(blockedThread)).messages).toEqual([]);
    expect(turnsOf(blockedThread)).toEqual([]);
  }, 30_000);

  it("admits only one concurrent guarded send while duplicate identities share its receipt", async () => {
    const bot = await newBot(), first = payload(bot, "FIRST_CONCURRENT_GUARDED"), second = payload(bot, "SECOND_CONCURRENT_GUARDED");
    const results = await Promise.all([guarded(bot, first), guarded(bot, second)]);
    expect(results.map(result => result.status).sort()).toEqual([202, 409]);
    const accepted = results.find(result => result.status === 202)!;
    expect(results.find(result => result.status === 409)!.body.code).toBe("guarded_branch");
    const original = accepted.body.message.sendId === first.sendId ? first : second;
    const loser = original === first ? second : first;
    const retries = await Promise.all([guarded(bot, original), guarded(bot, original)]);
    expect(retries.map(result => result.status)).toEqual([202, 202]);
    expect(retries.every(result => result.body.message.id === accepted.body.message.id)).toBe(true);
    expect(retries.every(result => !result.body.steered && !result.body.queued)).toBe(true);
    await launched(bot.activeTaskId);
    expect((await page(bot.activeTaskId)).messages.some((message) => message.steered)).toBe(false);
    expect((await page(bot.activeTaskId)).messages.filter(message => message.role === "user")).toHaveLength(1);
    await noQueuedWork(bot.activeTaskId);
    await finish(bot);
    expect(turnsOf(bot.activeTaskId)).toHaveLength(1);
    expect(fixture.fakeChat.requests.some((request: any) => JSON.stringify(request.messages ?? []).includes(loser.text))).toBe(false);
  }, 30_000);

  it("reports an exact request and stops only its snapshotted execution", async () => {
    expect((await api("GET", "/api/health")).body.capabilities.guardedRequests).toBe(1);
    const bot = await newBot(), input = payload(bot, "EXACT_REQUEST_TO_STOP");
    const accepted = await guarded(bot, input);
    expect(accepted.status).toBe(202);
    await launched(bot.activeTaskId);
    const route = `/api/bots/${bot.id}/requests/${input.sendId}`;
    await expect.poll(async () => (await api("GET", `${route}?threadId=${bot.activeTaskId}`)).body.phase, { timeout: 15_000 }).toBe("working");
    const snapshot = (await api("GET", `${route}?threadId=${bot.activeTaskId}`)).body;
    expect(snapshot).toMatchObject({ messageId: accepted.body.message.id, phase: "working" });
    expect(typeof snapshot.activeTurnId).toBe("string");
    expect(typeof snapshot.executionId).toBe("string");
    const target = { threadId: bot.activeTaskId, messageId: snapshot.messageId, expectedActiveLeafId: snapshot.activeLeafId,
      expectedTurnId: snapshot.activeTurnId, expectedExecutionId: snapshot.executionId };
    expect((await api("POST", `${route}/interrupt`, { ...target, expectedExecutionId: null })).status).toBe(409);
    expect((await api("POST", `${route}/interrupt`, { ...target, expectedTurnId: "foreign-turn" })).status).toBe(409);
    expect((await api("POST", `${route}/interrupt`, { ...target, extra: true })).status).toBe(400);
    expect((await api("POST", `${route}/interrupt`, target, { origin: "https://untrusted.example.test" })).status).toBe(403);
    const stopped = await api("POST", `${route}/interrupt`, target);
    expect(stopped).toMatchObject({ status: 200, body: { ok: true, outcome: "stopped" } });
    await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 15_000 }).toBe(false);
    expect((await api("POST", `${route}/interrupt`, target)).status).toBe(409);
    expect(existsSync(gate(bot.activeTaskId))).toBe(false);
  }, 30_000);

  it("keeps old stop receipts from reaching a later human turn and rejects foreign threads", async () => {
    const bot = await newBot(), input = payload(bot, "FIRST_REQUEST_COMPLETE");
    expect((await guarded(bot, input)).status).toBe(202);
    await finish(bot);
    const route = `/api/bots/${bot.id}/requests/${input.sendId}`;
    const done = (await api("GET", `${route}?threadId=${bot.activeTaskId}`)).body;
    expect(done.phase).toBe("settled");
    const final = done.messages.find((message: any) => message.turnTerminal);
    expect(final.requestMessageId).toBe(done.messageId);
    const target = { threadId: bot.activeTaskId, messageId: done.messageId, expectedActiveLeafId: done.activeLeafId,
      expectedTurnId: done.activeTurnId, expectedExecutionId: done.executionId };
    expect((await api("POST", `${route}/interrupt`, target)).status).toBe(409);
    const other = await newBot();
    expect((await api("GET", `${route}?threadId=${other.activeTaskId}`)).status).toBe(409);
    expect((await normalSend(bot, bot.activeTaskId, "A_LATER_HUMAN_REQUEST")).status).toBe(202);
    expect((await api("GET", `${route}?threadId=${bot.activeTaskId}`))).toMatchObject({ status: 409, body: { code: "guarded_request_changed" } });
    expect((await api("POST", `${route}/interrupt`, target)).status).toBe(409);
    expect(await threadBusy(bot, bot.activeTaskId)).toBe(true);
    await expect.poll(() => turnsOf(bot.activeTaskId).length, { timeout: 15_000 }).toBe(2);
    await finish(bot);
  }, 30_000);
});

it("refuses a parked conversation after its own provider settles while its teammate is still working", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    evidence.push({ method, path, body, result }); return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: ["control:rootclaw", ...args, "--url", fixture.info.url], result }); return result;
  };
  try {
    const chief = (await control(["new-bot", "--name", "Guarded coordinator", "--section", "Leadership"])).bot;
    const teammate = (await control(["new-bot", "--name", "Guarded teammate", "--section", "Engineering"])).bot;
    expect((await api("PATCH", `/api/bots/${chief.id}`, {
      chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true, parkDirectMessages: true,
    })).status).toBe(200);
    const gate = join(fixture.info.dataDir, "guarded-teammate.gate");
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({
      [chief.id]: {
        steps: [{ arguments: { bot_ids: [teammate.id], request_key: "guard-check", message: "Complete the gated fixture check." } }],
        reply: "The teammate owns the outstanding check.", resumeReply: "The guarded fixture check is complete.",
      },
      [teammate.id]: { gateFile: gate, reply: "The gated check passed." },
    }));
    await control(["send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Coordinate the gated fixture check."]);
    const nodes = () => readHandoffs(fixture.info.dataDir);
    await expect.poll(() => { try { return nodes().find(node => node.botId === teammate.id)?.status; } catch { return undefined; } }, { timeout: 15_000 }).toBe("running");
    // This no-op PATCH succeeds only once the task's raw busy flag and its dispatch claim are both released.
    await expect.poll(async () => (await api("PATCH", `/api/bots/${chief.id}/tasks/${chief.activeTaskId}`, { approvalMode: "ask" })).status,
      { timeout: 15_000 }).toBe(200);
    const pagePath = `/api/threads/${chief.activeTaskId}/messages?limit=100`;
    const baseline = (await api("GET", pagePath)).body as Page;
    expect(baseline.messages.some(message => message.text === "The teammate owns the outstanding check." && message.turnTerminal)).toBe(true);
    expect(nodes().find(node => node.botId === teammate.id)?.status).toBe("running");
    const refusal = await api("POST", `/api/bots/${chief.id}/messages/guarded`, {
      threadId: chief.activeTaskId, sendId: randomUUID(), text: "THIS_GUARDED_FOLLOWUP_MUST_NOT_RUN", expectedActiveLeafId: baseline.activeLeafId,
    });
    expect(refusal).toMatchObject({ status: 409, body: { code: "guarded_busy" } });
    expect((await api("GET", pagePath)).body).toEqual(baseline);
    expect((await api("GET", "/api/bots?messages=0")).body.botQueuedMessages?.[chief.activeTaskId] ?? []).toEqual([]);
    writeFileSync(gate, "finish only the isolated teammate");
    expect((await control(["wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "15"])).status).toBe("settled");
    const final = await control(["messages", "--bot", chief.id, "--task", chief.activeTaskId, "--limit", "20"]);
    expect(final.messages.some((message: Message) => message.text === "The guarded fixture check is complete.")).toBe(true);
    expect(final.messages.some((message: Message) => message.text === "THIS_GUARDED_FOLLOWUP_MUST_NOT_RUN")).toBe(false);
  } finally {
    const evidencePath = `${fixture.info.logPath}.guarded-coordination.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, limitation: "Actual runtime and gated fake teammate only; no live accounts, providers, or user data." }, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
}, 45_000);
