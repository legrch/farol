import type { Turn } from "../../domain/turn";

export interface TurnRepository {
  save(turn: Turn): Promise<void>;
  get(taskId: string): Promise<Turn | null>;
}
