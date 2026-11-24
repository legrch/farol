import type { BackendLifecycleObservation } from "../bridge/client";
import type { QualificationObservation } from "../bridge/qualification-metrics";
import type { OperationsStore } from "../operations/store";
import type { ConnectorRuntimeLifecycleObservation } from "../../../src/apps/desktop/secure-mcp-connector-runtime";

// The two diagnostic sinks the Go core launches report through. Main builds
// them once and hands the same functions to every launch. Both are closed,
// content-free projections of the original producer's facts: they never look
// up mutable host state, never change admission, recovery or drain results,
// and a closed output cannot replace the original lifetime outcome.

export type CoreReportPorts = Readonly<{
  runtimeEnvironment: string;
  buildIdentity: Readonly<{ buildId: string }>;
  // The live operations projection, read at each report: main may replace it.
  operationsStore: () => Pick<OperationsStore, "record">;
}>;

export type CoreReporters = Readonly<{
  reportQualificationObservation: (
    observation: QualificationObservation,
  ) => void;
  reportOwnedBackendLifecycle: (
    observation:
      BackendLifecycleObservation | ConnectorRuntimeLifecycleObservation,
  ) => void;
}>;

export function createCoreReporters(ports: CoreReportPorts): CoreReporters {
  function reportQualificationObservation(
    observation: QualificationObservation,
  ): void {
    if (ports.runtimeEnvironment !== "dev" && process.env.FAROL_E2E !== "1")
      return;
    try {
      process.stderr.write(
        "FAROL_QUALIFICATION_METRICS:" +
          JSON.stringify({
            schema: 1,
            buildId: ports.buildIdentity.buildId,
            pid: process.pid,
            ...observation,
          }) +
          "\n",
      );
    } catch {
      // Diagnostics never supply a positive qualification or a retry.
    }
  }
  function reportOwnedBackendLifecycle(
    observation:
      BackendLifecycleObservation | ConnectorRuntimeLifecycleObservation,
  ): void {
    try {
      // Child notifications during an admitted connector Stop are diagnostics,
      // not separate actions. The enclosing connection.stop records the final
      // drain result; cleanup-unknown remains independently durable if it fails.
      const connectorStopNotification =
        observation.source !== "go-backend" &&
        observation.phase === "closing" &&
        observation.event !== "cleanup-unknown";
      if (!connectorStopNotification)
        ports.operationsStore().record(
          {
            source: "Setup",
            kind:
              observation.source === "go-backend"
                ? "hub.lifecycle"
                : "connection.lifecycle",
            target: {},
          },
          observation.state === "outcome_unknown" ||
            observation.event === "cleanup-unknown"
            ? "unknown"
            : observation.event === "failure"
              ? "failed"
              : observation.state === "observed" &&
                  observation.phase === "closing" &&
                  observation.event === "child-close" &&
                  observation.exitCode === 0 &&
                  observation.signal === null &&
                  !observation.forced
                ? "done"
                : "unknown",
          observation.code,
          0,
        );
    } catch {
      // Optional operations projection cannot suppress the original diagnostic.
    }
    // Project only the original producer's closed terminal facts. This sink never
    // looks up mutable host state or changes admission, recovery or drain results.
    try {
      console.warn(
        "FAROL_BACKEND_LIFECYCLE:" +
          JSON.stringify({
            at: new Date().toISOString(),
            source: observation.source,
            phase: observation.phase,
            event: observation.event,
            code: observation.code,
            state: observation.state,
            exitCode: observation.exitCode,
            signal: observation.signal,
            forced: observation.forced,
            ...(observation.source === "go-backend"
              ? {
                  hostLifetimeId: observation.hostLifetimeId,
                  childLaunchId: observation.childLaunchId,
                }
              : { runtimeGeneration: observation.runtimeGeneration }),
          }),
      );
    } catch {
      // A closed diagnostic output cannot replace the original lifetime outcome.
    }
  }
  return { reportQualificationObservation, reportOwnedBackendLifecycle };
}
