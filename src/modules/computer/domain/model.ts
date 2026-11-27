export type AuthorityCapability =
  | "workspace.list"
  | "workspace.read"
  | "workspace.search"
  | "verification.run"
  | "workspace.write"
  | "workspace.shell";

export type WorkspaceAccess = "read" | "write";
export type NetworkAuthority = "none" | "approved";
export type CommandAuthority = "none" | "verification" | "workspace";
export type ParticipantRole = "main" | "agent" | "critic";
export type MutationOwnership = "none" | "task";

// The device and inode the approved folder had when the owner approved it.
export type WorkspaceRootIdentity = Readonly<{
  device: string;
  inode: string;
}>;

// The external Git metadata of a linked worktree the owner approved when they
// verified the workspace.
export type WorkspaceGitMetadataApproval = Readonly<{
  gitDirectory: string;
  commonDirectory: string;
}>;

// A workspace is approved only together with the identity its folder had when
// the owner verified it. Without one a folder that later took the same path
// would be indistinguishable from the approved one, so there is no approved
// workspace without an identity.
export type ApprovedWorkspace = Readonly<{
  workspaceId: string;
  root: string;
  access: WorkspaceAccess;
  rootIdentity: WorkspaceRootIdentity;
  gitMetadata?: WorkspaceGitMetadataApproval | undefined;
  // Shell access to the full Git object database, including historical
  // versions of paths excluded from ordinary workspace reads.
  gitHistoryApproved?: boolean | undefined;
  // A launch-time, generation-bound owner verification for shell effects.
  shellVerified?: boolean | undefined;
}>;

export type WorkspaceExclusion = Readonly<{
  workspaceId: string;
  path: string;
}>;

export type SubtreeWorkspaceScope = Readonly<{
  workspaceId: string;
  mode: "subtree";
  root: string;
  access: WorkspaceAccess;
}>;

export type ExactWorkspaceScope = Readonly<{
  workspaceId: string;
  mode: "exact";
  root: string;
  paths: readonly string[];
  access: WorkspaceAccess;
}>;

export type WorkspaceScope = SubtreeWorkspaceScope | ExactWorkspaceScope;

// "unknown" is never produced by this module: `deriveTaskGrant` and
// `narrowTaskGrant` below always stamp a concrete source. It exists so an
// authority reconstructed from an external record that predates provenance
// (see `codex-agent-workspace-probe.ts`'s `participant()`) can say so
// honestly instead of being coerced into looking like an ordinary grant.
export type WorkspaceRestrictionSource =
  "task-grant" | "owner-restriction" | "unknown";
export type ExclusionRestrictionSource =
  "computer-approval" | "task-grant" | "owner-restriction" | "unknown";

export type GrantedWorkspaceScope = WorkspaceScope &
  Readonly<{ restrictionSource: WorkspaceRestrictionSource }>;

export type GrantedWorkspaceExclusion = WorkspaceExclusion &
  Readonly<{
    restrictionSource: ExclusionRestrictionSource;
  }>;

export type ComputerApproval = Readonly<{
  ownerId: string;
  computerId: string;
  generation: number;
  workspaces: readonly ApprovedWorkspace[];
  excludedPaths?: readonly WorkspaceExclusion[] | undefined;
  capabilities: readonly AuthorityCapability[];
  network: NetworkAuthority;
  commands: CommandAuthority;
  // Trusted owner-settings projection for the Go route. Missing stays legacy.
  filePolicy?: "" | "approved-roots-v1" | undefined;
  expiresAt: number;
}>;

export type TaskAdmission = Readonly<{
  authorityId: string;
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  computerId: string;
  computerGeneration: number;
  workspaces: readonly WorkspaceScope[];
  excludedPaths?: readonly WorkspaceExclusion[] | undefined;
  capabilities: readonly AuthorityCapability[];
  network: NetworkAuthority;
  commands: CommandAuthority;
  expiresAt: number;
}>;

export type TaskGrant = Readonly<{
  authorityId: string;
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  computerId: string;
  computerGeneration: number;
  workspaces: readonly GrantedWorkspaceScope[];
  excludedPaths: readonly GrantedWorkspaceExclusion[];
  capabilities: readonly AuthorityCapability[];
  network: NetworkAuthority;
  commands: CommandAuthority;
  expiresAt: number;
}>;

export type ParticipantAuthority = Readonly<{
  participantId: string;
  parentParticipantId: string | null;
  role: ParticipantRole;
  mutationOwnership: MutationOwnership;
  grant: TaskGrant;
}>;

export type AuthorityNarrowing = Readonly<{
  workspaces: readonly WorkspaceScope[];
  excludedPaths?: readonly WorkspaceExclusion[] | undefined;
  capabilities: readonly AuthorityCapability[];
  network: NetworkAuthority;
  commands: CommandAuthority;
}>;

export type ParticipantAdmission = Readonly<{
  participantId: string;
  role: ParticipantRole;
  mutationOwnership: MutationOwnership;
}>;

export type DelegationAdmission = ParticipantAdmission &
  Readonly<{ narrowing?: AuthorityNarrowing }>;

export type WorkspaceOperation = Readonly<{
  kind:
    | "workspace.list"
    | "workspace.read"
    | "workspace.search"
    | "verification.run"
    | "workspace.write"
    | "workspace.shell";
  workspaceId: string;
  path: string;
  write?: boolean;
}>;

export type AuthorityOperation =
  WorkspaceOperation | Readonly<{ kind: "network.use" }>;

export type AuthorityAction = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  operation: AuthorityOperation;
}>;

export type TaskAuthorityIdentity = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
}>;

export type NativeHostAuthority = Readonly<{
  hostTaskId: string;
  ownerId: string;
  taskId: string;
  taskEpoch: number;
  workspaces: readonly WorkspaceScope[];
  excludedPaths?: readonly WorkspaceExclusion[] | undefined;
  capabilities: readonly AuthorityCapability[];
  network: NetworkAuthority;
  commands: CommandAuthority;
  expiresAt: number;
}>;

export type AuthorityErrorCode =
  | "AUTHORITY_OWNER_MISMATCH"
  | "AUTHORITY_TASK_MISMATCH"
  | "AUTHORITY_COMPUTER_MISMATCH"
  | "AUTHORITY_EXPIRED"
  | "AUTHORITY_INFLATION_DENIED"
  | "AUTHORITY_CAPABILITY_DENIED"
  | "AUTHORITY_PATH_DENIED"
  | "AUTHORITY_NETWORK_DENIED"
  | "AUTHORITY_COMMAND_DENIED"
  | "AUTHORITY_MUTATION_OWNERSHIP_DENIED";

// "unverified-provenance" is reported when the restriction that denied an
// action carries "unknown" provenance (see `WorkspaceRestrictionSource`):
// such a denial is real, but nobody can say whether it came from the task's
// own grant or from an owner narrowing, and it is never dressed up as either.
export type AuthorityFailureSource =
  | "computer-approval"
  | "task-admission"
  | "task-grant"
  | "owner-restriction"
  | "unverified-provenance"
  | "role"
  | "computer-policy"
  | "native-host";

export type AuthorityResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: AuthorityErrorCode;
        source: AuthorityFailureSource;
        retry: "never";
      }>;
    }>;
