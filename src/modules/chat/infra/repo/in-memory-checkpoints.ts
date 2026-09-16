import type { CheckpointStore } from "../../app/port/checkpoint-store";
import type { CheckpointEnvelope } from "../../domain/checkpoint";
import {
  sameContextBinding,
  type ContextBinding,
} from "../../domain/context-continuity";

function key(binding: ContextBinding, checkpointId: string): string {
  return JSON.stringify([
    binding.ownerId,
    binding.taskId,
    binding.hostThreadId,
    binding.sessionId,
    binding.providerProfileId,
    binding.modelId,
    binding.mode,
    checkpointId,
  ]);
}

export class InMemoryCheckpoints implements CheckpointStore {
  private readonly checkpoints = new Map<string, CheckpointEnvelope>();
  private nextPutFailure: string | null = null;

  failNextPut(code: string): void {
    this.nextPutFailure = code;
  }

  async put(checkpoint: CheckpointEnvelope): Promise<void> {
    if (this.nextPutFailure) {
      const code = this.nextPutFailure;
      this.nextPutFailure = null;
      throw new Error(code);
    }
    const checkpointKey = key(checkpoint.binding, checkpoint.checkpointId);
    const existing = this.checkpoints.get(checkpointKey);
    if (existing && JSON.stringify(existing) !== JSON.stringify(checkpoint)) {
      throw new Error("CHECKPOINT_ID_CONFLICT");
    }
    this.checkpoints.set(checkpointKey, structuredClone(checkpoint));
  }

  async get(
    binding: ContextBinding,
    checkpointId: string,
  ): Promise<CheckpointEnvelope | null> {
    const checkpoint = this.checkpoints.get(key(binding, checkpointId));
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async deleteTask(binding: ContextBinding): Promise<void> {
    for (const [checkpointKey, checkpoint] of this.checkpoints) {
      if (sameContextBinding(checkpoint.binding, binding)) {
        this.checkpoints.delete(checkpointKey);
      }
    }
  }
}
