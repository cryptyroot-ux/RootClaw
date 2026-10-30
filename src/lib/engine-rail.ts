import type { InstanceInfo } from "@/state/store";

export function configuredModelInstances(instances: readonly InstanceInfo[], selectedInstanceId?: string): InstanceInfo[] {
  return instances.filter((instance) =>
    instance.instanceId === selectedInstanceId
      || (instance.snapshot.state === "available" && instance.models.options.length > 0));
}

export function isCustomOnly(instance: { access?: InstanceInfo["access"] } | undefined): boolean {
  return instance?.access === "custom";
}

/** The rail's groups: built-in engines, API-key connections, then custom (local) endpoints. */
export function splitEngineRail<T>(instances: readonly T[]): { native: T[]; api: T[]; custom: T[] } {
  const native: T[] = [];
  const api: T[] = [];
  const custom: T[] = [];
  for (const instance of instances) {
    const access = (instance as { access?: InstanceInfo["access"] }).access;
    if (access === "custom") custom.push(instance);
    else if (access === "api") api.push(instance);
    else native.push(instance);
  }
  return { native, api, custom };
}
