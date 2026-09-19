import type {
  ApprovedProductWorkspace,
  WorkspaceRootIdentity,
} from "../../pkg/product-settings/contract";

export type IdentityBoundWorkspace = ApprovedProductWorkspace &
  Readonly<{ rootIdentity: WorkspaceRootIdentity }>;

// Only a workspace bound to the folder identity the owner verified can carry
// authority. One saved before identities existed is left out of every approval
// until the owner verifies it again, rather than trusted by its pathname.
export function identityBoundWorkspaces(
  workspaces: readonly ApprovedProductWorkspace[],
): IdentityBoundWorkspace[] {
  return workspaces.flatMap((workspace) =>
    workspace.rootIdentity
      ? [{ ...workspace, rootIdentity: workspace.rootIdentity }]
      : [],
  );
}
