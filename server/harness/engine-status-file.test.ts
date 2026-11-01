import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { engineStatusFile, flushEngineStatusFiles } from "./engine-status-file.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await removeTempDir(dir);
  dir = undefined;
});

it("writes what the save delay still holds when the process exits cleanly, once", () => {
  dir = mkdtempSync(join(tmpdir(), "rootclaw-engine-status-"));
  const file = join(dir, "providers", "engine-status.json");
  const status = engineStatusFile(file);
  const row = { instanceId: "work", driverKind: "antigravityAgent", cli: "agy", snapshot: { state: "available" as const, authenticated: true } };
  status.save([row]);
  expect(existsSync(file)).toBe(false);
  flushEngineStatusFiles();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, engines: [row] });
  const read = status.read(() => ({ driverKind: "antigravityAgent", cli: "agy" }));
  expect(read.get("work")).toEqual({ state: "available", authenticated: true });
  flushEngineStatusFiles();
  expect(process.listeners("exit").filter((listener) => listener === flushEngineStatusFiles)).toHaveLength(1);
});

it("keeps the native free-provider mark and ignores retired ChatGPT-plan metadata", () => {
  dir = mkdtempSync(join(tmpdir(), "rootclaw-engine-status-"));
  const file = join(dir, "providers", "engine-status.json");
  const status = engineStatusFile(file);
  const free = { state: "available" as const, authenticated: true, freeFallback: true };
  mkdirSync(join(dir, "providers"), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 1, engines: [
    { instanceId: "openrouter", driverKind: "openai-compat", cli: null, snapshot: { ...free, chatgptPlan: true } },
  ] }));
  const read = status.read(() => ({ driverKind: "openai-compat", cli: null }));
  expect(read.get("openrouter")).toEqual(free);
});
