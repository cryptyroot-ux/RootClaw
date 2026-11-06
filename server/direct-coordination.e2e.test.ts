import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-rootclaw.ts";
import { request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { openSse } from "./testing/sse.ts";

const promptOf = (turn: any): string => typeof turn.prompt === "string" ? turn.prompt : turn.prompt?.message?.content ?? "";
const told = (turn: any): string => `${turn.system}\n${promptOf(turn)}`;
const requestForBot = (f: any, bot: any): any => f.session.fakeChat.requests.findLast((request: any) =>
  request.messages?.some((message: any) => message.role === "system" &&
    String(message.content).match(/"sharedBotFolder":\s*"([^"]+)"/)?.[1]?.endsWith(`/${bot.id}`)));
const requestsForThread = (f: any, threadId: string): any[] => f.session.fakeChat.requests.filter((request: any) =>
  request.messages?.some((message: any) => message.role === "system" && String(message.content).includes(threadId)));
const requestForThread = (f: any, threadId: string): any => requestsForThread(f, threadId).at(-1);
const nativeToolResults = (f: any, threadId: string) => {
  const seen = new Set<string>();
  const results: Array<{ name: string; response: any; output: string }> = [];
  for (const request of f.session.fakeChat.requests) {
    const messages = request.messages as any[] | undefined;
    if (!messages?.some((message) => message.role === "system" && String(message.content).includes(threadId))) continue;
    const names = new Map<string, string>();
    for (const message of messages) {
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) if (call.id) names.set(call.id, call.function?.name ?? "");
      }
      if (message.role !== "tool" || !message.tool_call_id || seen.has(message.tool_call_id)) continue;
      seen.add(message.tool_call_id);
      let response: any;
      try { response = JSON.parse(String(message.content)); } catch { response = { result: String(message.content) }; }
      const value = response.result ?? response.error ?? response;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const wrapped = /^<<<UNTRUSTED TOOL OUTPUT nonce=[^\n]+>>>\n([\s\S]*?)\n<<<END UNTRUSTED TOOL OUTPUT nonce=[^\n]+>>>$/.exec(text);
      results.push({ name: names.get(message.tool_call_id) ?? "", response, output: wrapped?.[1] ?? text });
    }
  }
  return results;
};

/** With ROOTCLAW_TEST_DESKTOP_OWNER_TOKEN it runs as the desktop app runs it, every change carrying the app's owner capability. */
async function fixture(test: (f: any) => Promise<void>, fakeEnv: NodeJS.ProcessEnv = {}) {
  const desktopOwner = fakeEnv.ROOTCLAW_TEST_DESKTOP_OWNER_TOKEN;
  const realFetch = globalThis.fetch;
  if (desktopOwner) globalThis.fetch = (input, init = {}) => realFetch(input, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), "x-rootclaw-desktop-owner": desktopOwner } });
  try { await fixtureSession(test, fakeEnv); } finally { globalThis.fetch = realFetch; }
}

async function fixtureSession(test: (f: any) => Promise<void>, fakeEnv: NodeJS.ProcessEnv) {
  const session = await launchVerificationServer({ ...process.env, ...fakeEnv }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { ROOTCLAW_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Leadership")).bot;
    const lead = (await cli("new-bot", "--name", "Engineering lead", "--section", "Engineering")).bot;
    const specialist = (await cli("new-bot", "--name", "Reviewer", "--section", "Engineering")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {
      [chief.id]: { steps: [{ arguments: { bot_ids: [lead.id], message: "Implement and independently verify the CSV export" } }], reply: "Assigned to Engineering", resumeReply: "The requested CSV export is implemented and verified" },
      [lead.id]: { steps: [{ arguments: { bot_ids: [specialist.id], message: "Independently verify the CSV export" } }], reply: "Sent for verification", resumeReply: "Implemented and reviewer confirmed checks" },
      [specialist.id]: { reply: "CSV boundary cases verified" },
    };
    const save = () => writeFileSync(planPath, JSON.stringify(plan));
    const nodes = () => readHandoffs(session.info.dataDir);
    const eventsOf = (id: string): string[] => {
      const db = new DatabaseSync(join(session.info.dataDir, "runtime.db"), { readOnly: true });
      try {
        return (db.prepare("SELECT kind FROM assignment_events WHERE assignment_id = ? ORDER BY id").all(id) as Array<{ kind: string }>).map(row => row.kind);
      } finally { db.close(); }
    };
    const evidence = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const start = async () => { save(); return cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Please have Engineering build and independently verify a CSV export. Own the result."); };
    const wait = () => cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30");
    await test({ session, cli, api, chief, lead, specialist, plan, save, start, wait, nodes, eventsOf, evidence, messages });
  } finally { await session.close(); }
}

it("sends cross-bot work onward without resuming either sender", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "sent-work-ready");
  f.plan[f.chief.id] = { steps: [{ arguments: {
    bot_ids: [f.lead.id], message: "Own the release and send final QA to Reviewer.", thread: "new", reply: "none",
  } }], reply: "Release sent" };
  f.plan[f.lead.id] = { steps: [{ arguments: {
    bot_ids: [f.specialist.id], message: "Own final release QA.", thread: "new", reply: "none",
  } }], reply: "QA sent onward" };
  f.plan[f.specialist.id] = { gateFile: gate, reply: "Release QA complete" };

  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const sendOf = (botId: string) => f.evidence().find((turn: any) => turn.botId === botId)?.evidence
    .find((entry: any) => entry.step?.arguments?.reply === "none")?.response.result;
  const leadSend = () => sendOf(f.lead.id);
  await expect.poll(leadSend, { timeout: 15_000 }).toBeTruthy();
  expect(leadSend().isError).toBeFalsy();
  expect(sendOf(f.chief.id)?.isError).toBeFalsy();
  const sentThread = (botId: string, text: string) => f.nodes().find((node: any) => node.botId === botId && node.text === text)?.threadId;
  const leadThreadId = sentThread(f.lead.id, "Own the release and send final QA to Reviewer.");
  const qaThreadId = sentThread(f.specialist.id, "Own final release QA.");
  expect(leadThreadId).toBeTruthy();
  expect(qaThreadId).toBeTruthy();
  await expect.poll(async () => (await f.api("/api/bots?messages=0")).bots
    .find((bot: any) => bot.id === f.specialist.id)?.busy, { timeout: 15_000 }).toBe(true);
  await f.api(`/api/bots/${f.lead.id}`, { peers: [] }, "PATCH");
  writeFileSync(gate, "finish detached work");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.specialist.id).length, { timeout: 15_000 }).toBe(1);
  const bots = (await f.api("/api/bots")).bots;
  const leadThread = bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.threadId === leadThreadId);
  const qaThread = bots.find((bot: any) => bot.id === f.specialist.id).tasks.find((task: any) => task.threadId === qaThreadId);
  expect(leadThread.title).toBe("Own the release and send final QA to Reviewer.");
  expect(qaThread.title).toBe("Own final release QA.");
  const qaMessages = await f.messages(qaThread.threadId);
  expect(qaMessages.some((message: any) => message.text === "Release QA complete")).toBe(true);
  expect(qaMessages.some((message: any) => message.tool?.name?.includes("Send failed"))).toBe(false);
  expect((await f.messages(leadThread.threadId)).some((message: any) => message.text?.includes("Release QA complete"))).toBe(false);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text?.includes("QA sent") || message.text?.includes("Release QA complete"))).toBe(false);
}), 60_000);

it("marks a failed one-way send so restart recovery cannot duplicate its notice", () => fixture(async f => {
  // The failed send reports an incident to Clive, the lead's Chief; answering it must not send the task again.
  f.plan[f.chief.id] = { steps: [{ arguments: {
    bot_ids: [f.lead.id], message: "Try the task", thread: "new", reply: "none",
  } }], reply: "Sent", byPrompt: [{ promptIncludes: "[Incident report from RootClaw", plan: { reply: "Noted the failed send" } }] };
  f.plan[f.lead.id] = { fail: true };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const failureNotice = async () => {
    const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
    const tasks = lead?.tasks.filter((item: any) => item.title === "Try the task") ?? [];
    expect(tasks.length).toBeLessThanOrEqual(1);
    if (!tasks[0]) return null;
    const messages = await f.messages(tasks[0].threadId);
    return messages.find((message: any) => message.tool?.name?.startsWith("Send failed")) ?? null;
  };
  await expect.poll(failureNotice, { timeout: 15_000 }).toBeTruthy();
  expect((await failureNotice())?.tool?.handoffId).toEqual(expect.any(String));
}), 45_000);

