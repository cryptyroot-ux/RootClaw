// Cut 03 AC-4: the batching hints in the workspace tool prompt, and one response's edits plus reads run as one round.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.ROOTCLAW_RETRY_SCALE ??= "0.001";

const executed = vi.hoisted(() => [] as string[]);
vi.mock("./workspace-tools.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./workspace-tools.ts")>();
  return { ...original, executeWorkspaceTool: (...args: Parameters<typeof original.executeWorkspaceTool>) => {
    executed.push(`${args[0]} ${String(args[1].path)}`);
    return original.executeWorkspaceTool(...args);
  } };
});

import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { WORKSPACE_TOOLS_PROMPT } from "./workspace-tools.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("workspace tool prompt", () => {
  it("carries the batching hints", () => {
    expect(WORKSPACE_TOOLS_PROMPT).toContain("Think first, then batch everything: in your first response read the files the task names and any others you need, without listing or searching first");
    expect(WORKSPACE_TOOLS_PROMPT).toContain("go one call at a time only when the next file depends on a result");
    expect(WORKSPACE_TOOLS_PROMPT).toContain("Edits to different files can share a response; they run in order");
    expect(WORKSPACE_TOOLS_PROMPT).toContain("Put the check after the change, in the same response");
    expect(WORKSPACE_TOOLS_PROMPT).toContain("Make a file's changes in one edit, not repeated small edits");
    expect(WORKSPACE_TOOLS_PROMPT).toContain("Do not reread a file you just edited");
    expect(WORKSPACE_TOOLS_PROMPT).toContain("Combine verification commands into one shell call");
  });

  it("leaves the eval task texts and the harness system prompt unchanged", () => {
    const tasks = readFileSync(new URL("../../evals/engine-tasks/tasks.ts", import.meta.url));
    expect(createHash("sha256").update(tasks).digest("hex")).toBe("d49d96dc1266243e02143023e4fd9a14f647dbe0f8d009fc851980ca46ec352a");
    expect(readFileSync(new URL("../../evals/engine-tasks/run-engine-tasks.ts", import.meta.url), "utf8"))
      .toContain("system: `You are a careful software engineer working in the given folder with workspace tools. Verify your work before answering.${extras.system}`,");
  });
});

describe("one response with edits and reads", () => {
  it("runs two edits to different files and three reads in one round, edits in order, results in call order", async () => {
    const base = mkdtempSync(join(tmpdir(), "rootclaw-orchestration-"));
    const cwd = join(base, "work");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "a.txt"), "alpha\n");
    writeFileSync(join(cwd, "b.txt"), "bravo\n");
    writeFileSync(join(cwd, "c.txt"), "charlie\n");
    const calls: Array<[string, Record<string, unknown>]> = [
      ["edit_file", { path: "a.txt", old_string: "alpha", new_string: "ALPHA" }],
      ["edit_file", { path: "b.txt", old_string: "bravo", new_string: "BRAVO" }],
      ["read_file", { path: "a.txt" }], ["read_file", { path: "b.txt" }], ["read_file", { path: "c.txt" }],
    ];
    const requests: Array<{ messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }> = [];
    const server = createServer(async (request, response) => {
      if (request.url === "/v1/models") { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
      let data = "";
      for await (const part of request) data += part.toString();
      requests.push(JSON.parse(data));
      const delta = requests.length === 1
        ? { content: null, tool_calls: calls.map(([name, args], index) => ({ index, id: `call_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }
        : { content: "Done." };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const instance = await OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "orchestration", enabled: true,
      config: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "FIXTURE_ORCH_KEY" },
      environment: { FIXTURE_ORCH_KEY: "fixture-orch-credential-9d2c" } });
    const recorder = recordEvents(instance.adapter);
    cleanups.push(async () => {
      recorder.stop();
      await instance.dispose();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await removeTempDir(base);
    });
    await instance.adapter.sendTurn({ threadId: randomUUID(), text: "work", model: "m", cwd, approvalMode: "full" });
    const done = await recorder.until((event) => event.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(requests).toHaveLength(2);
    expect(executed.slice(0, 2)).toEqual(["edit_file a.txt", "edit_file b.txt"]);
    expect([...executed].sort()).toEqual(["edit_file a.txt", "edit_file b.txt", "read_file a.txt", "read_file b.txt", "read_file c.txt"]);
    const results = requests[1]!.messages.filter((message) => message.role === "tool")
      .map((message) => ({ id: message.tool_call_id, ...JSON.parse(String(message.content)) as { ok: boolean; result: string } }));
    expect(results.map((result) => result.id)).toEqual(["call_0", "call_1", "call_2", "call_3", "call_4"]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[2]!.result).toContain("ALPHA");
    expect(results[3]!.result).toContain("BRAVO");
    expect(results[4]!.result).toContain("charlie");
  });
});
