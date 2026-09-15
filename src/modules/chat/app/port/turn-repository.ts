import type { Turn } from "../../domain/turn";

export type TurnAdmission =
  | Readonly<{ status: "admitted"; turn: Turn }>
  | Readonly<{ status: "existing"; turn: Turn }>;

export interface TurnRepository {
  admit(turn: Turn): Promise<TurnAdmission>;
  save(turn: Turn): Promise<void>;
  get(taskId: string): Promise<Turn | null>;
}
