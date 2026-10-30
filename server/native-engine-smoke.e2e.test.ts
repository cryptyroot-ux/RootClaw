// RootClaw runs on native engines only: one real server, the native OpenAI-compatible engine on a loopback fake,
// and the everyday paths a person uses. No agent CLI is installed, probed or started.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-rootclaw.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";

const REMOVED_ENGINE_WORDS = /claude|codex|antigravity|opencode|copilot|cline|gemini|kimi|qwen|hermes|deepseek|museCode|piAgent|acp\b|cli not found|not installed/i;

it("boots clean and runs bots, streaming, tools, channels and routines on the native engine", async () => {
  const fixture = await launchVerificationServer();
  try {
    const api = fixtureApi(fixture.info.url);
    const cli = async (...args: string[]) => await runControlOmb([...args, "--url", fixture.info.url]) as any;
    expect((await cli("doctor")).ok).toBe(true);

    // Only native engines are listed, and the default one is ready.
    const { instances } = await api("GET", "/api/instances");
    const kinds = new Set(instances.map((instance: any) => instance.driverKind));
    for (const kind of kinds) expect(["openai-compat", "grok", "groq", "mistral", "cerebras", "meta", "minimax"]).toContain(kind);
    expect(instances.find((instance: any) => instance.instanceId === "openaiCompat")?.snapshot.state).toBe("available");

    // A new bot starts on the native engine, and its reply streams back.
    const { bot } = await cli("new-bot", "--name", "Native smoke");
    expect(bot.modelSelection?.instanceId ?? (await api("GET", "/api/bots")).bots.find((b: any) => b.id === bot.id).modelSelection.instanceId).toBe("openaiCompat");
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "ping native");
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const transcript = await cli("messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "20");
    expect(JSON.stringify(transcript.messages)).toContain("Fixture reply: ping native");

    // The native turn mounts the team, memory and app tools, and a tool call runs through the native loop.
    const first = fixture.fakeChat.requests[0] as { tools?: Array<{ function: { name: string } }> };
    const toolNames = (first.tools ?? []).map((tool) => tool.function.name);
    expect(toolNames.length).toBeGreaterThan(0);
    const readOnly = toolNames.find((name) => /list_bots|list_channels|whoami|memory_search|list/i.test(name)) ?? toolNames[0]!;
    await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", `CALL_TOOL ${readOnly} {}`);
    expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const afterTool = fixture.fakeChat.requests.at(-1) as { messages: Array<{ role: string }> };
    expect(afterTool.messages.some((message) => message.role === "tool")).toBe(true);

    // A channel routes a message to its member and the member answers there.
    const { channel } = await cli("new-channel", "--name", "Smoke room", "--members", bot.id);
    const before = fixture.fakeChat.requests.length;
    await cli("send-channel", "--channel", channel.id, "--text", "hello room");
    await expect.poll(() => fixture.fakeChat.requests.length, { timeout: 30_000 }).toBeGreaterThan(before);

    // A routine fires and completes on the native engine.
    const { routine } = await api("POST", "/api/routines", {
      name: "Smoke routine", prompt: "Report.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    const { run } = await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: any) => item.id === run.id)?.status, { timeout: 30_000 }).toBe("completed");

    // Nothing in the server log names a removed engine or a missing CLI.
    const log = readFileSync(fixture.info.logPath, "utf8");
    const bad = log.split("\n").filter((line) => /warn|error|fail/i.test(line) && REMOVED_ENGINE_WORDS.test(line));
    expect(bad).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 180_000);
