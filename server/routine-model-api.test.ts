import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-rootclaw.ts";

describe("routine model selection through PATCH", () => {
  let fixture: VerificationServer;
  const modelA = { instanceId: "openaiCompat", model: "model-a" };
  const modelB = { instanceId: "openaiCompat", model: "model-b" };
  const schedule = { type: "daily", time: "09:00" };

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const stored = (id: string) => (JSON.parse(readFileSync(join(fixture.info.dataDir, "routines.json"), "utf8")).routines as Array<{ id: string }>)
    .find((routine) => routine.id === id);

  afterEach(async () => { if (fixture) await fixture.close(); });

  it("replaces model-a with model-b, keeps an omitted selection, and clears explicit null", async () => {
    fixture = await launchVerificationServer();
    const createdBot = await api("POST", "/api/bots", { name: "Model fixture", modelSelection: { instanceId: "openaiCompat", model: "fixture-model" } });
    expect(createdBot.status).toBe(201);
    const botId = createdBot.body.bot.id as string;
    const created = await api("POST", "/api/routines", {
      name: "Model", prompt: "Check the inbox", botId, schedule, modelSelection: modelA,
    });
    expect(created.status).toBe(201);
    const id = created.body.routine.id as string;
    expect(created.body.routine.modelSelection).toEqual(modelA);
    expect(stored(id)).toMatchObject({ modelSelection: modelA });

    const replaced = await api("PATCH", `/api/routines/${id}`, { modelSelection: modelB });
    expect(replaced.status).toBe(200);
    expect(replaced.body.routine.modelSelection).toEqual(modelB);
    expect(stored(id)).toMatchObject({ modelSelection: modelB });

    const refused = await api("PATCH", `/api/routines/${id}`, { modelSelection: { instanceId: "", model: "nope" } });
    expect(refused.status).toBe(400);
    expect(stored(id)).toMatchObject({ modelSelection: modelB });

    const kept = await api("PATCH", `/api/routines/${id}`, { name: "Renamed" });
    expect(kept.status).toBe(200);
    expect(kept.body.routine).toMatchObject({ name: "Renamed", modelSelection: modelB });

    const cleared = await api("PATCH", `/api/routines/${id}`, { modelSelection: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.routine).not.toHaveProperty("modelSelection");
    expect(stored(id)).not.toHaveProperty("modelSelection");
    expect((await api("GET", "/api/routines")).body.routines.find((routine: { id: string }) => routine.id === id)).not.toHaveProperty("modelSelection");
  }, 30_000);
});
