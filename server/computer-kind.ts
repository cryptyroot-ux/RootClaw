/** Which kind of computer a turn resource names: this machine, a local VM, a cloud box or a VPS. */
export type ComputerKind = "thisComputer" | "localVm" | "box" | "vps";

export function computerKindForResource(resource: string): ComputerKind | undefined {
  if (resource === "computer:host") return "thisComputer";
  if (resource.startsWith("computer:vm:")) return "localVm";
  // computer:box: and computer:box-bot: are Boat's historical resource prefixes.
  if (resource.startsWith("computer:box:") || resource.startsWith("computer:box-bot:")) return "box";
  if (resource.startsWith("computer:vps:")) return "vps";
}
