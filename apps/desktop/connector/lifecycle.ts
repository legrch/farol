import {
  childLifecycleRecord,
  type ConnectorRuntimeLifecycleObservation,
} from "./receipt";

// How one connector child's lifecycle diagnostics reach the host sink. Each
// source and event is reported once per child lifetime and tagged with the
// phase read at that moment. The runtime owns the lifetime and the phase; the
// sink is a port. A diagnostic can never change Start, Stop or group ownership,
// so every failure here, thrown or rejected, is swallowed.

const CLEANUP_UNKNOWN = "connector-anchor:cleanup-unknown";

export type ConnectorLifetime = Readonly<{
  phase: { value: ConnectorRuntimeLifecycleObservation["phase"] };
  runtimeGeneration: string;
  reported: Set<string>;
}>;

export type LifecycleSink = (
  observation: ConnectorRuntimeLifecycleObservation,
) => unknown;

function deliver(
  sink: LifecycleSink,
  observation: ConnectorRuntimeLifecycleObservation,
): void {
  void Promise.resolve(sink(Object.freeze(observation))).catch(() => undefined);
}

// The observer handed to the child. It closes over the original lifetime,
// never over a mutable slot that a replacement child could take.
export function lifecycleObserver(
  lifetime: ConnectorLifetime,
  sink: LifecycleSink,
): (observation: unknown) => void {
  return (observation) => {
    try {
      const record = childLifecycleRecord(observation);
      if (!record) return;
      const key = `${record.source}:${record.event}`;
      if (lifetime.reported.has(key)) return;
      lifetime.reported.add(key);
      deliver(sink, {
        ...record,
        phase: lifetime.phase.value,
        runtimeGeneration: lifetime.runtimeGeneration,
      });
    } catch {
      /* Diagnostics cannot alter Start, stop or group ownership. */
    }
  };
}

// Stop could not confirm that the owned group closed. Reported at most once.
export function reportCleanupUnknown(
  lifetime: ConnectorLifetime,
  sink: LifecycleSink,
  forced: boolean,
): void {
  if (lifetime.reported.has(CLEANUP_UNKNOWN)) return;
  lifetime.reported.add(CLEANUP_UNKNOWN);
  try {
    deliver(sink, {
      source: "connector-anchor",
      phase: "closing",
      event: "cleanup-unknown",
      code: "CONNECTOR_STOP_UNCONFIRMED",
      state: "outcome_unknown",
      exitCode: null,
      signal: null,
      forced,
      runtimeGeneration: lifetime.runtimeGeneration,
    });
  } catch {
    /* Preserve the original Stop failure. */
  }
}
