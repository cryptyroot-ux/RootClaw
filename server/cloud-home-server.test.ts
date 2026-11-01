// The full server as a Cloud home over its real HTTP boundary, still sent the ROOTCLAW_HOSTED_* settings an Admin from before
// Cloud Pro dropped included AI. Disposable home; no network; the native engine on a loopback fixture.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudHomePlaceRefusal, cloudPairingSignature, cloudRequestSignature } from "./cloud-home.ts";
import { cloudHomePrompt } from "./system-prompt.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { FAKE_OPENAI_MODEL, startFakeOpenAiChat, type FakeOpenAiChat } from "./testing/fake-openai-chat.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "rootclaw-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const token = `rootclaw_cloudai_${randomBytes(32).toString("base64url")}`;
const gateway = {
  ROOTCLAW_HOSTED_MODEL_URL: "https://cloud.example.test/api/cloud/gateway/g0123456789abcdef0123456789abcd",
  ROOTCLAW_HOSTED_MODEL_TOKEN: token,
  ROOTCLAW_HOSTED_MODELS: JSON.stringify({ anthropic: [], openai: ["gpt-fixture"], openrouter: ["anthropic/claude-fixture"] }),
};
// Cloud Pro's included Boat computers, voice and decisions.
const included = {
  ROOTCLAW_CLOUD_BOAT_URL: "https://cloud.example.test/api/cloud/services/boat/api/box/v1",
  ROOTCLAW_CLOUD_BOAT_TOKEN: `box_rootclaw_${randomBytes(24).toString("base64url")}`,
  ROOTCLAW_CLOUD_VOICE_URL: "https://cloud.example.test/api/cloud/services/voice/v1",
  ROOTCLAW_CLOUD_VOICE_TOKEN: `rootclaw_voice_${randomBytes(24).toString("base64url")}`,
  ROOTCLAW_TTS_DEFAULT_VOICE: "preset0voice0id",
  ROOTCLAW_CLOUD_DECIDER_URL: "https://cloud.example.test/api/cloud/services/decider",
  ROOTCLAW_CLOUD_DECIDER_TOKEN: `rootclaw_decide_${randomBytes(32).toString("base64url")}`,
};
const includedTokens = [included.ROOTCLAW_CLOUD_BOAT_TOKEN, included.ROOTCLAW_CLOUD_VOICE_TOKEN, included.ROOTCLAW_CLOUD_DECIDER_TOKEN];
const CAPABILITY_KEY = "cloud-home-server-test-capability";
const MODEL = { instanceId: "openaiCompat", model: FAKE_OPENAI_MODEL };
let home: string;
let base: string;
let child: ChildProcess;
let fake: FakeOpenAiChat;
let log = "";

let ownerToken = "";

/** A request through the edge. Without `remote`, it comes from one of the
 * owner's own devices (paired with the Admin's signed request): on a Cloud
 * home a bare local request is only a service, never the owner. */
