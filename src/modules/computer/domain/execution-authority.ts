export type AuthorityCapability =
  | "workspace.list"
  | "workspace.read"
  | "workspace.search"
  | "verification.run"
  | "workspace.write";

export type WorkspaceAccess = "read" | "write";
export type NetworkAuthority = "none" | "approved";
export type CommandAuthority = "none" | "verification";
export type ParticipantRole = "main" | "agent" | "critic";
export type MutationOwnership = "none" | "task";

export type ApprovedWorkspace = Readonly<{
  workspaceId: string;
  root: string;
  access: WorkspaceAccess;
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

type GrantedWorkspaceScope = WorkspaceScope &
  Readonly<{ restrictionSource: "task-grant" | "owner-restriction" }>;

export type ComputerApproval = Readonly<{
  ownerId: string;
  computerId: string;
  generation: number;
  workspaces: readonly ApprovedWorkspace[];
  capabilities: readonly AuthorityCapability[];
  network: NetworkAuthority;
  commands: CommandAuthority;
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
    | "workspace.write";
  workspaceId: string;
  path: string;
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

export type NativeHostAuthority = Readonly<{
  hostTaskId: string;
  ownerId: string;
  taskId: string;
  taskEpoch: number;
  workspaces: readonly WorkspaceScope[];
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

export type AuthorityFailureSource =
  | "computer-approval"
  | "task-admission"
  | "task-grant"
  | "owner-restriction"
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

function success<Value>(value: Value): AuthorityResult<Value> {
  return { ok: true, value };
}

function failure<Value = never>(
  code: AuthorityErrorCode,
  source: AuthorityFailureSource,
): AuthorityResult<Value> {
  return { ok: false, error: { code, source, retry: "never" } };
}

function isCanonicalAbsolutePath(value: string): boolean {
  if (!value.startsWith("/") || value.includes("\0")) return false;
  if (value === "/") return true;
  if (value.length > 1 && value.endsWith("/")) return false;
  return value.split("/").every((part, index) => {
    if (index === 0) return part === "";
    return part !== "" && part !== "." && part !== "..";
  });
}

function isWithin(root: string, candidate: string): boolean {
  if (!isCanonicalAbsolutePath(root) || !isCanonicalAbsolutePath(candidate)) {
    return false;
  }
  if (root === "/") return true;
  return candidate === root || candidate.startsWith(`${root}/`);
}

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
  return parent === "verification" || requested === "none";
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

export function deriveTaskGrant(
  approval: ComputerApproval,
  admission: TaskAdmission,
  now: number,
): AuthorityResult<TaskGrant> {
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
  if (
    admission.expiresAt > approval.expiresAt ||
    !capabilitySetIncludes(approval.capabilities, admission.capabilities) ||
    !networkIncludes(approval.network, admission.network) ||
    !commandsInclude(approval.commands, admission.commands) ||
    !scopesAreSubset(approval.workspaces, admission.workspaces)
  ) {
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
  if (
    !capabilitySetIncludes(grant.capabilities, narrowing.capabilities) ||
    !networkIncludes(grant.network, narrowing.network) ||
    !commandsInclude(grant.commands, narrowing.commands) ||
    !scopesAreSubset(publicScopes(grant.workspaces), narrowing.workspaces)
  ) {
    return failure("AUTHORITY_INFLATION_DENIED", "owner-restriction");
  }
  return success({
    ...grant,
    workspaces: narrowing.workspaces.map((scope) =>
      cloneScope(scope, "owner-restriction"),
    ),
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
    policy.commands !== "verification"
  ) {
    return failure("AUTHORITY_COMMAND_DENIED", source);
  }

  const matching = policy.workspaces.filter(
    (scope) => scope.workspaceId === operation.workspaceId,
  );
  const permitsPath = matching.some(
    (scope) =>
      scopeContainsPath(scope, operation.path) &&
      (operation.kind !== "workspace.write" || scope.access === "write"),
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
  if (grant.ownerId !== action.ownerId) {
    return failure("AUTHORITY_OWNER_MISMATCH", "task-grant");
  }
  if (
    grant.sessionId !== action.sessionId ||
    grant.taskId !== action.taskId ||
    grant.taskEpoch !== action.taskEpoch
  ) {
    return failure("AUTHORITY_TASK_MISMATCH", "task-grant");
  }
  if (
    operation.kind === "workspace.write" &&
    participant.mutationOwnership !== "task"
  ) {
    return failure("AUTHORITY_MUTATION_OWNERSHIP_DENIED", "role");
  }

  const result = authorizeAgainstPolicy(
    {
      workspaces: publicScopes(grant.workspaces),
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
    operation.kind !== "network.use" &&
    grant.workspaces.some(
      (scope) =>
        scope.workspaceId === operation.workspaceId &&
        scope.restrictionSource === "owner-restriction",
    )
  ) {
    return failure("AUTHORITY_PATH_DENIED", "owner-restriction");
  }
  return result;
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
