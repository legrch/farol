import { z } from "zod";
import {
  nativeRefusalReason,
  type NativeRefusalReason,
} from "../renderer/native-refusal";
import type {
  OperationEntry,
  OperationMetadata,
  OperationRejection,
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
import {
  operationKinds,
  recordableOperationCode,
} from "../renderer/operations-vocabulary";

const maxRecentRejections = 5;
const maxRejectionIssues = 4;
const maxRejectionPath = 8;
const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/u;

/** Non-sensitive facts only: a kind from the closed vocabulary, schema paths
 * (property names from the schema, never data values) and issue codes. */
function describeRejection(
  error: z.ZodError,
  metadata: unknown,
): OperationRejection {
  let kind = "unparsed";
  try {
    const candidate = (metadata as { kind?: unknown } | null)?.kind;
    if (
      typeof candidate === "string" &&
      (operationKinds as readonly string[]).includes(candidate)
    )
      kind = candidate;
  } catch {
    // A hostile getter leaves the kind unparsed.
  }
  return {
    kind,
    issues: error.issues.slice(0, maxRejectionIssues).map((issue) => ({
      path:
        issue.path
          .slice(0, maxRejectionPath)
          .map((part) =>
            typeof part === "number"
              ? "#"
              : typeof part === "string" && identifier.test(part)
                ? part
                : "?",
          )
          .join(".") || "(root)",
      code: String(issue.code).slice(0, 40),
    })),
  };
}

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
  nativeRefusalReason?: NativeRefusalReason,
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
    rejectedMetadata: number;
    recentRejections: OperationRejection[];
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
  let rejectedMetadata = 0;
  const recentRejections: OperationRejection[] = [];
  // A schema rejection is not a disk problem: it is counted on its own, while
  // the entry is still recorded as not persisted.
  const failed = (outcome?: Outcome, error?: unknown, metadata?: unknown) => {
    if (error instanceof z.ZodError) {
      rejectedMetadata++;
      recentRejections.push(describeRejection(error, metadata));
      if (recentRejections.length > maxRecentRejections)
        recentRejections.splice(
          0,
          recentRejections.length - maxRecentRejections,
        );
    } else writeFailures++;
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
    outcome: Outcome | (() => Outcome) | undefined,
    metadata?: unknown,
  ): void => {
    const unavailable = (error?: unknown) =>
      failed(
        typeof outcome === "function" ? outcome() : outcome,
        error,
        metadata,
      );
    try {
      void Promise.resolve(action()).catch(unavailable);
    } catch (error) {
      unavailable(error);
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
        return (outcome, code, durationMs, reason) => {
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
                nativeRefusalReason(classified.code, reason),
              );
            },
            () => recordedOutcome,
            metadata,
          );
        };
      } catch (error) {
        failed("pending", error, metadata);
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
              // Only the original read's classified refusal may enrich its
              // lifecycle; correlation remains the ID fixed at begin time.
              const refreshed = recordableMetadata(metadata, workspaces());
              const diagnostic = refreshed.readDiagnostic;
              if (
                safe.kind === "computer_workspace_read" &&
                safe.requestId &&
                classified.outcome === "refused" &&
                classified.code === "WORKSPACE_PATH_REFUSED" &&
                diagnostic &&
                refreshed.diagnosticBinding
              ) {
                safe.readDiagnostic = diagnostic;
                safe.diagnosticBinding = refreshed.diagnosticBinding;
              }
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
            metadata,
          );
        };
      } catch (error) {
        failed("pending", error, metadata);
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
        metadata,
      );
    },
    setWorkspaceLabels(workspaces) {
      observe(() => {
        labels = OperationWorkspaceLabelsSchema.parse(
          workspaces.map(({ workspaceId, label }) => ({ workspaceId, label })),
        );
        return sink.setWorkspaceLabels?.(labels);
      }, undefined);
    },
    diagnostics: () => ({
      writeFailures,
      droppedEntries,
      unrecordedUncertainEntries,
      unmappedCodes,
      rejectedMetadata,
      recentRejections: recentRejections.map((entry) => ({
        kind: entry.kind,
        issues: entry.issues.map((issue) => ({ ...issue })),
      })),
    }),
  };
  return recorder;
}
