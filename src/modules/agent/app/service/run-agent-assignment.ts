import {
  failure,
  success,
  type Result,
} from "../../../../pkg/kernel/domain/result";
import type { AgentHost } from "../port/agent-host";
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
  startAssignment,
  type Assignment,
  type AssignmentAuthority,
  type AssignmentErrorCode,
  type AssignmentIdentity,
} from "../../domain/assignment";

export type AgentRunReceipt = StoredAssignment;

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
}>;

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
          (scope.mode === "subtree" || scope.paths.includes(initialPath)),
      ),
  );
}

export class RunAgentAssignment {
  private readonly inFlight = new Map<
    string,
    Promise<Result<AgentRunReceipt, AssignmentErrorCode>>
  >();

  constructor(
    private readonly host: AgentHost,
    private readonly assignments: AssignmentRepository,
    private readonly authority: AgentAuthorityPort,
  ) {}

  execute(
    command: AgentAssignmentCommand,
  ): Promise<Result<AgentRunReceipt, AssignmentErrorCode>> {
    const identity = command.identity;
    const key = JSON.stringify([
      identity.assignmentId,
      identity.ownerId,
      identity.sessionId,
      identity.taskId,
      identity.taskEpoch,
      identity.generation,
    ]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const execution = this.executeAdmitted(command).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, execution);
    return execution;
  }

  private async executeAdmitted(
    command: AgentAssignmentCommand,
  ): Promise<Result<AgentRunReceipt, AssignmentErrorCode>> {
    const delegated = await this.resolveAuthority(command);
    if (!delegated.ok) return delegated;
    const identity = command.identity;
    const authority = delegated.value;
    if (!focusAllowed(command.focus.initialPaths, authority)) {
      return failure("AGENT_FOCUS_DENIED");
    }
    const assignmentAuthority: AssignmentAuthority = {
      authorityId: authority.authorityId,
      participantId: authority.participantId,
      parentParticipantId: authority.parentParticipantId,
      role: authority.role,
      mutationOwnership: authority.mutationOwnership,
    };
    const prepared = createAssignment(identity, assignmentAuthority);
    let admission: Awaited<ReturnType<AssignmentRepository["admit"]>>;
    try {
      admission = await this.assignments.admit({
        assignment: prepared,
        resultRef: null,
      });
    } catch {
      return failure("AGENT_ADMISSION_FAILED");
    }
    if (admission.status === "existing") {
      if (!this.matchesStoredAuthority(admission.record, authority)) {
        return failure("AGENT_AUTHORITY_CORRELATION");
      }
      return success(await this.tombstoneInterrupted(admission.record));
    }

    let spawned: Awaited<ReturnType<AgentHost["spawn"]>>;
    try {
      spawned = await this.host.spawn({
        identity,
        authority,
        focus: { initialPaths: [...command.focus.initialPaths] },
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
    await this.bestEffortSave({ assignment: started.value, resultRef: null });

    let waited: Awaited<ReturnType<AgentHost["wait"]>>;
    try {
      waited = await this.host.wait(spawned.correlation);
    } catch {
      return this.terminal(
        markChildOutcomeUnknown(started.value, spawned.correlation, {
          code: "AGENT_WAIT_TRANSPORT_UNKNOWN",
          source: "native-host-transport",
          retry: "never",
        }),
      );
    }

    if (waited.status === "completed") {
      const completed = completeAssignment(started.value, waited.correlation);
      if (!completed.ok) return failure(completed.error.code);
      const record = {
        assignment: completed.value,
        resultRef: waited.resultRef,
      };
      await this.bestEffortSave(record);
      return success(record);
    }
    if (waited.status === "outcome_unknown") {
      return this.terminal(
        markChildOutcomeUnknown(started.value, waited.correlation, {
          code: waited.code,
          source: "native-host-transport",
          retry: "never",
        }),
      );
    }
    return this.terminal(
      failChildAssignment(started.value, waited.correlation, {
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
    const record = { assignment: result.value, resultRef: null };
    await this.bestEffortSave(record);
    return success(record);
  }

  private async tombstoneInterrupted(
    record: StoredAssignment,
  ): Promise<StoredAssignment> {
    if (record.assignment.terminal) return record;
    const result =
      record.assignment.phase === "prepared" || !record.assignment.childId
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
              childId: record.assignment.childId,
            },
            {
              code: "AGENT_INTERRUPTED_WITHOUT_IN_FLIGHT_OWNER",
              source: "recovery",
              retry: "never",
            },
          );
    if (!result.ok) return record;
    const tombstone = { assignment: result.value, resultRef: null };
    await this.bestEffortSave(tombstone);
    return tombstone;
  }

  private async bestEffortSave(record: StoredAssignment): Promise<void> {
    try {
      await this.assignments.save(record);
    } catch {
      // The in-memory terminal decision still prevents a retry in this run.
    }
  }
}
