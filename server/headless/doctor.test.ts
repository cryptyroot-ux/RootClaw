import "../testing/scrub-ambient-rootclaw-env.ts";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OllamaCloudDriver } from "../drivers/api-providers.ts";
import type { HeadlessIo } from "./output.ts";
import { runHeadless } from "./main.ts";

type Rec = Record<string, any>;
// A fixture, never a real key.
const fixtureKey = "ollama-fixture-key-0123456789";

// The workspace's Ollama Cloud instance, built by the real driver with no saved key: only the server's own
// OLLAMA_API_KEY (the driver's fallback) can make it ready. The workspace's config shows no saved key.
async function doctorWithServerEnv() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
  const instance = await OllamaCloudDriver.create({ instanceId: "ollamaCloud", displayName: "Ollama Cloud", enabled: true,
    config: OllamaCloudDriver.defaultConfig(), environment: {} });
  const snapshot = await instance.snapshot();
  await instance.dispose();
  const callTool = vi.fn(async (name: string) => {
    if (name === "get_system_health") return { app: "rootclaw", ok: true };
    if (name === "list_available_models") return { instances: [{ instanceId: "ollamaCloud", driverKind: "ollama", snapshot }] };
    throw new Error(`unexpected tool ${name}`);
  });
  const request = vi.fn(async (path: string) => {
    if (path === "/.well-known/rootclaw/environment") return { version: "test", label: "Test", capabilities: { jobs: true } };
    if (path === "/api/auth/session") return { kind: "loopback", trust: "owner" };
    if (path === "/api/config") return { ollama: { configured: false } };
    throw new Error(`unexpected GET ${path}`);
  });
  const out: string[] = [];
  const io: HeadlessIo = { out: (text) => out.push(text), err: (text) => out.push(text), readStdin: async () => "" };
  const code = await runHeadless(["doctor", "--json"], { io, env: { ROOTCLAW_URL: "http://127.0.0.1:19996" }, request: request as any, callTool: callTool as any });
  return { code, result: JSON.parse(out.join("\n")) as Rec, text: out.join("\n") };
}

describe("doctor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("counts Ollama Cloud ready from the server's own OLLAMA_API_KEY, and never prints it", async () => {
    vi.stubEnv("OLLAMA_API_KEY", fixtureKey);
    const { code, result, text } = await doctorWithServerEnv();
    expect(code).toBe(0);
    expect(result).toMatchObject({ ok: true, availableEngines: ["ollamaCloud"], problems: [] });
    expect(text).not.toContain(fixtureKey);
  });

  it("reports no engine without that key", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "");
    const { code, result } = await doctorWithServerEnv();
    expect(code).not.toBe(0);
    expect(result).toMatchObject({ ok: false, availableEngines: [], problems: [expect.stringContaining("no engine is available")] });
  });
});