it("lets a bot ask a bot in another department directly, with nothing set up first", () => fixture(async f => {
  // Engineering lead and Clive, the Chief in Leadership: different departments, no peers list, no grant either way.
  await f.api(`/api/bots/${f.chief.id}`, { managedSections: [] }, "PATCH");
  f.plan[f.lead.id] = {
    steps: [{ arguments: { bot_ids: ["Clive"], message: "Can we upgrade to the latest PHP version?", consult: true } }],
    reply: "Asked Clive", resumeReply: "Clive says yes: the latest PHP is fine for us.",
  };
  f.plan[f.chief.id] = { reply: "Yes, the latest PHP version is fine for us." };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "Please ask Clive if we can upgrade to the latest PHP version");
  expect((await f.cli("wait", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--timeout", "30")).status).toBe("settled");
  const asked = f.evidence().find((turn: any) => turn.botId === f.lead.id);
  expect(asked.system).toContain("You can reach every other bot on this team, in every department");
  expect(asked.system).toContain("Clive — General assistant (Leadership) [Chief of Staff]");
  const response = asked.evidence.find((entry: any) => entry.step).response;
  expect(response.result.isError).toBeFalsy();
  const child = f.nodes().find((node: any) => node.parentId);
  expect(child).toMatchObject({ botId: f.chief.id, mode: "consult", status: "completed" });
  const said = await f.messages(f.lead.activeTaskId);
  expect(said.some((message: any) => message.tool?.name === "Sent to Clive")).toBe(true);
  expect(said.some((message: any) => message.text === "Clive says yes: the latest PHP is fine for us.")).toBe(true);
}), 45_000);

it.each([false, true])("starts independent work immediately and frees the Chief while waiting (source fails: %s)", fail => fixture(async f => {
  const sourceGate = join(f.session.info.dataDir, "source-ready");
  const childGate = join(f.session.info.dataDir, "child-ready");
  const childReady = join(f.session.info.dataDir, "child-started");
  f.plan[f.chief.id].gateFile = sourceGate;
  f.plan[f.chief.id].fail = fail;
  f.plan[f.lead.id] = { readyFile: childReady, gateFile: childGate, reply: "CSV export implemented and checked" };
  await f.start();
  await expect.poll(() => f.nodes().find((n: any) => n.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await expect.poll(() => existsSync(childReady), { timeout: 15_000 }).toBe(true);
  const leadPrompt = JSON.stringify(requestForBot(f, f.lead)?.messages);
  expect(leadPrompt).toContain("[LIVE TEAMMATES]");
  expect(leadPrompt).toContain(`[id: ${f.specialist.id}]`);
  expect(f.nodes().find((n: any) => n.botId === f.chief.id).status).toBe("source");
  writeFileSync(sourceGate, "finish the fixture source turn");
  const readChief = async () => (await f.api("/api/bots?messages=0")).bots.find((b: any) => b.id === f.chief.id);
  await expect.poll(async () => {
    const b = await readChief();
    return !b.busy && b.waitingForTeammates && b.tasks.find((t: any) => t.threadId === f.chief.activeTaskId)?.waitingForTeammates;
  }, { timeout: 30_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.chief.activeTaskId}`, { approvalMode: "ask" }, "PATCH");
  expect(f.nodes().find((n: any) => n.botId === f.lead.id).status).toBe("running");
  writeFileSync(childGate, "complete the fixture teammate");
  await expect.poll(() => f.nodes().find((n: any) => n.botId === f.chief.id)?.status, { timeout: 15_000 }).toBe("completed");
  const finalWait = await f.wait();
  expect(finalWait.status).toBe(fail ? "failed" : "settled");
  expect((await f.messages(f.chief.activeTaskId)).filter((m: any) => m.text === f.plan[f.chief.id].resumeReply)).toHaveLength(1);
  await expect.poll(async () => {
    const b = await readChief();
    return { busy: b.busy, waitingForTeammates: b.waitingForTeammates };
  }, { timeout: 15_000 }).toEqual({ busy: false, waitingForTeammates: false });
}), 60_000);

it("coordinates a lead and its specialist from ordinary chat, returns to Clive, and leaves unrelated tasks untouched", () => fixture(async f => {
  const originalLead = await f.messages(f.lead.activeTaskId);
  const originalSpecialist = await f.messages(f.specialist.activeTaskId);
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.specialist.id, f.lead.id, f.chief.id]);
  expect(f.nodes().every((node: any) => !node.groupId && node.status === "completed")).toBe(true);
  expect((await f.api("/api/bots")).groups).toEqual([]);
  expect(await f.messages(f.lead.activeTaskId)).toEqual(originalLead);
  expect(await f.messages(f.specialist.activeTaskId)).toEqual(originalSpecialist);
  const receipt = (await f.messages(f.chief.activeTaskId)).find((message: any) => message.tool?.name === "Sent to Engineering lead");
  expect(receipt.threadRef).toMatchObject({ botId: f.lead.id, threadId: f.nodes().find((node: any) => node.botId === f.lead.id).threadId });
  expect(receipt.threadRef.threadId).not.toBe(f.lead.activeTaskId);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(true);
  const bots = (await f.api("/api/bots")).bots;
  expect(bots.find((bot: any) => bot.id === f.lead.id).managedSections).toBeUndefined();
  const turn = f.evidence().find((entry: any) => entry.botId === f.lead.id);
  const leadRequests = f.session.fakeChat.requests.filter((candidate: any) =>
    candidate.messages?.some((message: any) => message.role === "system" && message.content?.includes(`You are ${f.lead.name},`)),
  );
  const leadTools = leadRequests.flatMap((candidate: any) => candidate.tools ?? []).map((tool: any) => tool.function);
  const loader = leadTools.find((tool: any) => tool.name === "load_tools");
  const deferred = [...String(loader?.description ?? "").matchAll(/^agents_([\w]+):/gm)].map((match) => match[1]);
  const tools = [...new Set([...leadTools.map((tool: any) => tool.name), ...deferred])].map((name) => name.replace(/^agents_/, ""));
  expect(tools).toContain("coordinate_bots");
  expect(tools).toContain("assignment_status");
  for (const alias of ["delegate_bot", "ask_bot", "send_to_bot", "check_delegation", "wait_delegation"]) expect(tools).not.toContain(alias);
  expect(turn.system).toContain("only an actual coordinate_bots result proves that teammate participated");
  expect(bots.find((bot: any) => bot.id === f.lead.id).tasks.find((task: any) => task.threadId === receipt.threadRef.threadId).openedBy)
    .toMatchObject({ botId: f.chief.id, name: "Clive" });
}), 45_000);

it("announces a settled delegation and its resume in the parent thread", () => fixture(async f => {
  const stream = await openSse(`${f.session.info.url}/api/events`);
  try {
    await f.start();
    expect((await f.wait()).status).toBe("settled");
    // f.wait() resolves through the control CLI poll, independent of the SSE reader: until() proves both settles are stored first.
    await Promise.all([
      stream.until(frame => frame.kind === "notify"
        && frame.notification?.kind === "delegation-settled"
        && frame.notification.botId === f.chief.id),
      stream.until(frame => frame.kind === "notify"
        && frame.notification?.kind === "delegation-settled"
        && frame.notification.botId === f.lead.id),
    ]);
    const settles = () => stream.frames.filter(frame => frame.kind === "notify" && frame.notification?.kind === "delegation-settled");
    const chiefFrames = settles().filter(frame => frame.notification.botId === f.chief.id);
    expect(chiefFrames).toHaveLength(1);
    expect(chiefFrames[0].notification).toMatchObject({
      threadId: f.chief.activeTaskId,
      title: "Clive resumed with results",
      body: "Results in from Engineering lead",
    });
    const leadFrames = settles().filter(frame => frame.notification.botId === f.lead.id);
    expect(leadFrames).toHaveLength(1);
    expect(leadFrames[0].notification.threadId).not.toBe(f.lead.activeTaskId);
    expect(settles().some(frame => frame.notification.botId === f.specialist.id)).toBe(false);
    expect(stream.frames.some(frame => frame.kind === "notify" && frame.notification?.kind === "done"
      && (frame.notification.botId === f.lead.id || frame.notification.botId === f.specialist.id))).toBe(false);
    const chips = (await f.messages(f.chief.activeTaskId))
      .filter((message: any) => message.kind === "activity" && message.tool?.name.startsWith("Resumed with "));
    expect(chips.map((message: any) => message.tool.name)).toEqual(["Resumed with Engineering lead results, reviewing"]);
  } finally { stream.close(); }
}), 45_000);

it.each(["resume", "stop", "failed resume", "failed root"] as const)("keeps a guarded Chief request exact through coordination and %s", action => fixture(async f => {
  const threadId = f.chief.activeTaskId;
  const sendId = randomUUID();
  const route = `/api/bots/${f.chief.id}/requests/${sendId}`;
  const gate = join(f.session.info.dataDir, "guarded-coordination.gate");
  const evidence: unknown[] = [{ fixture: f.session.info, action }];
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(f.session.info.url + path, { method,
      headers: { "content-type": "application/json", origin: f.session.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected); return result;
  };
  try {
    await api("PATCH", `/api/bots/${f.chief.id}`, { parkDirectMessages: true });
    await api("PATCH", `/api/bots/${f.chief.id}/tasks/${threadId}`, { approvalMode: "ask" });
    f.plan[f.lead.id] = { gateFile: gate, reply: "The gated CSV export check passed" };
    f.plan[f.chief.id].failResumed = action === "failed resume";
    f.save();
    const before = await api("GET", `/api/threads/${threadId}/messages`);
    const accepted = await api("POST", `/api/bots/${f.chief.id}/messages/guarded`, {
      threadId, sendId, text: "Coordinate the gated CSV export check and own the result.", expectedActiveLeafId: before.activeLeafId,
    }, 202);
    const snapshot = () => api("GET", `${route}?threadId=${threadId}`);
    await expect.poll(async () => {
      const current = await snapshot();
      return current.phase === "waiting" && current.activeTurnId === null &&
        current.messages.some((message: any) => message.text === "Assigned to Engineering" && message.turnTerminal);
    }, { timeout: 15_000 }).toBe(true);
    const waiting = await snapshot();
    expect(waiting).toMatchObject({ messageId: accepted.message.id, phase: "waiting", activeTurnId: null, executionId: expect.any(String) });
    expect(waiting.messages[0]).toMatchObject({ id: accepted.message.id, sendId, role: "user" });
    expect(waiting.messages.at(-1).id).toBe(waiting.activeLeafId);
    expect(waiting.messages.find((message: any) => message.text === "Assigned to Engineering").requestMessageId).toBe(accepted.message.id);
    await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
    const child = f.nodes().find((node: any) => node.botId === f.lead.id);
    await api("PATCH", `/api/bots/${f.chief.id}/tasks/${threadId}`, { approvalMode: "ask" });
    const target = { threadId, messageId: waiting.messageId, expectedActiveLeafId: waiting.activeLeafId,
      expectedTurnId: waiting.activeTurnId, expectedExecutionId: waiting.executionId };
    if (action === "failed root") {
      await api("PATCH", `/api/bots/${f.chief.id}`, { chiefOfStaff: false, hidden: true });
      writeFileSync(gate, "release the isolated teammate after its root lost its Chief");
      await expect.poll(() => f.nodes().find((node: any) => node.id === waiting.executionId)?.status, { timeout: 15_000 }).toBe("failed");
      const finalWait = await f.wait();
      evidence.push({ command: ["wait", "--bot", f.chief.id, "--task", threadId, "--timeout", "30"], result: finalWait });
      expect(finalWait.status).toBe("settled");
      const failed = await snapshot();
      expect(failed).toMatchObject({ messageId: accepted.message.id, phase: "untracked", activeTurnId: null, executionId: waiting.executionId });
      expect(failed.messages[0].requestPending).toBe(true);
      expect(failed.messages[0].requestCancelled).not.toBe(true);
      expect(failed.messages.find((message: any) => message.turnTerminal)).toMatchObject({
        text: "Assigned to Engineering", requestMessageId: accepted.message.id, turnSucceeded: true,
      });
      expect(failed.messages.some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
      expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
      evidence.push({ command: ["messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30"],
        result: await f.cli("messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30") });
      return;
    }
    if (action === "stop") {
      await api("POST", `${route}/interrupt`, { ...target, expectedExecutionId: null }, 409);
      expect(await api("POST", `${route}/interrupt`, target)).toEqual({ ok: true, outcome: "stopped" });
      await api("POST", `${route}/interrupt`, target, 409);
      expect(f.nodes().find((node: any) => node.botId === f.lead.id).status).toBe("running");
    }
    writeFileSync(gate, "finish only the isolated teammate");
    const childWait = await f.cli("wait", "--bot", f.lead.id, "--task", child.threadId, "--timeout", "20");
    evidence.push({ command: ["wait", "--bot", f.lead.id, "--task", child.threadId, "--timeout", "20"], result: childWait });
    expect(childWait.status).toBe("settled");
    await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id).status).toBe("completed");
    const finalWait = await f.wait();
    evidence.push({ command: ["wait", "--bot", f.chief.id, "--task", threadId, "--timeout", "30"], result: finalWait });
    expect(action === "failed resume" ? ["settled", "failed"] : ["settled"]).toContain(finalWait.status);
    if (action === "stop") {
      // Give an erroneously queued resume time to handshake and publish a turn.
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
      const messages = await f.messages(threadId);
      expect(new Set(messages.filter((message: any) => message.turnId).map((message: any) => message.turnId)).size).toBe(1);
      expect(messages.some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
      await api("POST", `${route}/interrupt`, target, 409);
    } else if (action === "failed resume") {
      const failed = await snapshot();
      expect(failed).toMatchObject({ messageId: accepted.message.id, phase: "untracked", activeTurnId: null });
      expect(failed.executionId).not.toBe(waiting.executionId);
      const initial = failed.messages.find((message: any) => message.turnTerminal);
      expect(initial).toMatchObject({ text: "Assigned to Engineering", requestMessageId: accepted.message.id, turnSucceeded: true });
      expect(failed.messages.findLast((message: any) => message.turnSucceeded !== undefined).turnSucceeded).toBe(false);
      expect(failed.messages.some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
      expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.chief.id]);
      await api("POST", `${route}/interrupt`, target, 409);
    } else {
      const settled = await snapshot();
      expect(settled).toMatchObject({ messageId: accepted.message.id, phase: "settled", activeTurnId: null, executionId: expect.any(String) });
      expect(settled.executionId).not.toBe(waiting.executionId);
      expect(settled.messages[0].id).toBe(accepted.message.id);
      expect(settled.messages.at(-1).id).toBe(settled.activeLeafId);
      for (let index = 1; index < settled.messages.length; index++) expect(settled.messages[index].parentId).toBe(settled.messages[index - 1].id);
      const replies = settled.messages.filter((message: any) => message.role === "bot" && message.kind === "text" && message.turnTerminal);
      expect(replies.map((message: any) => message.text)).toEqual(["Assigned to Engineering", "The requested CSV export is implemented and verified"]);
      expect(new Set(replies.map((message: any) => message.turnId)).size).toBe(2);
      expect(settled.messages.filter((message: any) => message.turnId).every((message: any) => message.requestMessageId === accepted.message.id)).toBe(true);
      expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.chief.id]);
      await api("POST", `${route}/interrupt`, target, 409);
    }
    evidence.push({ command: ["messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30"],
      result: await f.cli("messages", "--bot", f.chief.id, "--task", threadId, "--limit", "30") });
  } finally {
    const evidencePath = `${f.session.info.logPath}.guarded-coordination-${action.replaceAll(" ", "-")}.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath, logPath: f.session.info.logPath }));
  }
}), 45_000);

it("opens a fresh thread on a teammate with coordinate_bots thread \"new\" and gets the result back", () => fixture(async f => {
  const originalLead = await f.messages(f.lead.activeTaskId);
  f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], message: "NEW_THREAD_BRIEF verify the CSV export yourself", thread: "new" } }],
    reply: "Opened a fresh thread", resumeReply: "The fresh thread reported back" };
  f.plan[f.lead.id] = { reply: "NEW_THREAD_RESULT verified" };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const answered = f.evidence()[0].evidence.find((entry: any) => entry.step?.arguments?.thread === "new").response.result;
  expect(answered.isError).toBeFalsy();
  expect(nativeToolResults(f, f.chief.activeTaskId).find((entry) => entry.name === "agents_coordinate_bots")?.output).not.toMatch(/Deprecated|alias/);
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  expect(child).toMatchObject({ mode: "work", reply: "resume", status: "completed", text: expect.stringContaining("NEW_THREAD_BRIEF") });
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks.find((task: any) => task.threadId === child.threadId)).toMatchObject({ title: "NEW_THREAD_BRIEF verify the CSV export yourself", openedBy: { botId: f.chief.id, name: "Clive" } });
  expect(child.threadId).not.toBe(f.lead.activeTaskId);
  expect(await f.messages(f.lead.activeTaskId)).toEqual(originalLead);
  expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.lead.id, f.chief.id]);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied" && message.tool.output === "NEW_THREAD_RESULT verified")).toBe(true);
}), 45_000);

