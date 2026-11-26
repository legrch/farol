import type {
  OperationEntry,
  OperationRejection,
  OperationsSnapshot,
} from "../renderer/operations-contract";

// Pure rules for reading the operations directory back into one snapshot.

export type DiagnosticCounts = {
  unmappedCodes: number;
  rejectedMetadata: number;
  recentRejections: OperationRejection[];
  writeFailures: number;
  droppedEntries: number;
  unrecordedUncertainEntries: number;
};

/** This writer's live counters on top of what other writers left on disk. */
export function mergeDiagnostics(
  snapshot: OperationsSnapshot,
  current: DiagnosticCounts,
): DiagnosticCounts {
  return {
    unmappedCodes: snapshot.unmappedCodes + current.unmappedCodes,
    rejectedMetadata: snapshot.rejectedMetadata + current.rejectedMetadata,
    recentRejections: [
      ...snapshot.recentRejections,
      ...current.recentRejections,
    ].slice(-5),
    writeFailures: snapshot.writeFailures + current.writeFailures,
    droppedEntries: snapshot.droppedEntries + current.droppedEntries,
    unrecordedUncertainEntries:
      snapshot.unrecordedUncertainEntries + current.unrecordedUncertainEntries,
  };
}

/** Fold one persisted diagnostics file into the running totals. */
export function addDiagnostics(
  totals: DiagnosticCounts,
  parsed: DiagnosticCounts,
): void {
  totals.unmappedCodes += parsed.unmappedCodes;
  totals.rejectedMetadata += parsed.rejectedMetadata;
  totals.recentRejections = [
    ...totals.recentRejections,
    ...parsed.recentRejections,
  ].slice(-5);
  totals.writeFailures += parsed.writeFailures;
  totals.droppedEntries += parsed.droppedEntries;
  totals.unrecordedUncertainEntries += parsed.unrecordedUncertainEntries;
}

/** Oldest first, bounded; a start whose observation exists is dropped. */
export function settleEntries(
  entries: readonly OperationEntry[],
  limit: number,
): OperationEntry[] {
  const observed = new Set(
    entries
      .filter((entry) => entry.lifecycle?.phase === "observed")
      .map((entry) => entry.lifecycle!.id),
  );
  return entries
    .filter(
      (entry) =>
        entry.lifecycle?.phase !== "started" ||
        !observed.has(entry.lifecycle.id),
    )
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
}

/** Lifecycles still active are only claimed from a trustworthy read. */
export function trustedActiveLifecycles(
  closed: boolean,
  snapshot: OperationsSnapshot,
  diagnostics: DiagnosticCounts,
  active: Iterable<string>,
): string[] {
  return closed ||
    snapshot.readPending === true ||
    snapshot.corruptLines > 0 ||
    diagnostics.writeFailures > 0 ||
    diagnostics.droppedEntries > 0
    ? []
    : [...active].slice(0, 20000);
}

/** The bytes after a record that a concurrent append may have completed:
 * where the unterminated tail starts, and how much of it is now on disk. */
export function growingTail(
  snapshot: Buffer,
  statSize: number,
  afterSize: number,
  segmentBytes: number,
): { offset: number; fragment: Buffer; size: number } | undefined {
  if (!(
    afterSize > statSize &&
    afterSize <= segmentBytes + 16384 &&
    snapshot.length > 0 &&
    snapshot.at(-1) !== 10
  ))
    return undefined;
  const offset = snapshot.lastIndexOf(10) + 1;
  const fragment = snapshot.subarray(offset);
  const size = afterSize - offset;
  return size > 0 ? { offset, fragment, size } : undefined;
}

/** The completed record text when a re-read extends the fragment to a full line. */
export function completedTail(
  tail: Buffer,
  bytesRead: number,
  size: number,
  fragment: Buffer,
): string | undefined {
  const observed = tail.subarray(0, bytesRead);
  const newline = observed.indexOf(10);
  return bytesRead === size &&
    newline >= 0 &&
    newline >= fragment.length &&
    observed.subarray(0, fragment.length).equals(fragment)
    ? observed.subarray(0, newline).toString("utf8")
    : undefined;
}
