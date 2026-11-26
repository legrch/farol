import { validate, type ComputerProcessTerminalAudit } from "../bridge/wire";
import {
  AuditDetailsSchema,
  OperationEntrySchema,
  OperationReferenceSchema,
  type OperationEntry,
  type OperationReference,
} from "../renderer/operations-contract";

// Pure rules for appending a terminal observation to an existing operation:
// which facts are admissible, the key that identifies the operation, how a
// prior record compares with a repeat, and the bounded entry that is stored.

export type TerminalAuditDetails = ReturnType<
  typeof AuditDetailsSchema.safeParse
>;
export type TerminalExit =
  { kind: "code"; value: number } | { kind: "signal"; value: number };

const entryLimitBytes = 12 * 1024;

/** The fact is complete, bound to the reference and fully settled. */
export function terminalAdmissible(
  reference: OperationReference,
  fact: ComputerProcessTerminalAudit,
): boolean {
  return !(
    !OperationReferenceSchema.safeParse(reference).success ||
    !validate("ComputerProcessTerminalAudit", fact) ||
    reference.owner !== "computer.process" ||
    reference.operationId !== fact.operationId ||
    reference.buildId !== fact.buildId ||
    reference.runtimeId !== fact.runtimeId ||
    !fact.rootWaited ||
    !fact.outputDrained ||
    fact.groupCleanup === "pending" ||
    fact.descendantCleanup === "pending" ||
    !(fact.exitCode !== undefined
      ? fact.exitCode <= 255 && fact.exitSignal === 0
      : fact.exitSignal >= 1 && fact.exitSignal <= 128)
  );
}

export function parseTerminalAuditDetails(
  fact: ComputerProcessTerminalAudit,
): TerminalAuditDetails | undefined {
  return fact.auditDetails === undefined
    ? undefined
    : AuditDetailsSchema.safeParse(fact.auditDetails);
}

export function terminalKey(fact: ComputerProcessTerminalAudit): string {
  return JSON.stringify([fact.buildId, fact.runtimeId, fact.operationId]);
}

/** Whether a stored entry belongs to the operation the fact describes. */
export function matchesTerminalOperation(
  entry: OperationEntry,
  fact: ComputerProcessTerminalAudit,
): boolean {
  return (
    "schema" in entry &&
    entry.operationRef?.owner === "computer.process" &&
    entry.operationRef.operationId === fact.operationId &&
    entry.operationRef.buildId === fact.buildId &&
    entry.operationRef.runtimeId === fact.runtimeId
  );
}

export function terminalExit(fact: ComputerProcessTerminalAudit): TerminalExit {
  return fact.exitCode !== undefined
    ? { kind: "code", value: fact.exitCode }
    : { kind: "signal", value: fact.exitSignal };
}

export function terminalExecutionFacts(fact: ComputerProcessTerminalAudit) {
  return {
    rootWaited: fact.rootWaited,
    outputDrained: fact.outputDrained,
    groupCleanup: fact.groupCleanup,
    descendantCleanup: fact.descendantCleanup,
    timedOut: fact.timedOut,
    authorityLost: fact.authorityLost,
  };
}

/** A repeat of the same exit and facts is a duplicate; anything else conflicts. */
export function terminalRepeatVerdict(
  prior: { exit?: unknown; executionFacts?: unknown },
  exit: TerminalExit,
  executionFacts: ReturnType<typeof terminalExecutionFacts>,
): "duplicate" | "conflict" {
  return JSON.stringify(prior.exit) === JSON.stringify(exit) &&
    JSON.stringify(prior.executionFacts) === JSON.stringify(executionFacts)
    ? "duplicate"
    : "conflict";
}

const encodedBytes = (entry: OperationEntry): number =>
  Buffer.byteLength(JSON.stringify(entry) + "\n", "utf8");

/** The entry to store, with excerpts withheld when the record is over the
 * cap. Undefined when it cannot fit even then. */
export function buildTerminalEntry(input: {
  id: string;
  at: number;
  reference: OperationReference;
  exit: TerminalExit;
  executionFacts: ReturnType<typeof terminalExecutionFacts>;
  auditDetails: TerminalAuditDetails | undefined;
}): OperationEntry | undefined {
  const { auditDetails } = input;
  let entry = OperationEntrySchema.parse({
    id: input.id,
    at: input.at,
    source: "ChatGPT",
    kind: "computer.process.terminal",
    target: {},
    outcome: "done",
    code: null,
    durationMs: null,
    schema: "farol.operation/2",
    operationRef: { ...input.reference, binding: "accepted" },
    subjectRef: null,
    timing: null,
    exit: input.exit,
    executionFacts: input.executionFacts,
    ...(auditDetails?.success ? { auditDetails: auditDetails.data } : {}),
  });
  // The cap applies to the complete encoded record, not just its details.
  if (encodedBytes(entry) > entryLimitBytes && auditDetails?.success) {
    const withheld = (value: typeof auditDetails.data.command) =>
      value.state === "filtered" || value.state === "filtered-truncated"
        ? { state: "withheld" as const, reason: "entry_limit" as const }
        : value;
    entry = OperationEntrySchema.parse({
      ...entry,
      auditDetails: {
        command: withheld(auditDetails.data.command),
        stdout: withheld(auditDetails.data.stdout),
        stderr: withheld(auditDetails.data.stderr),
      },
    });
  }
  return encodedBytes(entry) > entryLimitBytes ? undefined : entry;
}
