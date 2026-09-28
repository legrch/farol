import type { CodexThreadRuntime } from "../port/codex-thread-runtime";

/** Decode only the supported Thread.status union; never pass provider payloads. */
export function readCodexThreadRuntime(
  value: unknown,
): CodexThreadRuntime | null {
  const snapshot = {
    scope: "thread" as const,
    source: "thread/read" as const,
    snapshot: "non-atomic" as const,
  };
  if (value === undefined) return { ...snapshot, state: "unavailable" };
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const status = value as Record<string, unknown>;
  if (status.type === "active") {
    if (
      !Array.isArray(status.activeFlags) ||
      status.activeFlags.length > 2 ||
      new Set(status.activeFlags).size !== status.activeFlags.length ||
      !status.activeFlags.every(
        (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
      )
    )
      return null;
    return {
      ...snapshot,
      state: "active",
      activeFlags: [...status.activeFlags],
    };
  }
  if (
    (status.type === "notLoaded" ||
      status.type === "idle" ||
      status.type === "systemError") &&
    status.activeFlags === undefined
  )
    return { ...snapshot, state: status.type };
  return null;
}
