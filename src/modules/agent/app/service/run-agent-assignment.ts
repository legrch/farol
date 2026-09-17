import {
  failure,
  success,
  type Result,
} from "../../../../pkg/kernel/domain/result";
import type { AgentHost } from "../port/agent-host";
import type { AgentCommandDigester } from "../port/agent-command-digester";
import type { AgentAssignmentIntent } from "../port/agent-host";
import type {
  AgentAuthorityNarrowing,
  AgentAuthorityPort,
  DelegatedAgentAuthority,
} from "../port/execution-authority";
import type {
  AssignmentRepository,
  StoredAssignment,
} from "../port/assignment-repository";
import {
  completeAssignment,
  createAssignment,
  failChildAssignment,
  failPreparedAssignment,
  markChildOutcomeUnknown,
  markSpawnOutcomeUnknown,
  matchesChildCorrelation,
  startAssignment,
  type Assignment,
  type AssignmentAuthority,
  type AssignmentErrorCode,
  type AssignmentIdentity,
} from "../../domain/assignment";

export type AgentRunReceipt = StoredAssignment &
  Readonly<{
    resultRetention: "not_applicable" | "durable" | "memory_only";
  }>;

export type AgentAssignmentCommand = Readonly<{
  identity: AssignmentIdentity;
  delegation: Readonly<{
    parentParticipantId: string;
    participantId: string;
    role: "agent" | "critic";
    mutationOwnership: "none" | "task";
    narrowing?: AgentAuthorityNarrowing;
  }>;
  focus: Readonly<{ initialPaths: readonly string[] }>;
  intent: AgentAssignmentIntent;
  admission?: "new" | "rejoin";
}>;

export function agentAssignmentCommandFingerprint(
  command: AgentAssignmentCommand,
  digester: AgentCommandDigester,
): string {
  return digester.digest(
    JSON.stringify([
      "farol-agent-command-v1",
      command.identity.assignmentId,
      command.identity.ownerId,
      command.identity.sessionId,
      command.identity.taskId,
      command.identity.taskEpoch,
      command.identity.generation,
      command.delegation.parentParticipantId,
      command.delegation.participantId,
      command.delegation.role,
      command.delegation.mutationOwnership,
      command.delegation.narrowing ?? null,
      command.focus.initialPaths,
      command.intent,
    ]),
  );
}

function validIntent(intent: AgentAssignmentIntent): boolean {
  if (intent.kind === "compatibility") return true;
  return (
    intent.objective.trim().length > 0 &&
    intent.objective.length <= 8_000 &&
    !intent.objective.includes("\0")
  );
}

function canonicalAbsolutePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 4_096 ||
    !value.startsWith("/") ||
    value.includes("\0") ||
    (value.length > 1 && value.endsWith("/"))
  ) {
    return false;
  }
  return value.split("/").every((part, index) => {
    if (index === 0) return part === "";
    return part !== "" && part !== "." && part !== "..";
  });
}

function within(root: string, candidate: string): boolean {
  if (!canonicalAbsolutePath(root) || !canonicalAbsolutePath(candidate)) {
    return false;
  }
  return root === "/" || candidate === root || candidate.startsWith(`${root}/`);
}

function focusAllowed(
  initialPaths: readonly string[],
  authority: DelegatedAgentAuthority,
): boolean {
  if (
    initialPaths.length > 256 ||
    new Set(initialPaths).size !== initialPaths.length
  ) {
    return false;
  }
  return initialPaths.every(
    (initialPath) =>
      canonicalAbsolutePath(initialPath) &&
      authority.workspaces.some(
        (scope) =>
          within(scope.root, initialPath) &&
          (scope.mode === "subtree" || scope.paths.includes(initialPath)) &&
          !authority.excludedPaths.some(
            (exclusion) =>
              exclusion.workspaceId === scope.workspaceId &&
              within(exclusion.path, initialPath),
          ),
      ),
  );
}

type ActiveAssignmentExecution = Readonly<{
  commandFingerprint: string;
  execution: Promise<Result<AgentRunReceipt, AssignmentErrorCode>>;
}>;

