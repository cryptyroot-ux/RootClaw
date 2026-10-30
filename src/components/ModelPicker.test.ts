import { Children, createElement, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { AppState, Bot, InstanceInfo } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import { Select } from "./Select";

// The store module touches window and localStorage at import time, so it is stubbed to render under the node
// environment.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { instances: [] as InstanceInfo[], modelVariantSessions: {} as AppState["modelVariantSessions"], dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: fixture.instances, bots: [], modelVariantSessions: fixture.modelVariantSessions },
    dispatch: fixture.dispatch,
    refreshInstances: vi.fn(),
    refreshModels: vi.fn(),
  }),
}));

// These cases cover the full picker; Simple mode has its own file.
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));

const { EffortRow, ModelPicker } = await import("./ModelPicker");
const { ClaudeAccountSelect, ModelEngineRail } = await import("./ModelPickerFull");

afterAll(() => vi.unstubAllGlobals());

function engine(effortLevels?: readonly EffortLevel[]): InstanceInfo {
  return {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    snapshot: { state: "available", version: "1.0.0" },
    models: { default: "gpt-5.6", options: [{ id: "gpt-5.6", label: "GPT-5.6" }] },
    ...(effortLevels ? { capabilities: { effortLevels } } : {}),
  };
}

function bot(effort?: EffortLevel): Bot {
  return {
    id: "atlas",
    threadId: "thread-atlas",
    name: "Atlas",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "codex", model: "gpt-5.6", ...(effort ? { effort } : {}) },
    messages: [],
  };
}

function levelButtons(markup: string): Array<{ label: string; pressed: boolean }> {
  return [...markup.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)</g)].map((match) => ({
    label: match[2],
    pressed: match[1] === "true",
  }));
}

function renderEffort(instances: InstanceInfo[], effort?: EffortLevel): string {
  fixture.instances = instances;
  return renderToStaticMarkup(createElement(EffortRow, { bot: bot(effort) }));
}

describe("EffortRow", () => {
  it("uses a compact dropdown without changing scope or conflating None with Default", () => {
    fixture.instances = [engine(["none", "low", "high"])];
    const row = EffortRow({ bot: bot("high"), threadId: "independent-thread", updateBotDefault: true, compact: true })!;
    const select = Children.toArray(row.props.children).at(-1) as ReactElement<{ value: string; onChange: (event: ChangeEvent<HTMLSelectElement>) => void }>;
    expect(select.type).toBe(Select);
    expect(select.props.value).toBe("high");
    for (const value of ["none", ""]) {
      select.props.onChange({ target: { value } } as ChangeEvent<HTMLSelectElement>);
      expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "independent-thread", updateBotDefault: true,
        selection: { instanceId: "codex", model: "gpt-5.6", effort: value || undefined } });
    }
    const markup = renderToStaticMarkup(createElement(EffortRow, { bot: bot(), compact: true }));
    expect(markup).toContain('aria-label="Reasoning effort"');
    expect(markup).not.toContain("<button");
    expect([...markup.matchAll(/<option[^>]*>([^<]+)</g)].map((match) => match[1])).toEqual(["Default", "None", "Low", "High"]);
  });
  it("can apply effort to the pinned thread and bot default together", () => {
    fixture.instances = [engine(["high"])];
    const row = EffortRow({ bot: bot(), threadId: "thread-atlas", updateBotDefault: true })!;
    const levels = Children.toArray(row.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
    const high = Children.toArray(levels.props.children)[1] as ReactElement<{ onClick: () => void }>;
    high.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "thread-atlas", updateBotDefault: true, selection: { instanceId: "codex", model: "gpt-5.6", effort: "high" } });
  });
  it("pins thread effort changes without changing profile defaults", () => {
    fixture.instances = [engine(["high"])];
    const row = EffortRow({ bot: bot(), threadId: "independent-thread" })!;
    const levels = Children.toArray(row.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
    const high = Children.toArray(levels.props.children)[1] as ReactElement<{ onClick: () => void }>;
    high.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "independent-thread", selection: { instanceId: "codex", model: "gpt-5.6", effort: "high" } });
  });
  it("renders nothing for an engine that declares no effort levels", () => {
    expect(renderEffort([engine()])).toBe("");
    expect(renderEffort([engine([])])).toBe("");
    expect(renderEffort([])).toBe("");
  });

  it("offers only the levels the selected engine accepts, plus Default", () => {
    const markup = renderEffort([engine(["low", "medium", "high"])]);

    expect(levelButtons(markup).map((button) => button.label)).toEqual(["Default", "Low", "Medium", "High"]);
    expect(markup).not.toContain(">X-High<");
    expect(markup).not.toContain(">Max<");
  });

  it("keeps Default and None apart — Default sends no level, None sends one", () => {
    const markup = renderEffort([engine(["none", "low"])]);

    expect(levelButtons(markup).map((button) => button.label)).toEqual(["Default", "None", "Low"]);
  });

  it("marks the active level, and Default when the bot carries no level", () => {
    const pressed = (markup: string) => levelButtons(markup).find((button) => button.pressed)?.label;

    expect(pressed(renderEffort([engine(["low", "high"])], "high"))).toBe("High");
    expect(pressed(renderEffort([engine(["low", "high"])]))).toBe("Default");
  });

  it("renames xhigh, the one level that does not capitalize cleanly", () => {
    expect(renderEffort([engine(["xhigh"])])).toContain(">X-High<");
  });
});