it("names a fresh teammate thread with coordinate_bots title", () => fixture(async f => {
  f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], message: "TITLED_BRIEF verify the CSV export yourself", thread: "new", title: "CSV export: verify" } }],
    reply: "Opened a titled thread", resumeReply: "The titled thread reported back" };
  f.plan[f.lead.id] = { reply: "TITLED_RESULT verified" };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const answered = f.evidence()[0].evidence.find((entry: any) => entry.step?.arguments?.title).response.result;
  expect(answered.isError).toBeFalsy();
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks.find((task: any) => task.threadId === child.threadId)).toMatchObject({ title: "CSV export: verify", openedBy: { botId: f.chief.id, name: "Clive" } });
}), 45_000);

it("lets the opener find and close the completed task", () => fixture(async f => {
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks).toHaveLength(2);
  f.plan[f.chief.id] = {
    steps: [
      { tool: "list_threads", arguments: {} },
      { tool: "close_thread", arguments: { thread_id: child.threadId } },
      { tool: "list_threads", arguments: {} },
    ],
    reply: "I read the result and closed its completed task",
  };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Find the completed engineering task and close it after reading the result.");
  expect((await f.wait()).status).toBe("settled");
  const listed = nativeToolResults(f, f.chief.activeTaskId).filter((entry) => entry.name === "agents_list_threads");
  expect(listed).toHaveLength(2);
  expect(listed[0].output).toContain(child.threadId);
  expect(listed[0].output).not.toContain(f.lead.activeTaskId);
  expect(listed[1].output).toContain("closed");
  const closedLead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(closedLead.tasks.find((task: any) => task.threadId === child.threadId).closedBy).toMatchObject({ botId: f.chief.id });
  expect((await f.messages(child.threadId)).some((message: any) => message.text === "Implemented and reviewer confirmed checks")).toBe(true);
}), 45_000);

