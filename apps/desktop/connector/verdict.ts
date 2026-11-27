/** The tunnel observation the verdict reads; absent while nothing was seen. */
export type TunnelObservation = Readonly<{
  state: string;
  runtimeGeneration: string;
}> | null;

/**
 * One passive transport sample. A terminal observation of another runtime or
 * an outcome-unknown one is `unknown`, never `unreachable`: only a known exit
 * or a failed health check may lead to recovery.
 */
export function transportVerdict(
  terminal: TunnelObservation,
  runtimeGeneration: string,
  healthy: boolean,
): "healthy" | "unreachable" | "exited" | "unknown" {
  if (terminal && terminal.runtimeGeneration !== runtimeGeneration)
    return "unknown";
  return terminal?.state === "outcome_unknown"
    ? "unknown"
    : terminal?.state === "exited"
      ? "exited"
      : healthy
        ? "healthy"
        : "unreachable";
}
