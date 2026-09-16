import type {
  ContextAdmission,
  ContextAdmissionLease,
  ContextAdmissionResult,
  ContextRepository,
} from "../../app/port/context-repository";
import {
  sameCompactionRequest,
  sameContextBinding,
  sameContextSessionIdentity,
  type CompactionRequest,
  type ContextBinding,
  type ContextSession,
} from "../../domain/context-continuity";

function key(binding: ContextBinding): string {
  return JSON.stringify([
    binding.ownerId,
    binding.taskId,
    binding.hostThreadId,
    binding.sessionId,
  ]);
}

function boundaryKey(
  binding: ContextBinding,
  request: CompactionRequest,
): string {
  return JSON.stringify([key(binding), request.source, request.sourceBoundary]);
}

function sameAdmission(
  admission: ContextAdmission,
  binding: ContextBinding,
  sourceEpoch: number,
  request: CompactionRequest,
): ContextAdmissionResult | null {
  if (!sameContextBinding(admission.binding, binding)) {
    return { status: "conflict", reason: "binding" };
  }
  if (admission.sourceEpoch !== sourceEpoch) {
    return { status: "conflict", reason: "epoch" };
  }
  if (!sameCompactionRequest(admission.request, request)) {
    return { status: "conflict", reason: "request" };
  }
  return null;
}

export class InMemoryContextSessions implements ContextRepository {
  private readonly sessions = new Map<string, ContextSession>();
  private readonly epochAdmissions = new Map<string, ContextAdmission>();
  private readonly boundaryAdmissions = new Map<string, ContextAdmission>();
  private readonly leases = new Map<string, string>();
  private nextLease = 1;

  constructor(initial: readonly ContextSession[] = []) {
    for (const session of initial) this.saveSync(session);
  }

  async load(binding: ContextBinding): Promise<ContextSession | null> {
    const session = this.sessions.get(key(binding));
    if (!session) return null;
    if (!sameContextSessionIdentity(session.binding, binding)) {
      throw new Error("CONTEXT_REPOSITORY_IDENTITY_MISMATCH");
    }
    return structuredClone(session);
  }

  async save(session: ContextSession): Promise<void> {
    this.saveSync(session);
  }

  async acquireCompactionAdmission(
    binding: ContextBinding,
    sourceEpoch: number,
    request: CompactionRequest,
  ): Promise<ContextAdmissionResult> {
    const sessionKey = key(binding);
    if (this.leases.has(sessionKey)) return { status: "busy" };
    const token = `memory-lease-${this.nextLease}`;
    this.nextLease += 1;
    this.leases.set(sessionKey, token);

    const boundary = this.boundaryAdmissions.get(boundaryKey(binding, request));
    const boundaryConflict = boundary
      ? sameAdmission(boundary, binding, sourceEpoch, request)
      : null;
    if (boundaryConflict) {
      this.leases.delete(sessionKey);
      return boundaryConflict;
    }

    const epochKey = `${sessionKey}:${sourceEpoch}`;
    const epoch = this.epochAdmissions.get(epochKey);
    const epochConflict = epoch
      ? sameAdmission(epoch, binding, sourceEpoch, request)
      : null;
    if (epochConflict) {
      this.leases.delete(sessionKey);
      return epochConflict;
    }

    const admission: ContextAdmission = {
      binding: { ...binding },
      sourceEpoch,
      request: { ...request },
    };
    if (!epoch) this.epochAdmissions.set(epochKey, admission);
    if (!boundary) {
      this.boundaryAdmissions.set(boundaryKey(binding, request), admission);
    }
    return {
      status: "acquired",
      admission: structuredClone(admission),
      lease: { sessionKey, token },
    };
  }

  async releaseCompactionAdmission(
    lease: ContextAdmissionLease,
  ): Promise<void> {
    if (this.leases.get(lease.sessionKey) !== lease.token) {
      throw new Error("CONTEXT_ADMISSION_LEASE_MISMATCH");
    }
    this.leases.delete(lease.sessionKey);
  }

  private saveSync(session: ContextSession): void {
    const existing = this.sessions.get(key(session.binding));
    if (existing && !sameContextBinding(existing.binding, session.binding)) {
      throw new Error("CONTEXT_REPOSITORY_BINDING_MISMATCH");
    }
    this.sessions.set(key(session.binding), structuredClone(session));
  }
}
