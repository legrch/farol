import type { ContextRepository } from "../../app/port/context-repository";
import {
  sameContextBinding,
  type ContextBinding,
  type ContextSession,
} from "../../domain/context-continuity";

function key(binding: ContextBinding): string {
  return JSON.stringify([
    binding.ownerId,
    binding.taskId,
    binding.hostThreadId,
    binding.sessionId,
    binding.providerProfileId,
    binding.modelId,
    binding.mode,
  ]);
}

export class InMemoryContextSessions implements ContextRepository {
  private readonly sessions = new Map<string, ContextSession>();

  constructor(initial: readonly ContextSession[] = []) {
    for (const session of initial) this.saveSync(session);
  }

  async load(binding: ContextBinding): Promise<ContextSession | null> {
    const session = this.sessions.get(key(binding));
    if (!session) return null;
    if (!sameContextBinding(session.binding, binding)) {
      throw new Error("CONTEXT_REPOSITORY_BINDING_MISMATCH");
    }
    return structuredClone(session);
  }

  async save(session: ContextSession): Promise<void> {
    this.saveSync(session);
  }

  private saveSync(session: ContextSession): void {
    this.sessions.set(key(session.binding), structuredClone(session));
  }
}
