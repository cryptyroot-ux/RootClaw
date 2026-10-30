import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { choiceIsSelected, modelChoices } from "./model-choices";

const xai = {
  instanceId: "xaiApi",
  driverKind: "grok",
  displayName: "xAI",
  snapshot: { state: "available" },
  models: { default: "grok-4", options: [{ id: "grok-4", label: "Grok 4" }, { id: "grok-4-mini", label: "Grok 4 Mini" }] },
} as InstanceInfo;

describe("model choices", () => {
  it("lists the instance's models as they are, and matches the selected one", () => {
    const choices = modelChoices(xai, xai.models.options);
    expect(choices.map((choice) => choice.label)).toEqual(["Grok 4", "Grok 4 Mini"]);
    expect(choiceIsSelected(choices[1]!, { instanceId: "xaiApi", model: "grok-4-mini" })).toBe(true);
    expect(choiceIsSelected(choices[0]!, { instanceId: "xaiApi", model: "grok-4-mini" })).toBe(false);
  });
});
