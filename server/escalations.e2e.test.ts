import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-rootclaw.ts";
import { openSse } from "./testing/sse.ts";

async function launch() {
  const fixture = await launchVerificationServer(process.env);
  const { url, dataDir } = fixture.info;
  const fakeChat = fixture.fakeChat;
  const api = async (method: string, path: string, body?: unknown, expectedStatus = 200) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(expectedStatus);
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const requestFor = (threadId: string) => fakeChat.requests.findLast((request: any) => {
    if (request.stream !== true) return false;
    const system = (request.messages as any[]).find((message) => message.role === "system")?.content;
    const cwd = typeof system === "string" ? /"currentWorkingFolder"\s*:\s*"((?:\\.|[^"])*)"/.exec(system)?.[1] : undefined;
    return cwd ? basename(JSON.parse(`"${cwd}"`)) === threadId : false;
  }) as any;
  const dump = async (threadId: string) => {
    await expect.poll(() => requestFor(threadId), { timeout: 20_000 }).toBeTruthy();
    const request = requestFor(threadId);
    const messages = request.messages as any[];
    return {
      ...request,
      prompt: messages,
      systemPrompt: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n"),
    };
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const botsNow = async () => (await api("GET", "/api/bots")).bots as any[];
  await api("PATCH", "/api/config", { features: { chiefEscalations: true } });
  const turnEnded = (botId: string, threadId: string) => expect.poll(async () =>
    (await botsNow()).find((b) => b.id === botId)?.tasks?.find((t: any) => t.threadId === threadId)?.busy, { timeout: 30_000 }).toBe(false);
  const escalationsThread = async (botId: string) => {
    await expect.poll(async () => (await botsNow()).find((b) => b.id === botId)?.tasks?.some((t: any) => t.title === "Team escalations"), { timeout: 20_000 }).toBe(true);
    return (await botsNow()).find((b) => b.id === botId).tasks.find((t: any) => t.title === "Team escalations") as { threadId: string };
  };
  return { url, dataDir, api, control, dump, messages, botsNow, fakeChat, turnEnded, escalationsThread, close: () => fixture.close() };
}

