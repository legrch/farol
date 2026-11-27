import type { OperationEntry } from "../renderer/operations-contract";

// Pure admission rules for the bounded write queue. The store owns the queue
// itself; these decide what is queued, what may be evicted and whether it fits.

export type QueuedEntry = {
  encoded: Buffer;
  at: number;
  lifecycle: OperationEntry["lifecycle"];
  droppable: boolean;
};

/** Pending and unknown entries are never droppable: they are the only record
 * of an effect whose outcome is not known. */
export function queuedEntry(entry: OperationEntry): QueuedEntry {
  return {
    encoded: Buffer.from(JSON.stringify(entry) + "\n"),
    at: entry.at,
    lifecycle: entry.lifecycle,
    droppable: entry.outcome !== "pending" && entry.outcome !== "unknown",
  };
}

/** Which queued rows to evict, oldest first, for an item to fit, and whether
 * it fits afterwards. A row may go when it is droppable, or when the item is
 * the observation of that very start. */
export function planEviction(
  queue: readonly QueuedEntry[],
  item: QueuedEntry,
  pendingBytes: number,
  queueLimit: number,
  queueByteLimit: number,
): { victims: number[]; fits: boolean } {
  const lifecycle = item.lifecycle;
  const victims: number[] = [];
  let count = queue.length;
  let bytes = pendingBytes;
  for (
    let index = 0;
    index < queue.length &&
    (count >= queueLimit || bytes + item.encoded.length > queueByteLimit);
    index++
  ) {
    const queued = queue[index]!;
    const replacesStart =
      item.droppable &&
      lifecycle?.phase === "observed" &&
      queued.lifecycle?.id === lifecycle.id &&
      queued.lifecycle.phase === "started";
    if (!queued.droppable && !replacesStart) continue;
    victims.push(index);
    count--;
    bytes -= queued.encoded.length;
  }
  return {
    victims,
    fits: !(
      count >= queueLimit || bytes + item.encoded.length > queueByteLimit
    ),
  };
}
