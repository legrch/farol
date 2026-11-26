import { deniedBy, RESTRICTION_FAILURE_SOURCE } from "./exclusion";
import type {
  AuthorityAction,
  AuthorityCapability,
  AuthorityFailureSource,
  AuthorityResult,
  CommandAuthority,
  ComputerApproval,
  NativeHostAuthority,
  NetworkAuthority,
  ParticipantAuthority,
  TaskAuthorityIdentity,
  WorkspaceExclusion,
  WorkspaceOperation,
  WorkspaceScope,
} from "./model";
import { failure, success } from "./outcome";
import { publicScopes, scopeContainsPath } from "./scope";

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
