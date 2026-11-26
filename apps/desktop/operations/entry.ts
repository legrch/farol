import {
  nativeRefusalReason,
  type NativeRefusalReason,
} from "../renderer/native-refusal";
import {
  OperationEntrySchema,
  type ExecutionReferences,
  type OperationEntry,
  type OperationMetadata,
} from "../renderer/operations-contract";

// Pure builders for the entries the recorder appends. Identity and time come
// from the caller so the store keeps the order of its clock and id reads.

/** The references an observation carries: a successful shell start becomes
 * accepted, anything else keeps what the start recorded. */
export function observedReferences(
  metadata: OperationMetadata,
  outcome: OperationEntry["outcome"],
  references: ExecutionReferences | undefined,
): ExecutionReferences | undefined {
  return references &&
    outcome === "done" &&
    metadata.kind === "computer_shell_start" &&
    references.operationRef
    ? {
        ...references,
        operationRef: { ...references.operationRef, binding: "accepted" },
      }
    : references;
}

/** Parse one recorded entry; an execution entry is schema 2 with no timing
 * beyond the request and a native reason only for a native refusal. */
export function buildEntry(input: {
  metadata: OperationMetadata;
  id: string;
  at: number;
  outcome: OperationEntry["outcome"];
  code: string | null;
  durationMs: number;
  lifecycle?: NonNullable<OperationEntry["lifecycle"]> | undefined;
  references?: ExecutionReferences | undefined;
  requestedAt?: number | undefined;
  reason?: NativeRefusalReason | undefined;
}): OperationEntry {
  const { code, outcome, references, lifecycle } = input;
  return OperationEntrySchema.parse({
    ...input.metadata,
    ...(lifecycle ? { lifecycle } : {}),
    id: input.id,
    at: input.at,
    outcome,
    code,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    ...(references
      ? {
          schema: "farol.operation/2",
          ...references,
          timing: {
            requestedAt: input.requestedAt,
            startedAt: null,
            endedAt: null,
          },
          exit: null,
          executionFacts: null,
          ...(code === "PROCESS_NATIVE_REFUSED" && outcome === "refused"
            ? { nativeRefusalReason: nativeRefusalReason(code, input.reason) }
            : {}),
        }
      : {}),
  });
}