it("delivers a pending peer-comm approval card to the Chief's escalations thread", async () => {
  const { api, control, dump, messages, fakeChat, turnEnded, escalationsThread, close } = await launch();
  try {
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const ada = (await control(["new-bot", "--name", "Ada", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${ada.id}`, { approvePeerComms: true, approvalMode: "ask" });
    const hedge = (await control(["new-bot", "--name", "Hedge", "--section", "Ops"])).bot;
    fakeChat.set({ routes: [{
      match: "File the memo after checking with Hedge",
      toolCalls: [
        { name: "load_tools", input: { names: ["coordinate_bots"] } },
        { name: "agents_coordinate_bots", input: { bot_ids: [hedge.id], message: "Hedge, a quick one before I file the memo.", consult: true }, round: 1 },
      ],
      reply: "I asked Hedge and will wait for the person's say-so.",
    }] });

    await control(["send", "--bot", ada.id, "--text", "File the memo after checking with Hedge."]);
    await expect.poll(async () => (await messages(ada.activeTaskId)).some((m) => m.kind === "options" && m.card?.requestId), { timeout: 20_000 }).toBe(true);
    const escalations = await escalationsThread(chief.id);
    await expect.poll(async () => (await messages(escalations.threadId)).some((m) =>
      m.kind === "activity" && m.tool?.ok === false && /Escalation: Ada's work .*approval card to contact @Hedge is waiting on the person/.test(m.tool?.name ?? "")
      && m.threadRef?.threadId === ada.activeTaskId && m.threadRef?.botId === ada.id,
    ), { timeout: 10_000 }).toBe(true);
    const run = await dump(escalations.threadId);
    const prompt = JSON.stringify(run.prompt);
    expect(prompt).toContain("[Escalation notice from RootClaw — not from the person.");
    expect(prompt).toContain("approval card to contact @Hedge is waiting on the person");
    expect(prompt).toContain("Hedge, a quick one before I file the memo.");
    expect(prompt).toContain(`bot_id \\"${ada.id}\\"`);
    expect(prompt).toContain(`thread_id \\"${ada.activeTaskId}\\"`);
    expect(run.systemPrompt).toContain("Team escalations");
    const noticeLine = (await messages(escalations.threadId)).find((m) => m.role === "user" && /Escalation notice/.test(m.text ?? ""));
    expect(noticeLine?.peerAsk).toEqual({ botId: ada.id, name: "Ada", unattended: true, incident: { threadId: ada.activeTaskId, notified: true } });

    await api("POST", `/api/bots/${ada.id}/respond`, { requestId: (await messages(ada.activeTaskId)).find((m) => m.kind === "options")?.card?.requestId, behavior: "deny" });
    await turnEnded(ada.id, ada.activeTaskId);
    await turnEnded(chief.id, escalations.threadId);
    expect((await messages(hedge.activeTaskId)).filter((m) => m.role === "user")).toEqual([]);
  } finally {
    await close();
  }
}, 150_000);

it("delivers a teammate turn that ends needing input to the Chief's escalations thread", async () => {
  const { api, control, dump, messages, fakeChat, turnEnded, escalationsThread, close } = await launch();
  try {
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const mira = (await control(["new-bot", "--name", "Mira", "--section", "Ops"])).bot;
    fakeChat.set({ routes: [{ match: "Tag the release", reply: "Half done.\nNEEDS INPUT: which repository should I tag?" }] });

    await control(["send", "--bot", mira.id, "--text", "Tag the release."]);
    await turnEnded(mira.id, mira.activeTaskId);

    const escalations = await escalationsThread(chief.id);
    await expect.poll(async () => (await messages(escalations.threadId)).some((m) =>
      m.kind === "activity" && m.tool?.ok === false && /Escalation: Mira's work .*turn ended on a question the person has not answered/.test(m.tool?.name ?? "")
      && m.threadRef?.threadId === mira.activeTaskId,
    ), { timeout: 10_000 }).toBe(true);
    const run = await dump(escalations.threadId);
    const prompt = JSON.stringify(run.prompt);
    expect(prompt).toContain("[Escalation notice from RootClaw — not from the person.");
    expect(prompt).toContain("which repository should I tag?");
    expect(prompt).toContain(`thread_id \\"${mira.activeTaskId}\\"`);
    const noticeLine = (await messages(escalations.threadId)).find((m) => m.role === "user" && /Escalation notice/.test(m.text ?? ""));
    expect(noticeLine?.peerAsk).toEqual({ botId: mira.id, name: "Mira", unattended: true, incident: { threadId: mira.activeTaskId } });
    await turnEnded(chief.id, escalations.threadId);
  } finally {
    await close();
  }
}, 150_000);

it("carries the provenance fence header on a bot-raised escalation", async () => {
  const { api, control, dump, messages, fakeChat, turnEnded, escalationsThread, close } = await launch();
  try {
    const chief = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const mira = (await control(["new-bot", "--name", "Mira", "--section", "Ops"])).bot;
    fakeChat.set({ routes: [{
      match: "Ship the deploy",
      toolCalls: [
        { name: "load_tools", input: { names: ["raise_escalation"] } },
        { name: "agents_raise_escalation", input: { reason: "The deploy needs the production key only the person can unlock." }, round: 1 },
      ],
      reply: "I flagged the gate and stopped.",
    }] });

    await control(["send", "--bot", mira.id, "--text", "Ship the deploy."]);
    await turnEnded(mira.id, mira.activeTaskId);

    const escalations = await escalationsThread(chief.id);
    const run = await dump(escalations.threadId);
    const prompt = JSON.stringify(run.prompt);
    expect(prompt).toContain("[Escalation notice from RootClaw — not from the person.");
    expect(prompt).toContain("The deploy needs the production key only the person can unlock.");
    expect(prompt).toContain("it raised this flag itself");
    expect(prompt).toContain(`thread_id \\"${mira.activeTaskId}\\"`);
    const noticeLine = (await messages(escalations.threadId)).find((m) => m.role === "user" && /Escalation notice/.test(m.text ?? ""));
    expect(noticeLine?.text?.split("\n")[0]).toMatch(/^\[.+ from RootClaw — not from the person\. .+\]$/);
    expect(noticeLine?.peerAsk).toEqual({ botId: mira.id, name: "Mira", unattended: true, incident: { threadId: mira.activeTaskId } });
    await turnEnded(chief.id, escalations.threadId);
  } finally {
    await close();
  }
}, 150_000);

it("routes a Chief's own gate to the person, never a dead end", async () => {
  const { url, api, control, botsNow, fakeChat, turnEnded, close } = await launch();
  try {
    const clive = (await control(["new-bot", "--name", "Clive", "--section", "Ops"])).bot;
    await api("PATCH", `/api/bots/${clive.id}`, { chiefOfStaff: true });
    fakeChat.set({ routes: [{
      match: "Ship the deploy",
      toolCalls: [
        { name: "load_tools", input: { names: ["raise_escalation"] } },
        { name: "agents_raise_escalation", input: { reason: "The production key needs the person's unlock." }, round: 1 },
      ],
      reply: "I flagged the gate and stopped.",
    }] });
    const stream = await openSse(`${url}/api/events`, { origin: url });
    try {
      await control(["send", "--bot", clive.id, "--text", "Ship the deploy."]);
      await turnEnded(clive.id, clive.activeTaskId);
      const name = `Barrier ${randomUUID().slice(0, 8)}`;
      await api("PATCH", `/api/bots/${clive.id}`, { name });
      await stream.until((frame) => frame.kind === "bot" && frame.bot?.name === name, 10_000);
      const notified = stream.frames.filter((frame) => frame.kind === "notify").map((frame) => frame.notification);
      expect(notified.some((n: any) => n?.kind === "incident" && n.botId === clive.id
        && /Escalation: Clive's work .*it raised this flag itself/.test(n.body ?? ""))).toBe(true);
    } finally {
      stream.close();
    }
    expect((await botsNow()).find((b) => b.id === clive.id)?.tasks?.some((t: any) => t.title === "Team escalations")).toBeFalsy();
  } finally {
    await close();
  }
}, 150_000);