it("does not treat self-opened work or an abandoned human branch as new human authority", () => fixture(async f => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 1 } }, "PUT");
  const room = (await f.cli("new-channel", "--name", "Updates", "--members", f.chief.id, "--section", "Leadership")).channel;
  const post = (message: string, expectError = false) => ({ tool: "post_to_room", arguments: { group_id: room.id, message }, expectError });
  f.plan[f.chief.id] = { turns: [
    { steps: [post("First update"), post("Second update"), { tool: "start_thread", arguments: { title: "Independent job", message: "Continue the separate check." } }], reply: "Opened the independent job" },
    { steps: [post("A self-opened job is not another human answer", true), { tool: "request_credential", arguments: { credential_id: "ttsKey", reason: "Fixture continuation" } }], reply: "Waiting for the fixture credential decision" },
    { reply: "This alternative human branch will be abandoned" },
    { reply: "Continuing only the original self-opened job" },
    { steps: [post("A real user explicitly asked for this update")], reply: "Posted the requested update" },
  ] };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Post two updates and open one independent check.");
  await expect.poll(() => f.evidence().length, { timeout: 20_000 }).toBe(2);
  const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
  const child = chief.tasks.find((task: any) => task.title === "Independent job");
  expect(child).toBeDefined();
  const childWait = () => f.cli("wait", "--bot", f.chief.id, "--task", child.threadId, "--timeout", "20");
  const providerFinished = async (turns: number) => {
    await expect.poll(() => f.evidence().length, { timeout: 20_000 }).toBe(turns);
    await expect.poll(async () => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id)
      .tasks.find((task: any) => task.threadId === child.threadId).busy).toBe(false);
  };
  await providerFinished(2);
  expect((await childWait()).status).toBe("needs-user");
  const attempt = f.evidence()[1].evidence.find((entry: any) => entry.step?.tool === "post_to_room");
  expect(attempt.response.result.isError).toBe(true);
  const refusedPost = (await f.messages(child.threadId)).find((message: any) =>
    message.kind === "activity" && message.tool?.name === "agents_post_to_room" && message.tool.ok === false);
  expect(refusedPost.tool.output).toContain("nobody has answered");
  expect((await f.messages(room.activeTaskId)).filter((message: any) => message.peerPost)).toHaveLength(2);
  const secret = (await f.messages(child.threadId)).find((message: any) => message.kind === "secret");
  expect(secret).toBeDefined();
  const opening = (await f.messages(child.threadId)).find((message: any) => message.peerAsk?.botId === f.chief.id);
  await f.api(`/api/bots/${f.chief.id}/messages/${opening.id}/edit`, { threadId: child.threadId, text: "An alternative human request." });
  await providerFinished(3);
  await f.api(`/api/bots/${f.chief.id}/active-branch`, { threadId: child.threadId, messageId: secret.id });
  expect((await f.messages(child.threadId)).some((message: any) => message.text === "An alternative human request.")).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/secret-cards/${secret.id}/dismiss`, { threadId: child.threadId });
  await providerFinished(4);
  expect((await childWait()).status).toBe("settled");
  const startThread = f.session.fakeChat.requests.findLast((candidate: any) =>
    candidate.messages?.some((message: any) => message.role === "system" && message.content?.includes(`You are ${f.chief.name},`) && message.content.includes(f.chief.activeTaskId)) &&
    candidate.tools?.some((tool: any) => tool.function?.name === "agents_start_thread"),
  )?.tools?.find((tool: any) => tool.function?.name === "agents_start_thread")?.function;
  expect(startThread?.parameters.properties.bot_id.enum).toEqual([f.chief.id]);
  expect((await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id).tasks).toHaveLength(2);
  await f.cli("send", "--bot", f.chief.id, "--task", child.threadId, "--text", "Now I want you to post one new update.");
  await providerFinished(5);
  expect((await childWait()).status).toBe("settled");
  expect((await f.messages(room.activeTaskId)).filter((message: any) => message.peerPost)).toHaveLength(3);
}), 45_000);

it("returns nested coordinated results after a native provider retry", () => fixture(async f => {
  f.session.fakeChat.setBotMode(f.lead.id, "error");
  await f.start();
  await expect.poll(() => f.evidence().some((turn: any) => turn.botId === f.lead.id && turn.providerError), { timeout: 15_000 }).toBe(true);
  f.session.fakeChat.setBotMode(f.lead.id, undefined);
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toHaveLength(3);
  expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
  expect(f.evidence().filter((turn: any) => !turn.providerError).map((turn: any) => turn.botId))
    .toEqual([f.chief.id, f.lead.id, f.specialist.id, f.lead.id, f.chief.id]);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id && turn.providerError)).toHaveLength(1);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(true);
}), 45_000);

it("returns nested results after continuing a source that already has conversation history", () => fixture(async f => {
  const coordination = f.plan[f.chief.id];
  f.plan[f.chief.id] = { reply: "Earlier conversation" };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Hello before the task");
  expect((await f.wait()).status).toBe("settled");
  f.plan[f.chief.id] = coordination;
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes()).toHaveLength(4);
  expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
  expect(f.evidence().map((turn: any) => turn.botId)).toEqual([f.chief.id, f.chief.id, f.lead.id, f.specialist.id, f.lead.id, f.chief.id]);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Earlier conversation")).toBe(true);
}), 45_000);

it("uses recipient bot defaults for its new task, never the sender's or its selected old thread's settings", () => fixture(async f => {
  const models = await f.cli("models");
  const options = models.instances.find((instance: any) => instance.instanceId === f.lead.modelSelection.instanceId).models.options;
  const selected = options.find((model: any) => model.id !== f.lead.modelSelection.model);
  expect(selected?.id).toBe("fixture-alternative");
  await f.api(`/api/bots/${f.lead.id}/tasks/${f.lead.activeTaskId}`, { modelSelection: { instanceId: f.lead.modelSelection.instanceId, model: selected.id }, approvalMode: "auto" }, "PATCH");
  await f.start(); expect((await f.wait()).status).toBe("settled");
  const node = f.nodes().find((entry: any) => entry.botId === f.lead.id);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks.find((task: any) => task.threadId === f.lead.activeTaskId)).toMatchObject({ modelSelection: { model: selected.id }, approvalMode: "auto" });
  expect(lead.tasks.find((task: any) => task.threadId === node.threadId)).toMatchObject({ modelSelection: f.lead.modelSelection, approvalMode: "full" });
   const nativeRequests = requestsForThread(f, node.threadId);
   expect(nativeRequests.length).toBeGreaterThan(0);
   expect(nativeRequests.every((request: any) => request.model === f.lead.modelSelection.model)).toBe(true);
}, { FAKE_CHAT_MODELS: '["fixture-model","fixture-alternative"]' }), 45_000);

const sendReceipts = (f: any, threadId: string) => nativeToolResults(f, threadId)
  .filter((entry) => entry.name === "agents_coordinate_bots")
  .map((entry) => JSON.parse(entry.output).receipts[0]);

it("continues one recipient thread for every follow-up from the same conversation", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Header row added" }, { reply: "Write-up published" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } }], reply: "Assigned the build" },
    { reply: "The export is implemented" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Add the header row to that export" } }], reply: "Assigned the header row" },
    { reply: "The header row is in" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Document the export you just built" } }], reply: "Assigned the write-up" },
    { reply: "It is documented" },
  ] };
  f.save();
  const send = async (text: string) => {
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", text);
    expect((await f.wait()).status).toBe("settled");
  };
  const leadTasks = async () => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks;
  await send("Ask Engineering to build the CSV export.");
  const first = (await leadTasks()).find((task: any) => task.threadId !== f.lead.activeTaskId);
  expect(first.title).toBe("@Clive · work");
  expect(first.openedBy).toMatchObject({ botId: f.chief.id, name: "Clive", kind: "work", threadId: f.chief.activeTaskId });
  expect(first.closedBy).toMatchObject({ botId: f.chief.id });
  await send("Now ask them to add the header row.");
  await send("Now ask them to document it.");
  const tasks = await leadTasks();
  expect(tasks).toHaveLength(2);
  expect(tasks.find((task: any) => task.threadId === first.threadId)).toMatchObject({ title: "@Clive · work", closedBy: { botId: f.chief.id } });
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId)).toEqual([first.threadId, first.threadId, first.threadId]);
  const briefs = ["Implement the CSV export", "Add the header row to that export", "Document the export you just built"];
  const transcript = (await f.messages(first.threadId)).map((message: any) => message.text).filter(Boolean).join("\n");
  for (const brief of briefs) expect(transcript).toContain(brief);
  const leadTurns = f.evidence().filter((turn: any) => turn.botId === f.lead.id);
  expect(leadTurns.map((turn: any) => turn.threadId)).toEqual([first.threadId, first.threadId, first.threadId]);
  for (const [index, brief] of briefs.entries()) expect(promptOf(leadTurns[index])).toContain(brief);
  expect(leadTurns.every((turn: any) => promptOf(turn).includes("current request and returned results arrive in the user turn"))).toBe(true);
  for (const brief of briefs) expect(leadTurns.every((turn: any) => !turn.system.includes(brief))).toBe(true);
  const receipts = sendReceipts(f, f.chief.activeTaskId);
  expect(receipts.map((receipt: any) => receipt.threadId)).toEqual([first.threadId, first.threadId, first.threadId]);
  for (const receipt of receipts) expect(receipt.detail).toBe('sent to "@Clive · work"; it runs after anything still running there');
  const chips = (await f.messages(f.chief.activeTaskId)).filter((message: any) => message.threadRef?.threadId === first.threadId);
  expect(chips.filter((message: any) => message.tool?.name === "Sent to Engineering lead")).toHaveLength(3);
  expect((await leadTasks()).find((task: any) => task.threadId === f.lead.activeTaskId)).not.toHaveProperty("closedBy");
}), 90_000);

it.each<[string, NodeJS.ProcessEnv]>([
  ["a headless server", {}],
  ["the desktop app", { ROOTCLAW_TEST_DESKTOP_OWNER_TOKEN: randomBytes(32).toString("base64url") }],
])("on %s, keeps a follow-up sent during teammate work in the same thread, and returns one result", (_where, env) => fixture(async f => {
  expect((await f.api("/.well-known/rootclaw/environment", undefined, "GET")).capabilities.selfUpdate)
    .toBe(env.ROOTCLAW_TEST_DESKTOP_OWNER_TOKEN ? "desktop-managed" : "operator");
  const gate = join(f.session.info.dataDir, "first-request.gate");
  f.plan[f.lead.id] = { turns: [
    { gateFile: gate, reply: "Export implemented" },
    { reply: "Export implemented with the requested header row" },
  ] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } }], reply: "Assigned the build" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Also add a header row to that export" } }], reply: "Sent the change" },
    { reply: "Reviewed" },
  ] };
  const chiefTurns = () => f.evidence().filter((turn: any) => turn.botId === f.chief.id);
  const stream = await openSse(`${f.session.info.url}/api/events`);
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await expect.poll(() => chiefTurns().length, { timeout: 15_000 }).toBe(1);
  await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Change of plan: the export also needs a header row.", threadId: f.chief.activeTaskId });
  await expect.poll(() => chiefTurns().length, { timeout: 20_000 }).toBe(2);
  expect(told(chiefTurns()[1])).toContain("send the change to the same teammate with coordinate_bots");
  const [running, ...others] = f.nodes().filter((node: any) => node.botId === f.lead.id);
  expect(others, "the change started no second job").toEqual([]);
  expect(sendReceipts(f, f.chief.activeTaskId)[1]).toMatchObject({ outcome: "injected", threadId: running.threadId, requestId: running.id });
  expect((await f.messages(running.threadId)).filter((message: any) => message.peerAsk?.name === "Clive" && message.text === "Also add a header row to that export"))
    .toHaveLength(1);
  writeFileSync(gate, "go");
  expect((await f.wait()).status).toBe("settled");
  await expect.poll(() => f.nodes().filter((node: any) => node.parentId).map((node: any) => node.status), { timeout: 15_000 }).toEqual(["completed"]);
  const leadTurns = f.evidence().filter((turn: any) => turn.botId === f.lead.id);
  expect(leadTurns.map((turn: any) => [turn.turnIndex, turn.threadId])).toEqual([[0, running.threadId], [1, running.threadId]]);
  expect(promptOf(leadTurns[1])).toContain("Also add a header row to that export");
  expect((await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks).toHaveLength(2);
  await stream.until(frame => frame.kind === "bot" && frame.bot?.id === f.lead.id
    && frame.bot.tasks?.find((task: any) => task.threadId === running.threadId)?.closedBy);
  const closed = stream.frames.filter(frame => frame.kind === "bot" && frame.bot?.id === f.lead.id)
    .map(frame => Boolean(frame.bot.tasks?.find((task: any) => task.threadId === running.threadId)?.closedBy));
  stream.close();
  expect(closed.filter((now, at) => now && !closed[at - 1])).toHaveLength(1);
}, env), 60_000);

it("runs two assignments to one teammate from one turn in its thread, one after the other", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Benchmark finished" }] };
  f.plan[f.chief.id] = { steps: [
    { arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } },
    { arguments: { bot_ids: [f.lead.id], message: "Benchmark the exporter on the large fixture" } },
  ], reply: "Both assignments are out", resumeReply: "Both came back" };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const tasks = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks;
  expect(tasks).toHaveLength(2);
  const work = tasks.find((task: any) => task.openedBy?.kind === "work");
  expect(work).toMatchObject({ title: "@Clive · work", closedBy: { botId: f.chief.id } });
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId)).toEqual([work.threadId, work.threadId]);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => [turn.turnIndex, turn.threadId]))
    .toEqual([[0, work.threadId], [1, work.threadId]]);
  const transcript = (await f.messages(work.threadId)).map((message: any) => message.text).filter(Boolean).join("\n");
  expect(transcript).toContain("Implement the CSV export");
  expect(transcript).toContain("Benchmark the exporter");
}), 60_000);

it("gives another conversation of the same Chief its own thread with the teammate", () => fixture(async f => {
  f.plan[f.lead.id] = { turns: [{ reply: "Export implemented" }, { reply: "Invoices exported" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Implement the CSV export" } }], reply: "Assigned" },
    { reply: "Done" },
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: "Export the invoices" } }], reply: "Assigned" },
    { reply: "Done" },
  ] };
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const other = (await f.api(`/api/bots/${f.chief.id}/tasks`, { title: "Invoices" })).task.threadId;
  await f.cli("send", "--bot", f.chief.id, "--task", other, "--text", "Ask Engineering to export the invoices.");
  expect((await f.cli("wait", "--bot", f.chief.id, "--task", other, "--timeout", "30")).status).toBe("settled");
  const work = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id).tasks.filter((task: any) => task.openedBy?.kind === "work");
  expect(work.map((task: any) => task.openedBy.threadId).sort()).toEqual([f.chief.activeTaskId, other].sort());
  expect(new Set(f.nodes().filter((node: any) => node.botId === f.lead.id).map((node: any) => node.threadId))).toEqual(new Set(work.map((task: any) => task.threadId)));
}), 60_000);

it("runs an identical call made twice in one turn once, without an extra recipient thread", () => fixture(async f => {
  f.plan[f.chief.id].steps.push(structuredClone(f.plan[f.chief.id].steps[0]));
  await f.start(); expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().filter((node: any) => node.botId === f.lead.id)).toHaveLength(1);
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  expect(lead.tasks).toHaveLength(2);
  expect((await f.messages(f.chief.activeTaskId)).filter((message: any) => message.tool?.name === "Sent to Engineering lead")).toHaveLength(1);
  const [sent, repeated] = sendReceipts(f, f.chief.activeTaskId);
  expect(repeated).toMatchObject({ requestId: sent.requestId, threadId: sent.threadId });
  expect(repeated.detail).toContain("already sent");
}), 45_000);

it.each<[string, Record<string, unknown>, string]>([
  ["finished", { reply: "3 tests fail" }, "not sent again: it already finished and its result stands; send it with rework=true to run it again"],
  ["failed", { fail: true }, "not sent again: it failed; send it with rework=true to retry"],
])("runs an identical brief again only with rework=true once its first run %s", (how, firstRun, refusal) => fixture(async f => {
  const brief = "Run the full test suite and report every failure";
  f.plan[f.lead.id] = { turns: [firstRun, { reply: "All tests pass" }] };
  f.plan[f.chief.id] = { turns: [
    { steps: [{ arguments: { bot_ids: [f.lead.id], message: brief } }], reply: "Sent" },
    { steps: [
      { arguments: { bot_ids: [f.lead.id], message: brief }, expectError: true },
      ...(how === "finished" ? [{ arguments: { bot_ids: [f.lead.id], message: "Thanks, approved" }, expectError: true }] : []),
      { arguments: { bot_ids: [f.lead.id], message: brief, rework: true } },
    ], reply: "Sent again" },
    { reply: "The suite is green" },
  ] };
  await f.start();
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 30_000 }).toBe(3);
  expect((await f.wait()).status).toBe("settled");
  const results = nativeToolResults(f, f.chief.activeTaskId).filter((entry) => entry.name === "agents_coordinate_bots");
  const [sent, repeated] = results;
  const rerun = results.at(-1)!;
  expect(repeated.response.ok).toBe(false);
  expect(repeated.output).toContain(refusal);
  if (how === "finished") expect(results[2].output).toContain("Only use rework=true for concrete additional work.");
  const [first, again] = [sent, rerun].map((result) => JSON.parse(result.output).receipts[0]);
  expect(again).toMatchObject({ outcome: "queued", threadId: first.threadId });
  expect(again.requestId).not.toBe(first.requestId);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => turn.threadId)).toEqual([first.threadId, first.threadId]);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The suite is green")).toBe(true);
}), 60_000);

it("dispatches to a spare recipient thread without waiting for unrelated work", () => fixture(async f => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 2 } }, "PUT");
  const gate = join(f.session.info.dataDir, "unrelated-work.gate");
  const ready = join(f.session.info.dataDir, "unrelated-work.ready");
  f.plan[f.lead.id] = { readyFile: ready, gateFile: gate, reply: "Unrelated work completed" };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "My unrelated task");
  try {
    await expect.poll(() => existsSync(ready), { timeout: 10_000 }).toBe(true);
    f.plan[f.lead.id] = { reply: "Coordinated work completed" };
    await f.start();
    await expect.poll(() => f.nodes().find((n: any) => n.parentId)?.status, { timeout: 8_000 }).toBe("completed");
    expect((await f.wait()).status).toBe("settled");
    const lead = (await f.api("/api/bots")).bots.find((b: any) => b.id === f.lead.id);
    expect(lead.tasks.find((t: any) => t.threadId === f.lead.activeTaskId).busy).toBe(true);
    expect((await f.messages(f.chief.activeTaskId)).some((m: any) => m.text === "The requested CSV export is implemented and verified")).toBe(true);
  } finally {
    writeFileSync(gate, "go");
  }
}), 45_000);

it("queues a recipient at capacity, preserving its existing task and resuming only the pinned parent", () => fixture(async f => {
  await f.api("/api/config", { threads: { maxConcurrentPerBot: 1 } }, "PUT");
  f.plan[f.lead.id] = { turns: [{ delayMs: 2500, reply: "Unrelated work completed" }, { reply: "Coordinated work completed" }] };
  f.save();
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "My unrelated task");
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 10_000 }).toBe("queued");
  await expect.poll(async () => {
    const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
    return { busy: chief.busy, waitingForTeammates: chief.waitingForTeammates };
  }, { timeout: 15_000 }).toEqual({ busy: false, waitingForTeammates: true });
  const next = await f.api(`/api/bots/${f.chief.id}/tasks`, { title: "Other conversation" });
  expect((await f.wait()).status).toBe("settled");
  expect(await f.messages(next.task.threadId)).toEqual([]);
  expect((await f.messages(f.lead.activeTaskId)).some((message: any) => message.text === "Unrelated work completed")).toBe(true);
  expect(f.evidence().filter((turn: any) => turn.botId === f.lead.id).map((turn: any) => turn.threadId)).toEqual([f.lead.activeTaskId, f.nodes().find((node: any) => node.parentId && node.botId === f.lead.id).threadId]);
}), 45_000);

/** A message sent while the Chief's assigning turn is still finishing is steered into that turn, so it is never parked or started on its own. */
const assigningTurnEnded = (f: any) => expect.poll(async () => {
  const chief = (await f.api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.chief.id);
  return { busy: chief.busy, waitingForTeammates: chief.waitingForTeammates };
}, { timeout: 15_000 }).toEqual({ busy: false, waitingForTeammates: true });

it("runs a message sent while a teammate works, keeps the assignment, and names it in that turn", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "steered-assignment-ready");
  f.plan[f.lead.id] = { gateFile: gate, reply: "CSV export implemented" };
  f.plan[f.chief.id] = { turns: [
    { steps: structuredClone(f.plan[f.chief.id].steps), reply: "Assigned to Engineering" },
    { reply: "Noted; Engineering is still working on it" },
    { reply: "The requested CSV export is implemented and verified" },
  ] };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);

  await assigningTurnEnded(f);
  const receipt = await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Also make sure the export is UTF-8.", threadId: f.chief.activeTaskId });
  expect(receipt.queued).toBeUndefined();
  expect(receipt.message.text).toBe("Also make sure the export is UTF-8.");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 20_000 }).toBe(2);

  const steered = f.evidence().filter((turn: any) => turn.botId === f.chief.id)[1];
  expect(steered.resumed).toBe(false);
  expect(told(steered)).toContain("Assignments you already sent are still outstanding");
  expect(told(steered)).toContain(assignment.id);
  expect(told(steered)).toContain("Engineering lead");
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).toBe("running");
  writeFileSync(gate, "finish after the steered turn read its assignments");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().every((node: any) => node.status === "completed")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(true);
}), 60_000);

it("parks a message behind outstanding teammate work when the bot opts in, then runs it after", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "parked-assignment-ready");
  f.plan[f.lead.id] = { gateFile: gate, reply: "CSV export implemented" };
  f.plan[f.chief.id] = { turns: [
    { steps: structuredClone(f.plan[f.chief.id].steps), reply: "Assigned to Engineering" },
    { reply: "The requested CSV export is implemented and verified" },
    { reply: "Noted; the export is UTF-8 too" },
  ] };
  await f.api(`/api/bots/${f.chief.id}`, { parkDirectMessages: true }, "PATCH");
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);
  await assigningTurnEnded(f);

  const receipt = await f.api(`/api/bots/${f.chief.id}/messages`, { text: "Also make sure the export is UTF-8.", threadId: f.chief.activeTaskId });
  expect(receipt.queued).toBe(true);
  expect(typeof receipt.queueId).toBe("string");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Also make sure the export is UTF-8.")).toBe(false);
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).toBe("running");
  writeFileSync(gate, "finish after the message was parked");

  expect((await f.wait()).status).toBe("settled");
  await expect.poll(() => f.evidence().filter((turn: any) => turn.botId === f.chief.id).length, { timeout: 20_000 }).toBe(3);
  const parked = f.evidence().filter((turn: any) => turn.botId === f.chief.id)[2];
  expect(parked.resumed).toBe(false);
  expect(told(parked)).not.toContain("Assignments you already sent are still outstanding");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Also make sure the export is UTF-8.")).toBe(true);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Noted; the export is UTF-8 too")).toBe(true);
}), 60_000);

it("runs a teammate's hand-off to the Chief in the Chief's work thread for that sender, cancelling no live coordination", () => fixture(async f => {
  const ops = (await f.cli("new-bot", "--name", "Ops", "--section", "Leadership")).bot;
  const assign = structuredClone(f.plan[f.chief.id].steps);
  f.plan[f.lead.id] = { delayMs: 6000, reply: "CSV export implemented" };
  // Turns whose order nothing pins pick their entry by what they were asked.
  f.plan[f.chief.id] = { script: [
    { key: "assign", match: ["Please have Engineering build"], steps: assign, reply: "Assigned to Engineering" },
    { key: "note", match: ["Nightly note: confirm the export owner."], reply: "The export owner is Engineering." },
    { key: "review", match: ["Your downstream room requests have settled."], reply: "The requested CSV export is implemented and verified" },
  ] };
  f.plan[ops.id] = { script: [
    { key: "send", match: ["Send the nightly note."], steps: [{ arguments: { bot_ids: [f.chief.id], message: "Nightly note: confirm the export owner." } }], reply: "Delegated the nightly note" },
    { key: "resume", match: ["Your downstream room requests have settled."], reply: "Recorded the outcome of the nightly note" },
  ] };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  const assignment = f.nodes().find((node: any) => node.parentId);

  const { routine } = await f.api("/api/routines", { name: "Nightly note", prompt: "Send the nightly note.", botId: ops.id,
    enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
  await f.api(`/api/routines/${routine.id}/run`, {});
  await expect.poll(() => f.evidence().some((turn: any) => turn.planKey === "note"), { timeout: 25_000 }).toBe(true);
  const note = f.evidence().find((turn: any) => turn.planKey === "note");
  expect(note.threadId).not.toBe(f.chief.activeTaskId);
  const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
  expect(chief.tasks.find((task: any) => task.threadId === note.threadId)).toMatchObject({ title: "@Ops · work", openedBy: { botId: ops.id, kind: "work" } });
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.peerAsk?.botId === ops.id || String(message.text ?? "").includes("Nightly note"))).toBe(false);
  expect(f.nodes().find((node: any) => node.id === assignment.id).status).not.toBe("cancelled");

  await expect.poll(() => f.nodes().find((node: any) => node.id === assignment.id)?.status, { timeout: 25_000 }).toBe("completed");
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied"), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => f.evidence().map((turn: any) => turn.planKey).filter(Boolean).sort(), { timeout: 20_000 }).toEqual(["assign", "note", "resume", "review", "send"]);
  // The last settlement lands a tick after its turn's end.
  await expect.poll(() => f.nodes().every((node: any) => node.status === "completed"), { timeout: 10_000 }).toBe(true);
}), 60_000);

it("stops a waiting source without reaching into the teammate already working", () => fixture(async f => {
  const childGate = join(f.session.info.dataDir, "child-ready");
  f.plan[f.lead.id] = { gateFile: childGate, reply: "Finished after the source was stopped" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  await assigningTurnEnded(f);
  await f.api(`/api/bots/${f.chief.id}/interrupt`, { threadId: f.chief.activeTaskId });

  await expect.poll(() => f.nodes().find((node: any) => !node.parentId)?.status).toBe("cancelled");
  expect(f.nodes().find((node: any) => node.parentId).status).toBe("running");
  writeFileSync(childGate, "finish after the source was stopped");
  expect((await f.wait()).status).toBe("settled");
  const chip = (await f.messages(f.chief.activeTaskId)).find((message: any) => message.tool?.name?.startsWith("Stopped here"));
  expect(chip.tool.name).toContain("Engineering lead");
  expect(chip.threadRef).toMatchObject({ botId: f.lead.id, threadId: f.nodes().find((node: any) => node.parentId).threadId });

  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 20_000 }).toBe("completed");
  expect(f.nodes().find((node: any) => node.parentId).result).toContain("Finished after the source was stopped");
  await expect.poll(async () => (await f.messages(f.chief.activeTaskId)).some((message: any) => message.tool?.name === "Engineering lead replied")).toBe(true);
  const replied = (await f.messages(f.chief.activeTaskId)).find((message: any) => message.tool?.name === "Engineering lead replied");
  expect(replied.tool.output).toContain("Finished after the source was stopped");
  expect(f.evidence().filter((turn: any) => turn.botId === f.chief.id)).toHaveLength(1);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The requested CSV export is implemented and verified")).toBe(false);
}), 60_000);

it("deleting the waiting source cancels its tree and never recreates the deleted conversation", () => fixture(async f => {
  // The teammate holds its reply until the source is gone, however slowly the runner settles the Chief's own turn.
  const childGate = join(f.session.info.dataDir, "child-ready");
  f.plan[f.lead.id] = { gateFile: childGate, reply: "Must not return to a deleted task" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("running");
  // A running task cannot be deleted (409): the source is "waiting" only once its own turn has settled.
  await expect.poll(async () => {
    const waiting = (await f.api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.chief.id);
    return !waiting.busy && waiting.tasks.find((task: any) => task.threadId === f.chief.activeTaskId)?.waitingForTeammates;
  }, { timeout: 30_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}/tasks/${f.chief.activeTaskId}`, {}, "DELETE");
  await expect.poll(() => f.nodes().every((node: any) => node.status === "cancelled")).toBe(true);
  writeFileSync(childGate, "finish after the source was deleted");
  await expect.poll(async () => (await f.api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === f.lead.id).busy, { timeout: 15_000 }).toBe(false);
  expect(f.nodes().every((node: any) => node.status === "cancelled")).toBe(true);
  const chief = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id);
  expect(chief.tasks.some((task: any) => task.threadId === f.chief.activeTaskId)).toBe(false);
  expect(await f.messages(chief.threadId)).toEqual([]);
  for (const task of chief.tasks) {
    expect((await f.messages(task.threadId)).some((message: any) => message.text?.includes("Must not return to a deleted task"))).toBe(false);
  }
}), 45_000);

