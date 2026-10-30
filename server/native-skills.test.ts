import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, type AppConfig } from "./config.ts";
import { createSkillsLibraryHost } from "./host/skills-library.ts";
import { installSkill } from "./skills.ts";
import type { BotRecord, Store } from "./store.ts";
import { TASK_WORKSPACES_DIR } from "./workspace.ts";

// HOME and the data folder are this test file's own temporary ones (server/testing/setup.ts).
const HOME = join(DATA_DIR, "..");
const USER_SKILLS = join(HOME, ".claude", "skills");
const SHARED = join(TASK_WORKSPACES_DIR, ".claude", "skills");
const PROJECTS = join(HOME, "projects");
afterEach(() => {
  for (const dir of [TASK_WORKSPACES_DIR, USER_SKILLS, PROJECTS]) rmSync(dir, { recursive: true, force: true });
});

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Works with ${name}.\n---\n\nFollow the steps.\n`;
function plant(root: string, name: string): string {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), skillMd(name));
  return join(root, name, "SKILL.md");
}

function hostFor(driverKind: string, options: { cfg?: AppConfig; cwd?: string; threadCwd?: string | null } = {}) {
  const id = `bot-${randomUUID().slice(0, 8)}`;
  const bot = { id, threadId: "main", modelSelection: { instanceId: "engine", model: "m" }, ...(options.cwd ? { cwd: options.cwd } : {}) } as BotRecord;
  const host = createSkillsLibraryHost({
    store: {
      bot: () => undefined,
      messagesFor: () => [],
      taskByThread: (_botId: string, threadId: string) => (threadId === "pinned" ? { cwd: options.threadCwd } : undefined),
    } as unknown as Store,
    cfg: options.cfg ?? ({} as AppConfig),
    appendSkillRequestCard: () => ({ requestId: "", summary: "" }),
    instanceOf: (instanceId) => ({ instanceId, driverKind }),
  });
  return { host, bot };
}

const listed = (skills: Array<{ name: string; origin?: string }>) => skills.map((skill) => `${skill.name}:${skill.origin ?? "own"}`);

describe("skills the engine loads by itself", () => {

  it("never run one under the name of the bot's own skill that is switched off", () => {
    const { host, bot } = hostFor("grok");
    plant(SHARED, "mine");
    installSkill(bot.id, "local", [{ path: "SKILL.md", content: skillMd("mine") }]);
    expect(listed(host.listBotSkills(bot))).toEqual(["mine:own"]);
    expect(host.expandSkillCommand(bot, "main", "/mine go")).toBe("/mine go");
  });

  it.skipIf(process.platform === "win32")("never read a SKILL.md that is itself a link", () => {
    const { host, bot } = hostFor("grok");
    mkdirSync(join(SHARED, "linked"), { recursive: true });
    symlinkSync(plant(join(DATA_DIR, "elsewhere"), "secret"), join(SHARED, "linked", "SKILL.md"));
    expect(host.listBotSkills(bot)).toEqual([]);
    expect(host.readBotSkillFile(bot, "linked")).toBeNull();
    expect(host.expandSkillCommand(bot, "main", "/linked go")).toBe("/linked go");
  });

});
