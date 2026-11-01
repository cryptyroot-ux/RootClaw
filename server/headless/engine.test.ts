import "../testing/scrub-ambient-rootclaw-env.ts";

import { describe, expect, it, vi } from "vitest";

import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

type Rec = Record<string, any>;
const KEY = "sk-ant-api03-test-0123456789abcdefghijklmnop";

function workspace(seed: { configured?: Record<string, boolean>; available?: string[] } = {}) {
  const config: Rec = {
    anthropic: { configured: Boolean(seed.configured?.anthropic) },
    openai: { configured: false }, openaiCompat: { configured: false, url: "" }, mistral: { configured: false },
  };
  const writes: Array<{ path: string; body?: Rec }> = [];
  const instances = () => ["anthropicApi", "openai", "openaiCompat", "mistral"].map((instanceId) => ({
    instanceId, driverKind: instanceId === "anthropicApi" ? "anthropic" : "openai-compat",
    snapshot: { state: seed.available?.includes(instanceId) ? "available" : "unavailable" },
  }));
  const request = vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if ((init.method ?? "GET") !== "GET") writes.push({ path, ...(body ? { body } : {}) });
    if (path === "/api/config" && init.method === "PUT") {
      for (const [name, value] of Object.entries(body as Rec)) {
        config[name] = { ...config[name], ...(value.key ? { configured: true } : {}),
          ...(value.url !== undefined && name === "openaiCompat" ? { url: value.url } : {}) };
      }
      return { ok: true };
    }
    if (path === "/api/config") return config;
    if (path === "/api/instances") return { instances: instances() };
    throw new Error(`unexpected ${init.method ?? "GET"} ${path}`);
  });
  const callTool = vi.fn(async (name: string) => {
    if (name === "list_available_models") return { instances: instances() };
    throw new Error(`unexpected tool ${name}`);
  });
  const run = async (argv: string[], env: Rec = { ANTHROPIC_API_KEY: KEY }) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => err.push(text), readStdin: async () => "" };
    const code = await runHeadless(argv, { io, env: { ROOTCLAW_URL: "http://127.0.0.1:19997", ...env }, request: request as any, callTool: callTool as any });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { config, writes, run };
}

describe("engine set", () => {
  it("writes a key once, never prints it, and leaves it alone on the next run unless --rotate", async () => {
    const w = workspace();
    const first = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--json"]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({ ok: true, kind: "claude", instanceId: "anthropicApi", configured: true, changed: ["key"] });
    expect(w.writes).toEqual([{ path: "/api/config", body: { anthropic: { key: KEY } } }]);
    expect(first.out + first.err).not.toContain(KEY);

    w.writes.length = 0;
    const again = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY"]);
    expect(again.out).toBe("claude was already set up; nothing changed (pass --rotate to replace its key). Bots use it as anthropicApi/MODEL (rootclaw models).");
    expect(w.writes).toEqual([]);
    expect((await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--rotate", "--json"])).code).toBe(0);
    expect(w.writes).toEqual([{ path: "/api/config", body: { anthropic: { key: KEY } } }]);
  });

  it("does not install external provider CLIs", async () => {
    const w = workspace();
    const result = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--install", "--json"]);
    expect(JSON.parse(result.out)).toMatchObject({ ok: false, exitCode: 2, error: "provider API keys do not install external CLIs" });
    expect(w.writes).toEqual([]);
  });

  it("configures Anthropic as a native API provider and accepts an optional base URL", async () => {
    const w = workspace();
    const only = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--base-url", "https://gw.example.com", "--json"]);
    expect(JSON.parse(only.out)).toMatchObject({ instanceId: "anthropicApi", changed: ["key", "baseUrl"] });
    expect(w.writes[0]).toEqual({ path: "/api/config", body: { anthropic: { key: KEY, url: "https://gw.example.com" } } });
    const kept = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--base-url", "https://gw2.example.com"]);
    expect(kept.out).toContain("warning: claude already has a key and the server does not show its base URL, so --base-url was not written: pass --rotate to write both");
    expect(w.writes).toHaveLength(1);
    const retired = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--only-claude-api", "--json"]);
    expect(JSON.parse(retired.out)).toMatchObject({ ok: false, exitCode: 2, error: "--only-claude-api was removed with external engine support" });
    const compat = await w.run(["engine", "set", "openai-compatible", "--key-env", "ANTHROPIC_API_KEY", "--json"]);
    expect(JSON.parse(compat.out)).toMatchObject({ ok: false, exitCode: 2, error: "openai-compatible needs --base-url" });
    const mistral = await w.run(["engine", "set", "mistral", "--key-env", "ANTHROPIC_API_KEY", "--base-url", "https://x.example", "--json"]);
    expect(JSON.parse(mistral.out)).toMatchObject({ exitCode: 2, error: "mistral takes no base URL" });
  });

  it("refuses a key it cannot read, and a dry run writes nothing", async () => {
    const w = workspace();
    const unset = await w.run(["engine", "set", "claude", "--key-env", "NOT_SET", "--json"], {});
    expect(JSON.parse(unset.out)).toMatchObject({ exitCode: 2, error: "the claude key: the environment variable NOT_SET is not set" });
    const both = await w.run(["engine", "set", "claude", "--key-env", "A", "--key-file", "B", "--json"]);
    expect(JSON.parse(both.out)).toMatchObject({ exitCode: 2, error: "give the key one way: --key-env VAR or --key-file FILE" });
    const dry = await w.run(["engine", "set", "claude", "--key-env", "ANTHROPIC_API_KEY", "--dry-run", "--json"]);
    expect(JSON.parse(dry.out)).toMatchObject({ dryRun: true, changed: ["key"] });
    expect(w.writes).toEqual([]);
  });
});

describe("engine list", () => {
  it("shows each engine and which keys are set, never their values", async () => {
    const w = workspace({ configured: { anthropic: true }, available: ["anthropicApi"] });
    const listed = await w.run(["engine", "list", "--json"]);
    expect(JSON.parse(listed.out).keys).toEqual({ claude: true, openai: false, openrouter: false, "openai-compatible": false, xai: false, groq: false, mistral: false, cerebras: false, ollama: false });
    const human = await w.run(["engine", "list"]);
    expect(human.out).toContain("anthropicApi · anthropic · available");
    expect(human.out).toContain("Keys set: claude");
  });
});
