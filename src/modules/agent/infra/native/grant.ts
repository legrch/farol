import path from "node:path";
import type { AgentSpawnRequest } from "../../app/port/agent-host";

export function validDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function canonicalAbsolutePath(value: string): boolean {
  if (
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    (value.length > 1 && value.endsWith(path.sep))
  ) {
    return false;
  }
  const normalized = path.normalize(value);
  return normalized === value && !value.split(path.sep).includes("..");
}

export function within(root: string, candidate: string): boolean {
  return (
    canonicalAbsolutePath(root) &&
    canonicalAbsolutePath(candidate) &&
    (candidate === root || candidate.startsWith(`${root}${path.sep}`))
  );
}

export function compatible(
  request: AgentSpawnRequest,
  now: number,
  runtimeRoot: string,
): boolean {
  const authority = request.authority;
  const permittedCapabilities = new Set([
    "workspace.list",
    "workspace.read",
    "workspace.search",
    "verification.run",
  ]);
  const verificationEnabled =
    authority.capabilities.includes("verification.run");
  const commandsAllowed =
    request.intent.kind === "product"
      ? (authority.commands === "verification" && verificationEnabled) ||
        (authority.commands === "none" && !verificationEnabled)
      : authority.commands === "none" && !verificationEnabled;
  const focusAllowed =
    request.focus.initialPaths.length > 0 &&
    request.focus.initialPaths.length <= 256 &&
    new Set(request.focus.initialPaths).size ===
      request.focus.initialPaths.length &&
    request.focus.initialPaths.every(
      (candidate) =>
        canonicalAbsolutePath(candidate) &&
        authority.workspaces.some((workspace) => {
          const inside = within(workspace.root, candidate);
          const selected =
            workspace.mode === "subtree" || workspace.paths.includes(candidate);
          const excluded = authority.excludedPaths.some(
            (entry) =>
              entry.workspaceId === workspace.workspaceId &&
              within(entry.path, candidate),
          );
          return inside && selected && !excluded;
        }),
    );
  const intentAllowed =
    request.intent.kind === "compatibility" ||
    (request.intent.objective.trim().length > 0 &&
      request.intent.objective.length <= 8_000 &&
      !request.intent.objective.includes("\0"));
  return (
    authority.ownerId === request.identity.ownerId &&
    authority.sessionId === request.identity.sessionId &&
    authority.taskId === request.identity.taskId &&
    authority.taskEpoch === request.identity.taskEpoch &&
    authority.mutationOwnership === "none" &&
    authority.network === "none" &&
    commandsAllowed &&
    authority.expiresAt >= now &&
    authority.workspaces.length > 0 &&
    authority.workspaces.every(
      (workspace) =>
        canonicalAbsolutePath(workspace.root) &&
        !within(workspace.root, runtimeRoot) &&
        !within(runtimeRoot, workspace.root) &&
        (workspace.mode === "subtree" ||
          workspace.paths.every(
            (candidate) =>
              canonicalAbsolutePath(candidate) &&
              within(workspace.root, candidate),
          )),
    ) &&
    authority.excludedPaths.every(
      (entry) =>
        canonicalAbsolutePath(entry.path) &&
        authority.workspaces.some(
          (workspace) =>
            workspace.workspaceId === entry.workspaceId &&
            within(workspace.root, entry.path),
        ),
    ) &&
    authority.workspaces.every((workspace) => workspace.access === "read") &&
    authority.capabilities.every((capability) =>
      permittedCapabilities.has(capability),
    ) &&
    intentAllowed &&
    focusAllowed
  );
}
