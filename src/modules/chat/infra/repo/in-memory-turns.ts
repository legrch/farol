import type { TurnRepository } from "../../app/port/turn-repository";
import type { Turn } from "../../domain/turn";

export class InMemoryTurns implements TurnRepository {
  private readonly turns = new Map<string, Turn>();

  async save(turn: Turn): Promise<void> {
    this.turns.set(turn.identity.taskId, structuredClone(turn));
  }

  async get(taskId: string): Promise<Turn | null> {
    const turn = this.turns.get(taskId);
    return turn ? structuredClone(turn) : null;
  }
}
