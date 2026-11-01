// Cut 04: a model the catalog does not know that refuses images gets one resend without them, and no images after.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const FIXTURE = join(import.meta.dirname, "../../evals/fixtures/multimodal/rootclaw-04.png");
const MODEL = "mystery-vision-m";
const done = () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);

/** Turns with the fixture attached; `refuse` answers a request that carries an image. */
async function turns(id: string, count: number, refuse: () => Response) {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: MODEL, context_length: 128_000 }] }));
    const raw = String(init!.body);
    bodies.push(raw);
    return raw.includes("image_url") ? refuse() : done();
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const inst = await OpenAICompatDriver.create({ instanceId: id, displayName: "Fixture", enabled: true,
    config: { url: "https://endpoint.invalid/v1", apiKeyEnv: "TEST_KEY", model: MODEL }, environment: { TEST_KEY: "fixture-key" } });
  await inst.refreshModels!();
  const recorder = recordEvents(inst.adapter);
  const outcomes: Array<{ ok?: boolean; requests: number }> = [];
  try {
    for (let turn = 0; turn < count; turn++) {
      const before = bodies.length;
      await inst.adapter.sendTurn({ threadId: `${id}-${turn}`, text: "Read the image.", model: MODEL, approvalMode: "full",
        cwd: mkdtempSync(join(tmpdir(), "rootclaw-fallback-")), images: [{ path: FIXTURE, mime: "image/png", bytes: readFileSync(FIXTURE).length }] });
      const completed = await recorder.until((event) => event.type === "turn.completed" &&
        recorder.events.filter((seen) => seen.type === "turn.completed").length === turn + 1, 60_000) as { ok?: boolean };
      outcomes.push({ ok: completed.ok, requests: bodies.length - before });
    }
  } finally { recorder.stop(); await inst.dispose(); }
  return { bodies, outcomes };
}

describe("image refusal from an unknown model", () => {
  it.each([
    ["400 does not support images", 400, { error: { message: "This model does not support image input." } }],
    ["404 OpenRouter no endpoint", 404, { error: { message: "No endpoints found that support image input", code: 404 } }],
  ])("resends once without images after a %s and sends none for the rest of the instance", async (_name, status, body) => {
    const { bodies, outcomes } = await turns(`fallback-${status}`, 2, () => new Response(JSON.stringify(body), { status }));
    expect(outcomes).toEqual([{ ok: true, requests: 2 }, { ok: true, requests: 1 }]);
    expect(bodies[0]).toContain("image_url");
    for (const raw of bodies.slice(1)) {
      expect(raw).not.toContain("image_url");
      expect(raw).toContain("this model cannot see images");
    }
  });

  it("does not resend after any other 400", async () => {
    const { bodies, outcomes } = await turns("fallback-schema", 1,
      () => new Response(JSON.stringify({ error: { message: "messages.1.content: invalid schema", type: "invalid_request_error" } }), { status: 400 }));
    expect(outcomes).toEqual([{ ok: false, requests: 1 }]);
    expect(bodies[0]).toContain("image_url");
  });
});
