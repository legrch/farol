import { accessIncludes } from "./inclusion";
import type {
  ApprovedWorkspace,
  GrantedWorkspaceScope,
  WorkspaceScope,
} from "./model";
import { isCanonicalAbsolutePath, isWithin } from "./paths";

export function scopeContainsPath(
  scope: WorkspaceScope,
  path: string,
): boolean {
  if (!isWithin(scope.root, path)) return false;
  return scope.mode === "subtree" || scope.paths.includes(path);
}

export function scopeContainsScope(
  parent: WorkspaceScope | ApprovedWorkspace,
  requested: WorkspaceScope,
): boolean {
  if (
    parent.workspaceId !== requested.workspaceId ||
    !accessIncludes(parent.access, requested.access) ||
    !isWithin(parent.root, requested.root)
  ) {
    return false;
  }

  if (!("mode" in parent) || parent.mode === "subtree") {
    if (requested.mode === "subtree") return true;
    return (
      requested.paths.length > 0 &&
      new Set(requested.paths).size === requested.paths.length &&
      requested.paths.every((path) => isWithin(requested.root, path))
    );
  }

  if (requested.mode !== "exact") return false;
  const allowed = new Set(parent.paths);
  return (
    requested.paths.length > 0 &&
    new Set(requested.paths).size === requested.paths.length &&
    requested.paths.every(
      (path) => isWithin(requested.root, path) && allowed.has(path),
    )
  );
}

export function scopesAreSubset(
  parent: readonly (WorkspaceScope | ApprovedWorkspace)[],
  requested: readonly WorkspaceScope[],
): boolean {
  const ids = new Set<string>();
  return requested.every((scope) => {
    if (ids.has(scope.workspaceId) || !isCanonicalAbsolutePath(scope.root)) {
      return false;
    }
    ids.add(scope.workspaceId);
    return parent.some((candidate) => scopeContainsScope(candidate, scope));
  });
}

export function cloneScope(
  scope: WorkspaceScope,
  restrictionSource: "task-grant" | "owner-restriction",
): GrantedWorkspaceScope {
  return scope.mode === "subtree"
    ? { ...scope, restrictionSource }
    : { ...scope, paths: [...scope.paths], restrictionSource };
}

export function publicScopes(
  scopes: readonly GrantedWorkspaceScope[],
): readonly WorkspaceScope[] {
  return scopes.map(({ restrictionSource: _restrictionSource, ...scope }) =>
    scope.mode === "subtree" ? scope : { ...scope, paths: [...scope.paths] },
  );
}