// The desktop is a single process, but product composition may create a fresh
// service object for a follower invocation. Keep the execution owner at the
// process boundary so a live prepared record cannot be mistaken for crash
// recovery merely because the follower received a different service object.
const activeAssignmentExecutions = new Map<string, ActiveAssignmentExecution>();

export class RunAgentAssignment {
  constructor(
    private readonly host: AgentHost,
    private readonly assignments: AssignmentRepository,
    private readonly authority: AgentAuthorityPort,
    private readonly commandDigester: AgentCommandDigester,
  ) {}

  async execute(
    command: AgentAssignmentCommand,
  ): Promise<Result<AgentRunReceipt, AssignmentErrorCode>> {
    if (!validIntent(command.intent)) {
      return failure("AGENT_ASSIGNMENT_INVALID");
    }
    const delegated = await this.resolveAuthority(command);
    if (!delegated.ok) return delegated;
    const authority = delegated.value;
    if (!focusAllowed(command.focus.initialPaths, authority)) {
      return failure("AGENT_FOCUS_DENIED");
    }

    const identity = command.identity;
    const key = JSON.stringify([
      identity.assignmentId,
      identity.ownerId,
      identity.sessionId,
      identity.taskId,
      identity.taskEpoch,
      identity.generation,
    ]);
    const commandFingerprint = agentAssignmentCommandFingerprint(
      command,
      this.commandDigester,
    );
    const existing = activeAssignmentExecutions.get(key);
    if (existing) {
      return existing.commandFingerprint === commandFingerprint
        ? existing.execution
        : failure("AGENT_ASSIGNMENT_CONFLICT");
    }
    const execution = this.executeAdmitted(
      command,
      authority,
      commandFingerprint,
    ).finally(() => {
      if (activeAssignmentExecutions.get(key)?.execution === execution) {
        activeAssignmentExecutions.delete(key);
      }
    });
    activeAssignmentExecutions.set(key, { commandFingerprint, execution });
    return execution;
  }

  private async executeAdmitted(
    command: AgentAssignmentCommand,
    authority: DelegatedAgentAuthority,
    commandFingerprint: string,
  ): Promise<Result<AgentRunReceipt, AssignmentErrorCode>> {
    const identity = command.identity;
    const assignmentAuthority: AssignmentAuthority = {
      authorityId: authority.authorityId,
      participantId: authority.participantId,
      parentParticipantId: authority.parentParticipantId,
      role: authority.role,
      mutationOwnership: authority.mutationOwnership,
    };
    const prepared = createAssignment(
      identity,
      assignmentAuthority,
      commandFingerprint,
    );
    let admission: Awaited<ReturnType<AssignmentRepository["admit"]>>;
    try {
      if (command.admission === "rejoin") {
        const existing = await this.assignments.load(identity);
        if (!existing) return failure("AGENT_REJOIN_UNAVAILABLE");
        admission = { status: "existing", record: existing };
      } else {
        admission = await this.assignments.admit(this.record(prepared, null));
      }
    } catch {
      return failure(
        command.admission === "rejoin"
          ? "AGENT_REJOIN_UNAVAILABLE"
          : "AGENT_ADMISSION_FAILED",
      );
    }
    if (admission.status === "existing") {
      if (!this.matchesStoredAuthority(admission.record, authority)) {
        return failure("AGENT_AUTHORITY_CORRELATION");
      }
      const recovered = admission.record.assignment;
      if (recovered.commandFingerprint !== commandFingerprint) {
        return failure("AGENT_ASSIGNMENT_CONFLICT");
      }
      if (
        !recovered.terminal &&
        recovered.phase === "running" &&
        recovered.parentThreadId &&
        recovered.childId &&
        recovered.parentTurnId &&
        recovered.childTurnId &&
        recovered.delegationDigest
      ) {
        const childId = recovered.childId;
        return this.waitForChild(recovered, {
          ...recovered.identity,
          authorityId: recovered.authority.authorityId,
          participantId: recovered.authority.participantId,
          role: recovered.authority.role,
          parentThreadId: recovered.parentThreadId,
          childId,
          parentTurnId: recovered.parentTurnId,
          childTurnId: recovered.childTurnId,
          hostRole: recovered.hostRole,
          delegationDigest: recovered.delegationDigest,
        });
      }
      return success(await this.recoverInterrupted(admission.record));
    }

    let spawned: Awaited<ReturnType<AgentHost["spawn"]>>;
    try {
      spawned = await this.host.spawn({
        identity,
        authority,
        focus: { initialPaths: [...command.focus.initialPaths] },
        intent: command.intent,
      });
    } catch {
      return this.terminal(
        markSpawnOutcomeUnknown(prepared, {
          code: "AGENT_SPAWN_TRANSPORT_UNKNOWN",
          source: "native-host-transport",
          retry: "never",
        }),
      );
    }

    if (spawned.status === "outcome_unknown") {
      return this.terminal(
        markSpawnOutcomeUnknown(prepared, {
          code: spawned.code,
          source: "native-host-transport",
          retry: "never",
        }),
      );
    }
    if (spawned.status === "failed") {
      return this.terminal(
        failPreparedAssignment(prepared, {
          code: spawned.code,
          source: "native-host",
          retry: "never",
        }),
      );
    }

    const started = startAssignment(prepared, spawned.correlation);
    if (!started.ok) return failure(started.error.code);
    await this.trySave(this.record(started.value, null));

    return this.waitForChild(started.value, spawned.correlation);
  }

