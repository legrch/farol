import type { Clock } from "../../../../pkg/kernel/app/clock";
import type { AuthorityRepository } from "../port/authority-repository";
import type { ComputerApprovalRepository } from "../port/computer-approval-repository";
import type {
  ReadonlyWorkspace,
  ReadonlyWorkspaceErrorCode,
  ReadonlyWorkspaceExecutionContext,
  ReadonlyWorkspaceOperation,
  ReadonlyWorkspaceOutput,
  WorkspaceApprovedRoot,
} from "../port/readonly-workspace";
import {
  approvedWorkspaceBinding,
  authorizeComputerAction,
  authorizeTaskIdentity,
  type AuthorityErrorCode,
  type AuthorityFailureSource,
  type ExactWorkspaceScope,
  type WorkspaceScope,
} from "../../domain/execution-authority";

export type ReadonlyComputerOperation =
  | ReadonlyWorkspaceOperation
  | Readonly<{ kind: "workspace.context"; relativePath: string }>;

// Verification is a composite operation: four 10 s attestation commands,
// two 15 s snapshots and two 10 s Git commands can consume 90 s before cleanup.
// Reserve 30 s for preparation/cleanup, still with one fixed admitted deadline.
export function readonlyComputerExecutionLeaseMs(
  operation: ReadonlyComputerOperation,
): number {
  return operation.kind === "verification.run" ? 120_000 : 15_000;
}

export type WorkspaceContext = Readonly<{
  kind: "workspace.context";
  root: string;
  approvedRoot: WorkspaceApprovedRoot;
  scope: "subtree";
}>;

export type ReadonlyComputerActionRequest = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  participantId: string;
  turnId: string;
  generation: number;
  callId: string;
  workspaceId: string;
  operation: ReadonlyComputerOperation;
}>;

export type ReadonlyComputerActionOutput = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  participantId: string;
  turnId: string;
  generation: number;
  callId: string;
  workspaceId: string;
  relativePath: string;
  operation: ReadonlyComputerOperation;
  output: ReadonlyWorkspaceOutput | WorkspaceContext;
}>;

export type ReadonlyComputerActionErrorCode =
  | AuthorityErrorCode
  | ReadonlyWorkspaceErrorCode
  | "COMPUTER_PARTICIPANT_NOT_FOUND"
  | "COMPUTER_APPROVAL_NOT_FOUND"
  | "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"
  | "COMPUTER_APPROVAL_STORE_UNAVAILABLE"
  | "COMPUTER_PATH_INVALID";

export type ReadonlyComputerActionFailureSource =
  AuthorityFailureSource | "authority-store" | "native-workspace";

export type ReadonlyComputerActionResult =
  | Readonly<{ ok: true; value: ReadonlyComputerActionOutput }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: ReadonlyComputerActionErrorCode;
        source: ReadonlyComputerActionFailureSource;
        retry: "never";
      }>;
    }>;

function failure(
  code: ReadonlyComputerActionErrorCode,
  source: ReadonlyComputerActionFailureSource,
): ReadonlyComputerActionResult {
  return { ok: false, error: { code, source, retry: "never" } };
}

function workspaceScope(
  scopes: readonly WorkspaceScope[],
  workspaceId: string,
): WorkspaceScope | null {
  return scopes.find((scope) => scope.workspaceId === workspaceId) ?? null;
}

function absoluteTarget(root: string, relativePath: string): string | null {
  if (relativePath === ".") return root;
  if (
    relativePath.length === 0 ||
    relativePath.length > 4_096 ||
    relativePath.startsWith("/") ||
    relativePath.endsWith("/") ||
    relativePath.includes("\\") ||
    [...relativePath].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code < 32 || code === 127;
    })
  ) {
    return null;
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }
  return root === "/" ? `/${relativePath}` : `${root}/${relativePath}`;
}

function relativeExcludedPaths(
  root: string,
  workspaceId: string,
  exclusions: readonly Readonly<{ workspaceId: string; path: string }>[],
): readonly string[] {
  const prefix = root === "/" ? "/" : `${root}/`;
  return exclusions.flatMap((exclusion) =>
    exclusion.workspaceId === workspaceId && exclusion.path.startsWith(prefix)
      ? [exclusion.path.slice(prefix.length)]
      : [],
  );
}

function relativeExactFilePaths(scope: ExactWorkspaceScope): readonly string[] {
  const prefix = scope.root === "/" ? "/" : `${scope.root}/`;
  return scope.paths.map((selected) =>
    selected === scope.root ? "." : selected.slice(prefix.length),
  );
}

export class RunReadonlyComputerAction {
  constructor(
    private readonly authorities: AuthorityRepository,
    private readonly approvals: ComputerApprovalRepository,
    private readonly workspace: ReadonlyWorkspace,
    private readonly clock: Clock,
  ) {}

