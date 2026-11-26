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

import {
  capabilitySetIncludes,
  commandsInclude,
  networkIncludes,
} from "./inclusion";
import {
  mergeExclusions,
  deniedBy,
  exclusionAffectsScope,
  exclusionsAreValid,
  relevantExclusions,
  RESTRICTION_FAILURE_SOURCE,
} from "./exclusion";
import type {
  AuthorityAction,
  AuthorityCapability,
  AuthorityFailureSource,
  AuthorityNarrowing,
  AuthorityResult,
  CommandAuthority,
  ComputerApproval,
  DelegationAdmission,
  NativeHostAuthority,
  NetworkAuthority,
  ParticipantAdmission,
  ParticipantAuthority,
  TaskAdmission,
  TaskAuthorityIdentity,
  TaskGrant,
  WorkspaceExclusion,
  WorkspaceGitMetadataApproval,
  WorkspaceOperation,
  WorkspaceScope,
} from "./model";
import { failure, success } from "./outcome";
import {
  cloneScope,
  publicScopes,
  scopeContainsPath,
  scopesAreSubset,
} from "./scope";

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
