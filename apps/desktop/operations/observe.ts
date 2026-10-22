import type {
  OperationEntry,
  OperationMetadata,
  OperationsRecorder,
} from "../renderer/operations-contract";

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const code = (v: unknown): string | null =>
  typeof v === "string" && /^[A-Za-z0-9._-]{1,120}$/u.test(v) ? v : null;
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
export async function observeOperation<T>(
  recorder: OperationsRecorder,
  metadata: OperationMetadata,
  action: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  const finish =
    recorder.begin?.(metadata) ??
    ((
      outcome: OperationEntry["outcome"],
      code: string | null,
      durationMs: number,
    ) => recorder.record(metadata, outcome, code, durationMs));
  try {
    const value = await action();
    const result =
      metadata.kind === "chatgpt.consult.send" &&
      object(value).status === "submitted"
        ? { outcome: "done" as const, code: null }
        : operationResult(value);
    finish(result.outcome, result.code, performance.now() - start);
    return value;
  } catch (error) {
    // The action may already have taken effect. Logging never invents a failure.
    const classified = object(error);
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
    const result = known
      ? operationResult({ status: state, code: code(classified.code) })
      : { outcome: "unknown" as const, code: "OPERATION_OUTCOME_UNKNOWN" };
    finish(result.outcome, result.code, performance.now() - start);
    throw error;
  }
}
