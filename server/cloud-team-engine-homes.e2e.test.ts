import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { shellSandbox } from "./drivers/workspace-tools.ts";
import { audienceHome } from "./engine-homes/layout.ts";
import { personKey } from "./person-key.ts";
import { FAKE_OPENAI_MODEL, startFakeOpenAiChat, type FakeOpenAiChat } from "./testing/fake-openai-chat.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-team-homes_${randomBytes(8).toString("hex")}`;
const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };

let fx: CloudSendFixture, team: CloudTeamFixture, chat: FakeOpenAiChat;
let owner = "", admin = "", bob = "", bot: { id: string; mainThreadId: string };
let nativeRoot = "", dataDir = "", bobHome = "", ownerHome = "", bobThread = "";
const isolatedNativeShell = process.platform === "linux" && shellSandbox() === "bwrap";

const messages = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Array<{ role: string; text?: string }>;
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
async function turn(token: string, threadId: string, text: string) {
  const before = (await messages(token, threadId)).length;
  const sent = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => await idle(token) && (await messages(token, threadId)).length >= before + 2,
    { timeout: 60_000, interval: 100 }).toBe(true);
}
const newThread = async (token: string, title: string) => {
  const created = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
};

beforeAll(async () => {
  if (process.platform === "win32") return;
  nativeRoot = mkdtempSync(join(tmpdir(), "rootclaw-cloud-native-team-"));
  dataDir = join(nativeRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  chat = await startFakeOpenAiChat();
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    openaiCompat: { url: chat.url, key: "fixture-only", model: FAKE_OPENAI_MODEL },
    defaultModelSelection: { instanceId: "openaiCompat", model: FAKE_OPENAI_MODEL },
    instances: { openaiCompat: { driver: "openai-compat", displayName: "Fixture engine" } },
  }));
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-homes", name: "Acme", env: {
    HOME: nativeRoot, USERPROFILE: nativeRoot, ROOTCLAW_DATA_DIR: dataDir,
  } } });
  team = fx.team!;
  bobHome = audienceHome(dataDir, `member:${personKey({ id: "", email: BOB.email })}`);
  ownerHome = audienceHome(dataDir, `member:${personKey({ id: "", email: OWNER.email })}`);
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  bob = (await team.pair(BOB)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
}, hostTimeout(120_000));

afterAll(async () => {
  const errors: unknown[] = [];
  for (const cleanup of [
    async () => await fx?.close(),
    async () => await chat?.stop(),
    () => { if (nativeRoot) rmSync(nativeRoot, { recursive: true, force: true }); },
  ]) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Cloud native Team fixture cleanup failed");
});

it.runIf(process.platform !== "win32")("a private Team Cloud turn uses its member's and team's context, excludes another member's, and stays private", async () => {
  const workspace = join(dataDir, "workspaces", bot.id);
  const layer = (audience: string) => `${bot.id}--${audience}`;
  mkdirSync(join(workspace, "memory"), { recursive: true });
  writeFileSync(join(workspace, "MEMORY.md"), "# Memory\n\n- Team marker team-amber-63\n");
  const bobWorkspace = join(dataDir, "workspaces", layer(`member-${personKey({ id: "", email: BOB.email })}`));
  mkdirSync(join(bobWorkspace, "memory"), { recursive: true });
  writeFileSync(join(bobWorkspace, "MEMORY.md"), "# Memory\n\n- Bob-only memory marker bob-cobalt-28\n");
  mkdirSync(join(dataDir, "workspaces", layer(`member-${personKey({ id: "", email: ADMIN.email })}`), "memory"), { recursive: true });
  writeFileSync(join(dataDir, "workspaces", layer(`member-${personKey({ id: "", email: ADMIN.email })}`), "MEMORY.md"), "# Memory\n\n- Admin-only marker admin-jade-91\n");
  bobThread = await newThread(bob, "Bob and Scout");
  const profile = await team.as(bob, "PUT", "/api/me", { aboutMe: "Profile-only marker profile-violet-47." });
  expect(profile.status, JSON.stringify(profile.body)).toBe(200);
  expect((await team.as(bob, "GET", "/api/me")).body.aboutMe).toBe("Profile-only marker profile-violet-47.");
  await turn(bob, bobThread, "Please greet me.");
  const request = chat.requests.at(-1)!;
  const wire = JSON.stringify(request.messages);
  expect(wire).toContain("profile-violet-47");
  expect(wire).toContain("bob-cobalt-28");
  expect(wire).toContain("team-amber-63");
  expect(wire).not.toContain("admin-jade-91");
  expect((await team.as(owner, "GET", `/api/threads/${bobThread}/messages?limit=200`)).status).toBe(404);
  expect((await team.as(admin, "GET", `/api/threads/${bobThread}/messages?limit=200`)).status).toBe(404);
  expect((await team.as(owner, "GET", "/api/me")).body.aboutMe).not.toContain("profile-violet-47");
  await turn(owner, await newThread(owner, "Olive and Scout"), "Hello.");
  const ownerWire = JSON.stringify(chat.requests.at(-1)!.messages);
  expect(ownerWire).toContain("team-amber-63");
  expect(ownerWire).not.toContain("profile-violet-47");
  expect(ownerWire).not.toContain("bob-cobalt-28");
}, hostTimeout(120_000));

it.runIf(process.platform !== "win32")("Bob's native conversation resumes with its private history", async () => {
  await turn(bob, bobThread, "Repeat my private marker.");
  const request = chat.requests.at(-1)!;
  expect(JSON.stringify(request.messages)).toContain("profile-violet-47");
  expect(JSON.stringify(request.messages)).toContain("bob-cobalt-28");
  expect(JSON.stringify(request.messages)).not.toContain("admin-jade-91");
}, hostTimeout(90_000));

it.runIf(isolatedNativeShell)("Owner and Admin native shell turns cannot read Bob's engine-home marker", async () => {
  const marker = "bob-home-shell-only-marker-7d2f";
  mkdirSync(bobHome, { recursive: true });
  writeFileSync(join(bobHome, "private-marker.txt"), marker);
  chat.set({ toolCalls: [{ name: "shell", input: { command: `if [ -r '${join(bobHome, "private-marker.txt")}' ]; then cat '${join(bobHome, "private-marker.txt")}'; else echo BOB_HOME_UNREADABLE; fi` } }] });
  for (const token of [owner, admin]) {
    const thread = await newThread(token, "Check home isolation");
    const before = chat.requests.length;
    await turn(token, thread, "Check the private path using the shell tool.");
    const requests = chat.requests.slice(before);
    const toolResults = requests.flatMap((request) => request.messages as Array<{ role?: string; content?: unknown }>)
      .filter((message) => message.role === "tool").map((message) => JSON.stringify(message.content)).join("\n");
    expect(toolResults).toContain("BOB_HOME_UNREADABLE");
    expect(toolResults).not.toContain(marker);
  }
}, hostTimeout(120_000));

it.runIf(process.platform !== "win32")("a member who leaves has their engine home removed", async () => {
  expect(existsSync(bobHome)).toBe(true);
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: BOB.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(existsSync(bobHome)).toBe(false);
  expect(existsSync(ownerHome)).toBe(true);
}, hostTimeout(60_000));