describe("ModelPicker trigger", () => {
  const renderTrigger = (effort?: EffortLevel) => {
    fixture.instances = [engine(["low", "high"])];
    return renderToStaticMarkup(createElement(ModelPicker, { bot: bot(effort) }));
  };

  const effortChip = (markup: string) =>
    markup.match(/<span data-model-effort[^>]*>(.*?)<\/span>/s)?.[1].replace(/<!--.*?-->/g, "").trim();

  /** React HTML-escapes the apostrophe and may encode the newline numerically; both are undone here. */
  const tooltipLines = (markup: string): string[] => {
    const encoded = markup.match(/<button[^>]*\stitle="([^"]*)"/s)?.[1];
    if (encoded === undefined) return [];
    const amp = String.fromCharCode(38);
    const newline = String.fromCharCode(10);
    return encoded
      .replaceAll(amp + "#x27;", "'")
      .replaceAll(amp + "#10;", newline)
      .split(newline);
  };

  it("names the thread in busy header help and the bot in profile settings", () => {
    fixture.instances = [engine()];
    for (const threadId of ["independent-thread", undefined]) {
      const markup = renderToStaticMarkup(createElement(ModelPicker, { bot: { ...bot(), busy: true }, threadId }));
      expect(tooltipLines(markup)).toEqual([
        "Codex · GPT-5.6",
        `Stop this ${threadId ? "thread" : "bot"}'s turn before changing its model`,
      ]);
    }
  });

  it("puts the current model and effort above the busy advisory", () => {
    fixture.instances = [engine(["low", "high"])];
    const markup = renderToStaticMarkup(createElement(ModelPicker, { bot: { ...bot("high"), busy: true }, threadId: "independent-thread" }));
    expect(tooltipLines(markup)).toEqual([
      "Codex · GPT-5.6 · High effort",
      "Stop this thread's turn before changing its model",
    ]);
  });

  it("shows the model and its effort together in the header", () => {
    const markup = renderTrigger("high");

    expect(markup).toContain("GPT-5.6");
    expect(effortChip(markup)).toBe("· High");
    expect(markup).toContain("Codex · GPT-5.6 · High effort");
  });

  it("says nothing about effort when the bot sends no level", () => {
    const markup = renderTrigger();

    expect(markup).toContain("GPT-5.6");
    expect(effortChip(markup)).toBeUndefined();
    expect(markup).not.toContain("effort");
    expect(markup).toContain("@max-4xl/chathead:size-[30px]");
    expect(markup).not.toContain("data-model-account-compact");
  });

  it("visibly identifies the selected account when Claude has multiple instances", () => {
    fixture.instances = [
      { ...engine(), instanceId: "claude-personal", driverKind: "claudeAgent", displayName: "Personal" },
      { ...engine(), instanceId: "claude-work", driverKind: "claudeAgent", displayName: "Work" },
    ];
    const markup = renderToStaticMarkup(createElement(ModelPicker, {
      bot: { ...bot(), modelSelection: { instanceId: "claude-work", model: "gpt-5.6" } },
    }));
    expect(markup).toMatch(/<span data-model-account[^>]*>Work · <\/span>/);
    expect(markup).not.toMatch(/<span data-model-account[^>]*>Personal/);
    expect(markup).toMatch(/<span data-model-account-compact="true" class="hidden max-w-20 truncate @max-4xl\/chathead:inline">Work<\/span><span class="[^"]*@max-4xl\/chathead:hidden"/);
    expect(markup).not.toContain("@max-4xl/chathead:size-[30px]");
  });
});

