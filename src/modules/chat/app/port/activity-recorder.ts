import type { TurnPhase } from "../../domain/turn";

export type ActivityRecord = Readonly<{
  taskId: string;
  turnId: string;
  generation: number;
  at: number;
  kind:
    | "phase"
    | "delta_observed"
    | "computer_requested"
    | "computer_completed"
    | "terminal_persistence_failed"
    | "client_delivery_acknowledged"
    | "client_delivery_failed"
    | "terminal";
  phase: TurnPhase;
  sequence: number | null;
  capability:
    | "workspace.read"
    | "workspace.list"
    | "workspace.search"
    | "verification.run"
    | null;
}>;

export interface ActivityRecorder {
  record(record: ActivityRecord): Promise<void>;
}
