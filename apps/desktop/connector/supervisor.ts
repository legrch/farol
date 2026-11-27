import type { DesktopReservation } from "../host/admission";
import { computerConnectorAdmission } from "../../../src/apps/desktop/summary-fence-recovery";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import { channels } from "../../../src/pkg/ipc/channels";
import { connectorRuntimeUncertain } from "../../../src/pkg/product-settings/connector-uncertainty";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import { ConnectionStatusTracker } from "../connection-status";
import { ConnectorTransportWatch } from "../connector-transport-watch";
import { observeOperation } from "../operations/observe";
import { passiveHealthObserver } from "../operations/passive-health";
import { ownerStopPresentationCurrent } from "../owner-stop-presentation";
import {
  unavailableConnectionStatus,
  type ConnectionStatusView,
} from "../renderer/connection-status";
import {
  bindingMatches,
  transportKey,
  type ConnectionStatusCapture,
  type ConnectorHealthCapture,
  type ConnectorTransportCapture,
  type OwnerStoppedCapture,
} from "./capture";
import type { ConnectorSupervisorPorts } from "./ports";
import { statusBody } from "./projection";
import {
  attemptGeneration,
  closureAcknowledges,
  recoveryFailureCode,
} from "./recovery";
import { transportVerdict } from "./verdict";

export type {
  ConnectionStatusCapture,
  ConnectorHealthCapture,
  ConnectorTransportCapture,
  OwnerStoppedCapture,
} from "./capture";
export type { ConnectorSupervisorPorts } from "./ports";

// Supervision of the one Secure MCP connector: the capture/current predicates
// that correlate an observation with its original owner, the passive status
// projection, and the transport watch with its recovery. The main process
// keeps every owner (settings, Go core, helper, admission flags) and lends
// them through the ports below; nothing here holds authority of its own.

/** A value the supervisor keeps and the main process reads or replaces. */
export type Held<T> = { current: T };