it("withholds direct results when the sender's peers list cuts the teammate off mid-turn", () => fixture(async f => {
  // Revoke while the teammate's engine is inside its turn: a "running" record is written at dispatch, before setup.
  const ready = join(f.session.info.dataDir, "private-work.ready");
  const gate = join(f.session.info.dataDir, "private-work.gate");
  f.plan[f.lead.id] = { readyFile: ready, gateFile: gate, reply: "PRIVATE_ENGINEERING_RESULT" };
  await f.start();
  await expect.poll(() => existsSync(ready), { timeout: 15_000 }).toBe(true);
  await f.api(`/api/bots/${f.chief.id}`, { peers: [] }, "PATCH");
  writeFileSync(gate, "finish the private work after the teammate was cut off");
  expect((await f.wait()).status).toBe("settled");
  const resumed = f.evidence().find((turn: any) => turn.botId === f.chief.id && turn.resumed);
  expect(JSON.stringify(resumed), told(resumed).slice(-1_500)).not.toContain("PRIVATE_ENGINEERING_RESULT");
  const child = f.nodes().find((node: any) => node.parentId);
  expect(child.status, `${JSON.stringify(child)}\n${told(resumed).slice(-1_500)}`).toBe("failed");
  expect(promptOf(resumed)).toContain("Result withheld");
}), 45_000);

