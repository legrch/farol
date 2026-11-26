import type {
  AuthorityFailureSource,
  ApprovedWorkspace,
  ExclusionRestrictionSource,
  GrantedWorkspaceExclusion,
  WorkspaceExclusion,
  WorkspaceScope,
} from "./model";
import { comparableWithin, isCanonicalAbsolutePath } from "./paths";
import { scopeContainsPath } from "./scope";

const MAX_EXCLUSIONS_PER_WORKSPACE = 32;

export function exclusionKey(exclusion: WorkspaceExclusion): string {
  return `${exclusion.workspaceId}\0${exclusion.path}`;
}

export function exclusionsAreValid(
  scopes: readonly (WorkspaceScope | ApprovedWorkspace)[],
  exclusions: readonly WorkspaceExclusion[],
): boolean {
  const keys = new Set<string>();
  const perWorkspace = new Map<string, number>();
  return exclusions.every((exclusion) => {
    const key = exclusionKey(exclusion);
    if (keys.has(key) || !isCanonicalAbsolutePath(exclusion.path)) {
      return false;
    }
    keys.add(key);
    // The cap is per workspace, as Settings enforces it. The grant's own size
    // stays bounded by the combined check on its relevant exclusions.
    const count = (perWorkspace.get(exclusion.workspaceId) ?? 0) + 1;
    if (count > MAX_EXCLUSIONS_PER_WORKSPACE) return false;
    perWorkspace.set(exclusion.workspaceId, count);
    return scopes.some(
      (scope) =>
        scope.workspaceId === exclusion.workspaceId &&
        scopeContainsPath(
          "mode" in scope ? scope : { ...scope, mode: "subtree" as const },
          exclusion.path,
        ),
    );
  });
}

export function exclusionAffectsScope(
  exclusion: WorkspaceExclusion,
  scope: WorkspaceScope,
): boolean {
  if (exclusion.workspaceId !== scope.workspaceId) return false;
  if (scope.mode === "subtree") {
    return (
      comparableWithin(scope.root, exclusion.path) ||
      comparableWithin(exclusion.path, scope.root)
    );
  }
  return scope.paths.some((path) => comparableWithin(exclusion.path, path));
}

export function relevantExclusions(
  scopes: readonly WorkspaceScope[],
  exclusions: readonly WorkspaceExclusion[],
  restrictionSource: GrantedWorkspaceExclusion["restrictionSource"],
): readonly GrantedWorkspaceExclusion[] {
  return exclusions
    .filter((exclusion) =>
      scopes.some((scope) => exclusionAffectsScope(exclusion, scope)),
    )
    .map((exclusion) => ({ ...exclusion, restrictionSource }));
}

export function mergeExclusions(
  ...groups: readonly (readonly GrantedWorkspaceExclusion[])[]
): readonly GrantedWorkspaceExclusion[] {
  const merged = new Map<string, GrantedWorkspaceExclusion>();
  for (const group of groups) {
    for (const exclusion of group) {
      merged.set(exclusionKey(exclusion), { ...exclusion });
    }
  }
  return [...merged.values()];
}

export function deniedBy<Exclusion extends WorkspaceExclusion>(
  exclusions: readonly Exclusion[],
  workspaceId: string,
  path: string,
): Exclusion | null {
  return (
    exclusions.find(
      (exclusion) =>
        exclusion.workspaceId === workspaceId &&
        comparableWithin(exclusion.path, path),
    ) ?? null
  );
}

// How a denial by a restriction is reported, by where that restriction came
// from. A lookup rather than a chain of conditions: every provenance value
// maps to exactly one closed failure source, and "unknown" is its own
// answer, never a fallback onto "task-grant".
export const RESTRICTION_FAILURE_SOURCE: Readonly<
  Record<ExclusionRestrictionSource, AuthorityFailureSource>
> = {
  "computer-approval": "computer-approval",
  "task-grant": "task-grant",
  "owner-restriction": "owner-restriction",
  unknown: "unverified-provenance",
};