/** Transport capture, its currency predicate and the admitted recovery. */
export function connectorTransport(host: ConnectorSupervisorPorts) {
  const connectorAttemptGeneration = (
    input: Parameters<typeof attemptGeneration>[1],
  ): string => attemptGeneration(host.buildId, input);

  function captureConnectorTransport(): ConnectorTransportCapture | null {
    const owner = host.configuration();
    const connector = host.secureMcpConnectorRuntime();
    const core = host.desktopGoCore();
    const snapshot = owner?.snapshot();
    const binding = core?.currentComputerConnectorBinding();
    if (
      !owner ||
      !connector ||
      !core ||
      !binding ||
      snapshot?.status !== "ready"
    )
      return null;
    const settings = snapshot.settings;
    const selected = settings.connectors.secureMcp;
    const runtime = selected.runtime;
    if (
      host.quitInProgress() ||
      host.installedUpdateAdmission() ||
      host.connectorTaskAdmission() ||
      host.connectorStartInFlight() ||
      host.configurationRequests() ||
      host.authorityTransitions().current() ||
      host.codexAgentOperationActive() ||
      connector.hasUnresolvedEffect() ||
      settings.computer.pendingEdit ||
      settings.setup.computer.outcomeUnknown ||
      connectorRuntimeUncertain(settings) ||
      selected.credential !== "stored" ||
      !runtime ||
      runtime.state === "outcome_unknown" ||
      runtime.buildId !== host.buildId ||
      binding.buildId !== host.buildId ||
      runtime.computerGeneration !== settings.computer.generation ||
      runtime.connectorGeneration !== selected.generation ||
      binding.connectorGeneration !== String(selected.generation) ||
      !computerConnectorAdmission(host.summaryFenceRecovery()).admissible
    )
      return null;
    return Object.freeze({
      key: transportKey(binding, runtime.runtimeGeneration),
      owner,
      connector,
      core,
      binding,
      revision: settings.revision,
      computerGeneration: settings.computer.generation,
      connectorGeneration: selected.generation,
      runtimeGeneration: runtime.runtimeGeneration,
    });
  }

  function connectorTransportCurrent(
    original: ConnectorTransportCapture,
    revision = original.revision,
    stopped = false,
    admitted = false,
  ): boolean {
    const snapshot = original.owner.snapshot();
    if (
      host.configuration() !== original.owner ||
      host.secureMcpConnectorRuntime() !== original.connector ||
      host.desktopGoCore() !== original.core ||
      snapshot.status !== "ready" ||
      host.quitInProgress() ||
      host.installedUpdateAdmission() ||
      host.configurationRequests() ||
      host.codexAgentOperationActive() ||
      original.connector.hasUnresolvedEffect() ||
      snapshot.settings.revision !== revision ||
      snapshot.settings.computer.generation !== original.computerGeneration ||
      snapshot.settings.connectors.secureMcp.generation !==
        original.connectorGeneration ||
      snapshot.settings.computer.pendingEdit ||
      snapshot.settings.setup.computer.outcomeUnknown ||
      connectorRuntimeUncertain(snapshot.settings) ||
      snapshot.settings.connectors.secureMcp.credential !== "stored" ||
      !computerConnectorAdmission(host.summaryFenceRecovery()).admissible ||
      (admitted
        ? !host.connectorTaskAdmission() ||
          host.authorityTransitions().current() !== "connector-start"
        : host.connectorTaskAdmission() ||
          host.connectorStartInFlight() !== null ||
          host.authorityTransitions().current() !== null)
    )
      return false;
    const runtime = snapshot.settings.connectors.secureMcp.runtime;
    return stopped
      ? runtime === null &&
          original.core.currentComputerConnectorBinding() === undefined
      : runtime !== null &&
          runtime.state !== "outcome_unknown" &&
          runtime.runtimeGeneration === original.runtimeGeneration &&
          runtime.buildId === host.buildId &&
          original.core.currentComputerConnectorBinding() === original.binding;
  }

  async function recoverConnectorTransport(
    original: ConnectorTransportCapture,
    observationCurrent: () => boolean,
    afterKnownClosure?: () => Promise<(() => boolean) | null>,
  ): Promise<ProductConfigurationResult> {
    if (!observationCurrent() || !connectorTransportCurrent(original))
      return host.transitionRefusal();
    const transition = host
      .authorityTransitions()
      .tryReserve("connector-start");
    if (!transition) return host.transitionRefusal();
    let admission: DesktopReservation | null = null;
    try {
      admission = host.reserveConnectorTask();
      return await host.observeConnectorStart(async () => {
        let revision = original.revision;
        let stopped = false;
        let continuationCurrent = observationCurrent;
        const current = () =>
          continuationCurrent() &&
          connectorTransportCurrent(original, revision, stopped, true);
        if (!current()) return host.transitionRefusal();
        try {
          if (await host.computerMcpLifecycle().hasUnconfirmedStop())
            return host.configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
          if (!current()) return host.transitionRefusal();
          // All original MCP leases, tunnel group and this exact Go slot must
          // acknowledge closure. A missing/no-op Close is not recovery evidence.
          await host.stopAndConfirmComputerMcp(
            original.connector,
            null,
            original.core,
          );
        } catch {
          return host.configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
        }
        const closure = original.core.computerConnectorClosureReceipt();
        if (!closure || !closureAcknowledges(closure.result, original.binding))
          return host.configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
        // Close cleared the exact slot. Recheck the unchanged Settings owner
        // before its stopped publication, then advance only from that original ACK.
        const snapshot = original.owner.snapshot();
        if (
          host.configuration() !== original.owner ||
          host.secureMcpConnectorRuntime() !== original.connector ||
          host.desktopGoCore() !== original.core ||
          host.quitInProgress() ||
          host.installedUpdateAdmission() ||
          snapshot.status !== "ready" ||
          snapshot.settings.revision !== revision ||
          snapshot.settings.computer.generation !==
            original.computerGeneration ||
          snapshot.settings.connectors.secureMcp.generation !==
            original.connectorGeneration
        )
          return host.transitionRefusal();
        const result = ProductConfigurationResultSchema.parse(
          await original.owner.recordSecureMcpStopped(
            undefined,
            "stop",
            revision,
          ),
        );
        if (!result.ok) return result;
        if (result.snapshot.status !== "ready")
          return host.configurationFailure("SETTINGS_WRITE_FAILED");
        revision = result.snapshot.settings.revision;
        stopped = true;
        if (!connectorTransportCurrent(original, revision, stopped, true))
          return host.transitionRefusal();
        if (closure.result.recovery !== "settled")
          return host.configurationFailure(
            recoveryFailureCode(closure.result.recovery),
          );
        if (!continuationCurrent()) {
          // Only ordinary sleep may pause this SAME original operation here:
          // exact settled Close and stopped publication are known, and successor
          // Open/Prepare/Start have not been dispatched. Permanent invalidation
          // returns null; no phase, ACK, lease or operation deadline is renewed.
          const resumed = await afterKnownClosure?.();
          if (!resumed) return host.transitionRefusal();
          continuationCurrent = resumed;
        }
        if (!current()) return host.transitionRefusal();
        // The existing owner handles executable/credential rechecks, Go admission,
        // new challenge and original result. No Verify or provider prompt is sent.
        return host.startAdmittedSecureMcpConnector(
          false,
          false,
          original.binding,
          continuationCurrent,
        );
      });
    } finally {
      admission?.release();
      transition.release();
    }
  }

  return {
    connectorAttemptGeneration,
    captureConnectorTransport,
    connectorTransportCurrent,
    recoverConnectorTransport,
  };
}
export type ConnectorTransport = ReturnType<typeof connectorTransport>;

