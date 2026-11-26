import type { ComputerApproval, WorkspaceGitMetadataApproval } from "./model";

export type {
  ApprovedWorkspace,
  AuthorityAction,
  AuthorityCapability,
  AuthorityErrorCode,
  AuthorityFailureSource,
  AuthorityNarrowing,
  AuthorityOperation,
  AuthorityResult,
  CommandAuthority,
  ComputerApproval,
  DelegationAdmission,
  ExactWorkspaceScope,
  ExclusionRestrictionSource,
  GrantedWorkspaceExclusion,
  MutationOwnership,
  NativeHostAuthority,
  NetworkAuthority,
  ParticipantAdmission,
  ParticipantAuthority,
  ParticipantRole,
  SubtreeWorkspaceScope,
  TaskAdmission,
  TaskAuthorityIdentity,
  TaskGrant,
  WorkspaceAccess,
  WorkspaceExclusion,
  WorkspaceGitMetadataApproval,
  WorkspaceOperation,
  WorkspaceRestrictionSource,
  WorkspaceRootIdentity,
  WorkspaceScope,
} from "./model";

export {
  createParticipantAuthority,
  delegateParticipantAuthority,
  deriveTaskGrant,
} from "./derive";
export {
  authorizeComputerAction,
  authorizeNativeHostAction,
  authorizeTaskAction,
  authorizeTaskIdentity,
} from "./policy";

/**
 * What the owner approved about one workspace's folder, for the native
 * boundary: the folder's identity, so another object that has since taken its
 * path is refused, and a linked worktree's approved Git metadata, the only
 * metadata outside the root that Git verification may open.
 */
export function approvedWorkspaceBinding(
  approval: ComputerApproval,
  workspaceId: string,
): Readonly<{
  approvedRoot: Readonly<{ path: string; device: string; inode: string }>;
  gitMetadata?: WorkspaceGitMetadataApproval;
}> | null {
  const approved = approval.workspaces.find(
    (workspace) => workspace.workspaceId === workspaceId,
  );
  if (!approved) return null;
  return {
    approvedRoot: { path: approved.root, ...approved.rootIdentity },
    ...(approved.gitMetadata ? { gitMetadata: approved.gitMetadata } : {}),
  };
}