it("retains returned direct reports for follow-up turns but rechecks reach before replay", () => fixture(async f => {
  f.plan[f.lead.id] = { reply: "PRIVATE_ENGINEERING_FACT_8347" };
  f.plan[f.chief.id].resumeReply = "Finished";
  await f.start(); expect((await f.wait()).status).toBe("settled");
  f.plan[f.chief.id] = { reply: "Follow-up answered" };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Summarize the existing engineering report");
  expect((await f.wait()).status).toBe("settled");
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "Follow-up answered")).toBe(true);
  const followup = (await f.messages(f.chief.activeTaskId)).findLast((message: any) => message.role === "user");
  await f.api(`/api/bots/${f.chief.id}/messages/${followup.id}/edit`, { threadId: f.chief.activeTaskId, text: "Check the earlier engineering report" });
  expect((await f.wait()).status).toBe("settled");
  expect(JSON.stringify(requestForThread(f, f.chief.activeTaskId)?.messages)).toContain("PRIVATE_ENGINEERING_FACT_8347");
  await f.api(`/api/bots/${f.chief.id}`, { peers: [] }, "PATCH");
  f.plan[f.chief.id] = { reply: "Access removed" };
  f.save();
  const edited = (await f.messages(f.chief.activeTaskId)).findLast((message: any) => message.role === "user");
  await f.api(`/api/bots/${f.chief.id}/messages/${edited.id}/edit`, { threadId: f.chief.activeTaskId, text: "What can you access now?" });
  expect((await f.wait()).status).toBe("settled");
  expect(JSON.stringify(requestForThread(f, f.chief.activeTaskId)?.messages)).toContain("Teammate result withheld");
  expect(JSON.stringify(requestForThread(f, f.chief.activeTaskId)?.messages)).not.toContain("PRIVATE_ENGINEERING_FACT_8347");
}), 45_000);