/** Health and owner-stop captures with their currency predicates. */
export function connectorHealth(host: ConnectorSupervisorPorts) {
  const completedOwnerStop: Held<OwnerStoppedCapture | null> = {
    current: null,
  };

  // Passive diagnostics do not reserve the effect-admission lane or block UI.
  function captureConnectorHealth(): ConnectorHealthCapture | null {
    const owner = host.configuration(),
      connector = host.secureMcpConnectorRuntime(),
      core = host.desktopGoCore();
    const state = owner?.snapshot(),
      binding = core?.currentComputerConnectorBinding();
    if (
      !owner ||
      !connector ||
      !core?.backendAvailable ||
      !binding ||
      state?.status !== "ready" ||
      host.quitInProgress() ||
      host.installedUpdateAdmission()
    )
      return null;
    const selected = state.settings.connectors.secureMcp,
      runtime = selected.runtime;
    if (
      !runtime ||
      runtime.state === "outcome_unknown" ||
      !connector.isRunning() ||
      connector.getTunnelObservation() !== null ||
      connector.hasUnresolvedEffect() ||
      runtime.buildId !== host.buildId ||
      binding.buildId !== host.buildId ||
      runtime.computerGeneration !== state.settings.computer.generation ||
      runtime.connectorGeneration !== selected.generation ||
      binding.connectorGeneration !== String(selected.generation)
    )
      return null;
    return {
      owner,
      connector,
      core,
      binding,
      runtimeGeneration: runtime.runtimeGeneration,
      computerGeneration: runtime.computerGeneration,
      connectorGeneration: runtime.connectorGeneration,
    };
  }

  function connectorHealthCurrent(original: ConnectorHealthCapture): boolean {
    const current = captureConnectorHealth();
    return (
      current !== null &&
      current.owner === original.owner &&
      current.connector === original.connector &&
      current.core === original.core &&
      current.runtimeGeneration === original.runtimeGeneration &&
      current.computerGeneration === original.computerGeneration &&
      current.connectorGeneration === original.connectorGeneration &&
      bindingMatches(original.binding, current.binding)
    );
  }

  // Stop correlation does not require a positive health sample or a running
  // helper: an already exited helper can still have an admitted Go owner to close.
  function captureConnectorStop(): Pick<
    ConnectorHealthCapture,
    | "owner"
    | "connector"
    | "core"
    | "binding"
    | "computerGeneration"
    | "connectorGeneration"
  > | null {
    const owner = host.configuration(),
      connector = host.secureMcpConnectorRuntime(),
      core = host.desktopGoCore();
    const state = owner?.snapshot(),
      binding = core?.currentComputerConnectorBinding();
    if (
      !owner ||
      !connector ||
      !core?.backendAvailable ||
      !binding ||
      state?.status !== "ready" ||
      host.quitInProgress() ||
      host.installedUpdateAdmission() ||
      connectorRuntimeUncertain(state.settings) ||
      state.settings.computer.pendingEdit !== null ||
      state.settings.setup.computer.outcomeUnknown ||
      host.workspaceMutationAdmission() ||
      connector.hasUnresolvedEffect()
    )
      return null;
    const selected = state.settings.connectors.secureMcp,
      runtime = selected.runtime;
    if (
      binding.buildId !== host.buildId ||
      binding.connectorGeneration !== String(selected.generation) ||
      (runtime &&
        (runtime.state === "outcome_unknown" ||
          runtime.buildId !== host.buildId ||
          runtime.computerGeneration !== state.settings.computer.generation ||
          runtime.connectorGeneration !== selected.generation))
    )
      return null;
    return {
      owner,
      connector,
      core,
      binding,
      computerGeneration: state.settings.computer.generation,
      connectorGeneration: selected.generation,
    };
  }

  function ownerStoppedCurrent(original: OwnerStoppedCapture): boolean {
    const owner = host.configuration(),
      connector = host.secureMcpConnectorRuntime(),
      core = host.desktopGoCore();
    const state = owner?.snapshot();
    if (
      !owner ||
      !connector ||
      !core ||
      state?.status !== "ready" ||
      completedOwnerStop.current !== original
    )
      return false;
    return ownerStopPresentationCurrent(original, {
      owner,
      connector,
      core,
      receipt: core.computerConnectorOwnerStoppedReceipt(),
      computerGeneration: state.settings.computer.generation,
      connectorGeneration: state.settings.connectors.secureMcp.generation,
      backendAvailable: core.backendAvailable,
      stoppedSettings: state.settings.connectors.secureMcp.runtime === null,
      setupOutcomeUnknown: connectorRuntimeUncertain(state.settings),
      settingsEditPending: state.settings.computer.pendingEdit !== null,
      settingsOutcomeUnknown: state.settings.setup.computer.outcomeUnknown,
      workspaceMutationInProgress: host.workspaceMutationAdmission(),
      helperRunning: connector.isRunning(),
      helperOutcomeUnknown: connector.hasUnresolvedEffect(),
      tunnelObserved: connector.getTunnelObservation() !== null,
      currentBinding: core.currentComputerConnectorBinding() !== undefined,
      admissionInProgress: host.connectorTaskAdmission(),
      quitting: host.quitInProgress(),
      updating: host.installedUpdateAdmission(),
    });
  }

  function observedConnectorHealth(
    connector: SecureMcpConnectorRuntime,
  ): Promise<boolean> {
    return observeOperation(
      host.operationsStore(),
      { source: "Setup", kind: "connection.health", target: {} },
      () => connector.checkHealth(),
    );
  }

  return {
    completedOwnerStop,
    captureConnectorHealth,
    connectorHealthCurrent,
    captureConnectorStop,
    ownerStoppedCurrent,
    observedConnectorHealth,
  };
}
export type ConnectorHealth = ReturnType<typeof connectorHealth>;

