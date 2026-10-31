// A key is read from an environment variable or a file and never printed; a provider already set up is left alone unless --rotate.
import { readFileSync } from "node:fs";

import { EXIT, flag, usageError } from "./args.ts";
import type { HeadlessClient } from "./client.ts";
import type { VerbContext, VerbOutcome } from "./context.ts";

type Rec = Record<string, any>;

export const ENGINE_KINDS: Record<string, { config: string; instance: string; baseUrl: "no" | "allowed" | "required" }> = {
  claude: { config: "anthropic", instance: "anthropicApi", baseUrl: "allowed" },
  openai: { config: "openai", instance: "openai", baseUrl: "no" },
  openrouter: { config: "openrouter", instance: "openrouter", baseUrl: "no" },
  "openai-compatible": { config: "openaiCompat", instance: "openaiCompat", baseUrl: "required" },
  xai: { config: "xai", instance: "xaiApi", baseUrl: "allowed" },
  groq: { config: "groq", instance: "groq", baseUrl: "allowed" },
  mistral: { config: "mistral", instance: "mistral", baseUrl: "no" },
  cerebras: { config: "cerebras", instance: "cerebras", baseUrl: "no" },
  ollama: { config: "ollama", instance: "ollamaCloud", baseUrl: "no" },
};

/** Never from the command line itself. */
export function readSecret(source: { env?: string; file?: string }, env: NodeJS.ProcessEnv, what: string): string {
  if (source.env !== undefined) {
    const value = env[source.env]?.trim();
    if (!value) throw usageError(`${what}: the environment variable ${source.env} is not set`);
    return value;
  }
  if (source.file !== undefined) {
    let value: string;
    try {
      value = readFileSync(source.file, "utf8").trim();
    } catch (error) {
      throw usageError(`${what}: ${source.file} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
    if (!value) throw usageError(`${what}: ${source.file} is empty`);
    return value;
  }
  throw usageError(`${what}: put the key in an environment variable or a file`);
}

export interface EngineRequest {
  kind: string;
  key: string;
  baseUrl?: string;
  onlyClaudeApi?: boolean;
  install?: boolean;
  rotate?: boolean;
  dryRun?: boolean;
}

export async function applyEngine(client: HeadlessClient, request: EngineRequest): Promise<Rec> {
  const kind = ENGINE_KINDS[request.kind];
  if (!kind) throw usageError(`unknown engine ${request.kind}: use one of ${Object.keys(ENGINE_KINDS).join(", ")}`);
  if (request.baseUrl !== undefined && kind.baseUrl === "no") throw usageError(`${request.kind} takes no base URL`);
  if (request.baseUrl === undefined && kind.baseUrl === "required") throw usageError(`${request.kind} needs --base-url`);
  if (request.baseUrl !== undefined && !/^https?:\/\/[^\s]+$/.test(request.baseUrl)) throw usageError("the base URL must start with http:// or https://");
  if (request.install) throw usageError("provider API keys do not install external CLIs");
  if (request.onlyClaudeApi) throw usageError("--only-claude-api was removed with external engine support");
  const instanceId = kind.instance;
  const status: Rec = (await client.json<Rec>("/api/config"))[kind.config] ?? {};
  const configured = status.configured === true;
  const patch: Rec = {};
  const changed: string[] = [];
  if (!configured || request.rotate) {
    patch.key = request.key;
    changed.push("key");
    if (request.baseUrl !== undefined) { patch.url = request.baseUrl; changed.push("baseUrl"); }
  } else if (request.baseUrl !== undefined && typeof status.url === "string" && status.url !== request.baseUrl) {
    patch.url = request.baseUrl;
    changed.push("baseUrl");
  }
  // The address of a key already set is never shown, so --base-url cannot be compared with it.
  const unverified = configured && !request.rotate && request.baseUrl !== undefined && typeof status.url !== "string";
  const result: Rec = { ok: true, kind: request.kind, instanceId, configured: configured || changed.includes("key"), changed, ...(request.dryRun ? { dryRun: true } : {}),
    ...(unverified ? { warnings: [`${request.kind} already has a key and the server does not show its base URL, so --base-url was not written: pass --rotate to write both`] } : {}) };
  if (request.dryRun) return result;
  if (Object.keys(patch).length) await client.json("/api/config", { method: "PUT", body: JSON.stringify({ [kind.config]: patch }) });
  return result;
}

export async function engineVerb(ctx: VerbContext): Promise<VerbOutcome> {
  const client = await ctx.client();
  if (ctx.verb === "engine list") {
    const [models, config] = await Promise.all([client.tool("list_available_models", {}), client.json<Rec>("/api/config")]);
    const keys = Object.fromEntries(Object.entries(ENGINE_KINDS).map(([kind, spec]) => [kind, config[spec.config]?.configured === true]));
    const instances: Rec[] = models.instances ?? [];
    return {
      result: { instances, keys }, exitCode: EXIT.done,
      human: [
        ...instances.map((instance) => `${instance.instanceId} · ${instance.displayName ?? instance.driverKind} · ${instance.snapshot?.state ?? "unknown"}`),
        `Keys set: ${Object.entries(keys).filter(([, set]) => set).map(([kind]) => kind).join(", ") || "none"}`,
      ],
    };
  }
  const kind = ctx.positionals[0]?.trim();
  if (!kind) throw usageError(`name the engine: ${Object.keys(ENGINE_KINDS).join(", ")}`);
  const keyEnv = flag(ctx.flags, "key-env");
  const keyFile = flag(ctx.flags, "key-file");
  if ((keyEnv === undefined) === (keyFile === undefined)) throw usageError("give the key one way: --key-env VAR or --key-file FILE");
  const key = readSecret(keyEnv !== undefined ? { env: keyEnv } : { file: keyFile! }, ctx.env, `the ${kind} key`);
  const result = await applyEngine(client, {
    kind, key, ...(flag(ctx.flags, "base-url") ? { baseUrl: flag(ctx.flags, "base-url")!.trim() } : {}),
    onlyClaudeApi: ctx.flags["only-claude-api"] === true, install: ctx.flags.install === true,
    rotate: ctx.flags.rotate === true, dryRun: ctx.flags["dry-run"] === true,
  });
  const done = result.changed.length
    ? `${result.dryRun ? "Would set" : "Set"} ${result.changed.join(", ")} for ${kind}`
    : `${kind} was already set up; nothing changed (pass --rotate to replace its key)`;
  return { result, exitCode: EXIT.done, human: [`${done}. Bots use it as ${result.instanceId}/MODEL (rootclaw models).`,
    ...((result.warnings ?? []) as string[]).map((line) => `warning: ${line}`)] };
}