async function api(method: string, path: string, options: { body?: unknown; remote?: boolean; headers?: Record<string, string> } = {}) {
  const asOwner = !options.remote && ownerToken !== "";
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      // What the Caddy edge adds to every request it forwards: never the owner.
      ...(options.remote || asOwner ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } : {}),
      ...(asOwner ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "rootclaw-cloud-home-server-"));
  fake = await startFakeOpenAiChat();
  const dataDir = join(home, ".rootclaw");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      // Pin the fleet's other defaults so this never probes an installed CLI.
      ...Object.fromEntries(["claude", "codex", "cursor", "githubCopilot", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      openaiCompat: { driver: "openai-compat", displayName: "Fixture", config: { url: fake.url, key: "fixture-only", model: FAKE_OPENAI_MODEL } },
    },
  }));
  // Moved here from a Windows PC by a release that left the PC's data folder in memory.
  mkdirSync(join(dataDir, ".backups"));
  writeFileSync(join(dataDir, ".backups", "last-restore.json"), JSON.stringify({ restored: true, id: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }));
  mkdirSync(join(dataDir, "workspaces", "moved"), { recursive: true });
  writeFileSync(join(dataDir, "workspaces", "moved", "MEMORY.md"), "The register is C:\\Users\\Ada\\.rootclaw\\files\\register.xlsx.\n");
  // The web UI's pages (a stand-in for the built app).
  mkdirSync(join(home, "web"));
  writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>RootClaw</title>");
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const fixtureOrigin = new URL(fake.url).origin;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent(`const allow=${JSON.stringify(fixtureOrigin)};const real=globalThis.fetch.bind(globalThis);globalThis.fetch=async(input,init)=>{const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;if(url.startsWith(allow))return real(input,init);return new Response("offline fixture",{status:503});};`)}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, ROOTCLAW_DATA_DIR: dataDir, ROOTCLAW_PORT: String(port), ROOTCLAW_WEBHOOK_PORT: String(port + 1), ROOTCLAW_STATIC_DIR: join(home, "web"),
      ROOTCLAW_CLOUD_ROLE: "home", ROOTCLAW_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", ROOTCLAW_CLOUD_ADMIN_URL: "https://cloud.example.test",
      ROOTCLAW_CLOUD_BOOTSTRAP_SECRET: secret, ROOTCLAW_PUBLIC_URL: `https://${HOST}`,
      ROOTCLAW_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY,
      ...gateway,
      ...included,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await api("GET", "/api/health")).body?.pid === child.pid) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ownerToken = await ownerPairing();
  // Chief first makes the seeded bot its team's Chief, which answers a teammate's failed run with a Team incidents turn
  // of its own on the same Claude: a second failed turn in the health read. Stepped down, each test's turns are its own.
  const seeded = ((await api("GET", "/api/bots?messages=0")).body.bots as any[]).find((bot) => bot.chiefOfStaff);
  expect((await api("PATCH", `/api/bots/${seeded.id}`, { body: { chiefOfStaff: false } })).status).toBe(200);
}, 30_000);

async function ownerPairing(): Promise<string> {
  const body = JSON.stringify({ label: "RootClaw app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await api("POST", "/api/cloud/pairing", { remote: true, headers: {
    "content-type": "application/json", "x-rootclaw-cloud-timestamp": timestamp, "x-rootclaw-cloud-nonce": nonce,
    "x-rootclaw-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body: JSON.parse(body) });
  return (await api("POST", "/api/auth/pair", { remote: true, body: { code: granted.body.code } })).body.token as string;
}

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (fake) await fake.stop();
  if (home) await removeTempDir(home);
});

it("boots with stray gateway settings and never logs them", () => {
  expect(log).not.toContain(token);
  expect(log).not.toContain(secret);
  for (const includedToken of includedTokens) expect(log).not.toContain(includedToken);
});

// Cloud homes are Linux; on Windows the data folder is itself a drive path.
it.skipIf(process.platform === "win32")("rewrites the data folder of the computer it was moved from before anything reads it", () => {
  const dataDir = join(home, ".rootclaw");
  expect(readFileSync(join(dataDir, "workspaces", "moved", "MEMORY.md"), "utf8")).toBe(`The register is ${dataDir}/files/register.xlsx.\n`);
  expect(JSON.parse(readFileSync(join(dataDir, ".backups", "last-restore.json"), "utf8")).pathsRewritten).toBe(true);
});

it("offers the included computers, voice and decisions with no key, and never shows or saves their tokens", async () => {
  const status = await api("GET", "/api/config");
  expect(status.status).toBe(200);
  expect(status.body.box).toEqual({ configured: true, included: true });
  expect(status.body.tts).toMatchObject({ configured: true, ready: true, provider: "elevenlabs", voice: "preset0voice0id", included: true });
  expect(status.body.decider).toEqual({ provider: "jev", configured: true, included: true, enabled: true, jobs: { roomRouting: true } });
  const saved = readFileSync(join(home, ".rootclaw", "config.json"), "utf8");
  for (const includedToken of includedTokens) {
    expect(JSON.stringify(status.body)).not.toContain(includedToken);
    expect(saved).not.toContain(includedToken);
  }
});

