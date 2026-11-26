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

import type {
  ApprovedWorkspace,
  AuthorityAction,
  AuthorityCapability,
  AuthorityFailureSource,
  AuthorityNarrowing,
  AuthorityResult,
  CommandAuthority,
  ComputerApproval,
  DelegationAdmission,
  ExclusionRestrictionSource,
  GrantedWorkspaceExclusion,
  GrantedWorkspaceScope,
  NativeHostAuthority,
  NetworkAuthority,
  ParticipantAdmission,
  ParticipantAuthority,
  TaskAdmission,
  TaskAuthorityIdentity,
  TaskGrant,
  WorkspaceAccess,
  WorkspaceExclusion,
  WorkspaceGitMetadataApproval,
  WorkspaceOperation,
  WorkspaceScope,
} from "./model";
import { failure, success } from "./outcome";
import { comparableWithin, isCanonicalAbsolutePath, isWithin } from "./paths";

function accessIncludes(
  parent: WorkspaceAccess,
  requested: WorkspaceAccess,
): boolean {
  return parent === "write" || requested === "read";
}

function commandsInclude(
  parent: CommandAuthority,
  requested: CommandAuthority,
): boolean {
  return (
    parent === requested ||
    requested === "none" ||
    (parent === "workspace" && requested === "verification")
  );
}

function networkIncludes(
  parent: NetworkAuthority,
  requested: NetworkAuthority,
): boolean {
  return parent === "approved" || requested === "none";
}

function capabilitySetIncludes(
  parent: readonly AuthorityCapability[],
  requested: readonly AuthorityCapability[],
): boolean {
  const available = new Set(parent);
  return requested.every((capability) => available.has(capability));
}

function scopeContainsPath(scope: WorkspaceScope, path: string): boolean {
  if (!isWithin(scope.root, path)) return false;
  return scope.mode === "subtree" || scope.paths.includes(path);
}