  private async waitForChild(
    assignment: Assignment,
    correlation: Parameters<AgentHost["wait"]>[0],
  ): Promise<Result<AgentRunReceipt, AssignmentErrorCode>> {
    let waited: Awaited<ReturnType<AgentHost["wait"]>>;
    try {
      waited = await this.host.wait(correlation);
    } catch {
      return this.terminal(
        markChildOutcomeUnknown(assignment, correlation, {
          code: "AGENT_WAIT_TRANSPORT_UNKNOWN",
          source: "native-host-transport",
          retry: "never",
        }),
      );
    }

    if (waited.status === "completed") {
      const completed = completeAssignment(assignment, waited.correlation);
      if (!completed.ok) return failure(completed.error.code);
      const record = {
        assignment: completed.value,
        resultRef: waited.resultRef,
        parentDelivery: "pending" as const,
        workspaceEnforcement: waited.workspaceEnforcement,
      };
      const persisted = await this.trySave(record);
      return success(this.receipt(record, persisted));
    }
    if (waited.status === "running") {
      if (!matchesChildCorrelation(assignment, waited.correlation)) {
        return failure("AGENT_CORRELATION");
      }
      const record = this.record(assignment, null);
      const persisted = await this.trySave(record);
      return success(this.receipt(record, persisted));
    }
    if (waited.status === "outcome_unknown") {
      return this.terminal(
        markChildOutcomeUnknown(assignment, waited.correlation, {
          code: waited.code,
          source: "native-host-transport",
          retry: "never",
        }),
      );
    }
    return this.terminal(
      failChildAssignment(assignment, waited.correlation, {
        code: waited.code,
        source: "native-host",
        retry: "never",
      }),
    );
  }

  private async resolveAuthority(
    command: AgentAssignmentCommand,
  ): Promise<Result<DelegatedAgentAuthority, AssignmentErrorCode>> {
    let decision: Awaited<ReturnType<AgentAuthorityPort["delegate"]>>;
    try {
      const request = {
        identity: command.identity,
        parentParticipantId: command.delegation.parentParticipantId,
        participantId: command.delegation.participantId,
        role: command.delegation.role,
        mutationOwnership: command.delegation.mutationOwnership,
        ...(command.delegation.narrowing
          ? { narrowing: command.delegation.narrowing }
          : {}),
      };
      decision = await this.authority.delegate(request);
    } catch {
      return failure("AGENT_AUTHORITY_UNAVAILABLE");
    }
    if (!decision.ok) return failure(decision.error.code);
    return this.matchesCommandAuthority(command, decision.value)
      ? success(decision.value)
      : failure("AGENT_AUTHORITY_CORRELATION");
  }

