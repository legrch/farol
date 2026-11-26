import type { CheckpointEnvelope } from "../../domain/checkpoint";

// Retention selection of the private context store: which stored checkpoints
// fall outside the per-task budget. Pure over already-read envelopes.

export type StoredCheckpointFile = Readonly<{
  name: string;
  checkpoint: CheckpointEnvelope;
}>;

// Newest first; ties on creation time break on the larger checkpoint id.
// Protected checkpoints always survive and consume budget, so the unprotected
// ones keep what remains of `maximum` and the oldest of them expire.
export function selectExpiredCheckpoints(
  records: ReadonlyArray<StoredCheckpointFile>,
  protectedCheckpointIds: ReadonlySet<string>,
  maximum: number,
): ReadonlyArray<StoredCheckpointFile> {
  const ordered = [...records].sort((left, right) => {
    const byTime = right.checkpoint.createdAt - left.checkpoint.createdAt;
    return byTime !== 0
      ? byTime
      : right.checkpoint.checkpointId.localeCompare(
          left.checkpoint.checkpointId,
        );
  });
  const protectedCount = ordered.filter((record) =>
    protectedCheckpointIds.has(record.checkpoint.checkpointId),
  ).length;
  const unprotectedCapacity = Math.max(0, maximum - protectedCount);
  return ordered
    .filter(
      (record) => !protectedCheckpointIds.has(record.checkpoint.checkpointId),
    )
    .slice(unprotectedCapacity);
}
