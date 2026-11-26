import type { WorkspaceMutationRequest } from "../../app/port/mutable-workspace";

// Deny lists the adapter applies to every request, whatever the owner adds.

export const DEFAULT_DENIED_PATHS = Object.freeze([
  ".env",
  ".ssh",
  ".aws",
  ".gnupg",
  ".git",
  ".git-credentials",
  ".netrc",
  ".pypirc",
  ".docker/config.json",
  ".kube/config",
  "Library/Keychains",
]);

export const DEFAULT_WRITE_DENIED_PATHS = Object.freeze([".git"]);

// The helper refuses more deny prefixes than this.  The adapter measures the
// union of mandatory and owner exclusions first, so an oversized policy is a
// specific refusal instead of a generic invalid request, and no exclusion is
// ever dropped to make a request fit.
export const MAX_HELPER_DENIED_PATHS = 64;

export function deniedPaths(
  request: Readonly<{
    workspace: Readonly<{ deniedPaths: readonly string[] }>;
  }>,
): readonly string[] {
  return [
    ...new Set([...DEFAULT_DENIED_PATHS, ...request.workspace.deniedPaths]),
  ];
}

export function verificationDeniedPaths(
  request: Readonly<{
    workspace: Readonly<{ deniedPaths: readonly string[] }>;
  }>,
): readonly string[] {
  return [
    ...new Set([
      ...DEFAULT_DENIED_PATHS.filter((relative) => relative !== ".git"),
      ...request.workspace.deniedPaths,
    ]),
  ];
}

export function writeDeniedPaths(
  request: WorkspaceMutationRequest,
): readonly string[] {
  return [
    ...new Set([
      ...DEFAULT_WRITE_DENIED_PATHS,
      ...request.workspace.writeDeniedPaths,
    ]),
  ];
}