it("runs the owed direct follow-up while the same bot works in another thread", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "hold-gate");
  // The hold's turn starts while the assigning turn is still open, so each turn picks its plan by its own text.
  f.plan[f.chief.id] = { script: [
    { key: "assign", match: ["Assign the check, then open an independent job"], steps: [
      { tool: "coordinate_bots", arguments: { bot_ids: [f.specialist.id], message: "Independently verify the CSV export" } },
      { tool: "start_thread", arguments: { title: "Independent hold", message: "Run the long independent check." } },
    ], reply: "Assigned the check and opened the hold" },
    { key: "hold", match: ["Run the long independent check."], gateFile: gate, reply: "The hold finished" },
    { key: "resume", match: ["Your downstream room requests have settled."], reply: "The follow-up ran while the hold worked" },
  ] };
  f.save();
  await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", "Assign the check, then open an independent job that runs long.");
  const chiefTasks = async () => (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.chief.id).tasks;
  const holdBusy = async () => (await chiefTasks()).find((task: any) => task.title === "Independent hold")?.busy;
  // The self-opened job stays mid-turn at its gate, so the whole-bot busy flag stays up for an unrelated thread.
  await expect.poll(holdBusy, { timeout: 20_000 }).toBe(true);
  const root = () => f.nodes().find((node: any) => !node.parentId);
  await expect.poll(() => root()?.status, { timeout: 15_000 }).toBe("completed");
  expect(await holdBusy()).toBe(true);
  const tasks = await chiefTasks();
  expect(tasks.find((task: any) => task.threadId === f.chief.activeTaskId).busy).toBe(false);
  writeFileSync(gate, "");
  await expect.poll(holdBusy, { timeout: 10_000 }).toBe(false);
  expect((await f.messages(f.chief.activeTaskId)).some((message: any) => message.text === "The follow-up ran while the hold worked")).toBe(true);
}), 45_000);

