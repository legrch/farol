import type {
  AssignmentRepository,
  StoredAssignment,
} from "../../app/port/assignment-repository";

function key(record: StoredAssignment): string {
  const identity = record.assignment.identity;
  return JSON.stringify([
    identity.assignmentId,
    identity.ownerId,
    identity.generation,
  ]);
}

export class InMemoryAssignments implements AssignmentRepository {
  private readonly assignments = new Map<string, StoredAssignment>();

  async admit(record: StoredAssignment) {
    const identity = key(record);
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

  async save(record: StoredAssignment): Promise<void> {
    this.assignments.set(key(record), structuredClone(record));
  }
}
