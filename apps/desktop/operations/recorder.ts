import type {
  OperationEntry,
  OperationMetadata,
  OperationsRecorder,
} from "../renderer/operations-contract";

type Outcome = OperationEntry["outcome"];
type Finish = (
  outcome: Outcome,
  code: string | null,
  durationMs: number,
) => void;
type Labels = readonly { workspaceId: string; label: string }[];

/** Untrusted observer implementation; even a synchronous API may reject. */
export interface RecorderSink {
  begin?(metadata: OperationMetadata): unknown;
  record(...args: Parameters<OperationsRecorder["record"]>): unknown;
  setWorkspaceLabels?(workspaces: Labels): unknown;
}

/** All methods return synchronously and never throw or expose a rejection.
 * A failed begin returns an inert finish handle, without retry or fallback. */
export interface TotalOperationsRecorder extends OperationsRecorder {
  begin(metadata: OperationMetadata): Finish;
  setWorkspaceLabels(workspaces: Labels): void;
  diagnostics(): {
    writeFailures: number;
    droppedEntries: number;
    unrecordedUncertainEntries: number;
  };
}

const inert: Finish = () => {};

/** The single failure boundary for recorder implementations and their handles. */
export function createTotalOperationsRecorder(
  sink: RecorderSink,
  diagnosticsChanged: () => void = () => {},
): TotalOperationsRecorder {
  let writeFailures = 0;
  let droppedEntries = 0;
  let unrecordedUncertainEntries = 0;
  const failed = (outcome?: Outcome) => {
    writeFailures++;
    if (outcome !== undefined) droppedEntries++;
    if (outcome === "pending" || outcome === "unknown")
      unrecordedUncertainEntries++;
    try {
      // Notification is observational too, and must not recurse on failure.
      void Promise.resolve(diagnosticsChanged()).catch(() => {});
    } catch {
      // Counters remain available even when scheduling diagnostics fails.
    }
  };
  const observe = (action: () => unknown, outcome?: Outcome): void => {
    try {
      void Promise.resolve(action()).catch(() => failed(outcome));
    } catch {
      failed(outcome);
    }
  };
  const recorder: TotalOperationsRecorder = {
    begin(metadata) {
      try {
        if (!sink.begin)
          return (outcome, code, durationMs) =>
            recorder.record(metadata, outcome, code, durationMs);
        const finish = sink.begin(metadata);
        if (typeof finish !== "function") {
          // An async begin cannot supply a synchronous handle. Consume any
          // rejection, count this start once, and never resume it later.
          void Promise.resolve(finish).catch(() => {});
          failed("pending");
          return inert;
        }
        return (outcome, code, durationMs) =>
          observe(() => finish(outcome, code, durationMs), outcome);
      } catch {
        failed("pending");
        return inert;
      }
    },
    record(metadata, outcome, code, durationMs) {
      observe(() => sink.record(metadata, outcome, code, durationMs), outcome);
    },
    setWorkspaceLabels(workspaces) {
      observe(() => sink.setWorkspaceLabels?.(workspaces));
    },
    diagnostics: () => ({
      writeFailures,
      droppedEntries,
      unrecordedUncertainEntries,
    }),
  };
  return recorder;
}
