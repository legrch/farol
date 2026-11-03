import type { OperationsRecorder } from "../renderer/operations-contract";

// A watcher owns this projection. It records only changes in passive health;
// it does not alter the original check, retry it, or grant recovery authority.
export function passiveHealthObserver<T extends object>(
  record: OperationsRecorder,
  now: () => number = () => performance.now(),
) {
  let owner: T | null = null;
  let previous: "healthy" | "failed" | "unknown" = "healthy";
  return async (
    current: T,
    check: () => Promise<boolean>,
    stillCurrent: () => boolean,
  ): Promise<boolean> => {
    let start = 0;
    try {
      start = now();
    } catch {
      /* Retain the original check. */
    }
    let state: "healthy" | "failed" | "unknown" = "unknown";
    try {
      const value = await check();
      state = value ? "healthy" : "failed";
      return value;
    } finally {
      let valid = false;
      try {
        valid = stillCurrent();
      } catch {
        /* An invalid observation is not recorded. */
      }
      if (valid && owner !== current) {
        owner = current;
        previous = "healthy";
      }
      if (valid && state !== previous) {
        previous = state;
        try {
          record.record(
            { source: "Setup", kind: "connection.health", target: {} },
            state === "healthy"
              ? "done"
              : state === "failed"
                ? "failed"
                : "unknown",
            state === "failed"
              ? "CONNECTION_HEALTH_FAILED"
              : state === "unknown"
                ? "OPERATION_OUTCOME_UNKNOWN"
                : null,
            Math.max(0, Math.round(now() - start)),
          );
        } catch {
          /* Diagnostics cannot replace the original outcome. */
        }
      }
    }
  };
}
