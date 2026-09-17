import type { Clock } from "../../../../pkg/kernel/app/clock";
import type { AuthorityRepository } from "../port/authority-repository";
import type { ComputerApprovalRepository } from "../port/computer-approval-repository";
import type {
  ReadonlyWorkspace,
  ReadonlyWorkspaceErrorCode,
  ReadonlyWorkspaceExecutionContext,
  ReadonlyWorkspaceOperation,
  ReadonlyWorkspaceOutput,
} from "../port/readonly-workspace";
import {
  authorizeComputerAction,
  authorizeTaskIdentity,
  type AuthorityErrorCode,
  type AuthorityFailureSource,
  type ExactWorkspaceScope,
  type WorkspaceScope,
} from "../../domain/execution-authority";

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
  operation: ReadonlyWorkspaceOperation;
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
  operation: ReadonlyWorkspaceOperation;
  output: ReadonlyWorkspaceOutput;
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
          kind: request.operation.kind,
          workspaceId: request.workspaceId,
          path: target,
        },
      },
      this.clock.now(),
    );
    if (!authorized.ok) return authorized;
    if (scope.mode === "exact" && request.operation.kind === "workspace.list") {
      return failure("AUTHORITY_PATH_DENIED", "task-grant");
    }

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
        },
        operation: request.operation,
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
        output: result.value,
      },
    };
  }
}
