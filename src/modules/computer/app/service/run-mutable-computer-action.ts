import type { Clock } from "../../../../pkg/kernel/app/clock";
import type { AuthorityRepository } from "../port/authority-repository";
import type { ComputerApprovalRepository } from "../port/computer-approval-repository";
import type {
  MutableWorkspace,
  WorkspaceMutationErrorCode,
  WorkspaceMutationOperation,
  WorkspaceMutationReceipt,
} from "../port/mutable-workspace";
import type {
  StoredWorkspaceMutation,
  WorkspaceMutationDigester,
  WorkspaceMutationIdentity,
  WorkspaceMutationRepository,
} from "../port/workspace-mutation-repository";
import {
  authorizeComputerAction,
  authorizeTaskIdentity,
  type AuthorityErrorCode,
  type AuthorityFailureSource,
  type WorkspaceScope,
} from "../../domain/execution-authority";

export type MutableComputerActionRequest = Readonly<{
  operationId: string;
  ownerId: string;
  sessionId: string;
  taskId: string;
  taskEpoch: number;
  participantId: string;
  turnId: string;
  generation: number;
  callId: string;
  workspaceId: string;
  operation: WorkspaceMutationOperation;
}>;

export type MutableComputerActionOutput = Readonly<{
  operationId: string;
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
  operation: "edit" | "write";
  receipt: WorkspaceMutationReceipt;
  resultRetention: "durable" | "memory_only";
  redelivered: boolean;
}>;

export type MutableComputerActionErrorCode =
  | AuthorityErrorCode
  | WorkspaceMutationErrorCode
  | "COMPUTER_PARTICIPANT_NOT_FOUND"
  | "COMPUTER_APPROVAL_NOT_FOUND"
  | "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"
  | "COMPUTER_APPROVAL_STORE_UNAVAILABLE"
  | "COMPUTER_PATH_INVALID"
  | "COMPUTER_MUTATION_OPERATION_CONFLICT"
  | "COMPUTER_MUTATION_STORE_UNAVAILABLE"
  | "COMPUTER_MUTATION_FINGERPRINT_FAILED";

export type MutableComputerActionFailureSource =
  | AuthorityFailureSource
  | "authority-store"
  | "native-workspace"
  | "operation-store";

export type MutableComputerActionResult =
  | Readonly<{ ok: true; value: MutableComputerActionOutput }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: MutableComputerActionErrorCode;
        source: MutableComputerActionFailureSource;
        retry: "never";
      }>;
    }>;

type InFlightMutation = Readonly<{
  workspaceId: string;
  requestDigest: string;
  result: Promise<MutableComputerActionResult>;
}>;

function failure(
  code: MutableComputerActionErrorCode,
  source: MutableComputerActionFailureSource,
): MutableComputerActionResult {
  return { ok: false, error: { code, source, retry: "never" } };
}

function workspaceScope(
  scopes: readonly WorkspaceScope[],
  workspaceId: string,
): WorkspaceScope | null {
  return scopes.find((scope) => scope.workspaceId === workspaceId) ?? null;
}

function absoluteTarget(root: string, relativePath: string): string | null {
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

function mutationIdentity(
  request: MutableComputerActionRequest,
): WorkspaceMutationIdentity {
  return {
    operationId: request.operationId,
    ownerId: request.ownerId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    taskEpoch: request.taskEpoch,
    participantId: request.participantId,
  };
}

function identityKey(identity: WorkspaceMutationIdentity): string {
  return JSON.stringify([
    identity.operationId,
    identity.ownerId,
    identity.sessionId,
    identity.taskId,
    identity.taskEpoch,
    identity.participantId,
  ]);
}

function completedOutput(
  request: MutableComputerActionRequest,
  receipt: WorkspaceMutationReceipt,
  retention: "durable" | "memory_only",
  redelivered: boolean,
): MutableComputerActionResult {
  return {
    ok: true,
    value: {
      operationId: request.operationId,
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
      operation: receipt.operation,
      receipt,
      resultRetention: retention,
      redelivered,
    },
  };
}

function rebindResult(
  result: MutableComputerActionResult,
  request: MutableComputerActionRequest,
): MutableComputerActionResult {
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      ...result.value,
      turnId: request.turnId,
      generation: request.generation,
      callId: request.callId,
      redelivered: true,
    },
  };
}

export class RunMutableComputerAction {
  private readonly inFlight = new Map<string, InFlightMutation>();

  constructor(
    private readonly authorities: AuthorityRepository,
    private readonly approvals: ComputerApprovalRepository,
    private readonly mutations: WorkspaceMutationRepository,
    private readonly digester: WorkspaceMutationDigester,
    private readonly workspace: MutableWorkspace,
    private readonly clock: Clock,
  ) {}

