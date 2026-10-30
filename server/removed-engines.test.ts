import { describe, expect, it } from "vitest";
import { removedComputerInstanceIds } from "./computer-engine-removal.ts";
import { instanceConfigs, withoutRemovedEngines } from "./config.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { DEFAULT_FLEET, NATIVE_DEFAULT_INSTANCE, REMOVED_DRIVER_KINDS } from "./instance-fleets.ts";

describe("native engines only", () => {
  it("ships no external agent CLI or ACP driver", () => {
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort();
    expect(kinds).toEqual(["anthropic", "cerebras", "gemini", "grok", "groq", "meta", "minimax", "mistral", "ollama", "openai-compat", "openai-responses"]);
    for (const kind of kinds) expect(REMOVED_DRIVER_KINDS.has(kind)).toBe(false);
  });

  it("starts a fresh install on the native engine, with no removed engine in the fleet", () => {
    expect(DEFAULT_FLEET[NATIVE_DEFAULT_INSTANCE]?.driver).toBe("openai-compat");
    for (const entry of Object.values(DEFAULT_FLEET)) expect(REMOVED_DRIVER_KINDS.has(entry.driver)).toBe(false);
  });

  it("drops a saved instance on a removed engine and keeps the native ones", () => {
    const map = instanceConfigs({ instances: { claude: { driver: "claudeAgent" }, mine: { driver: "codex" }, openaiCompat: { driver: "openai-compat" } } } as never);
    expect(map.claude).toBeUndefined();
    expect(map.mine).toBeUndefined();
    expect(map.openaiCompat?.driver).toBe("openai-compat");
    expect(withoutRemovedEngines({ x: { driver: "piAgent" }, y: { driver: "groq" } })).toEqual({ y: { driver: "groq" } });
  });

  it("names every instance a saved bot could still point at on a removed engine", () => {
    const ids = removedComputerInstanceIds({ myClaude: { driver: "claudeAgent" }, groq: { driver: "groq" }, codex: { driver: "groq" } });
    expect(ids.has("myClaude")).toBe(true);
    expect(ids.has("claude")).toBe(true);
    expect(ids.has("chatgpt")).toBe(true);
    expect(ids.has("computer")).toBe(true);
    // An old default id the person reused for a kept engine stays theirs.
    expect(ids.has("codex")).toBe(false);
    expect(ids.has("groq")).toBe(false);
    expect(ids.has(NATIVE_DEFAULT_INSTANCE)).toBe(false);
  });
});