  async execute(
    request: ReadonlyComputerActionRequest,
    context: ReadonlyWorkspaceExecutionContext = {},
  ): Promise<ReadonlyComputerActionResult> {
    let participant;
    try {
      participant = await this.authorities.get(request.participantId);
    } catch {
      return failure("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store");
    }
    if (participant === null) {
      return failure("COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store");
    }

    const identity = authorizeTaskIdentity(participant, request);
    if (!identity.ok) return identity;

    const scope = workspaceScope(
      participant.grant.workspaces,
      request.workspaceId,
    );
    if (scope === null) {
      return failure("AUTHORITY_PATH_DENIED", "task-grant");
    }
    const target = absoluteTarget(scope.root, request.operation.relativePath);
    if (target === null) {
      return failure("COMPUTER_PATH_INVALID", "task-grant");
    }
    let approval;
    try {
      approval = await this.approvals.get(participant.grant.computerId);
    } catch {
      return failure("COMPUTER_APPROVAL_STORE_UNAVAILABLE", "authority-store");
    }
    if (approval === null) {
      return failure("COMPUTER_APPROVAL_NOT_FOUND", "computer-policy");
    }
    const authorized = authorizeComputerAction(
      participant,
      approval,
      {
        ownerId: request.ownerId,
        sessionId: request.sessionId,
        taskId: request.taskId,
        taskEpoch: request.taskEpoch,
        operation: {
          kind:
            request.operation.kind === "workspace.context"
              ? "workspace.list"
              : request.operation.kind,
          workspaceId: request.workspaceId,
          path: target,
        },
      },
      this.clock.now(),
    );
    if (!authorized.ok) return authorized;
    if (
      scope.mode === "exact" &&
      (request.operation.kind === "workspace.list" ||
        request.operation.kind === "workspace.context")
    ) {
      return failure("AUTHORITY_PATH_DENIED", "task-grant");
    }

    const binding = approvedWorkspaceBinding(approval, request.workspaceId);
    if (!binding) return failure("AUTHORITY_PATH_DENIED", "computer-approval");
    let result;
    try {
      const workspaceRequest = {
        workspace: {
          workspaceId: request.workspaceId,
          root: scope.root,
          deniedPaths: relativeExcludedPaths(
            scope.root,
            request.workspaceId,
            participant.grant.excludedPaths,
          ),
          ...(scope.mode === "exact"
            ? { exactFilePaths: relativeExactFilePaths(scope) }
            : {}),
          ...binding,
        },
        operation:
          request.operation.kind === "workspace.context"
            ? {
                kind: "workspace.list" as const,
                relativePath: request.operation.relativePath,
              }
            : request.operation,
      };
      result = context.signal
        ? await this.workspace.execute(workspaceRequest, context)
        : await this.workspace.execute(workspaceRequest);
    } catch {
      return failure("WORKSPACE_HELPER_FAILED", "native-workspace");
    }
    if (!result.ok) {
      return failure(result.error.code, "native-workspace");
    }
    if (context.signal?.aborted)
      return failure("WORKSPACE_REQUEST_CANCELLED", "native-workspace");
    // The helper may have yielded to native work. Do not disclose its output
    // after a revoked grant or approval, even when the read itself succeeded.
    let currentParticipant;
    let currentApproval;
    try {
      currentParticipant = await this.authorities.get(request.participantId);
    } catch {
      return failure("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store");
    }
    if (!currentParticipant)
      return failure("COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store");
    try {
      currentApproval = await this.approvals.get(
        currentParticipant.grant.computerId,
      );
    } catch {
      return failure("COMPUTER_APPROVAL_STORE_UNAVAILABLE", "authority-store");
    }
    if (!currentApproval)
      return failure("COMPUTER_APPROVAL_NOT_FOUND", "computer-policy");
    if (
      currentParticipant.grant.computerId !== participant.grant.computerId ||
      currentParticipant.grant.computerGeneration !==
        participant.grant.computerGeneration ||
      currentParticipant.grant.authorityId !== participant.grant.authorityId
    ) {
      return failure("AUTHORITY_COMPUTER_MISMATCH", "computer-policy");
    }
    const currentDecision = authorizeComputerAction(
      {
        ...currentParticipant,
        grant: {
          ...currentParticipant.grant,
          expiresAt: Math.min(
            participant.grant.expiresAt,
            currentParticipant.grant.expiresAt,
          ),
        },
      },
      currentApproval,
      {
        ...request,
        operation: {
          kind:
            request.operation.kind === "workspace.context"
              ? "workspace.list"
              : request.operation.kind,
          workspaceId: request.workspaceId,
          path: target,
        },
      },
      this.clock.now(),
    );
    if (!currentDecision.ok) return currentDecision;
    const currentScope = workspaceScope(
      currentParticipant.grant.workspaces,
      request.workspaceId,
    );
    const currentBinding = approvedWorkspaceBinding(
      currentApproval,
      request.workspaceId,
    );
    if (
      !currentScope ||
      currentScope.root !== scope.root ||
      currentScope.mode !== scope.mode ||
      !currentBinding ||
      currentBinding.approvedRoot.path !== binding.approvedRoot.path ||
      currentBinding.approvedRoot.device !== binding.approvedRoot.device ||
      currentBinding.approvedRoot.inode !== binding.approvedRoot.inode
    ) {
      return failure("WORKSPACE_ROOT_CHANGED", "native-workspace");
    }
    if (context.signal?.aborted)
      return failure("WORKSPACE_REQUEST_CANCELLED", "native-workspace");
    return {
      ok: true,
      value: {
        ownerId: request.ownerId,
        sessionId: request.sessionId,
        taskId: request.taskId,
        taskEpoch: request.taskEpoch,
        participantId: request.participantId,
        turnId: request.turnId,
        generation: request.generation,
        callId: request.callId,
        workspaceId: request.workspaceId,
        relativePath: request.operation.relativePath,
        operation: { ...request.operation },
        output:
          request.operation.kind === "workspace.context"
            ? {
                kind: "workspace.context",
                root: scope.root,
                approvedRoot: binding.approvedRoot,
                scope: "subtree",
              }
            : result.value,
      },
    };
  }
}