/** The passive connection status: its capture, tracker and projection. */
export function connectorStatus(
  host: ConnectorSupervisorPorts,
  health: Pick<
    ConnectorHealth,
    | "completedOwnerStop"
    | "captureConnectorHealth"
    | "connectorHealthCurrent"
    | "ownerStoppedCurrent"
  >,
) {
  const {
    completedOwnerStop,
    captureConnectorHealth,
    connectorHealthCurrent,
    ownerStoppedCurrent,
  } = health;
  let connectionStatusRevision = 0;
  let connectionStatusBody = "";
  let retainedConnectionView: ConnectionStatusView =
    unavailableConnectionStatus;

  function connectionAdmissionInProgress(): boolean {
    return (
      host.connectorTaskAdmission() &&
      host.connectorTaskAdmissionPurpose() !== "manual-diagnostic"
    );
  }

  const connectorConnection =
    new ConnectionStatusTracker<ConnectionStatusCapture>({
      capture: captureConnectionStatus,
      current: connectionStatusCurrent,
      observe: async (capture) => {
        if (capture.kind === "owner-stopped") {
          const original = capture.original;
          const result =
            await original.core.observeComputerConnectorOwnerStoppedHealth(
              original.receipt,
            );
          return connectionStatusCurrent(capture) ? result : null;
        }
        const original = capture.original;
        const health = await original.connector.observeHealth();
        if (
          !health ||
          health.runtimeGeneration !== original.runtimeGeneration ||
          !connectorHealthCurrent(original)
        )
          return null;
        const result = await original.core.observeComputerConnectorHealth(
          health.expectedInstanceId,
          health.snapshot,
        );
        return connectorHealthCurrent(original) ? result : null;
      },
      now: Date.now,
      monotonic: () => performance.now(),
    });

  function captureConnectionStatus(): ConnectionStatusCapture | null {
    if (connectionAdmissionInProgress()) return null;
    const running = captureConnectorHealth();
    if (running) return { kind: "running", original: running };
    const stopped = completedOwnerStop.current;
    return stopped && ownerStoppedCurrent(stopped)
      ? { kind: "owner-stopped", original: stopped }
      : null;
  }

  function connectionStatusCurrent(capture: ConnectionStatusCapture): boolean {
    if (connectionAdmissionInProgress()) return false;
    return capture.kind === "running"
      ? connectorHealthCurrent(capture.original)
      : ownerStoppedCurrent(capture.original);
  }

  function currentConnectionStatus(): ConnectionStatusView {
    const value = connectorConnection.view();
    const body = statusBody(value);
    if (body !== connectionStatusBody) {
      connectionStatusBody = body;
      retainedConnectionView = Object.freeze({
        ...value,
        revision: ++connectionStatusRevision,
      });
      const window = host.window();
      if (window && !window.isDestroyed()) {
        try {
          window.webContents.send(
            channels.connectionStatus,
            retainedConnectionView,
          );
        } catch {
          /* A projection cannot change original lifecycle or admission. */
        }
      }
    }
    return retainedConnectionView;
  }

  return {
    connectionAdmissionInProgress,
    connectorConnection,
    captureConnectionStatus,
    connectionStatusCurrent,
    currentConnectionStatus,
  };
}
export type ConnectorStatus = ReturnType<typeof connectorStatus>;

