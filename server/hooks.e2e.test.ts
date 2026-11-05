import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-rootclaw.ts";
it("rejects a forged internal hook bearer while native streamed turns remain isolated", async () => {
  const fixture = await launchVerificationServer();
  try {
    const forged = await fetch(`${fixture.info.url}/api/internal/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ event: "PostToolUse", payload: { tool_use_id: "x" } }),
    });
    expect(forged.status).toBe(401);

    const botResponse = await fetch(`${fixture.info.url}/api/bots`);
    const { bots } = await botResponse.json() as { bots: Array<{ id: string; busy: boolean }> };
    const bot = bots[0]!;
    const sent = await fetch(`${fixture.info.url}/api/bots/${bot.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "fixture native turn" }),
    });
    expect(sent.status).toBe(202);
    const deadline = Date.now() + 20_000;
    while (true) {
      const response = await fetch(`${fixture.info.url}/api/bots`);
      const current = (await response.json() as { bots: Array<{ id: string; busy: boolean }> }).bots.find((entry) => entry.id === bot.id);
      if (current && !current.busy && fixture.fakeChat.requests.some((request) => request.stream === true)) break;
      if (Date.now() > deadline) throw new Error("native streamed turn did not settle");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(fixture.fakeChat.requests.filter((request) => request.stream === true)).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
