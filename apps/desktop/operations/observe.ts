import type {
  OperationEntry,
  OperationMetadata,
  OperationsRecorder,
} from "../renderer/operations-contract";
import { recordableOperationCode } from "../renderer/operations-vocabulary";

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const code = recordableOperationCode;
/** Classification reads only closed status/code fields, never error text or bodies. */
export function operationResult(value: unknown): {
  outcome: OperationEntry["outcome"];
  code: string | null;
} {
  const v = object(value),
    error = object(v.error),
    evidence = object(v.evidence),
    data = object(v.data);
  const states = [
    v.status,
    v.state,
    v.phase,
    error.kind,
    error.code,
    v.code,
    v.reason,
    evidence.state,
    evidence.outcome,
    data.status,
    data.phase,
  ];
  const resultCode =
    code(v.reason) ??
    code(error.code) ??
    code(v.code) ??
    code(typeof v.error === "string" ? v.error : null);
  if (
    typeof v.status === "string" &&
    [
      "refused",
      "failed",
      "unknown",
      "pending",
      "unavailable",
      "unsupported",
      "blocked",
      "not-sent",
    ].includes(v.status)
  ) {
    return {
      outcome:
        v.status === "unknown"
          ? "unknown"
          : v.status === "pending"
            ? "pending"
            : v.status === "failed"
              ? "failed"
              : "refused",
      code: resultCode,
    };
  }
  if (typeof v.status === "number" && v.status >= 400)
    return {
      outcome: v.status >= 500 ? "failed" : "refused",
      code: "HTTP_OPERATION_REJECTED",
    };
  if (
    states.some((s) => typeof s === "string" && /unknown|unconfirmed/iu.test(s))
  )
    return { outcome: "unknown", code: resultCode };
  if (
    states.some(
      (s) =>
        s === "pending" ||
        s === "running" ||
        s === "starting" ||
        s === "accepted" ||
        s === "submitted" ||
        s === "applying",
    )
  )
    return { outcome: "pending", code: resultCode };
  if (
    states.includes("failed") ||
    (resultCode && /(?:FAILED|ERROR|TIMED_OUT|TIMEOUT)$/u.test(resultCode))
  )
    return { outcome: "failed", code: resultCode ?? "OPERATION_FAILED" };
  if (
    states.some(
      (s) =>
        s === "refused" ||
        s === "not-sent" ||
        s === "blocked" ||
        s === "unsupported" ||
        s === "unavailable",
    ) ||
    v.ok === false
  )
    return { outcome: "refused", code: resultCode ?? "OPERATION_REFUSED" };
  if (states.includes("failed") || v.error !== undefined)
    return { outcome: "failed", code: resultCode ?? "OPERATION_FAILED" };
  return { outcome: "done", code: resultCode };
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
        finish("failed", "OPERATION_SYNC_THROW", performance.now() - start);
        return;
      }
      const classified = object(value);
      const state = classified.state;
      const known =
        typeof state === "string" &&
        [
          "refused",
          "failed",
          "unknown",
          "pending",
          "unsupported",
          "unavailable",
        ].includes(state);
      const result = rejected
        ? known
          ? operationResult({ status: state, code: code(classified.code) })
          : { outcome: "unknown" as const, code: "OPERATION_OUTCOME_UNKNOWN" }
        : metadata.kind === "chatgpt.consult.send" &&
            classified.status === "submitted"
          ? { outcome: "done" as const, code: null }
          : metadata.kind === "connection.health" && value === false
            ? { outcome: "failed" as const, code: "CONNECTION_HEALTH_FAILED" }
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
