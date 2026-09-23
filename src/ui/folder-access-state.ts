import type {
  ApprovedProductWorkspace,
  ProductSettings,
} from "../pkg/product-settings/contract";

// A folder's green badge describes a bounded local access check at this exact
// build and scope. It never grants access or substitutes for descriptor checks.
export function folderAccessChecked(
  settings: ProductSettings,
  workspace: ApprovedProductWorkspace,
  buildId: string,
): boolean {
  const check = workspace.accessCheck;
  const identity = workspace.rootIdentity;
  if (check === null) return false;
  if (check)
    return (
      check.buildId === buildId &&
      check.computerGeneration === settings.computer.generation &&
      identity !== undefined &&
      check.rootIdentity.device === identity.device &&
      check.rootIdentity.inode === identity.inode
    );
  // Compatibility with a single previously verified folder; do not spread its
  // badge to other saved folders that were never part of that check.
  const prior = settings.setup.computer.verified;
  return (
    identity !== undefined &&
    prior?.workspaceId === workspace.workspaceId &&
    prior.buildId === buildId &&
    prior.configRevision === settings.computer.generation &&
    settings.setup.computer.reachable === "reachable" &&
    !settings.setup.computer.outcomeUnknown
  );
}

export function allFoldersChecked(
  settings: ProductSettings,
  buildId: string,
): boolean {
  return (
    settings.computer.workspaces.length > 0 &&
    settings.computer.workspaces.every((workspace) =>
      folderAccessChecked(settings, workspace, buildId),
    )
  );
}

export function folderDisplayName(workspace: ApprovedProductWorkspace): string {
  // Display the actual folder, not internal fixture labels or authority IDs.
  // The full path is displayed below. Every active grant remains visible.
  return workspace.root.split("/").filter(Boolean).at(-1) ?? workspace.root;
}