function scopeContainsScope(
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

function scopesAreSubset(
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

function exclusionKey(exclusion: WorkspaceExclusion): string {
  return `${exclusion.workspaceId}\0${exclusion.path}`;
}

function exclusionsAreValid(
  scopes: readonly (WorkspaceScope | ApprovedWorkspace)[],
  exclusions: readonly WorkspaceExclusion[],
): boolean {
  if (exclusions.length > 32) return false;
  const keys = new Set<string>();
  return exclusions.every((exclusion) => {
    const key = exclusionKey(exclusion);
    if (keys.has(key) || !isCanonicalAbsolutePath(exclusion.path)) {
      return false;
    }
    keys.add(key);
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

function exclusionAffectsScope(
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

function relevantExclusions(
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

function mergeExclusions(
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

function deniedBy<Exclusion extends WorkspaceExclusion>(
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
const RESTRICTION_FAILURE_SOURCE: Readonly<
  Record<ExclusionRestrictionSource, AuthorityFailureSource>
> = {
  "computer-approval": "computer-approval",
  "task-grant": "task-grant",
  "owner-restriction": "owner-restriction",
  unknown: "unverified-provenance",
};

function cloneScope(
  scope: WorkspaceScope,
  restrictionSource: "task-grant" | "owner-restriction",
): GrantedWorkspaceScope {
  return scope.mode === "subtree"
    ? { ...scope, restrictionSource }
    : { ...scope, paths: [...scope.paths], restrictionSource };
}

function publicScopes(
  scopes: readonly GrantedWorkspaceScope[],
): readonly WorkspaceScope[] {
  return scopes.map(({ restrictionSource: _restrictionSource, ...scope }) =>
    scope.mode === "subtree" ? scope : { ...scope, paths: [...scope.paths] },
  );
}

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

export function deriveTaskGrant(
  approval: ComputerApproval,
  admission: TaskAdmission,
  now: number,
): AuthorityResult<TaskGrant> {
  const approvalExclusions = approval.excludedPaths ?? [];
  const admissionExclusions = admission.excludedPaths ?? [];
  if (approval.ownerId !== admission.ownerId) {
    return failure("AUTHORITY_OWNER_MISMATCH", "computer-approval");
  }
  if (
    approval.computerId !== admission.computerId ||
    approval.generation !== admission.computerGeneration
  ) {
    return failure("AUTHORITY_COMPUTER_MISMATCH", "computer-approval");
  }
  if (now > approval.expiresAt || now > admission.expiresAt) {
    return failure("AUTHORITY_EXPIRED", "task-admission");
  }
  if (!exclusionsAreValid(approval.workspaces, approvalExclusions)) {
    return failure("AUTHORITY_INFLATION_DENIED", "computer-approval");
  }
  if (
    admission.expiresAt > approval.expiresAt ||
    !capabilitySetIncludes(approval.capabilities, admission.capabilities) ||
    !networkIncludes(approval.network, admission.network) ||
    !commandsInclude(approval.commands, admission.commands) ||
    !scopesAreSubset(approval.workspaces, admission.workspaces) ||
    !exclusionsAreValid(admission.workspaces, admissionExclusions)
  ) {
    return failure("AUTHORITY_INFLATION_DENIED", "task-admission");
  }

  const excludedPaths = mergeExclusions(
    relevantExclusions(
      admission.workspaces,
      approvalExclusions,
      "computer-approval",
    ),
    relevantExclusions(admission.workspaces, admissionExclusions, "task-grant"),
  );
  if (excludedPaths.length > 32) {
    return failure("AUTHORITY_INFLATION_DENIED", "task-admission");
  }

  return success({
    authorityId: admission.authorityId,
    ownerId: admission.ownerId,
    sessionId: admission.sessionId,
    taskId: admission.taskId,
    taskEpoch: admission.taskEpoch,
    computerId: admission.computerId,
    computerGeneration: admission.computerGeneration,
    workspaces: admission.workspaces.map((scope) =>
      cloneScope(scope, "task-grant"),
    ),
    excludedPaths,
    capabilities: [...admission.capabilities],
    network: admission.network,
    commands: admission.commands,
    expiresAt: admission.expiresAt,
  });
}

export function createParticipantAuthority(
  grant: TaskGrant,
  admission: ParticipantAdmission,
): AuthorityResult<ParticipantAuthority> {
  if (
    admission.mutationOwnership === "task" &&
    !grant.capabilities.includes("workspace.write")
  ) {
    return failure("AUTHORITY_INFLATION_DENIED", "role");
  }
  return success({
    participantId: admission.participantId,
    parentParticipantId: null,
    role: admission.role,
    mutationOwnership: admission.mutationOwnership,
    grant,
  });
}

function narrowTaskGrant(
  grant: TaskGrant,
  narrowing: AuthorityNarrowing,
): AuthorityResult<TaskGrant> {
  const requestedExclusions = narrowing.excludedPaths ?? [];
  if (
    !capabilitySetIncludes(grant.capabilities, narrowing.capabilities) ||
    !networkIncludes(grant.network, narrowing.network) ||
    !commandsInclude(grant.commands, narrowing.commands) ||
    !scopesAreSubset(publicScopes(grant.workspaces), narrowing.workspaces) ||
    !exclusionsAreValid(narrowing.workspaces, requestedExclusions)
  ) {
    return failure("AUTHORITY_INFLATION_DENIED", "owner-restriction");
  }
  const excludedPaths = mergeExclusions(
    grant.excludedPaths.filter((exclusion) =>
      narrowing.workspaces.some((scope) =>
        exclusionAffectsScope(exclusion, scope),
      ),
    ),
    relevantExclusions(
      narrowing.workspaces,
      requestedExclusions,
      "owner-restriction",
    ),
  );
  if (excludedPaths.length > 32) {
    return failure("AUTHORITY_INFLATION_DENIED", "owner-restriction");
  }
  return success({
    ...grant,
    workspaces: narrowing.workspaces.map((scope) =>
      cloneScope(scope, "owner-restriction"),
    ),
    excludedPaths,
    capabilities: [...narrowing.capabilities],
    network: narrowing.network,
    commands: narrowing.commands,
  });
}

export function delegateParticipantAuthority(
  parent: ParticipantAuthority,
  admission: DelegationAdmission,
): AuthorityResult<ParticipantAuthority> {
  if (
    admission.mutationOwnership === "task" &&
    parent.mutationOwnership !== "task"
  ) {
    return failure("AUTHORITY_INFLATION_DENIED", "role");
  }
  const narrowed = admission.narrowing
    ? narrowTaskGrant(parent.grant, admission.narrowing)
    : success(parent.grant);
  if (!narrowed.ok) return narrowed;
  if (
    admission.mutationOwnership === "task" &&
    !narrowed.value.capabilities.includes("workspace.write")
  ) {
    return failure("AUTHORITY_INFLATION_DENIED", "role");
  }
  return success({
    participantId: admission.participantId,
    parentParticipantId: parent.participantId,
    role: admission.role,
    mutationOwnership: admission.mutationOwnership,
    grant: narrowed.value,
  });
}

function requiredCapability(
  operation: WorkspaceOperation,
): AuthorityCapability {
  return operation.kind;
}

type ActionPolicy = Readonly<{
  workspaces: readonly WorkspaceScope[];
  excludedPaths?: readonly WorkspaceExclusion[] | undefined;
  capabilities: readonly AuthorityCapability[];
  network: NetworkAuthority;
  commands: CommandAuthority;
  expiresAt: number;
}>;

function authorizeAgainstPolicy(
  policy: ActionPolicy,
  action: AuthorityAction,
  now: number,
  source: AuthorityFailureSource,
): AuthorityResult<AuthorityAction> {
  if (now > policy.expiresAt) {
    return failure("AUTHORITY_EXPIRED", source);
  }
  if (action.operation.kind === "network.use") {
    return policy.network === "approved"
      ? success(action)
      : failure("AUTHORITY_NETWORK_DENIED", source);
  }

  const operation = action.operation;
  const capability = requiredCapability(operation);
  if (!policy.capabilities.includes(capability)) {
    return failure("AUTHORITY_CAPABILITY_DENIED", source);
  }
  if (
    operation.kind === "verification.run" &&
    policy.commands !== "verification" &&
    policy.commands !== "workspace"
  ) {
    return failure("AUTHORITY_COMMAND_DENIED", source);
  }
  if (operation.kind === "workspace.shell" && policy.commands !== "workspace") {
    return failure("AUTHORITY_COMMAND_DENIED", source);
  }
  if (
    deniedBy(policy.excludedPaths ?? [], operation.workspaceId, operation.path)
  ) {
    return failure("AUTHORITY_PATH_DENIED", source);
  }

  const matching = policy.workspaces.filter(
    (scope) => scope.workspaceId === operation.workspaceId,
  );
  const permitsPath = matching.some(
    (scope) =>
      scopeContainsPath(scope, operation.path) &&
      ((operation.kind !== "workspace.write" &&
        !(operation.kind === "workspace.shell" && operation.write)) ||
        scope.access === "write"),
  );
  return permitsPath
    ? success(action)
    : failure("AUTHORITY_PATH_DENIED", source);
}

export function authorizeTaskAction(
  participant: ParticipantAuthority,
  action: AuthorityAction,
  now: number,
): AuthorityResult<AuthorityAction> {
  const grant = participant.grant;
  const operation = action.operation;
  const identity = authorizeTaskIdentity(participant, action);
  if (!identity.ok) return identity;
  if (
    (operation.kind === "workspace.write" ||
      (operation.kind === "workspace.shell" && operation.write)) &&
    participant.mutationOwnership !== "task"
  ) {
    return failure("AUTHORITY_MUTATION_OWNERSHIP_DENIED", "role");
  }

  const exclusion =
    operation.kind === "network.use"
      ? null
      : deniedBy(grant.excludedPaths, operation.workspaceId, operation.path);
  if (exclusion) {
    return failure(
      "AUTHORITY_PATH_DENIED",
      RESTRICTION_FAILURE_SOURCE[exclusion.restrictionSource],
    );
  }

  const result = authorizeAgainstPolicy(
    {
      workspaces: publicScopes(grant.workspaces),
      excludedPaths: grant.excludedPaths,
      capabilities: grant.capabilities,
      network: grant.network,
      commands: grant.commands,
      expiresAt: grant.expiresAt,
    },
    action,
    now,
    "task-grant",
  );
  if (
    !result.ok &&
    result.error.code === "AUTHORITY_PATH_DENIED" &&
    operation.kind !== "network.use"
  ) {
    // A path outside the granted scope is denied by that scope, so the
    // denial carries the scope's own provenance: an owner narrowing says
    // so, and a scope whose provenance nobody verified says that instead
    // of passing as an ordinary task grant.
    const scope = grant.workspaces.find(
      (candidate) => candidate.workspaceId === operation.workspaceId,
    );
    if (scope && scope.restrictionSource !== "task-grant") {
      return failure(
        "AUTHORITY_PATH_DENIED",
        RESTRICTION_FAILURE_SOURCE[scope.restrictionSource],
      );
    }
  }
  return result;
}

export function authorizeTaskIdentity(
  participant: ParticipantAuthority,
  identity: TaskAuthorityIdentity,
): AuthorityResult<TaskAuthorityIdentity> {
  const grant = participant.grant;
  if (grant.ownerId !== identity.ownerId) {
    return failure("AUTHORITY_OWNER_MISMATCH", "task-grant");
  }
  if (
    grant.sessionId !== identity.sessionId ||
    grant.taskId !== identity.taskId ||
    grant.taskEpoch !== identity.taskEpoch
  ) {
    return failure("AUTHORITY_TASK_MISMATCH", "task-grant");
  }
  return success(identity);
}

export function authorizeComputerAction(
  participant: ParticipantAuthority,
  approval: ComputerApproval,
  action: AuthorityAction,
  now: number,
): AuthorityResult<AuthorityAction> {
  const taskDecision = authorizeTaskAction(participant, action, now);
  if (!taskDecision.ok) return taskDecision;
  const grant = participant.grant;
  if (approval.ownerId !== grant.ownerId) {
    return failure("AUTHORITY_OWNER_MISMATCH", "computer-policy");
  }
  if (
    approval.computerId !== grant.computerId ||
    approval.generation !== grant.computerGeneration
  ) {
    return failure("AUTHORITY_COMPUTER_MISMATCH", "computer-policy");
  }
  return authorizeAgainstPolicy(
    {
      workspaces: approval.workspaces.map((workspace) => ({
        ...workspace,
        mode: "subtree" as const,
      })),
      excludedPaths: approval.excludedPaths,
      capabilities: approval.capabilities,
      network: approval.network,
      commands: approval.commands,
      expiresAt: approval.expiresAt,
    },
    action,
    now,
    "computer-policy",
  );
}

export function authorizeNativeHostAction(
  participant: ParticipantAuthority,
  host: NativeHostAuthority,
  action: AuthorityAction,
  now: number,
): AuthorityResult<AuthorityAction> {
  const taskDecision = authorizeTaskAction(participant, action, now);
  if (!taskDecision.ok) return taskDecision;
  if (host.ownerId !== action.ownerId) {
    return failure("AUTHORITY_OWNER_MISMATCH", "native-host");
  }
  if (host.taskId !== action.taskId || host.taskEpoch !== action.taskEpoch) {
    return failure("AUTHORITY_TASK_MISMATCH", "native-host");
  }
  return authorizeAgainstPolicy(host, action, now, "native-host");
}
