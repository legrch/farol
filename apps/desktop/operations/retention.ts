// Pure retention and file-naming rules for the operations directory.

export const dayMs = 86400000;
export const segmentName = /^[0-9]{13}-[a-f0-9-]{36}\.jsonl$/u;
export const diagnosticsName = /^[0-9]{13}-[a-f0-9-]{36}\.diagnostics\.json$/u;
const diagnosticsBudgetBytes = 65536;

export type SegmentIndex = {
  first: number | null;
  last: number | null;
  count: number;
};
export type RetainedSegment = {
  name: string;
  file: string;
  size: number;
  index: SegmentIndex;
};
export type RetentionLimits = {
  days: number;
  bytes: number;
  entries: number;
};

/** A file this process may inspect: a regular, singly linked file of its own. */
export function trustedFile(
  stat: { isFile(): boolean; nlink: number; uid: number } | undefined,
  uid: number | undefined,
): boolean {
  return !(!stat?.isFile() || stat.nlink !== 1 || stat.uid !== uid);
}

/** Newest first by last observation, then by name. Filename time orders writes
 * with equal timestamps, never retention age. */
export function orderSegments<T extends RetainedSegment>(segments: T[]): T[] {
  return segments.sort(
    (a, b) =>
      (b.index.last ?? Infinity) - (a.index.last ?? Infinity) ||
      b.name.localeCompare(a.name),
  );
}

/** The segments to delete, in order: older than the window, or past the byte
 * or entry budget counted from the newest. */
export function segmentsToDelete<T extends RetainedSegment>(
  ordered: readonly T[],
  now: number,
  limits: RetentionLimits,
): T[] {
  const cutoff = now - limits.days * dayMs;
  let bytes = 0,
    entries = 0;
  const doomed: T[] = [];
  for (const segment of ordered) {
    bytes += segment.size + Buffer.byteLength(JSON.stringify(segment.index));
    entries += segment.index.count;
    if (
      (segment.index.last !== null && segment.index.last < cutoff) ||
      bytes > limits.bytes ||
      entries > limits.entries
    )
      doomed.push(segment);
  }
  return doomed;
}

/** Whether a diagnostics file goes: past its small shared budget, or older
 * than the window. `bytes` already includes this file. */
export function diagnosticsExpired(
  name: string,
  bytes: number,
  now: number,
  days: number,
): boolean {
  return (
    bytes > diagnosticsBudgetBytes ||
    Number(name.slice(0, 13)) < now - days * dayMs
  );
}