describe("OpenAI sign-ins in the rail", () => {
  const codex: InstanceInfo = { ...engine(), instanceId: "codex", driverKind: "codex", displayName: "Codex" };
  const plan: InstanceInfo = { ...engine(), instanceId: "chatgpt", driverKind: "codex", displayName: "ChatGPT plan" };
  const apiKey: InstanceInfo = { ...engine(), instanceId: "openai", driverKind: "openai-compat", displayName: "OpenAI", access: "api" };

  it("folds Codex and the ChatGPT plan into one OpenAI button, apart from the API-key OpenAI", () => {
    const markup = renderToStaticMarkup(createElement(ModelEngineRail, {
      instances: [codex, plan, apiKey], selectedInstance: plan, onSelect: () => {},
    }));
    expect(markup.match(/aria-label="OpenAI"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="OpenAI" aria-pressed="true"');
    expect(markup).not.toContain('aria-label="Codex"');
    expect(markup).not.toContain('aria-label="ChatGPT plan"');
    expect(markup.match(/data-rail-key-badge/g)).toHaveLength(1);
  });

  it("opens the remembered OpenAI sign-in", () => {
    const onSelect = vi.fn();
    const rail = ModelEngineRail({ instances: [codex, plan], openaiInstance: plan, onSelect });
    const button = Children.toArray(rail.props.children).find((child) => (child as ReactElement).type === "button") as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    expect(onSelect).toHaveBeenLastCalledWith(plan);
  });
});

describe("Claude provider and account selection", () => {
  const personal: InstanceInfo = { ...engine(), instanceId: "claude-personal", driverKind: "claudeAgent", displayName: "Personal" };
  const work: InstanceInfo = { ...engine(), instanceId: "claude-work", driverKind: "claudeAgent", displayName: "Work", access: "custom" };

  it("renders one Claude provider across Cloud and Local, pressed for either account", () => {
    for (const selectedInstance of [personal, work]) {
      const markup = renderToStaticMarkup(createElement(ModelEngineRail, {
        instances: [engine(), personal, work], selectedInstance, claudeInstance: work, onSelect: () => {},
      }));
      expect(markup.match(/aria-label="Claude"/g)).toHaveLength(1);
      expect(markup).toContain('aria-label="Claude" aria-pressed="true"');
      expect(markup).toContain('aria-label="OpenAI" aria-pressed="false"');
      expect(markup).not.toContain('aria-label="Personal"');
      expect(markup).not.toContain('aria-label="Work"');
      expect(markup).toContain("w-14");
    }
  });

  it("opens the remembered concrete Claude account, falling back to the first account", () => {
    const onSelect = vi.fn();
    for (const claudeInstance of [work, undefined]) {
      const rail = ModelEngineRail({ instances: [personal, work], claudeInstance, onSelect });
      const button = Children.toArray(rail.props.children).find((child) => (child as ReactElement).type === "button") as ReactElement<{ onClick: () => void }>;
      button.props.onClick();
      expect(onSelect).toHaveBeenLastCalledWith(claudeInstance ?? personal);
    }
  });

  it("shows the icon of the concrete Claude account the rail selects", () => {
    const personalIcon: InstanceInfo = { ...personal, icon: { kind: "preset", preset: "anthropic" } };
    const workIcon: InstanceInfo = { ...work, icon: { kind: "preset", preset: "azure" } };
    for (const claudeInstance of [workIcon, undefined]) {
      const target = claudeInstance ?? personalIcon;
      const rail = ModelEngineRail({ instances: [personalIcon, workIcon], claudeInstance, onSelect: () => {} });
      const button = Children.toArray(rail.props.children).find((child) => (child as ReactElement).type === "button") as ReactElement<{ children: ReactNode }>;
      const mark = Children.toArray(button.props.children)[0] as ReactElement<{ instance: InstanceInfo }>;
      expect(mark.props.instance).toBe(target);
    }
  });

  it("maps named native options to concrete instances without committing a model", () => {
    const onSelect = vi.fn();
    const dropdown = ClaudeAccountSelect({ accounts: [personal, work], selectedId: work.instanceId, onSelect });
    const markup = renderToStaticMarkup(dropdown);
    expect(markup).toContain('aria-label="Account"');
    expect(markup).toContain('<option value="claude-personal">Personal</option>');
    expect(markup).toContain('<option value="claude-work" selected="">Work</option>');
    const select = Children.toArray(dropdown.props.children)[1] as ReactElement<{ onChange: (event: ChangeEvent<HTMLSelectElement>) => void }>;
    select.props.onChange({ target: { value: personal.instanceId } } as ChangeEvent<HTMLSelectElement>);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(personal);
  });
});

describe("organisation policy", () => {
  it("shows an engine the organisation disallows as managed and dimmed, not hidden", () => {
    const blocked: InstanceInfo = { ...engine(), policy: { organizationName: "Fixture Agency", reason: "Fixture Agency allows only company models on this computer. Choose a Company model for this bot." } };
    const markup = renderToStaticMarkup(createElement(ModelEngineRail, { instances: [blocked], onSelect: () => {} }));
    expect(markup).toContain('aria-label="OpenAI · Managed by Fixture Agency"');
    expect(markup).toContain("opacity-40");
    const allowed = renderToStaticMarkup(createElement(ModelEngineRail, { instances: [engine()], onSelect: () => {} }));
    expect(allowed).not.toContain("Managed by");
  });
});
