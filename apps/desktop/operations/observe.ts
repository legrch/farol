import type {
  OperationMetadata,
  OperationsRecorder,
} from "../renderer/operations-contract";
import {
  mappedOperationOutcome,
  type OperationOutcome,
} from "../renderer/operation-outcomes";
import { recordableOperationCode } from "../renderer/operations-vocabulary";

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** ConnectorProcessBridge validates this diagnostic cohort against Go process
 * Read/completedState. A terminal READ confirms an observation even for nonzero
 * exits or signals; it does not establish command success or durable retention.
 * Do not parse output here or promote a generic terminal state.
 */
function confirmedProcessRead(data: Record<string, unknown>): boolean {
  return (
    data.state === "terminal" &&
    data.rootState === "exited" &&
    data.rootWaited === true &&
    data.groupCleanup === "confirmed" &&
    data.descendantCleanup === "confirmed" &&
    data.outputDrained === true &&
    (data.supervisorState === undefined || data.supervisorState === "exited") &&
    (data.exitCode !== undefined
      ? typeof data.exitCode === "number" &&
        Number.isInteger(data.exitCode) &&
        data.exitCode >= 0 &&
        data.exitCode <= 255 &&
        data.exitSignal === 0
      : typeof data.exitSignal === "number" &&
        Number.isInteger(data.exitSignal) &&
        data.exitSignal >= 1 &&
        data.exitSignal <= 128)
  );
}

/** Reads only closed code/state fields, never messages, bodies or exception text.
 * Unknown evidence dominates every terminal assertion, including `ok: true`.
 * Pending evidence dominates terminal assertions until settlement is confirmed.
 */
export function operationResult(value: unknown): {
  outcome: OperationOutcome;
  code: string | null;
} {
  const v = object(value),
    error = object(v.error),
    evidence = object(v.evidence),
    data = object(v.data),
    attempt = object(v.connectorAttempt),
    setup = object(v.connectorSetup);
  const rawCodes = [
    v.reason,
    error.code,
    v.code,
    typeof v.error === "string" ? v.error : undefined,
    evidence.code,
    data.code,
    object(data.error).code,
    object(data.failure).code,
    object(v.failure).code,
    setup.code,
  ].filter((code) => code !== undefined && code !== null && code !== "");
  const states = [
    v.status,
    v.state,
    v.phase,
    v.outcome,
    v.kind,
    error.kind,
    error.state,
    error.outcome,
    evidence.state,
    evidence.outcome,
    evidence.phase,
    data.status,
    confirmedProcessRead(data) ? "completed" : data.state,
    data.phase,
    data.outcome,
    attempt.outcome,
    setup.state,
  ].filter(
    (state) =>
      state !== undefined && state !== null && typeof state !== "object",
  );
  // HTTP is a transport assertion. It cannot override an unknown result code.
  const httpStatus =
    typeof v.status === "number" &&
    Number.isInteger(v.status) &&
    v.status >= 100 &&
    v.status <= 599
      ? v.status
      : undefined;
  const kinds = states.filter((state) => state !== httpStatus);
  if (
    [...rawCodes, ...kinds].some(
      (code) => mappedOperationOutcome(code) === undefined,
    )
  )
    return { outcome: "unknown", code: "OPERATION_CODE_UNMAPPED" };
  const classifiedCodes = rawCodes.map((code) => ({
    code: recordableOperationCode(code),
    outcome: mappedOperationOutcome(code),
  }));
  const stateOutcomes = kinds.map(mappedOperationOutcome);
  const uncertain = classifiedCodes.find(
    ({ outcome }) => outcome === "unknown",
  );
  if (uncertain || stateOutcomes.includes("unknown"))
    return {
      outcome: "unknown",
      code: uncertain?.code ?? classifiedCodes[0]?.code ?? null,
    };
  const pending = classifiedCodes.find(({ outcome }) => outcome === "pending");
  if (pending || stateOutcomes.includes("pending"))
    return {
      outcome: "pending",
      code: pending?.code ?? classifiedCodes[0]?.code ?? null,
    };
  const code = classifiedCodes[0]?.code ?? null;
  // Preserve explicit known refusal/failure kinds rather than guessing from `ok`.
  const terminal = stateOutcomes.find(
    (outcome) => outcome === "refused" || outcome === "failed",
  );
  if (terminal) return { outcome: terminal, code };
  if (httpStatus !== undefined && httpStatus >= 400)
    return httpStatus >= 500
      ? { outcome: "failed", code: code ?? "HTTP_OPERATION_FAILED" }
      : { outcome: "refused", code: code ?? "HTTP_OPERATION_REJECTED" };
  const codeOutcome = classifiedCodes.find(
    ({ outcome }) => outcome !== "done",
  )?.outcome;
  if (codeOutcome) return { outcome: codeOutcome, code };
  if (v.ok === false || (v.error !== undefined && v.error !== null))
    return { outcome: "unknown", code: code ?? "OPERATION_RESULT_UNCONFIRMED" };
  return { outcome: "done", code };
}
/** Observe settlement without replacing the action's promise or admitting work. */
export function observeOperation<T>(
  recorder: OperationsRecorder,
  metadata: OperationMetadata,
  action: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  let finish: ReturnType<NonNullable<OperationsRecorder["begin"]>> = () => {};
  try {
    finish =
      recorder.begin?.(metadata) ??
      ((outcome, code, durationMs) =>
        recorder.record(metadata, outcome, code, durationMs));
  } catch {
    // Observation failure cannot suppress the action or alter its timing.
  }
  const record = (value: unknown, rejected: boolean, synchronous = false) => {
    try {
      if (synchronous) {
        // Even a thrown proxy/getter is opaque: do not inspect the exception.
        const result = operationResult({ code: "OPERATION_SYNC_THROW" });
        finish(result.outcome, result.code, performance.now() - start);
        return;
      }
      const classified = object(value);
      const result = rejected
        ? Object.keys(classified).some((key) =>
            [
              "state",
              "status",
              "outcome",
              "kind",
              "code",
              "error",
              "reason",
            ].includes(key),
          )
          ? operationResult({ ...classified, ok: false })
          : operationResult({ code: "OPERATION_OUTCOME_UNKNOWN" })
        : metadata.kind === "chatgpt.consult.send" &&
            classified.status === "submitted"
          ? operationResult({ ...classified, status: "completed" })
          : metadata.kind === "connection.health" && value === false
            ? operationResult({ code: "CONNECTION_HEALTH_FAILED" })
            : operationResult(value);
      finish(result.outcome, result.code, performance.now() - start);
    } catch {
      // The observer cannot replace settlement, including the original error.
    }
  };
  let original: Promise<T>;
  try {
    original = action();
  } catch (error) {
    record(error, true, true);
    throw error;
  }
  void original.then(
    (value) => record(value, false),
    (error) => record(error, true),
  );
  return original;
}
