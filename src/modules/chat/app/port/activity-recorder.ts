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
    | "client_delivery_failed"
    | "terminal";
  phase: TurnPhase;
  sequence: number | null;
  capability: "inspect_fixture" | null;
}>;

export interface ActivityRecorder {
  record(record: ActivityRecord): Promise<void>;
}
