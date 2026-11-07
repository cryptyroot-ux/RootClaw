import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { createMemoryUpkeep, type UpkeepBot } from "./memory-upkeep.ts";
import { ensureWorkspace, writeMemoryFile, workspaceDir } from "./workspace.ts";

const writes = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("./atomic.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./atomic.ts")>();
  return {
    ...actual,
    writeFileAtomic: (path: string, data: string | Uint8Array, options?: { mode?: number; durable?: boolean }) => {
      writes.paths.push(path);
      return actual.writeFileAtomic(path, data, options);
    },
  };
});

const bots: UpkeepBot[] = Array.from({ length: 4 }, (_, index) => ({ id: `upkeep-${index}`, name: `Bot ${index}` }));
const today = new Date(2026, 8, 25, 10);

describe("memory upkeep state writes", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    writes.paths.length = 0;
    for (const bot of bots) {
      ensureWorkspace(bot.id);
      writeMemoryFile(bot.id, "- 2026-09-01 · Trip · until 2026-09-02\n");
    }
    writes.paths.length = 0;
  });

  it("writes one state snapshot for a tick that tidies multiple bots", async () => {
    const loop = createMemoryUpkeep({
      bots: () => bots,
      bot: (id) => bots.find((bot) => bot.id === id),
      engine: () => null,
      busy: () => false,
      addToAboutMe: () => 0,
      sourceLabel: () => "chat",
      quietMs: () => 60_000,
      tidyHour: () => 0,
      now: () => today,
    });
    await loop.tick();
    await loop.idle();
    const stateWrites = writes.paths.filter((path) => path === join(DATA_DIR, "memory-upkeep.json"));
    expect(stateWrites).toHaveLength(1);
    for (const bot of bots) expect(readFileSync(join(workspaceDir(bot.id), "MEMORY.md"), "utf8")).not.toContain("Trip");
  });
});
