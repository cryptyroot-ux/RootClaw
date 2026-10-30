import type { InstanceInfo, ModelSelection } from "@/state/store";

type ModelOption = InstanceInfo["models"]["options"][number];

export type ModelChoice = ModelOption & { nativeModel?: string; variant?: string };

/** The choices a model picker lists for an instance: its models, as the instance declares them. */
export function modelChoices(_instance: InstanceInfo, options: readonly ModelOption[]): ModelChoice[] {
  return [...options];
}

export function choiceIsSelected(choice: ModelChoice, selection: ModelSelection): boolean {
  return (choice.nativeModel ?? choice.id) === selection.model && choice.variant === selection.variant;
}

export function modelSelectionForPick(selection: ModelSelection, instance: InstanceInfo, model: string): ModelSelection {
  const next: ModelSelection = { instanceId: instance.instanceId, model };
  if (instance.instanceId === selection.instanceId) {
    if (instance.capabilities?.modelVariants && model === selection.model && selection.variant !== undefined) next.variant = selection.variant;
    else if (!instance.capabilities?.modelVariants && selection.effort) next.effort = selection.effort;
  }
  return next;
}
