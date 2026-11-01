// Cut 04 AC-8, live and run once: (a) a vision model reads the fixture, (b) a text-only model gets the note and no image part.
// Keys come from the environment only; the report redacts them and every base64 image.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.ROOTCLAW_DATA_DIR ??= mkdtempSync(join(tmpdir(), "multimodal-live-"));
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "fixtures", "multimodal", "rootclaw-04.png");
const PROMPT = "What text is in this image, and what color is it? Answer in one short English sentence.";
const NOTE = "this model cannot see images";
const MAX_REQUESTS = 12;
const secrets = [process.env.OLLAMA_API_KEY ?? "", process.env.OPENROUTER_API_KEY ?? ""].filter((key) => key.length >= 8);

const redact = (text: string) => {
  let out = text.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, (url) => `${url.slice(0, url.indexOf(",") + 1)}[${url.length} chars redacted]`);
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [redacted]").replace(/sk-or-[A-Za-z0-9.-]+/g, "sk-or-[redacted]");
};

interface Exchange { url: string; status: number | "ERR"; imageParts: number; note: boolean; request: string; response: string }
let exchanges: Exchange[] = [];
let sent = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (++sent > MAX_REQUESTS) throw new Error(`live request cap of ${MAX_REQUESTS} reached`);
  const url = String(input instanceof Request ? input.url : input).replace(/^(https?:\/\/[^/]+).*?(\/[^/?]*)(\?.*)?$/, "$1…$2");
  const body = typeof init?.body === "string" ? init.body : "";
  const exchange: Exchange = { url, status: "ERR", imageParts: (body.match(/"type":"image_url"/g) ?? []).length, note: body.includes(NOTE), request: redact(body), response: "" };
  exchanges.push(exchange);
  try {
    const response = await realFetch(input, init);
    exchange.status = response.status;
    exchange.response = redact((await response.clone().text()).slice(0, 4_000));
    return response;
  } catch (error) {
    exchange.response = redact((error as Error).message);
    throw error;
  }
}) as typeof fetch;

const { OllamaCloudDriver } = await import("../../server/drivers/api-providers.ts");
const { OpenAICompatDriver } = await import("../../server/drivers/openai-compat.ts");

async function ask(label: string, create: () => ReturnType<typeof OpenAICompatDriver.create>, model: string) {
  exchanges = [];
  const instance = await create();
  const text: string[] = [];
  type Completed = { ok: boolean; stopReason?: string | null; error?: string };
  const done = new Promise<Completed>((resolve) => {
    instance.adapter.onEvent((event) => {
      if (event.type === "content.delta" && event.streamKind === "assistant_text") text.push(event.delta);
      if (event.type === "turn.completed") resolve(event as Completed);
    });
  });
  const started = Date.now();
  await instance.adapter.sendTurn({ threadId: randomUUID(), text: PROMPT, model, approvalMode: "full", cwd: mkdtempSync(join(tmpdir(), "multimodal-cwd-")),
    images: [{ path: FIXTURE, mime: "image/png", bytes: readFileSync(FIXTURE).length }] });
  const completed = await Promise.race([done, new Promise<Completed>((resolve) => setTimeout(() => resolve({ ok: false, error: "timeout after 180s" }), 180_000).unref())]);
  await instance.dispose();
  const chats = exchanges.filter((exchange) => exchange.url.endsWith("/completions"));
  const statuses = exchanges.map((exchange) => exchange.status);
  return { label, model, ms: Date.now() - started, ok: completed.ok, stopReason: completed.stopReason ?? null, error: completed.error ? redact(completed.error) : null,
    answer: redact(text.join("")), statuses, infra: statuses.some((status) => status === 429 || status === 502),
    chatRequests: chats.length, imageParts: chats.reduce((n, exchange) => n + exchange.imageParts, 0), noteInBody: chats.some((exchange) => exchange.note), exchanges };
}

const reads = (answer: string) => /RC04/i.test(answer) && /\b(red|merah)\b/i.test(answer);
const ollama = () => OllamaCloudDriver.create({ instanceId: randomUUID(), displayName: "live", enabled: true,
  config: { ...OllamaCloudDriver.defaultConfig(), apiKeyEnv: "OLLAMA_API_KEY" }, environment: { OLLAMA_API_KEY: process.env.OLLAMA_API_KEY ?? "" } });
const openrouter = () => OpenAICompatDriver.create({ instanceId: randomUUID(), displayName: "live", enabled: true,
  config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" }, environment: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "" } });

const vision = [await ask("a: Ollama vision", ollama, "gemma4:31b")];
if (!vision[0]!.ok) vision.push(await ask("a: OpenRouter vision fallback", openrouter, "google/gemma-4-31b-it:free"));
const a = vision.at(-1)!;
const b = await ask("b: OpenRouter text-only", openrouter, "nvidia/nemotron-3-ultra-550b-a55b:free");
const bStatus400 = b.statuses.includes(400);

const result = {
  at: new Date().toISOString(), fixture: "evals/fixtures/multimodal/rootclaw-04.png", requests: sent,
  a: { pass: a.ok && reads(a.answer) && a.imageParts >= 1, infra: a.infra, model: a.model },
  b: { pass: b.ok && !bStatus400 && b.noteInBody && b.imageParts === 0, infra: b.infra, model: b.model, status400: bStatus400 },
  runs: [...vision, b],
};
const out = join(here, "..", "reports", "runs");
mkdirSync(out, { recursive: true });
const file = join(out, `multimodal-live-${result.at.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, redact(JSON.stringify(result, null, 2)));
for (const run of result.runs) console.log(`${run.label} (${run.model}): ok=${run.ok} statuses=${run.statuses.join(",")} imageParts=${run.imageParts} note=${run.noteInBody} answer=${JSON.stringify(run.answer.slice(0, 200))}`);
console.log(`a ${result.a.pass ? "PASS" : result.a.infra ? "INFRA" : "FAIL"}, b ${result.b.pass ? "PASS" : result.b.infra ? "INFRA" : "FAIL"}; requests ${sent}; report: ${file}`);