it("sends each teammate result once in the turn that reviews it", () => fixture(async f => {
  f.plan[f.lead.id].resumeReply = "LEAD_RESULT_ONCE implemented and verified";
  await f.start();
  expect((await f.wait()).status).toBe("settled");
  const text = promptOf(f.evidence().filter((turn: any) => turn.botId === f.chief.id).at(-1));
  expect(text).toContain("Your downstream room requests have settled.");
  expect(text.split("LEAD_RESULT_ONCE").length - 1).toBe(1);
}), 45_000);

it("gives a teammate each request once, never also as a bare assistant line", () => fixture(async f => {
  f.plan[f.lead.id] = { reply: "round result" };
  for (const key of ["first", "second"]) {
    f.plan[f.chief.id] = { steps: [{ arguments: { bot_ids: [f.lead.id], message: `REQUEST_${key.toUpperCase()} please do it` } }], reply: "Assigned", resumeReply: "Done" };
    f.save();
    await f.cli("send", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--text", `Delegate the ${key} request.`);
    expect((await f.wait()).status).toBe("settled");
  }
  const second = promptOf(f.evidence().filter((turn: any) => turn.botId === f.lead.id).at(-1));
  expect(second.split("REQUEST_SECOND").length - 1).toBe(1);
  expect(second).not.toMatch(/^Assistant: @/m);
}), 60_000);

async function onLoopbackEngine(f: any, answer: (res: ServerResponse, body: any) => void): Promise<() => Promise<void>> {
  const llm = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "loop-model" }] })); return; }
    answer(res, JSON.parse(raw));
  });
  await new Promise<void>(resolve => llm.listen(0, "127.0.0.1", resolve));
  const port = (llm.address() as { port: number }).port;
  const endpoint = await f.api("/api/instances/openai-compat", {
    displayName: "Loopback test engine", url: `http://127.0.0.1:${port}/v1`, key: "fixture-loop-key", models: ["loop-model"],
  });
  await f.api(`/api/bots/${f.lead.id}`, { modelSelection: { instanceId: endpoint.instanceId, model: "loop-model" } }, "PATCH");
  return () => new Promise<void>(resolve => llm.close(() => resolve()));
}

it("continues a teammate's step cap in place and stops it once it makes no progress", () => fixture(async f => {
  let calls = 0;
  const close = await onLoopbackEngine(f, (res, body) => {
    const offered = new Set((body.tools ?? []).map((tool: any) => tool.function?.name));
    const name = offered.has("read_file") ? "read_file" : "load_tools";
    const args = name === "read_file" ? { path: `missing-rootclaw-fixture-${calls + 1}.txt` } : { names: ["read_file"] };
    const call = { tool_calls: [{ index: 0, id: `call_${++calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: call, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await f.start();
    expect((await f.wait()).status).toBe("settled");
    const leads = f.nodes().filter((node: any) => node.botId === f.lead.id);
    expect(leads).toHaveLength(1);
    const child = leads[0];
    expect(child).toMatchObject({ status: "failed", outcome: "stalled", executions: 2,
      result: expect.stringMatching(/^Stopped after 64 steps without a final answer\./) });
    expect(child.outcomeDetail).toMatch(/^Stopped after 2 continuations without progress: Stopped after 64 steps without a final answer\./);
    expect(child.result).not.toContain("assign what is left");
    expect(f.eventsOf(child.id).filter((kind: string) => kind === "continued")).toHaveLength(1);
    expect(f.eventsOf(child.id)).toContain("stalled");
    const resumed = f.evidence().find((turn: any) => turn.botId === f.chief.id && turn.resumed);
    expect(promptOf(resumed)).toContain("Stopped after 2 continuations without progress");
    expect(promptOf(resumed)).not.toContain("assign what is left");
    const chip = (await f.messages(f.chief.activeTaskId)).find((message: any) => message.roomRequest?.phase === "result");
    expect(chip.tool.name).toContain("Engineering lead — failed: Stopped after 64 steps without a final answer");
    expect((await f.messages(f.chief.activeTaskId)).filter((message: any) => message.roomRequest?.phase === "result")).toHaveLength(1);
    const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
    expect(lead.tasks.map((task: any) => task.title).filter((title: string) => title.startsWith("Continue:"))).toEqual([]);
    expect(calls).toBe(128);
  } finally { await close(); }
}), 90_000);

it("tells the Chief a teammate's provider refused the turn, in the provider's words", () => fixture(async f => {
  const close = await onLoopbackEngine(f, res => {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Rate limit reached for loop-model: 30 requests per minute" } }));
  });
  try {
    await f.start();
    expect((await f.wait()).status).toBe("settled");
    const child = f.nodes().find((node: any) => node.botId === f.lead.id);
    expect(child.status).toBe("failed");
    expect(child.result).toContain("429");
    expect(child.result).toContain("Rate limit reached for loop-model: 30 requests per minute");
    const resumed = f.evidence().find((turn: any) => turn.botId === f.chief.id && turn.resumed);
    expect(promptOf(resumed)).toContain("Rate limit reached for loop-model");
  } finally { await close(); }
}), 45_000);

it("keeps a teammate working through a provider settings save that does not touch its engine", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "lead-ready");
  f.plan[f.lead.id] = { gateFile: gate, reply: "CSV export implemented and checked" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  const compat = async () => (await f.api("/api/instances")).instances.find((instance: any) => instance.instanceId === "openaiCompat");
  expect((await compat()).snapshot.state).toBe("available");
  await f.api("/api/config", { anthropic: { key: "fixture-anthropic-key" } }, "PATCH");
  expect((await compat()).snapshot.state).toBe("available");
  await f.api("/api/config", { anthropic: { key: "fixture-anthropic-key" } }, "PATCH");
  expect(f.nodes().find((node: any) => node.botId === f.lead.id).status).toBe("running");
  writeFileSync(gate, "finish the teammate");
  expect((await f.wait()).status).toBe("settled");
  expect(f.nodes().find((node: any) => node.botId === f.lead.id)).toMatchObject({ status: "completed", result: "CSV export implemented and checked" });
  const lead = (await f.api("/api/bots")).bots.find((bot: any) => bot.id === f.lead.id);
  for (const task of lead.tasks) {
    expect((await f.messages(task.threadId)).some((message: any) => message.tool?.name?.includes("provider settings changed"))).toBe(false);
  }
}), 45_000);

it("tells the Chief a teammate's turn stopped because its engine's settings changed", () => fixture(async f => {
  const gate = join(f.session.info.dataDir, "lead-ready");
  const independent = await f.api("/api/instances/openai-compat", {
    displayName: "Chief fixture engine", url: f.session.fakeChat.url, key: "fixture-chief-key", models: ["fixture-model"],
  });
  await f.api(`/api/bots/${f.chief.id}`, { modelSelection: { instanceId: independent.instanceId, model: "fixture-model" } }, "PATCH");
  f.plan[f.lead.id] = { gateFile: gate, reply: "Never reached" };
  await f.start();
  await expect.poll(() => f.nodes().find((node: any) => node.botId === f.lead.id)?.status, { timeout: 15_000 }).toBe("running");
  await f.api("/api/config", { openaiCompat: { key: "fixture-compat-key", url: "http://127.0.0.1:9/v1" } }, "PATCH");
  expect((await f.wait()).status).toBe("settled");
  const child = f.nodes().find((node: any) => node.botId === f.lead.id);
  expect(child.status).toBe("failed");
  expect(child.result).toMatch(/^Turn interrupted — provider settings changed\.(?: |$)/);
  const resumed = f.evidence().find((turn: any) => turn.botId === f.chief.id && turn.resumed);
  expect(promptOf(resumed)).toContain("Turn interrupted — provider settings changed.");
  expect(promptOf(resumed)).not.toContain("The coordinated turn was interrupted");
}), 45_000);