/** The timers and power events that drive status and transport observation. */
export function connectorWatch(
  host: ConnectorSupervisorPorts,
  transport: Pick<
    ConnectorTransport,
    | "captureConnectorTransport"
    | "connectorTransportCurrent"
    | "recoverConnectorTransport"
  >,
  status: Pick<
    ConnectorStatus,
    | "connectorConnection"
    | "captureConnectionStatus"
    | "connectionStatusCurrent"
    | "currentConnectionStatus"
  >,
) {
  const {
    captureConnectorTransport,
    connectorTransportCurrent,
    recoverConnectorTransport,
  } = transport;
  const {
    connectorConnection,
    captureConnectionStatus,
    connectionStatusCurrent,
    currentConnectionStatus,
  } = status;
  const connectorTransportWatch: Held<ConnectorTransportWatch<ConnectorTransportCapture> | null> =
    { current: null };
  const connectorTransportTimer: Held<NodeJS.Timeout | null> = {
    current: null,
  };
  const connectorStatusTimer: Held<NodeJS.Timeout | null> = { current: null };

  function startConnectorTransportWatch(): void {
    if (connectorTransportWatch.current || host.quitInProgress()) return;
    const observePassiveHealth =
      passiveHealthObserver<SecureMcpConnectorRuntime>(host.operationsStore());
    connectorTransportWatch.current = new ConnectorTransportWatch({
      capture: captureConnectorTransport,
      current: connectorTransportCurrent,
      observe: async (original) => {
        // Tunnel HTTP readiness cannot stand in for the original Go owner.
        // Lost backend settlement fences recovery; never respawn it here.
        if (!original.core.backendAvailable) return "unknown";
        const healthy = await observePassiveHealth(
          original.connector,
          () => original.connector.checkHealth(),
          () => connectorTransportCurrent(original),
        );
        if (!original.core.backendAvailable) return "unknown";
        return transportVerdict(
          original.connector.getTunnelObservation(),
          original.runtimeGeneration,
          healthy,
        );
      },
      unknown: async (original) => {
        if (!connectorTransportCurrent(original)) return;
        const transition = host
          .authorityTransitions()
          .tryReserve("connector-start");
        if (!transition) return;
        let admission: DesktopReservation | null = null;
        try {
          admission = host.reserveConnectorTask();
          if (
            !connectorTransportCurrent(original, original.revision, false, true)
          )
            return;
          const observationWindow = host.window();
          const failure = await host.recordConnectorRuntime(
            "outcome_unknown",
            original.runtimeGeneration,
            original.computerGeneration,
          );
          if (
            !failure &&
            !host.quitInProgress() &&
            !host.installedUpdateAdmission() &&
            host.configuration() === original.owner &&
            host.secureMcpConnectorRuntime() === original.connector &&
            host.desktopGoCore() === original.core &&
            host.window() === observationWindow &&
            observationWindow &&
            !observationWindow.isDestroyed()
          )
            observationWindow.webContents.send(channels.configurationChanged);
        } finally {
          admission?.release();
          transition.release();
        }
      },
      recover: async (original, observationCurrent, afterKnownClosure) => {
        const result = await recoverConnectorTransport(
          original,
          observationCurrent,
          afterKnownClosure,
        );
        host.reportConnectorTransport(
          original,
          result.ok ? "recovered_attachment_check_needed" : result.error,
        );
        const window = host.window();
        if (!host.quitInProgress() && window && !window.isDestroyed())
          window.webContents.send(channels.configurationChanged);
      },
      wait: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    const observeStatus = () => {
      void connectorConnection
        .sample()
        .then(currentConnectionStatus)
        .catch(() => undefined);
    };
    const check = () => {
      observeStatus();
      void connectorTransportWatch.current?.check().catch(() => {
        console.warn("FAROL_CONNECTOR_TRANSPORT_OBSERVATION_FAILED");
      });
    };
    connectorTransportTimer.current = setInterval(check, 30_000);
    connectorTransportTimer.current.unref();
    connectorStatusTimer.current = setInterval(currentConnectionStatus, 1000);
    connectorStatusTimer.current.unref();
    // Starting a status projection does not eagerly enter recovery observation.
    observeStatus();
    // The existing isolated-home proof is checked before this join starts.
    // This native-test seam invokes only the same passive observer as the timer;
    // it publishes no authority and is absent from ordinary owner launches.
    if (host.isolatedE2EHome !== undefined)
      process.addListener("farol-e2e-observe-connection", (reply: unknown) => {
        if (typeof reply !== "function") return;
        void (async () => {
          const original = captureConnectionStatus();
          if (!original) return { settled: false };
          let interrupted = false;
          const interrupt = () => {
            interrupted = true;
          };
          host.powerMonitor().on("suspend", interrupt);
          host.powerMonitor().on("resume", interrupt);
          try {
            // Settle any earlier read, then perform one after the test selected
            // its producer response. Coalescing cannot certify an older mode.
            await connectorConnection.sample();
            await connectorConnection.sample();
            return interrupted || !connectionStatusCurrent(original)
              ? { settled: false }
              : { settled: true, view: currentConnectionStatus() };
          } finally {
            host.powerMonitor().removeListener("suspend", interrupt);
            host.powerMonitor().removeListener("resume", interrupt);
          }
        })()
          .then(
            (value) => reply(value),
            () => reply({ settled: false }),
          )
          .catch(() => undefined);
      });
    host.powerMonitor().on("suspend", () => {
      connectorConnection.suspend();
      currentConnectionStatus();
      connectorTransportWatch.current?.suspend();
    });
    host.powerMonitor().on("resume", () => {
      connectorConnection.resume();
      connectorTransportWatch.current?.resume();
      check();
    });
  }

  return {
    connectorTransportWatch,
    connectorTransportTimer,
    connectorStatusTimer,
    startConnectorTransportWatch,
  };
}

/** The whole supervisor over one set of main-process ports. */
export function connectorSupervisor(host: ConnectorSupervisorPorts) {
  const transport = connectorTransport(host);
  const health = connectorHealth(host);
  const status = connectorStatus(host, health);
  const watch = connectorWatch(host, transport, status);
  return { ...transport, ...health, ...status, ...watch };
}