  execute(
    request: MutableComputerActionRequest,
  ): Promise<MutableComputerActionResult> {
    let requestDigest: string;
    try {
      requestDigest = this.digester.digest({
        workspaceId: request.workspaceId,
        operation: request.operation,
      });
    } catch {
      return Promise.resolve(
        failure("COMPUTER_MUTATION_FINGERPRINT_FAILED", "operation-store"),
      );
    }
    const identity = mutationIdentity(request);
    const key = identityKey(identity);
    const existing = this.inFlight.get(key);
    if (existing) {
      if (
        existing.workspaceId !== request.workspaceId ||
        existing.requestDigest !== requestDigest
      ) {
        return Promise.resolve(
          failure("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store"),
        );
      }
      return existing.result.then((result) => rebindResult(result, request));
    }

    const result = this.executeAdmitted(
      request,
      identity,
      requestDigest,
    ).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, {
      workspaceId: request.workspaceId,
      requestDigest,
      result,
    });
    return result;
  }

  private async executeAdmitted(
    request: MutableComputerActionRequest,
    identity: WorkspaceMutationIdentity,
    requestDigest: string,
  ): Promise<MutableComputerActionResult> {
    let existing: StoredWorkspaceMutation | null;
    try {
      existing = await this.mutations.load(identity);
    } catch {
      return failure("COMPUTER_MUTATION_STORE_UNAVAILABLE", "operation-store");
    }
    if (existing) {
      return this.recoverExisting(request, existing, requestDigest);
    }

    let participant;
    try {
      participant = await this.authorities.get(request.participantId);
    } catch {
      return failure("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store");
    }
    if (participant === null) {
      return failure("COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store");
    }
    const identityDecision = authorizeTaskIdentity(participant, request);
    if (!identityDecision.ok) return identityDecision;

    const scope = workspaceScope(
      participant.grant.workspaces,
      request.workspaceId,
    );
    if (scope === null) return failure("AUTHORITY_PATH_DENIED", "task-grant");
    const target = absoluteTarget(scope.root, request.operation.relativePath);
    if (target === null) return failure("COMPUTER_PATH_INVALID", "task-grant");

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
          kind: "workspace.write",
          workspaceId: request.workspaceId,
          path: target,
        },
      },
      this.clock.now(),
    );
    if (!authorized.ok) return authorized;

    const prepared: StoredWorkspaceMutation = {
      identity,
      workspaceId: request.workspaceId,
      requestDigest,
      phase: "prepared",
      outcome: null,
    };
    let admission;
    try {
      admission = await this.mutations.admit(prepared);
    } catch {
      return failure("COMPUTER_MUTATION_STORE_UNAVAILABLE", "operation-store");
    }
    if (admission.status === "existing") {
      return this.recoverExisting(request, admission.record, requestDigest);
    }

    let result: Awaited<ReturnType<MutableWorkspace["mutate"]>>;
    try {
      result = await this.workspace.mutate({
        workspace: {
          workspaceId: request.workspaceId,
          root: scope.root,
          deniedPaths: relativeExcludedPaths(
            scope.root,
            request.workspaceId,
            participant.grant.excludedPaths,
          ),
          writeDeniedPaths: [],
        },
        operation: request.operation,
      });
    } catch {
      result = {
        ok: false,
        error: {
          code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
          retry: "never",
        },
      };
    }

    if (result.ok) {
      const terminal: StoredWorkspaceMutation = {
        ...prepared,
        phase: "completed",
        outcome: { receipt: result.value },
      };
      const persisted = await this.trySave(terminal);
      return completedOutput(
        request,
        result.value,
        persisted ? "durable" : "memory_only",
        false,
      );
    }

    const unknown = result.error.code === "WORKSPACE_MUTATION_OUTCOME_UNKNOWN";
    const terminal: StoredWorkspaceMutation = {
      ...prepared,
      phase: unknown ? "outcome_unknown" : "failed",
      outcome: {
        code: result.error.code,
        source: "native-workspace",
      },
    };
    await this.trySave(terminal);
    return failure(result.error.code, "native-workspace");
  }

  private async recoverExisting(
    request: MutableComputerActionRequest,
    record: StoredWorkspaceMutation,
    requestDigest: string,
  ): Promise<MutableComputerActionResult> {
    if (
      record.workspaceId !== request.workspaceId ||
      record.requestDigest !== requestDigest
    ) {
      return failure("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store");
    }
    if (record.phase === "completed") {
      return completedOutput(request, record.outcome.receipt, "durable", true);
    }
    if (record.phase === "failed" || record.phase === "outcome_unknown") {
      return failure(record.outcome.code, record.outcome.source);
    }

    const tombstone: StoredWorkspaceMutation = {
      ...record,
      phase: "outcome_unknown",
      outcome: {
        code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
        source: "operation-store",
      },
    };
    await this.trySave(tombstone);
    return failure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "operation-store");
  }

  private async trySave(record: StoredWorkspaceMutation): Promise<boolean> {
    try {
      await this.mutations.save(record);
      return true;
    } catch {
      return false;
    }
  }
}
