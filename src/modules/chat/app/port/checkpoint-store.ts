import type { CheckpointEnvelope } from "../../domain/checkpoint";
import type { ContextBinding } from "../../domain/context-continuity";

export interface CheckpointStore {
  put(checkpoint: CheckpointEnvelope): Promise<void>;
  get(
    binding: ContextBinding,
    checkpointId: string,
  ): Promise<CheckpointEnvelope | null>;
  deleteTask(binding: ContextBinding): Promise<void>;
}
