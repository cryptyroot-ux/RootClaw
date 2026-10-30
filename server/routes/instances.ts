import { providerIconError } from "../../shared/provider-icon.ts";
import { z } from "zod";
import { persistableInstanceConfigs, saveConfig, type AppConfig } from "../config.ts";
import { addEndpoint, addEndpointSchema, isAddedEndpoint, withEndpointUrls } from "../openai-compat-endpoints.ts";
import type { InstanceConfigMap, ModelSelection, ProviderInstance } from "../contracts.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { checkEngine, type EngineCheck } from "../engine-check.ts";
import { providerIconPatchSchema, withInstanceIcon } from "../provider-icon.ts";
import type { Store } from "../store.ts";
import type { BusyFlag, ConfigStatus } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

const displayName = z.string().trim().min(1).max(80).refine((value) => !/\p{Cc}/u.test(value), "Name cannot contain control characters");
export const instanceSettingsSchema = z.object({
  displayName: displayName.optional(),
  tools: z.boolean().optional(),
  /** null goes back to the server's default wait. */
  replyWaitMinutes: z.number().int().min(1).max(60).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "No settings supplied");

export interface InstanceRouteDeps {
  store: Pick<Store, "bots" | "tasks">;
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get" | "refreshModels">;
  providerConfigBusy: BusyFlag;
  providerInstancesChanging: Pick<Set<string>, "add" | "delete">;
  describeInstances(): Promise<unknown>;
  persistProviderInstance(instanceId: string, instances: InstanceConfigMap): Promise<void>;
  configStatus(): ConfigStatus;
  broadcast(payload: Record<string, unknown>): void;
  threadBusy(botId: string, threadId: string): boolean;
  botForThread(botId: string, threadId: string): Pick<{ modelSelection: ModelSelection }, "modelSelection"> | null;
  activeGroupTurnForBot(botId: string): { threadId: string } | null;
  /** The server's tested-AI record (server/tested-ai.ts): a check there also settles the new-bot default. */
  checkInstance?(instance: ProviderInstance): Promise<EngineCheck>;
}

export function createInstanceRoutes(deps: InstanceRouteDeps): RouteHandler {
  const {
    store, cfg, registry, providerConfigBusy, providerInstancesChanging,
    persistProviderInstance, configStatus, broadcast, threadBusy,
    botForThread, activeGroupTurnForBot,
  } = deps;
  const describeInstances = async () => withEndpointUrls(await deps.describeInstances(), cfg.instances ?? {});
  const busyProviderSelections = () => store.bots.flatMap((bot) => {
    const busyTasks = store.tasks(bot.id).filter((task) => threadBusy(bot.id, task.threadId));
    const selections = busyTasks.map((task) => botForThread(bot.id, task.threadId)!.modelSelection);
    if (activeGroupTurnForBot(bot.id) || (bot.busy && busyTasks.length === 0)) selections.push(bot.modelSelection);
    return selections;
  });
  return async ({ req, res, path, method, json, readBody }) => {
    if (method === "GET" && path === "/api/instances") {
      return json(res, 200, { instances: await describeInstances() });
    }
    const companyMutation = /^\/api\/instances\/(company\.[\w.-]+)(?:\/|$)/.exec(path);
    if (companyMutation && method !== "GET") return json(res, 403, { error: "Company accounts are read-only here. Manage this connection in desktop Settings." });

    const instanceIconPatch = /^\/api\/instances\/([\w.-]+)\/icon$/.exec(path);
    if (method === "PATCH" && instanceIconPatch) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = providerIconPatchSchema.safeParse(await readBody(req, 192 * 1024));
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message;
        return json(res, 400, { error: detail && detail !== "Invalid input" ? detail : "Choose a built-in icon or upload a PNG, JPEG, or WebP image up to 128 KB." });
      }
      if (parsed.data.icon) {
        const invalid = providerIconError(parsed.data.icon);
        if (invalid) return json(res, 400, { error: invalid });
      }
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      providerConfigBusy.set(true);
      try {
        const changed = withInstanceIcon(cfg, instanceIconPatch[1], parsed.data.icon);
        if (!changed.ok) return json(res, 404, { error: `unknown instance "${instanceIconPatch[1]}"` });
        saveConfig({ instances: changed.instances }, { replaceInstances: true });
        cfg.instances = changed.instances;
        broadcast({ kind: "config", ...configStatus() });
        return json(res, 200, { instances: await describeInstances() });
      } finally { providerConfigBusy.set(false); }
    }

    if (method === "POST" && path === "/api/instances/openai-compat") {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = addEndpointSchema.safeParse(await readBody(req, 8192));
      if (!parsed.success) return json(res, 400, { error: "Enter a display name (up to 80 characters), a base URL and an API key." });
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      providerConfigBusy.set(true);
      try {
        const instances = persistableInstanceConfigs(cfg);
        const added = addEndpoint(instances, parsed.data);
        if ("error" in added) return json(res, 400, { error: added.error });
        await persistProviderInstance(added.instanceId, instances);
        return json(res, 201, { instanceId: added.instanceId, instances: await describeInstances() });
      } finally { providerConfigBusy.set(false); }
    }

    const instanceAction = /^\/api\/instances\/([\w.-]+)\/(refresh-models|check)$/.exec(path);
    if (method === "POST" && instanceAction) {
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const instanceId = instanceAction[1];
      const action = instanceAction[2];
      try {
        if (action === "check") {
          const instance = registry.get(instanceId);
          if (!instance) return json(res, 404, { error: "unknown instance" });
          res.setHeader("cache-control", "no-store");
          return json(res, 200, await (deps.checkInstance ?? checkEngine)(instance));
        }
        if (action === "refresh-models") {
          if (!(await registry.refreshModels(instanceId))) return json(res, 404, { error: "unknown instance" });
          return json(res, 200, { instances: await describeInstances() });
        }
        return PASS;
      } catch (error) {
        const requestedStatus = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
        const status = typeof requestedStatus === "number" && [400, 401, 404, 409, 413, 415].includes(requestedStatus) ? requestedStatus : 500;
        return json(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // PATCH /api/instances/:id {displayName?, tools?, replyWaitMinutes?}.
    const instancePatch = /^\/api\/instances\/([\w.-]+)$/.exec(path);
    if (method === "PATCH" && instancePatch) {
      // JSON-only, so a hostile page cannot send it as a simple request.
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return json(res, 415, { error: "content-type must be application/json" });
      }
      const parsed = instanceSettingsSchema.safeParse(await readBody(req, 16384));
      if (!parsed.success) return json(res, 400, { error: "Supply a valid name, boolean tools setting or a reply wait of 1 to 60 minutes." });
      const body = parsed.data;
      const instanceId = instancePatch[1];
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      if (busyProviderSelections().some((selection) => selection.instanceId === instanceId)) {
        return json(res, 409, { error: "Wait for bots using this account to finish before changing its settings." });
      }
      providerConfigBusy.set(true);
      providerInstancesChanging.add(instanceId);
      try {
        const instances = persistableInstanceConfigs(cfg);
        if (!Object.hasOwn(instances, instanceId)) return json(res, 404, { error: `unknown instance "${instanceId}"` });
        const entry = instances[instanceId];
        if (body.tools !== undefined) {
          if (!["openai-compat", "grok", "minimax", "mistral", "cerebras", "groq", "meta"].includes(entry.driver)) {
            return json(res, 400, { error: "The tools setting is available for OpenAI-compatible, Grok API, MiniMax API, Mistral API, Cerebras API, Groq API and Meta API instances only." });
          }
          entry.config = { ...entry.config as Record<string, unknown>, tools: body.tools };
        }
        if (body.replyWaitMinutes !== undefined) {
          if (entry.driver !== "openai-compat") return json(res, 400, { error: "The reply wait is available for OpenAI-compatible servers only." });
          const { replyWaitMinutes: _previous, ...rest } = entry.config as Record<string, unknown>;
          entry.config = body.replyWaitMinutes === null ? rest : { ...rest, replyWaitMinutes: body.replyWaitMinutes };
        }
        if (body.displayName !== undefined) entry.displayName = body.displayName;
        await persistProviderInstance(instanceId, instances);
        return json(res, 200, { instances: await describeInstances() });
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerConfigBusy.set(false);
      }
    }

    if (method === "DELETE" && instancePatch) {
      const instanceId = instancePatch[1];
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      const instances = persistableInstanceConfigs(cfg);
      if (!Object.hasOwn(instances, instanceId)) return json(res, 404, { error: "unknown instance" });
      if (!isAddedEndpoint(instanceId, instances[instanceId])) {
        return json(res, 400, { error: "Only added OpenAI-compatible endpoints can be removed here." });
      }
      if (cfg.defaultModelSelection?.instanceId === instanceId || store.bots.some((bot) =>
        bot.modelSelection.instanceId === instanceId || bot.fallback?.some(candidate => candidate.instanceId === instanceId) || store.tasks(bot.id).some((task) => task.modelSelection?.instanceId === instanceId)) ||
        busyProviderSelections().some((selection) => selection.instanceId === instanceId)) {
        return json(res, 409, { error: "Choose another engine for the bots and default model using this endpoint before removing it." });
      }
      providerConfigBusy.set(true);
      providerInstancesChanging.add(instanceId);
      try {
        delete instances[instanceId];
        await persistProviderInstance(instanceId, instances);
        return json(res, 200, { instances: await describeInstances() });
      } finally {
        providerInstancesChanging.delete(instanceId);
        providerConfigBusy.set(false);
      }
    }
    return PASS;
  };
}
