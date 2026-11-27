import {
  capabilitySetIncludes,
  commandsInclude,
  networkIncludes,
} from "./inclusion";
import {
  exclusionAffectsScope,
  exclusionsAreValid,
  mergeExclusions,
  relevantExclusions,
} from "./exclusion";
import type {
  AuthorityNarrowing,
  AuthorityResult,
  ComputerApproval,
  DelegationAdmission,
  ParticipantAdmission,
  ParticipantAuthority,
  TaskAdmission,
  TaskGrant,
} from "./model";
import { failure, success } from "./outcome";
import { cloneScope, publicScopes, scopesAreSubset } from "./scope";

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
