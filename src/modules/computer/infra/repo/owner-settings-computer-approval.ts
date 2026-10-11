import type { ProductSettings } from "../../../../pkg/product-settings/contract";
import type { ComputerApproval } from "../../domain/execution-authority";
import { identityBoundWorkspaces } from "./identity-bound-workspaces";

export const COMPUTER_TASK_GRANT_LIFETIME_MS = 12 * 60 * 60 * 1_000;

export function ownerSettingsComputerApproval(
  settings: ProductSettings,
  now: number,
): ComputerApproval {
  const workspaces = identityBoundWorkspaces(settings.computer.workspaces);
  const writeEnabled = workspaces.some(
    (workspace) => workspace.access === "write",
  );
  const computerVerification = settings.setup.computer.verified;
  const freshShellWorkspace = (workspace: (typeof workspaces)[number]) =>
    settings.computer.commands === "workspace" &&
    settings.setup.computer.reachable === "reachable" &&
    !settings.setup.computer.outcomeUnknown &&
    computerVerification?.configRevision === settings.computer.generation &&
    workspace.accessCheck?.computerGeneration ===
      settings.computer.generation &&
    workspace.accessCheck.buildId === computerVerification.buildId &&
    workspace.accessCheck.rootIdentity.device ===
      workspace.rootIdentity.device &&
    workspace.accessCheck.rootIdentity.inode === workspace.rootIdentity.inode;
  const shellEnabled = workspaces.some(freshShellWorkspace);
  const effectiveCommands =
    workspaces.length === 0
      ? "none"
      : settings.computer.commands === "workspace" && !shellEnabled
        ? "verification"
        : settings.computer.commands;
  const capabilities =
    workspaces.length === 0
      ? []
      : [
          "workspace.list" as const,
          "workspace.read" as const,
          "workspace.search" as const,
          ...(effectiveCommands !== "none"
            ? (["verification.run"] as const)
            : []),
          ...(shellEnabled ? (["workspace.shell"] as const) : []),
          ...(writeEnabled ? (["workspace.write"] as const) : []),
        ];
  const excludedPaths = workspaces.flatMap((workspace) =>
    workspace.excludedPaths.map((excluded) => ({
      workspaceId: workspace.workspaceId,
      path: excluded,
    })),
  );
  const expiresAt = now + COMPUTER_TASK_GRANT_LIFETIME_MS;
  return {
    ownerId: "owner-desktop",
    computerId: settings.computer.computerId,
    generation: settings.computer.generation,
    workspaces: workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      access: workspace.access,
      rootIdentity: workspace.rootIdentity,
      ...(workspace.gitHistoryApproved !== undefined
        ? { gitHistoryApproved: workspace.gitHistoryApproved }
        : {}),
      shellVerified: freshShellWorkspace(workspace),
      ...(workspace.gitMetadata ? { gitMetadata: workspace.gitMetadata } : {}),
    })),
    excludedPaths,
    capabilities,
    network: "none",
    commands: effectiveCommands,
    ...(settings.computer.filePolicy === "approved-roots-v1"
      ? { filePolicy: settings.computer.filePolicy }
      : {}),
    expiresAt,
  };
}
