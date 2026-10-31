// Lazy tool schemas: RootClaw's own MCP servers ("agents", "data") offer ~45 tools whose schemas cost ~11k prompt
// tokens on every request, though a turn uses a few at most. Their schemas are held back behind one `load_tools` tool
// that lists each by name and a one-line summary; loading one adds its full schema from the next model round on.
// A call to a held-back tool by name still runs (dispatch never needed the schema) and loads it too. What a thread
// loaded stays loaded for its later turns. ROOTCLAW_LAZY_TOOLS=0 offers every schema up front, as before.
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";

export const LOAD_TOOLS_TOOL = "load_tools";
const DEFERRABLE = /^(agents|data)_/;
const MAX_SUMMARY = 64;
/** Threads' loaded tool names; bounded so a long-lived server does not grow without limit. */
const loadedByThread = new Map<string, Set<string>>();
const MAX_THREADS = 500;

export function lazyToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ROOTCLAW_LAZY_TOOLS !== "0";
}

/** First sentence of a description, cut to one short line. */
export function toolSummary(description: string | undefined): string {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  return sentence.length > MAX_SUMMARY ? `${sentence.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : sentence;
}

export interface LazyTools {
  /** Held-back definitions by name. */
  deferred: Map<string, ChatToolDefinition>;
  /** Moves the named held-back tools into `definitions`; returns the names it loaded and the unknown ones. */
  load(names: readonly string[]): { loaded: string[]; already: string[]; unknown: string[] };
  isDeferred(name: string): boolean;
}

/** Splits `definitions` in place: deferrable tools not yet loaded on this thread are taken out and replaced by one
 * `load_tools` definition listing them. Returns null (and changes nothing) when there is nothing worth holding back. */
export function deferTools(definitions: ChatToolDefinition[], threadId: string, minDeferred = 4): LazyTools | null {
  const loadedBefore = loadedByThread.get(threadId) ?? new Set<string>();
  const candidates = definitions.filter((definition) => DEFERRABLE.test(definition.function.name) && !loadedBefore.has(definition.function.name));
  if (candidates.length < minDeferred || definitions.some((definition) => definition.function.name === LOAD_TOOLS_TOOL)) return null;
  const deferred = new Map(candidates.map((definition) => [definition.function.name, definition]));
  for (let i = definitions.length - 1; i >= 0; i--) if (deferred.has(definitions[i]!.function.name)) definitions.splice(i, 1);
  const loader = loadToolsDefinition(deferred);
  definitions.push(loader);
  const remember = (names: string[]) => {
    let set = loadedByThread.get(threadId);
    if (!set) {
      if (loadedByThread.size >= MAX_THREADS) loadedByThread.delete(loadedByThread.keys().next().value!);
      set = new Set();
      loadedByThread.set(threadId, set);
    }
    for (const name of names) set.add(name);
  };
  return {
    deferred,
    isDeferred: (name) => deferred.has(name),
    load(names) {
      const loaded: string[] = [];
      const unknown: string[] = [];
      const already: string[] = [];
      for (const asked of new Set(names)) {
        // The instructions name tools without their server prefix (coordinate_bots for agents_coordinate_bots).
        const name = deferred.has(asked) ? asked : [...deferred.keys()].find((key) => key.replace(DEFERRABLE, "") === asked) ?? asked;
        const definition = deferred.get(name);
        if (!definition) {
          const offered = definitions.find((d) => d.function.name === name || d.function.name.replace(DEFERRABLE, "") === name);
          if (offered && offered.function.name !== LOAD_TOOLS_TOOL) already.push(offered.function.name); else unknown.push(asked);
          continue;
        }
        deferred.delete(name);
        definitions.splice(definitions.indexOf(loader), 0, definition);
        loaded.push(name);
      }
      if (!deferred.size) definitions.splice(definitions.indexOf(loader), 1);
      else loader.function.description = loadToolsDescription(deferred);
      remember(loaded);
      return { loaded, already, unknown };
    },
  };
}

function loadToolsDescription(deferred: ReadonlyMap<string, ChatToolDefinition>): string {
  return "Load more tools: pass the names you need and their full schemas are available on your next step. " +
    "Load only what this task needs. Not yet loaded:\n" +
    [...deferred.values()].map((definition) => `${definition.function.name}: ${toolSummary(definition.function.description)}`).join("\n");
}

function loadToolsDefinition(deferred: ReadonlyMap<string, ChatToolDefinition>): ChatToolDefinition {
  return { type: "function", function: { name: LOAD_TOOLS_TOOL, description: loadToolsDescription(deferred),
    parameters: { type: "object", properties: { names: { type: "array", items: { type: "string" }, description: "Tool names from the list." } }, required: ["names"], additionalProperties: false } } };
}

/** The result text of a load_tools call. */
export function loadToolsResult(args: Record<string, unknown>, lazy: LazyTools | null): { ok: boolean; text: string } {
  const names = Array.isArray(args.names) ? args.names.filter((name): name is string => typeof name === "string") : [];
  if (!names.length) return { ok: false, text: "Pass names: an array of tool names from the load_tools list." };
  const { loaded, already, unknown } = lazy ? lazy.load(names) : { loaded: [], already: [], unknown: names };
  const parts = [];
  if (loaded.length) parts.push(`Loaded ${loaded.join(", ")}; call them now.`);
  if (already.length) parts.push(`Already available: ${already.join(", ")}.`);
  if (unknown.length) parts.push(`No such tool: ${unknown.join(", ")}.`);
  return { ok: loaded.length + already.length > 0, text: parts.join(" ") };
}

/** Test hook. */
export function resetLoadedTools(): void { loadedByThread.clear(); }
