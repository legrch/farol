import type {
  StoredWorkspaceMutation,
  WorkspaceMutationAdmission,
  WorkspaceMutationIdentity,
  WorkspaceMutationRepository,
} from "../../app/port/workspace-mutation-repository";

function key(identity: WorkspaceMutationIdentity): string {
  return JSON.stringify([
    identity.operationId,
    identity.ownerId,
    identity.sessionId,
    identity.taskId,
    identity.taskEpoch,
    identity.participantId,
  ]);
}

function sameBinding(
  left: StoredWorkspaceMutation,
  right: StoredWorkspaceMutation,
): boolean {
  return (
    key(left.identity) === key(right.identity) &&
    left.workspaceId === right.workspaceId &&
    left.requestDigest === right.requestDigest
  );
}

export class InMemoryWorkspaceMutationRepository implements WorkspaceMutationRepository {
  private readonly records = new Map<string, StoredWorkspaceMutation>();

  async admit(
    record: StoredWorkspaceMutation,
  ): Promise<WorkspaceMutationAdmission> {
    const recordKey = key(record.identity);
    const existing = this.records.get(recordKey);
    if (existing) {
      return { status: "existing", record: structuredClone(existing) };
    }
    const stored = structuredClone(record);
    this.records.set(recordKey, stored);
    return { status: "admitted", record: structuredClone(stored) };
  }

  async load(
    identity: WorkspaceMutationIdentity,
  ): Promise<StoredWorkspaceMutation | null> {
    const record = this.records.get(key(identity));
    return record ? structuredClone(record) : null;
  }

  async save(record: StoredWorkspaceMutation): Promise<void> {
    const recordKey = key(record.identity);
    const existing = this.records.get(recordKey);
    if (!existing) throw new Error("WORKSPACE_MUTATION_STATE_MISSING");
    if (!sameBinding(existing, record)) {
      throw new Error("WORKSPACE_MUTATION_BINDING_MISMATCH");
    }
    if (existing.phase !== "prepared") {
      if (JSON.stringify(existing) === JSON.stringify(record)) return;
      throw new Error("WORKSPACE_MUTATION_TERMINAL_IMMUTABLE");
    }
    if (record.phase === "prepared") return;
    this.records.set(recordKey, structuredClone(record));
  }
}
