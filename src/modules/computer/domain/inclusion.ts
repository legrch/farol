import type {
  AuthorityCapability,
  CommandAuthority,
  NetworkAuthority,
  WorkspaceAccess,
} from "./model";

export function accessIncludes(
  parent: WorkspaceAccess,
  requested: WorkspaceAccess,
): boolean {
  return parent === "write" || requested === "read";
}

export function commandsInclude(
  parent: CommandAuthority,
  requested: CommandAuthority,
): boolean {
  return (
    parent === requested ||
    requested === "none" ||
    (parent === "workspace" && requested === "verification")
  );
}

export function networkIncludes(
  parent: NetworkAuthority,
  requested: NetworkAuthority,
): boolean {
  return parent === "approved" || requested === "none";
}

export function capabilitySetIncludes(
  parent: readonly AuthorityCapability[],
  requested: readonly AuthorityCapability[],
): boolean {
  const available = new Set(parent);
  return requested.every((capability) => available.has(capability));
}
