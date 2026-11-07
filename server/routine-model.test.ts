import { describe, expect, it } from "vitest";

import { modelSwitchNeedsAsk, type ApprovalMode } from "../shared/approval-mode.ts";
import type { ModelSelection } from "../shared/wire.ts";
import type { Routine as SharedRoutine, RoutineInput as SharedRoutineInput } from "../shared/routines.ts";
import { ROUTINE_MODEL_PERMISSIONS, routineModelRefusal, routineThreadModel, type RoutineModelChecks } from "./routine-input.ts";

const HAIKU = { instanceId: "claude", model: "claude-3-haiku" };

describe("a routine's model and its bot's permissions", () => {
  const drivers: Record<string, string> = { claude: "claudeAgent", codex: "codex", gemini: "geminiAgent", pi: "pi" };
  const codex = { instanceId: "codex", model: "gpt-5-codex" };
  const bots: Record<string, { modelSelection: ModelSelection; approvalMode: ApprovalMode }> = {
    custom: { modelSelection: codex, approvalMode: "custom" },
    edits: { modelSelection: HAIKU, approvalMode: "edits" },
    full: { modelSelection: codex, approvalMode: "full" },
  };
  const checks: RoutineModelChecks = {
    check: (raw) => ({ ok: true, selection: raw as ModelSelection }),
    bot: (botId) => bots[botId],
    engineSwitchNeedsAsk: (mode, from, to) => modelSwitchNeedsAsk(mode, drivers[from.instanceId], drivers[to.instanceId]),
  };
  const refusal = { status: 400, error: ROUTINE_MODEL_PERMISSIONS };

  it("refuses a model on another engine when the bot's permission level cannot follow", () => {
    expect(routineModelRefusal({ botId: "custom", modelSelection: HAIKU }, checks)).toEqual(refusal);
    expect(routineModelRefusal({ botId: "edits", modelSelection: { instanceId: "pi", model: "pi-1" } }, checks)).toEqual(refusal);
  });

  it("rechecks an existing model when a routine moves to another bot and allows dropping it", () => {
    const existing = { botId: "full", modelSelection: HAIKU };
    expect(routineModelRefusal({ botId: "custom" }, checks, existing)).toEqual(refusal);
    expect(routineModelRefusal({ botId: "custom", modelSelection: null }, checks, existing)).toBeNull();
    expect(routineModelRefusal({ prompt: "Sweep twice" }, checks, existing)).toBeNull();
  });

  it("falls back to the bot's model when permissions changed after the routine was saved", () => {
    expect(routineThreadModel({ botId: "full", modelSelection: HAIKU }, checks)).toEqual(HAIKU);
    expect(routineThreadModel({ botId: "custom", modelSelection: HAIKU }, checks)).toBeUndefined();
  });

  it("exposes model selection through the shared routine wire shapes", () => {
    const schedule = { type: "once" as const, at: 1 };
    const input: SharedRoutineInput = {
      name: "Daily check", prompt: "Review inbox", botId: "bot", schedule, modelSelection: HAIKU,
    };
    const routine: SharedRoutine = {
      id: "routine", name: input.name, prompt: input.prompt, target: "bot", botId: input.botId,
      runOn: "rootclaw", enabled: true, schedule, durationMinutes: 30, modelSelection: HAIKU,
      nextRunAt: 1, createdAt: 1, updatedAt: 1,
    };
    expect(input.modelSelection).toEqual(HAIKU);
    expect(routine.modelSelection).toEqual(HAIKU);
  });
});
