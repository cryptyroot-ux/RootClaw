import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-rootclaw.ts";

it("validates and persists the per-bot helper switch, including creation", async () => {
  const fixture = await launchVerificationServer();
  try {
    const api = async (path: string, method = "GET", body?: unknown) => fetch(`${fixture.info.url}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const wrong of ["no", 0, null, { off: true }]) {
      const response = await api("/api/bots", "POST", { settings: { helperModel: wrong } });
      expect(response.status, JSON.stringify(wrong)).toBe(400);
    }
    const created = await api("/api/bots", "POST", { settings: { helperModel: false } });
    expect(created.status).toBe(201);
    const { bot } = await created.json() as { bot: { id: string; helperModel: boolean } };
    expect(bot.helperModel).toBe(false);
    const stored = () => (JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as Array<{ id: string; helperModel?: boolean }>).find((record) => record.id === bot.id);
    expect(stored()).toMatchObject({ helperModel: false });
    const updated = await api(`/api/bots/${bot.id}`, "PATCH", { helperModel: true });
    expect(updated.status).toBe(200);
    expect((await updated.json() as { bot: { helperModel: boolean } }).bot.helperModel).toBe(true);
    expect(stored()).toMatchObject({ helperModel: true });
    const listed = await api("/api/bots").then((response) => response.json()) as { bots: Array<{ id: string; helperModel?: boolean }> };
    expect(listed.bots.find((record) => record.id === bot.id)).toMatchObject({ helperModel: true });
  } finally {
    await fixture.close();
  }
});