it("pairs the app on a signed request and tells it its first run is the engine sign-in; no gateway models are served", async () => {
  const body = JSON.stringify({ label: "RootClaw app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await api("POST", "/api/cloud/pairing", { remote: true, headers: {
    "content-type": "application/json", "x-rootclaw-cloud-timestamp": timestamp, "x-rootclaw-cloud-nonce": nonce,
    "x-rootclaw-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body: JSON.parse(body) });
  expect(granted.status, JSON.stringify(granted.body)).toBe(200);
  const paired = await api("POST", "/api/auth/pair", { remote: true, body: { code: granted.body.code } });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  const auth = { authorization: `Bearer ${paired.body.token}` };
  const session = await api("GET", "/api/auth/session", { remote: true, headers: auth });
  expect(session.body).toMatchObject({ kind: "session", scopes: ["admin", "client"], cloudHome: true });
  expect(session.body).not.toHaveProperty("hosted");
  expect((await api("GET", "/api/config", { remote: true, headers: auth })).body.onboarding).not.toHaveProperty("firstTurnAt");
  const { instances } = (await api("GET", "/api/instances", { remote: true, headers: auth })).body;
  expect(instances.map((instance: any) => instance.instanceId)).toContain("openaiCompat");
  expect(instances.filter((instance: any) => instance.instanceId.startsWith("included.") || "included" in instance || instance.readOnly)).toEqual([]);
  expect(JSON.stringify(instances)).not.toContain("cloud.example.test");
});

async function mintBrowserSignIn(owner = "ada@example.test"): Promise<string> {
  const body = JSON.stringify({ label: "Web browser (Cloud page)", ttlSeconds: 120, purpose: "browser", owner });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await api("POST", "/api/cloud/pairing", { remote: true, headers: {
    "content-type": "application/json", "x-rootclaw-cloud-timestamp": timestamp, "x-rootclaw-cloud-nonce": nonce,
    "x-rootclaw-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body: JSON.parse(body) });
  expect(granted.status, JSON.stringify(granted.body)).toBe(200);
  expect(granted.body).toMatchObject({ purpose: "browser", credential: expect.stringMatching(/^rootclaw_pair_/) });
  expect(granted.body).not.toHaveProperty("code");
  return granted.body.credential as string;
}
const browserRequest = (body: Record<string, unknown>, cookie?: string) => fetch(`${base}/api/auth/pair`, { method: "POST", headers: {
  host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

it("signs a browser in from the Cloud page's \"Use in your browser\" into an owner's session, once, and never logs it", async () => {
  const credential = await mintBrowserSignIn();
  expect((await api("POST", "/api/auth/pair", { remote: true, body: { code: credential } })).status).toBe(401);
  expect((await api("POST", "/api/pair", { remote: true, body: { credential } })).status).toBe(401);
  expect((await api("POST", "/api/auth/pair", { remote: true, body: { code: credential, browser: true } })).status).toBe(400);
  for (let i = 0; i < 2; i++) {
    const preview = await browserRequest({ code: credential, browser: true, preview: true });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ owner: "ada@example.test", expiresAt: expect.any(Number) });
    expect(preview.headers.get("set-cookie")).toBeNull();
  }
  const signIn = () => browserRequest({ code: credential, label: "Safari on iPad", cookie: true, browser: true, attemptId: randomBytes(12).toString("base64url") });
  const signedIn = await signIn();
  expect(signedIn.status).toBe(200);
  expect(await signedIn.json()).not.toHaveProperty("token");
  const cookie = signedIn.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/Secure/);
  expect(cookie).toMatch(/SameSite=Lax/);
  const session = await api("GET", "/api/auth/session", { remote: true, headers: { cookie: cookie.split(";")[0] } });
  expect(session.body).toMatchObject({ kind: "session", label: "Safari on iPad", scopes: ["admin", "client"], cloudHome: true, owner: "ada@example.test" });
  const token = cookie.split(";")[0].split("=").slice(1).join("=");
  expect((await api("GET", "/api/auth/session", { remote: true, headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  const change = (headers: Record<string, string>) => api("POST", "/api/auth/stream-ticket", { remote: true, headers: { cookie: cookie.split(";")[0], ...headers } });
  expect((await change({})).status).toBe(403);
  expect((await change({ "sec-fetch-site": "cross-site" })).status).toBe(403);
  // (fetch sends its own Host here, so this Cloud's origin is the proxied scheme plus the fixture's address)
  expect((await change({ origin: base.replace("http:", "https:") })).status).toBe(200);
  expect((await change({ origin: `https://evil.example`, "sec-fetch-site": "same-origin" })).status).toBe(403);
  expect((await change({ "sec-fetch-site": "same-origin" })).status).toBe(200);
  expect((await signIn()).status).toBe(401);
  expect((await browserRequest({ code: credential, browser: true, preview: true })).status).toBe(401);
  expect(log).not.toContain(credential);
});

it("replaces a browser's own session when it signs in again, and a lost answer leaves a named session that can be revoked", async () => {
  const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0];
  const first = await browserRequest({ code: await mintBrowserSignIn(), label: "Chrome on Mac", cookie: true, browser: true, attemptId: randomBytes(12).toString("base64url") });
  expect(first.status).toBe(200);
  const firstCookie = cookieOf(first), firstId = ((await first.json()) as any).session.id as string;
  const second = await browserRequest({ code: await mintBrowserSignIn(), label: "Chrome on Mac", cookie: true, browser: true, attemptId: randomBytes(12).toString("base64url") }, firstCookie);
  expect(second.status).toBe(200);
  const secondCookie = cookieOf(second), secondId = ((await second.json()) as any).session.id as string;
  expect((await api("GET", "/api/auth/session", { remote: true, headers: { cookie: firstCookie } })).status).toBe(401);
  const listed = await api("GET", "/api/auth/sessions", { remote: true, headers: { cookie: secondCookie } });
  expect(listed.body.sessions.map((s: any) => s.id)).toContain(secondId);
  expect(listed.body.sessions.map((s: any) => s.id)).not.toContain(firstId);
  const lost = await browserRequest({ code: await mintBrowserSignIn(), label: "Firefox on Chromebook", cookie: true, browser: true, attemptId: randomBytes(12).toString("base64url") });
  const lostId = ((await lost.json()) as any).session.id as string;
  const orphan = (await api("GET", "/api/auth/sessions", { remote: true, headers: { cookie: secondCookie } })).body.sessions.find((s: any) => s.id === lostId);
  expect(orphan).toMatchObject({ label: "Firefox on Chromebook", scopes: ["admin", "client"], owner: "ada@example.test" });
  const revoke = await fetch(`${base}/api/auth/sessions/${lostId}`, { method: "DELETE", headers: { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https",
    "sec-fetch-site": "same-origin", cookie: secondCookie } });
  expect(revoke.status).toBe(200);
  expect((await api("GET", "/api/auth/session", { remote: true, headers: { cookie: cookieOf(lost) } })).status).toBe(401);
});

it("serves its pages to no frame and with no Referer", async () => {
  for (const path of ["/pair", "/", "/settings"]) {
    const page = await fetch(`${base}${path}`, { headers: { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } });
    expect(page.status, path).toBe(200);
    expect(page.headers.get("content-type"), path).toBe("text/html");
    expect(page.headers.get("content-security-policy"), path).toBe("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options"), path).toBe("DENY");
    expect(page.headers.get("referrer-policy"), path).toBe("no-referrer");
  }
});

it("does not count a turn that was stopped before it finished", async () => {
  const dump = join(home, "spawn-hang.json");
  rmSync(dump, { force: true });
  fake.set({ mode: "hang", dump, routes: [] });
  const created = await api("POST", "/api/bots", { body: {
    name: "Stopped fixture", modelSelection: MODEL, requireAvailableModel: true,
  } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const botId = created.body.bot.id;
  try {
    expect((await api("POST", `/api/bots/${botId}/messages`, { body: { text: "wait for me" } })).status).toBe(202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
  } finally {
    fake.set({ mode: "happy" });
    await api("POST", `/api/bots/${botId}/interrupt`, { body: {} });
  }
  const busy = async () => {
    const { bots } = (await api("GET", "/api/bots?messages=10")).body as { bots: Array<{ id: string; busy?: boolean }> };
    return bots.find((bot) => bot.id === botId)?.busy === true;
  };
  await expect.poll(busy, { timeout: 15_000 }).toBe(false);
  expect((await api("GET", "/api/config")).body.onboarding).not.toHaveProperty("firstTurnAt");
  rmSync(dump, { force: true });
});

it("never hands a gateway's settings or the signing secret to an engine", async () => {
  const dump = join(home, "spawn.json");
  rmSync(dump, { force: true });
  fake.set({ mode: "happy", dump, routes: [] });
  const created = await api("POST", "/api/bots", { body: {
    name: "Cloud fixture", modelSelection: MODEL, requireAvailableModel: true,
  } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await api("POST", `/api/bots/${created.body.bot.id}/messages`, { body: { text: "hello" } })).status).toBe(202);
  await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
  const sent = JSON.parse(readFileSync(dump, "utf8")) as { prompt?: string };
  expect(sent.prompt).toContain("hello");
  const body = JSON.stringify(sent);
  expect(body).not.toContain(token);
  expect(body).not.toContain(secret);
  for (const includedToken of includedTokens) expect(body).not.toContain(includedToken);
});

it("records when a bot's turn first finished here, once, in the Cloud's own settings", async () => {
  const first = async () => (await api("GET", "/api/config")).body.onboarding?.firstTurnAt as string | undefined;
  await expect.poll(first, { timeout: 15_000 }).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const recorded = await first();
  expect(JSON.parse(readFileSync(join(home, ".rootclaw", "config.json"), "utf8")).onboarding.firstTurnAt).toBe(recorded);
  const created = await api("POST", "/api/bots", { body: {
    name: "Second fixture", modelSelection: MODEL, requireAvailableModel: true,
  } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const botId = created.body.bot.id;
  expect((await api("POST", `/api/bots/${botId}/messages`, { body: { text: "hello again" } })).status).toBe(202);
  const replied = async () => {
    const { bots } = (await api("GET", "/api/bots?messages=10")).body as { bots: Array<{ id: string; busy?: boolean; messages: Array<{ role: string; kind: string }> }> };
    const bot = bots.find((entry) => entry.id === botId);
    return Boolean(bot && !bot.busy && bot.messages.some((message) => message.role === "bot" && message.kind === "text"));
  };
  await expect.poll(replied, { timeout: 15_000 }).toBe(true);
  expect(await first()).toBe(recorded);
});

it("offers its bots the browser and cloud computers only, and tells them they cannot see the person's computer", async () => {
  const status = await api("GET", "/api/config");
  expect(status.body).toMatchObject({ cloudHome: true, features: { browser: true } });
  const dump = join(home, "spawn-hang.json");
  rmSync(dump, { force: true });
  fake.set({ mode: "hang", dump, routes: [] });
  const created = await api("POST", "/api/bots", { body: {
    name: "Desk fixture", modelSelection: MODEL, requireAvailableModel: true,
  } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const botId = created.body.bot.id;
  const threadId = created.body.bot.threadId as string;
  try {
    expect((await api("POST", `/api/bots/${botId}/messages`, { body: { text: "list the files on my desktop" } })).status).toBe(202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
    const sent = JSON.parse(readFileSync(dump, "utf8")) as { systemPrompt?: string };
    expect(sent.systemPrompt).toContain(cloudHomePrompt(true));
    expect(sent.systemPrompt).toContain("check list_shared_computers");
    expect(sent.systemPrompt).not.toMatch(/Local VM is an isolated desktop|user's host|host desktop|select an available Local VM/);
    expect(JSON.stringify(sent)).not.toContain(token);
    expect(JSON.stringify(sent)).not.toContain(secret);
    const preview = (await api("GET", `/api/bots/${botId}/system-prompt`)).body.sections as Array<{ id: string; text: string }>;
    expect(preview.find((section) => section.id === "cloud-home")?.text).toBe(cloudHomePrompt(true));
    const minted = await api("POST", "/api/testing/internal-capability", {
      headers: { "x-rootclaw-test-capability": CAPABILITY_KEY },
      body: { botId, threadId, kind: "agents" },
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const select = (surface?: string) => fetch(`${base}/api/internal/computer/select`, {
      method: surface === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${minted.body.token}`, ...(surface === undefined ? {} : { "content-type": "application/json" }) },
      ...(surface === undefined ? {} : { body: JSON.stringify({ surface }) }),
    });
    const listed = await (await select()).json() as { canSelect: boolean; options: Array<{ surface: string }> };
    expect(listed.canSelect).toBe(true);
    expect(listed.options.map((option) => option.surface)).toEqual(["cloud", "browser"]);
    expect(JSON.stringify(listed)).not.toMatch(/this computer|Local VM|container runtime/i);
    for (const surface of ["local", "vm"] as const) {
      const refused = await select(surface);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toBe(cloudHomePlaceRefusal(surface));
    }
  } finally {
    fake.set({ mode: "happy" });
    await api("POST", `/api/bots/${botId}/interrupt`, { body: {} });
  }
});

it("refuses a bot still set to this computer or a Local VM, saying what is true on a Cloud home", async () => {
  fake.set({ mode: "happy", routes: [] });
  for (const computer of ["local", "vm"] as const) {
    const created = await api("POST", "/api/bots", { body: {
      name: `Earlier ${computer} fixture`, modelSelection: MODEL, requireAvailableModel: true,
    } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const botId = created.body.bot.id;
    expect((await api("PATCH", `/api/bots/${botId}`, { body: { computer } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${botId}/messages`, { body: { text: "list the files on my desktop" } })).status).toBe(202);
    const failure = async () => {
      const { bots } = (await api("GET", "/api/bots?messages=10")).body as { bots: Array<{ id: string; messages: Array<{ kind: string; tool?: { name: string; ok: boolean } }> }> };
      return bots.find((bot) => bot.id === botId)?.messages.find((message) => message.kind === "activity" && message.tool?.ok === false)?.tool?.name;
    };
    await expect.poll(failure, { timeout: 15_000 }).toBe(`error: ${cloudHomePlaceRefusal(computer)}`);
  }
});

it("tells the Admin's signed health read a failed turn's code, never its words, the bot's name or the request", async () => {
  const words = "You've hit your weekly limit · resets for ada.lovelace@example.test on Secret Merger Plans";
  fake.set({
    mode: "happy",
    routes: [{ match: "Draft the ACME layoffs memo", mode: "error" }],
    errorStatus: 429,
    errorMessage: words,
  });
  let botId = "";
  try {
    const created = await api("POST", "/api/bots", { body: {
      name: "Tallyspoon Ops", modelSelection: MODEL, requireAvailableModel: true,
    } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    botId = created.body.bot.id;
    expect((await api("POST", `/api/bots/${botId}/messages`, { body: { text: "Draft the ACME layoffs memo" } })).status).toBe(202);
  } finally {
    await expect.poll(async () => {
      const { bots } = (await api("GET", "/api/bots?messages=10")).body as { bots: Array<{ id: string; messages: Array<{ kind: string; tool?: { ok: boolean } }> }> };
      return bots.find((bot) => bot.id === botId)?.messages.some((message) => message.kind === "activity" && message.tool?.ok === false);
    }, { timeout: 15_000 }).toBe(true);
    fake.set({ mode: "happy", routes: [], errorStatus: undefined, errorMessage: undefined });
  }
  const read = async (key = secret) => {
    const target = "/api/cloud/health?after=0", timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    return api("GET", target, { remote: true, headers: { "x-rootclaw-cloud-timestamp": timestamp, "x-rootclaw-cloud-nonce": nonce,
      "x-rootclaw-cloud-signature": `v1=${cloudRequestSignature(key, timestamp, nonce, "GET", target, "")}` } });
  };
  await expect.poll(async () => (await read()).body.incidents?.some((incident: { botId: string }) => incident.botId === botId), { timeout: 15_000 }).toBe(true);
  const report = await read();
  expect(report.status).toBe(200);
  expect(report.body).toMatchObject({ v: 1, turns: { failed24h: expect.any(Number) }, engines: expect.arrayContaining([expect.objectContaining({ kind: "openai-compat", used: true })]) });
  expect(report.body.incidents).toContainEqual(expect.objectContaining({ kind: "turn", code: "quota", engine: "openai-compat", botId, count: 1 }));
  for (const planted of ["weekly limit", "ada.lovelace@example.test", "Secret Merger Plans", "Tallyspoon Ops", "Draft the ACME"]) {
    expect(JSON.stringify(report.body), planted).not.toContain(planted);
  }
  expect(log).not.toContain("ada.lovelace@example.test");
  expect((await read("W".repeat(43))).status).toBe(401);
  expect((await api("GET", "/api/cloud/health?after=0", { remote: true })).status).toBe(401);
});
