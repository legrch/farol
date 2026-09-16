import type { CheckpointEnvelope } from "../../domain/checkpoint";

export interface CheckpointStore {
  put(checkpoint: CheckpointEnvelope): Promise<void>;
  get(checkpointId: string): Promise<CheckpointEnvelope | null>;
  deleteTask(taskId: string): Promise<void>;
}
