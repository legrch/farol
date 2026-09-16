import type { CheckpointStore } from "../../app/port/checkpoint-store";
import type { CheckpointEnvelope } from "../../domain/checkpoint";

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
    const existing = this.checkpoints.get(checkpoint.checkpointId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(checkpoint)) {
      throw new Error("CHECKPOINT_ID_CONFLICT");
    }
    this.checkpoints.set(checkpoint.checkpointId, structuredClone(checkpoint));
  }

  async get(checkpointId: string): Promise<CheckpointEnvelope | null> {
    const checkpoint = this.checkpoints.get(checkpointId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  async deleteTask(taskId: string): Promise<void> {
    for (const [checkpointId, checkpoint] of this.checkpoints) {
      if (checkpoint.binding.taskId === taskId) {
        this.checkpoints.delete(checkpointId);
      }
    }
  }
}
