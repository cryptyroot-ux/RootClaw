// Cut 04: which models take images comes from the models.dev catalog; a text-only model gets a note, never an image part.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordEvents } from "../testing/events.ts";
import { OllamaCloudDriver } from "./api-providers.ts";
import { visionInput } from "./model-vision.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const FIXTURE = join(import.meta.dirname, "../../evals/fixtures/multimodal/rootclaw-04.png");
type Body = { messages: Array<{ role: string; content: unknown }> };

/** One turn with the fixture attached; returns every chat body the provider received. */
async function attach(driver: typeof OpenAICompatDriver, config: { url: string; apiKeyEnv: string; model: string }, model: string) {
  const bodies: Body[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (!String(input).endsWith("/chat/completions")) return String(input).endsWith("/models")
      ? new Response(JSON.stringify({ data: [{ id: model, context_length: 128_000 }] })) : new Response("{}", { status: 404 });
    bodies.push(JSON.parse(String(init!.body)) as Body);
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const inst = await driver.create({ instanceId: `vision-${model}`, displayName: "Fixture", enabled: true, config, environment: { TEST_KEY: "fixture-key" } });
  const recorder = recordEvents(inst.adapter);
  try {
    await inst.adapter.sendTurn({ threadId: `vision-${model}`, text: "What does the image say?", model, approvalMode: "full",
      cwd: mkdtempSync(join(tmpdir(), "rootclaw-vision-")), images: [{ path: FIXTURE, mime: "image/png", bytes: readFileSync(FIXTURE).length }] });
    await recorder.until((event) => event.type === "turn.completed");
  } finally { recorder.stop(); await inst.dispose(); }
  return bodies;
}

const imageParts = (bodies: Body[]) => bodies.flatMap((body) => body.messages)
  .flatMap((message) => (Array.isArray(message.content) ? message.content as Array<{ type: string }> : [])).filter((part) => part.type === "image_url");

describe("vision-catalog", () => {
  it("reads image input from the models.dev catalog and says unknown for a model it does not list", () => {
    expect(visionInput("ollama-cloud", "gemma4:31b")).toBe(true);
    expect(visionInput("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free")).toBe(false);
    expect(visionInput("ollama-cloud", "beam")).toBe("unknown");
    expect(visionInput(undefined, "gemma4:31b")).toBe("unknown");
  });

  it("sends OpenRouter nemotron :free the text-only note and no image part", async () => {
    const bodies = await attach(OpenAICompatDriver, { url: "https://openrouter.ai/api/v1", apiKeyEnv: "TEST_KEY", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
      "nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(bodies).toHaveLength(1);
    expect(imageParts(bodies)).toHaveLength(0);
    expect(bodies[0]!.messages.at(-1)!.content).toContain("this model cannot see images");
  });

  it.each(["gemma4:31b", "beam"])("sends the attachment to Ollama %s as an image part", async (model) => {
    const bodies = await attach(OllamaCloudDriver as unknown as typeof OpenAICompatDriver, { url: "https://ollama.com/v1", apiKeyEnv: "TEST_KEY", model }, model);
    expect(imageParts(bodies)).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(FIXTURE).toString("base64")}` } }]);
  });
});
