import {
  failure,
  success,
  type Result,
} from "../../../../pkg/kernel/domain/result";
import type { AgentHost } from "../port/agent-host";
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
  type AssignmentErrorCode,
  type AssignmentIdentity,
} from "../../domain/assignment";

export type AgentRunReceipt = StoredAssignment;

export class RunAgentAssignment {
  private readonly inFlight = new Map<
    string,
    Promise<Result<AgentRunReceipt, AssignmentErrorCode>>
  >();

  constructor(
    private readonly host: AgentHost,
    private readonly assignments: AssignmentRepository,
  ) {}

  execute(
    identity: AssignmentIdentity,
  ): Promise<Result<AgentRunReceipt, AssignmentErrorCode>> {
    const key = JSON.stringify([
      identity.assignmentId,
      identity.ownerId,
      identity.generation,
    ]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const execution = this.executeAdmitted(identity).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, execution);
    return execution;
  }

  private async executeAdmitted(
    identity: AssignmentIdentity,
  ): Promise<Result<AgentRunReceipt, AssignmentErrorCode>> {
    const prepared = createAssignment(identity);
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
      return success(await this.tombstoneInterrupted(admission.record));
    }

    let spawned: Awaited<ReturnType<AgentHost["spawn"]>>;
    try {
      spawned = await this.host.spawn(identity);
    } catch {
      return this.terminal(markSpawnOutcomeUnknown(prepared));
    }

    if (spawned.status === "outcome_unknown") {
      return this.terminal(markSpawnOutcomeUnknown(prepared));
    }
    if (spawned.status === "failed") {
      return this.terminal(failPreparedAssignment(prepared));
    }

    const started = startAssignment(prepared, spawned.correlation);
    if (!started.ok) return failure(started.error.code);
    await this.bestEffortSave({ assignment: started.value, resultRef: null });

    let waited: Awaited<ReturnType<AgentHost["wait"]>>;
    try {
      waited = await this.host.wait(spawned.correlation);
    } catch {
      return this.terminal(
        markChildOutcomeUnknown(started.value, spawned.correlation),
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
        markChildOutcomeUnknown(started.value, waited.correlation),
      );
    }
    return this.terminal(
      failChildAssignment(started.value, waited.correlation),
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
        ? markSpawnOutcomeUnknown(record.assignment)
        : markChildOutcomeUnknown(record.assignment, {
            ...record.assignment.identity,
            childId: record.assignment.childId,
          });
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
