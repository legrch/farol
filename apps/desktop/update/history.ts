import type { z } from "zod";
import { sameBuild } from "./record";
import type { Operation, SavedReceipt } from "./record";
import { settledBuild } from "./identity";

// The pure judgments behind archiving a superseded receipt. Each takes values or
// file metadata the caller already read; none opens, links or syncs a file.

type OperationRecord = z.infer<typeof Operation>;

/**
 * True when a previous settled receipt may be archived before the next update
 * replaces it: it is the direct predecessor of the next operation's source, or
 * a verified manual replacement sits between the two updates.
 */
export function archivePredecessorAdmitted(input: {
  previous: Pick<z.infer<typeof SavedReceipt>, "phase" | "runningBuildId"> & {
    operation: OperationRecord;
  };
  next: OperationRecord;
  compareVersions(left: string, right: string): number | null;
}): boolean {
  const { previous, next } = input;
  const settled = settledBuild(previous.phase, previous.operation);
  const directPredecessor =
    previous.runningBuildId === next.source.buildId &&
    [previous.operation.source, previous.operation.target].some((value) =>
      sameBuild(value, next.source),
    );
  // A verified manual replacement may sit between two OTA operations. Its
  // source identity is anchored by the adopted baseline and the next OTA's
  // admission; the older terminal receipt remains history, not its source.
  const manualPredecessor =
    settled !== null &&
    previous.runningBuildId === settled.buildId &&
    input.compareVersions(
      next.source.version,
      previous.operation.target.version,
    ) === 1;
  return (
    previous.operation.operationId !== next.operationId &&
    (directPredecessor || manualPredecessor)
  );
}

/** The file metadata the archive checks use. */
export type ArchiveStat = Readonly<{
  isFile(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}>;

/** True when the archive is not a private regular file holding exactly the original bytes. */
export function archiveUntrusted(
  stat: ArchiveStat,
  uid: number | undefined,
  size: number,
): boolean {
  return (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0 ||
    stat.size !== size
  );
}

/** True when the archive's identity or metadata moved between two reads. */
export function archiveMoved(before: ArchiveStat, after: ArchiveStat): boolean {
  return (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    after.mode !== before.mode ||
    after.uid !== before.uid
  );
}
