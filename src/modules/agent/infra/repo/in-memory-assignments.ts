import type {
  AssignmentRepository,
  StoredAssignment,
} from "../../app/port/assignment-repository";
import type { AssignmentIdentity } from "../../domain/assignment";

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
}