  private matchesCommandAuthority(
    command: AgentAssignmentCommand,
    authority: DelegatedAgentAuthority,
  ): boolean {
    const identity = command.identity;
    const delegation = command.delegation;
    return (
      authority.ownerId === identity.ownerId &&
      authority.sessionId === identity.sessionId &&
      authority.taskId === identity.taskId &&
      authority.taskEpoch === identity.taskEpoch &&
      authority.parentParticipantId === delegation.parentParticipantId &&
      authority.participantId === delegation.participantId &&
      authority.role === delegation.role &&
      authority.mutationOwnership === delegation.mutationOwnership
    );
  }

  private matchesStoredAuthority(
    record: StoredAssignment,
    authority: DelegatedAgentAuthority,
  ): boolean {
    const stored = record.assignment.authority;
    return (
      stored.authorityId === authority.authorityId &&
      stored.participantId === authority.participantId &&
      stored.parentParticipantId === authority.parentParticipantId &&
      stored.role === authority.role &&
      stored.mutationOwnership === authority.mutationOwnership
    );
  }

  private async terminal(
    result: Result<Assignment, AssignmentErrorCode>,
  ): Promise<Result<AgentRunReceipt, AssignmentErrorCode>> {
    if (!result.ok) return failure(result.error.code);
    const record = this.record(result.value, null);
    const persisted = await this.trySave(record);
    return success(this.receipt(record, persisted));
  }

  private async recoverInterrupted(
    record: StoredAssignment,
  ): Promise<AgentRunReceipt> {
    if (record.assignment.terminal) return this.receipt(record, true);
    const result =
      record.assignment.phase === "prepared" ||
      !record.assignment.parentThreadId ||
      !record.assignment.childId ||
      !record.assignment.parentTurnId ||
      !record.assignment.childTurnId ||
      !record.assignment.delegationDigest
        ? markSpawnOutcomeUnknown(record.assignment, {
            code: "AGENT_INTERRUPTED_WITHOUT_IN_FLIGHT_OWNER",
            source: "recovery",
            retry: "never",
          })
        : markChildOutcomeUnknown(
            record.assignment,
            {
              ...record.assignment.identity,
              authorityId: record.assignment.authority.authorityId,
              participantId: record.assignment.authority.participantId,
              role: record.assignment.authority.role,
              parentThreadId: record.assignment.parentThreadId,
              childId: record.assignment.childId,
              parentTurnId: record.assignment.parentTurnId,
              childTurnId: record.assignment.childTurnId,
              hostRole: record.assignment.hostRole,
              delegationDigest: record.assignment.delegationDigest,
            },
            {
              code: "AGENT_INTERRUPTED_WITHOUT_IN_FLIGHT_OWNER",
              source: "recovery",
              retry: "never",
            },
          );
    if (!result.ok) return this.receipt(record, true);
    const tombstone = this.record(result.value, null);
    const persisted = await this.trySave(tombstone);
    return this.receipt(tombstone, persisted);
  }

  private record(
    assignment: Assignment,
    resultRef: string | null,
  ): StoredAssignment {
    return {
      assignment,
      resultRef,
      parentDelivery:
        assignment.phase === "completed" ? "pending" : "not_applicable",
      workspaceEnforcement: "not_applicable",
    };
  }

  private receipt(
    record: StoredAssignment,
    persisted: boolean,
  ): AgentRunReceipt {
    return {
      ...record,
      resultRetention:
        record.assignment.phase === "completed"
          ? persisted
            ? "durable"
            : "memory_only"
          : "not_applicable",
    };
  }

  private async trySave(record: StoredAssignment): Promise<boolean> {
    try {
      await this.assignments.save(record);
      return true;
    } catch {
      // The in-memory terminal decision still prevents a retry in this run.
      return false;
    }
  }
}
