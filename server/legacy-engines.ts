// MIGRATION DATA ONLY. RootClaw no longer ships any external engine (agent CLIs, ACP agents); these ids
// survive only so a config.json or bot saved by an older build can be recognised and moved onto the native
// openai-compat engine. Nothing here is launched, offered in the UI, or used for any other decision.

/** Driver kinds of the removed external engines, as an older build saved them. */
export const REMOVED_DRIVER_KINDS: ReadonlySet<string> = new Set([
  "claudeAgent", "codex", "antigravityAgent", "grokAgent", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent",
  "opencodeGo", "qwenAgent", "hermesAgent", "deepseekAgent", "clineAgent", "copilotAgent", "customAcp", "piAgent", "museCode",
]);

/** The instance ids of the old default fleet whose engines were removed, with the driver each had. */
export const REMOVED_DEFAULT_INSTANCES: Readonly<Record<string, string>> = {
  grok: "grokAgent", kimi: "kimiAgent", droid: "droidAgent", cursor: "cursorAgent", githubCopilot: "copilotAgent",
  claude: "claudeAgent", claudeApi: "claudeAgent", codex: "codex", chatgpt: "codex", antigravity: "antigravityAgent",
  opencodeGo: "opencodeGo", deepseek: "deepseekAgent", museCode: "museCode", qwen: "qwenAgent", hermes: "hermesAgent",
  cline: "clineAgent", pi: "piAgent", gemini: "geminiAgent",
};
