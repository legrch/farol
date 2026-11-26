// Admission lease rules of the private context store: who holds a stored lease
// and which read failures are worth another attempt. Pure decisions; nothing
// here touches the filesystem or the process table.

export type LeaseHolder = "own" | "other_process" | "stale_instance";

// Classify a stored lease against this store's process identity. Only a lease
// from another process id needs a liveness check; the same process with another
// instance id is left behind by a restart and is stale.
export function leaseHolder(
  lease: Readonly<{ processId: number; processInstanceId: string }>,
  processId: number,
  processInstanceId: string,
): LeaseHolder {
  if (
    lease.processId === processId &&
    lease.processInstanceId === processInstanceId
  )
    return "own";
  if (lease.processId !== processId) return "other_process";
  return "stale_instance";
}

// A lease another writer is still creating may read as unsafe or corrupt for a
// moment; only the last attempt gives up.
export function leaseReadRetryable(
  error: unknown,
  attempt: number,
  lastAttempt: number,
): boolean {
  const message = error instanceof Error ? error.message : "";
  return (
    attempt < lastAttempt &&
    (message === "CONTEXT_LEASE_UNSAFE" || message === "CONTEXT_LEASE_CORRUPT")
  );
}
