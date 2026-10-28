import type {
  OperationEntry,
  OperationMetadata,
  OperationsRecorder,
} from "../renderer/operations-contract";
import {
  OperationMetadataSchema,
  OperationOutcomeSchema,
  OperationDurationSchema,
  OperationWorkspaceLabelsSchema,
  OperationReferenceSchema,
} from "../renderer/operations-contract";
import {
  resolveOperationTarget,
  type OperationWorkspaceLabels,
} from "./target";
import { mappedOperationOutcome } from "../renderer/operation-outcomes";
import { recordableOperationCode } from "../renderer/operations-vocabulary";

function recordableMetadata(
  metadata: OperationMetadata,
  workspaces: OperationWorkspaceLabels,
) {
  const target = metadata.target;
  return OperationMetadataSchema.parse({
    ...metadata,
    target: resolveOperationTarget(
      {
        ...target,
        ...(target.command === undefined
          ? {}
          : { command: target.command === "git" ? "git" : "other" }),
        ...(target.handle === undefined ? {} : { handle: "unrecognized" }),
      },
      workspaces,
      "identifier",
    ),
  });
}

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
  beginExecution?(
    ...args: Parameters<NonNullable<OperationsRecorder["beginExecution"]>>
  ): unknown;
  record(...args: Parameters<OperationsRecorder["record"]>): unknown;
  setWorkspaceLabels?(workspaces: Labels): unknown;
}

/** All methods return synchronously and never throw or expose a rejection.
 * A failed begin returns an inert finish handle, without retry or fallback. */
export interface TotalOperationsRecorder extends OperationsRecorder {
  beginExecution: NonNullable<OperationsRecorder["beginExecution"]>;
  begin(metadata: OperationMetadata): Finish;
  setWorkspaceLabels(workspaces: Labels): void;
  diagnostics(): {
    unmappedCodes: number;
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
  workspaceLabels?: () => OperationWorkspaceLabels,
): TotalOperationsRecorder {
  let labels: OperationWorkspaceLabels = [];
  const workspaces = () => workspaceLabels?.() ?? labels;
  let unmappedCodes = 0;
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
  const observe = (
    action: () => unknown,
    outcome?: Outcome | (() => Outcome),
  ): void => {
    const unavailable = () =>
      failed(typeof outcome === "function" ? outcome() : outcome);
    try {
      void Promise.resolve(action()).catch(unavailable);
    } catch {
      unavailable();
    }
  };
  const classification = (outcome: Outcome, code: string | null) => {
    OperationOutcomeSchema.parse(outcome);
    const safeCode = recordableOperationCode(code);
    if (
      safeCode === "provider_error" ||
      safeCode === "OPERATION_CODE_UNMAPPED"
    ) {
      unmappedCodes++;
      try {
        void Promise.resolve(diagnosticsChanged()).catch(() => {});
      } catch {
        /* Observational only. */
      }
    }
    const mapped = mappedOperationOutcome(safeCode);
    return {
      outcome: OperationOutcomeSchema.parse(
        mapped === "unknown" || mapped === "pending" ? mapped : outcome,
      ),
      code: safeCode,
    };
  };
  const recorder: TotalOperationsRecorder = {
    beginExecution(metadata, references) {
      try {
        const safe = recordableMetadata(metadata, workspaces());
        const refs = {
          operationRef:
            references.operationRef === null
              ? null
              : OperationReferenceSchema.parse(references.operationRef),
          subjectRef:
            references.subjectRef === null
              ? null
              : OperationReferenceSchema.parse(references.subjectRef),
        };
        if (!sink.beginExecution) return recorder.begin(safe);
        const finish = sink.beginExecution(safe, refs);
        if (typeof finish !== "function") {
          void Promise.resolve(finish).catch(() => {});
          failed("pending");
          return inert;
        }
        return (outcome, code, durationMs) => {
          let recordedOutcome = outcome;
          observe(
            () => {
              const classified = classification(outcome, code);
              recordedOutcome = classified.outcome;
              return finish(
                classified.outcome,
                classified.code,
                OperationDurationSchema.parse(
                  Math.max(0, Math.round(durationMs)),
                ),
              );
            },
            () => recordedOutcome,
          );
        };
      } catch {
        failed("pending");
        return inert;
      }
    },
    begin(metadata) {
      try {
        const safe = recordableMetadata(metadata, workspaces());
        if (!sink.begin)
          return (outcome, code, durationMs) =>
            recorder.record(metadata, outcome, code, durationMs);
        const finish = sink.begin(safe);
        if (typeof finish !== "function") {
          // An async begin cannot supply a synchronous handle. Consume any
          // rejection, count this start once, and never resume it later.
          void Promise.resolve(finish).catch(() => {});
          failed("pending");
          return inert;
        }
        return (outcome, code, durationMs) => {
          let recordedOutcome = outcome;
          observe(
            () => {
              // Configuration receipts may enrich the target before settlement.
              // Revalidate that target without letting source/kind change mid-flight.
              safe.target = recordableMetadata(
                {
                  ...safe,
                  target: metadata.target,
                },
                workspaces(),
              ).target;
              const classified = classification(outcome, code);
              recordedOutcome = classified.outcome;
              return finish(
                classified.outcome,
                classified.code,
                OperationDurationSchema.parse(
                  Math.max(0, Math.round(durationMs)),
                ),
              );
            },
            () => recordedOutcome,
          );
        };
      } catch {
        failed("pending");
        return inert;
      }
    },
    record(metadata, outcome, code, durationMs) {
      let recordedOutcome = outcome;
      observe(
        () => {
          const safe = recordableMetadata(metadata, workspaces());
          const classified = classification(outcome, code);
          recordedOutcome = classified.outcome;
          return sink.record(
            safe,
            classified.outcome,
            classified.code,
            OperationDurationSchema.parse(Math.max(0, Math.round(durationMs))),
          );
        },
        () => recordedOutcome,
      );
    },
    setWorkspaceLabels(workspaces) {
      observe(() => {
        labels = OperationWorkspaceLabelsSchema.parse(
          workspaces.map(({ workspaceId, label }) => ({ workspaceId, label })),
        );
        return sink.setWorkspaceLabels?.(labels);
      });
    },
    diagnostics: () => ({
      writeFailures,
      droppedEntries,
      unrecordedUncertainEntries,
      unmappedCodes,
    }),
  };
  return recorder;
}
