import type { TurnRepository } from "../../app/port/turn-repository";
import type { Turn } from "../../domain/turn";

function identityKey(turn: Turn): string {
  const identity = turn.identity;
  return JSON.stringify([
    identity.ownerId,
    identity.sessionId,
    identity.taskId,
    identity.turnId,
    identity.generation,
  ]);
}

export class InMemoryTurns implements TurnRepository {
  private readonly turns = new Map<string, Turn>();
  private readonly currentByTask = new Map<string, string>();

  async admit(turn: Turn) {
    const key = identityKey(turn);
    const existing = this.turns.get(key);
    if (existing) {
      return { status: "existing" as const, turn: structuredClone(existing) };
    }
    this.turns.set(key, structuredClone(turn));
    this.currentByTask.set(turn.identity.taskId, key);
    return { status: "admitted" as const, turn: structuredClone(turn) };
  }

  async save(turn: Turn): Promise<void> {
    const key = identityKey(turn);
    this.turns.set(key, structuredClone(turn));
    this.currentByTask.set(turn.identity.taskId, key);
  }

  async get(taskId: string): Promise<Turn | null> {
    const key = this.currentByTask.get(taskId);
    const turn = key ? this.turns.get(key) : undefined;
    return turn ? structuredClone(turn) : null;
  }
}
