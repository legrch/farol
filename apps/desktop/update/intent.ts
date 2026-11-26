import { z } from "zod";
import type {
  AcceptedBuild,
  DownloadIntent,
  DownloadStage,
  Journal,
  Operation,
  RestoreIntent,
  Retained,
  SavedReceipt,
} from "./record";

// The durable records the installed-update runtime writes, as values built from
// what the caller holds. Nothing here reads a file, holds a clock or writes: the
// caller picks the moment, the path and the write order, and every schema,
// field name and key order is the one the strict readers expect.

type Build = z.infer<typeof AcceptedBuild>;
type OperationRecord = z.infer<typeof Operation>;
type RetainedRecord = z.infer<typeof Retained>;
type SavedRecord = z.infer<typeof SavedReceipt>;
type Restore = z.infer<typeof RestoreIntent>;
type JournalRecord = z.infer<typeof Journal>;
type Download = z.infer<typeof DownloadStage>;
type Intent = z.infer<typeof DownloadIntent>;

/** The report the trusted obligations observer prints about this process. */
export const DrainReport = z.strictObject({
  drained: z.boolean(),
  obligationCount: z.number(),
  unreadableCount: z.number(),
  changedCount: z.number(),
});

/** A download stage as first allocated, before any directory exists. */
export function newDownloadStage(
  id: string,
  producer: Download["producer"],
): Download {
  return { phase: "downloading", id, producer };
}

/** The durable intent that binds one allocated stage to the release it fetches. */
export function downloadIntentFor(
  manifest: Readonly<{ buildId: string; archiveSha256: string }>,
  download: Download,
): Intent & { schema: "farol.update-download-intent/1" } {
  return {
    schema: "farol.update-download-intent/1" as const,
    buildId: manifest.buildId,
    archiveSha256: manifest.archiveSha256,
    download,
  };
}

/** The identity of the directory a stage was created in. */
export function stageIdentityOf(
  metadata: Readonly<{ dev: bigint; ino: bigint; birthtimeNs: bigint }>,
): NonNullable<Download["identity"]> {
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    birthtimeNs: String(metadata.birthtimeNs),
  };
}

/** The note kept after an interrupted download's stage was removed. */
export function interruptedDownloadRecord(intent: Intent, observedAt: string) {
  return {
    schema: "farol.interrupted-download/1",
    intent,
    outcome: "producer-ended-stage-removed",
    observedAt,
  };
}

/** The marker that fences a staged package, and its copy when one exists. */
export function cleanupMarkerFor(handle: string, operationRoot?: string) {
  return {
    schema: "farol.update-package-cleanup/1",
    handle,
    ...(operationRoot === undefined ? {} : { operationRoot }),
  };
}

/** True when a name may sit in a pre-dispatch operation directory as debris. */
export function preparedEntryAllowed(
  name: string,
  bindingFile: string,
): boolean {
  return (
    name === "staged.app" || name === bindingFile || name === "helper.log.jsonl"
  );
}

/** A restore intent recorded before the helper is launched. */
export function restoreIntentFor(input: {
  action: Restore["action"];
  operation: OperationRecord;
  priorPhase: JournalRecord["phase"];
  installedBefore: Build;
}): Restore {
  return {
    schema: "farol.update-restore-intent/1",
    action: input.action,
    operation: input.operation,
    priorPhase: input.priorPhase,
    installedBefore: input.installedBefore,
    helper: null,
  };
}

/** The same intent once the spawned helper is known. */
export function restoreIntentWithHelper(
  intent: Restore,
  pid: number,
  processStart: string | null,
): Restore {
  return { ...intent, helper: { pid, processStart } };
}

/** The intent that records a restore launch which never started. */
export function restoreNotStartedRecord(input: {
  action: Restore["action"];
  operation: OperationRecord;
  priorPhase: JournalRecord["phase"];
  notStartedAt: Build;
}) {
  return {
    schema: "farol.update-restore-intent/1",
    action: input.action,
    operation: input.operation,
    priorPhase: input.priorPhase,
    notStartedAt: input.notStartedAt,
  };
}

/** The refusal a restore leaves in its operation directory. */
export function restoreRefusalRecord(input: {
  action: string;
  operation: OperationRecord;
  code: string;
  priorPhase: JournalRecord["phase"];
}) {
  return {
    schema: "farol.update-refusal/1",
    action: input.action,
    operation: input.operation,
    code: input.code,
    priorPhase: input.priorPhase,
  };
}

/** The refusal an apply leaves beside its operation directory. */
export function applyRefusalRecord(operation: OperationRecord, code: string) {
  return {
    schema: "farol.update-refusal/1",
    action: "apply",
    operation,
    code,
  };
}

/** The witness that a restore helper exited without changing the journal. */
export function restoreExitRecord(
  pending: Restore,
  operation: OperationRecord,
) {
  return {
    schema: "farol.update-refusal/1",
    action: pending.action,
    operation,
    helper: pending.helper,
    priorPhase: pending.priorPhase,
    installedBefore: pending.installedBefore,
    code: "helper_exited_without_journal_change",
  };
}

/** The journal a settlement writes: the existing one, or a fresh one for the operation. */
export function settledJournal(
  journal: JournalRecord | null,
  operation: OperationRecord,
  phase: JournalRecord["phase"],
) {
  return {
    ...(journal ?? {
      schema: "farol.installed-update-journal/1",
      ...operation,
    }),
    phase,
  };
}

/** The receipt a settlement publishes for a retained update. */
export function settledReceiptRecord(
  retained: RetainedRecord,
  observedAt: string,
  phase: SavedRecord["phase"],
  runningBuildId: string,
) {
  return { ...retained, observedAt, phase, runningBuildId };
}

/** The retained update a saved receipt describes, without its settlement fields. */
export function retainedFromReceipt(saved: SavedRecord) {
  const {
    observedAt: _observedAt,
    phase: _phase,
    runningBuildId: _runningBuildId,
    ...record
  } = saved;
  return record;
}
