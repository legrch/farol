import type {
  AssignmentRepository,
  StoredAssignment,
} from "../../app/port/assignment-repository";
import {
  matchesChildCorrelation,
  type AssignmentIdentity,
  type ChildCorrelation,
} from "../../domain/assignment";

function key(identity: AssignmentIdentity): string {
  return JSON.stringify([
    identity.assignmentId,
    identity.ownerId,
    identity.sessionId,
    identity.taskId,
    identity.taskEpoch,
    identity.generation,
  ]);
}

export class InMemoryAssignments implements AssignmentRepository {
  private readonly assignments = new Map<string, StoredAssignment>();
  private readonly cancellations = new Set<string>();

  async admit(record: StoredAssignment) {
    const identity = key(record.assignment.identity);
    const existing = this.assignments.get(identity);
    if (existing) {
      return {
        status: "existing" as const,
        record: structuredClone(existing),
      };
    }
    this.assignments.set(identity, structuredClone(record));
    return { status: "admitted" as const, record: structuredClone(record) };
  }

  async load(identity: AssignmentIdentity): Promise<StoredAssignment | null> {
    const record = this.assignments.get(key(identity));
    return record ? structuredClone(record) : null;
  }

  async save(record: StoredAssignment): Promise<void> {
    this.assignments.set(
      key(record.assignment.identity),
      structuredClone(record),
    );
  }

  async claimCancellation(
    identity: AssignmentIdentity,
    correlation: ChildCorrelation,
  ): Promise<boolean> {
    const identityKey = key(identity);
    const stored = this.assignments.get(identityKey);
    if (
      !stored ||
      stored.assignment.phase !== "running" ||
      stored.assignment.terminal ||
      !matchesChildCorrelation(stored.assignment, correlation)
    )
      throw new Error("AGENT_CANCELLATION_BINDING_MISMATCH");
    if (this.cancellations.has(identityKey)) return false;
    this.cancellations.add(identityKey);
    return true;
  }
}
