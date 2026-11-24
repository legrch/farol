import { createHash } from "node:crypto";
import path from "node:path";
import type { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import type { PrivateConnectorKeyStore } from "../../../src/apps/desktop/connector-key-store";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import {
  ConnectorRuntimeEffectUnknown,
  type SecureMcpConnectorRuntime,
} from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import {
  computerConnectorAdmission,
  type SummaryFenceRecovery,
} from "../../../src/apps/desktop/summary-fence-recovery";
import type { verifySelectedTunnelClient } from "../../../src/apps/desktop/tunnel-client-probe";
import { connectorRuntimeUncertain } from "../../../src/pkg/product-settings/connector-uncertainty";
import {
  restartedConnectorAppSelection,
  selectedConnectorApp,
} from "../../../src/pkg/product-settings/connector-app-selection";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import { ConnectorHostError } from "../bridge/connector-host";
import type { ComputerConnectorBinding } from "../bridge/wire";
import type { DesktopGoCore } from "../go-core-host";
import type { DesktopAdmission } from "../host/admission";
import { observeOperation } from "../operations/observe";
import type { OperationsStore } from "../operations/store";
import type { createInstalledUpdateHost } from "../update/host";
import { TUNNEL_CLIENT } from "../tunnel-client-contract";
import type {
  connectorSupervisor,
  ConnectorTransportCapture,
} from "./supervisor";

// Starting the one Secure MCP connector: the observed reservation Quit waits
// on, the admitted start sequence and the runtime evidence it records. Main
// keeps every owner and flag; each `let` there is a late getter or a setter
// here, so a change made while a start waits is seen on the next read. The
// admission reservations, the authority transition and the start-in-flight
// promise are the owners' own objects, shared by reference. Nothing here
// retries: an unknown outcome is recorded and returned, never started again.

type Supervisor = ReturnType<typeof connectorSupervisor>;

export type ConnectorStartPorts = Readonly<{
  configuration: () => ProductConfigurationService | null;
  connectorCredentialStore: () => PrivateConnectorKeyStore | null;
  secureMcpConnectorRuntime: () => SecureMcpConnectorRuntime | null;
  desktopGoCore: () => DesktopGoCore | null;
  summaryFenceRecovery: () => SummaryFenceRecovery | null;
  connectorStartCancellation: () => AbortController | null;
  setConnectorStartCancellation: (value: AbortController | null) => void;
  setConnectorStartInFlight: (value: Promise<void> | null) => void;
  desktopAdmission: Pick<
    DesktopAdmission,
    "occupied" | "closed" | "reserveAdmitted"
  >;
  authorityTransitions: Pick<
    AuthorityTransitionReservation,
    "tryReserve" | "current"
  >;
  buildIdentity: Readonly<{ buildId: string }>;
  randomUUID: () => string;
  directory: string;
  installedUpdates: Pick<
    ReturnType<typeof createInstalledUpdateHost>,
    "resources"
  >;
  operationsStore: () => OperationsStore;
  statePaths: () => Readonly<{ secureMcpLaunch: string }>;
  configurationFailure: (
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
    connectorAttempt?: Extract<
      ProductConfigurationResult,
      { ok: false }
    >["connectorAttempt"],
  ) => ProductConfigurationResult;
  transitionRefusal: () => ProductConfigurationResult;
  // Main's stop: every argument is optional and defaults to main's live owner
  // at call time. The start paths call it with none, as main did; the
  // supervisor passes its captured connector and core through its own port.
  stopAndConfirmComputerMcp: (
    connector?: SecureMcpConnectorRuntime,
    inFlightStart?: Promise<void> | null,
    core?: DesktopGoCore,
  ) => Promise<void>;
  computerMcpLifecycle: () => Readonly<{
    prepare: (launchContractSha256: string) => Promise<void>;
  }>;
  e2eTunnelClientExecutable: () => string | "invalid" | undefined;
  verifyTunnelClientExecutable: (
    executablePath: string,
  ) => Promise<ProductConfigurationResult>;
  verifySelectedTunnelClient: typeof verifySelectedTunnelClient;
  clearConnectorVerificationReceipt: (root: string) => Promise<void>;
  connectorAttemptGeneration: Supervisor["connectorAttemptGeneration"];
}>;

export function reportConnectorTransport(
  original: ConnectorTransportCapture,
  code: string,
): void {
  // Caller supplies only a fixed classification; no endpoint, key, request body
  // or exception text enters this content-free lifecycle diagnostic.
  console.warn(
    "FAROL_CONNECTOR_TRANSPORT:" +
      JSON.stringify({
        at: new Date().toISOString(),
        code,
        profileId: original.binding.profileId,
        backendGeneration: original.binding.backendGeneration,
        runtimeId: original.binding.runtimeId,
        recoveryDisposition:
          original.core.computerConnectorClosureReceipt()?.result.recovery,
        computerGeneration: original.computerGeneration,
        connectorGeneration: original.connectorGeneration,
        buildId: original.binding.buildId,
      }),
  );
}

export function createConnectorStart(ports: ConnectorStartPorts) {
  const {
    configuration,
    connectorCredentialStore,
    secureMcpConnectorRuntime,
    desktopGoCore,
    summaryFenceRecovery,
    connectorStartCancellation,
    setConnectorStartCancellation,
    setConnectorStartInFlight,
    desktopAdmission,
    authorityTransitions,
    buildIdentity,
    randomUUID,
    directory,
    installedUpdates,
    operationsStore,
    statePaths,
    configurationFailure,
    transitionRefusal,
    stopAndConfirmComputerMcp,
    computerMcpLifecycle,
    e2eTunnelClientExecutable,
    verifyTunnelClientExecutable,
    verifySelectedTunnelClient,
    clearConnectorVerificationReceipt,
    connectorAttemptGeneration,
  } = ports;

  async function recordConnectorRuntime(
    state: "ready" | "unreachable" | "outcome_unknown",
    runtimeGeneration: string,
    computerGeneration: number,
  ): Promise<ProductConfigurationResult | null> {
    if (!configuration()) return configurationFailure("SETTINGS_UNAVAILABLE");
    const recorded = await configuration()!.recordSecureMcpRuntime({
      state,
      runtimeGeneration,
      computerGeneration,
      buildId: buildIdentity.buildId,
    });
    return recorded.ok
      ? null
      : ProductConfigurationResultSchema.parse(recorded);
  }

  function startSecureMcpConnector(
    repair: boolean,
    resumeAfterQuit = false,
  ): Promise<ProductConfigurationResult> {
    return observeOperation(
      operationsStore(),
      {
        source: resumeAfterQuit ? "Setup" : "You",
        kind: repair ? "connection.repair" : "connection.start",
        target: {},
      },
      () => startSecureMcpConnectorObserved(repair, resumeAfterQuit),
    );
  }
  async function startSecureMcpConnectorObserved(
    repair: boolean,
    resumeAfterQuit = false,
  ): Promise<ProductConfigurationResult> {
    if (desktopAdmission.occupied("connector-task"))
      return configurationFailure("CONNECTOR_ALREADY_RUNNING");
    const transition = authorityTransitions.tryReserve("connector-start");
    if (!transition) return transitionRefusal();
    const connectorAdmission =
      desktopAdmission.reserveAdmitted("connector-task");
    try {
      return await observeConnectorStart(() =>
        startAdmittedSecureMcpConnector(repair, resumeAfterQuit),
      );
    } finally {
      connectorAdmission.release();
      transition.release();
    }
  }

  // Quit observes the whole admitted sequence, including credential publication.
  async function observeConnectorStart(
    work: () => Promise<ProductConfigurationResult>,
  ): Promise<ProductConfigurationResult> {
    const cancellation = new AbortController();
    setConnectorStartCancellation(cancellation);
    let finish!: () => void;
    setConnectorStartInFlight(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    try {
      return await work();
    } finally {
      finish();
      setConnectorStartInFlight(null);
      if (connectorStartCancellation() === cancellation)
        setConnectorStartCancellation(null);
    }
  }

  // Only the existing start or credential owner may call this while retaining
  // its reservation. It never reacquires or drops authority to launch a child.
  async function startAdmittedSecureMcpConnector(
    repair: boolean,
    resumeAfterQuit = false,
    recoveryFrom?: ComputerConnectorBinding,
    recoveryCurrent?: () => boolean,
  ): Promise<ProductConfigurationResult> {
    // This only invalidates a recovery observation. The existing admitted owner
    // and Go authority still decide every launch; a missing guard refuses recovery.
    const recoveryPermitted = () =>
      recoveryFrom === undefined || recoveryCurrent?.() === true;
    const cancellation = connectorStartCancellation()?.signal;
    const startPermitted = () =>
      !cancellation?.aborted &&
      !desktopAdmission.closed() &&
      recoveryPermitted();
    const startRefusal = () =>
      recoveryPermitted()
        ? configurationFailure("CONNECTOR_START_FAILED")
        : transitionRefusal();
    if (!recoveryPermitted()) return transitionRefusal();
    if (
      !desktopAdmission.occupied("connector-task") ||
      !authorityTransitions.current()
    )
      return transitionRefusal();
    if (desktopAdmission.closed())
      return configurationFailure("CONNECTOR_START_FAILED");
    // C7 can be pending before any C4 WAL exists. No new Start, repair,
    // credential-associated Open or restoration may cross that custody.
    try {
      const originalStop = await desktopGoCore()?.observeOriginalStop();
      if (!originalStop || originalStop.restricted)
        return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
    } catch {
      return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
    }
    if (!startPermitted()) return startRefusal();
    if (
      !configuration() ||
      !connectorCredentialStore() ||
      !secureMcpConnectorRuntime()
    ) {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    if (secureMcpConnectorRuntime()!.hasUnresolvedEffect())
      return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
    const retained = configuration()!.snapshot();
    if (
      retained.status === "ready" &&
      connectorRuntimeUncertain(retained.settings)
    )
      return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
    // A start whose fence recovery could hold no record leaves the broker
    // nothing to refuse with: the connector is not exposed at all until a
    // later start recovers.
    const fenceAdmission = computerConnectorAdmission(summaryFenceRecovery());
    if (!fenceAdmission.admissible) {
      return configurationFailure(fenceAdmission.code);
    }
    if (secureMcpConnectorRuntime()!.isRunning() && !repair) {
      return configurationFailure("CONNECTOR_ALREADY_RUNNING");
    }
    if (repair) {
      try {
        await stopAndConfirmComputerMcp();
      } catch {
        return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
      }
    }
    if (repair || resumeAfterQuit) {
      if (!startPermitted()) return startRefusal();
      // The previous process has exited. Withdraw its live proof under this
      // start reservation before any new launch can succeed or be refused.
      // Historical completion remains available, but is never live readiness.
      const stopped = await configuration()!.recordSecureMcpStopped();
      if (!stopped.ok) return ProductConfigurationResultSchema.parse(stopped);
    }
    if (!startPermitted()) return startRefusal();
    // The ordinary Computer route is the selected Go backend. Its absence
    // cannot fall back to a separate TS authority or native helper.
    const core = desktopGoCore();
    if (!core) return configurationFailure("CONNECTOR_START_FAILED");
    let snapshot = configuration()!.snapshot();
    if (snapshot.status !== "ready") {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    let connector = snapshot.settings.connectors.secureMcp;
    if (connectorRuntimeUncertain(snapshot.settings))
      return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
    if (!connector.tunnelClient || !connector.tunnelId) {
      return configurationFailure("CONNECTOR_CONFIGURE_FAILED");
    }
    // A stored key reference alone is not a committed connector admission.
    // Do not publish a Go open if the settings write that records the key was
    // refused or lost before the credential state became durable.
    if (connector.credential !== "stored")
      return configurationFailure("CONNECTOR_CREDENTIAL_REQUIRED");
    // The old owner is already stopped above. Rebind the reviewed app-owned
    // executable without replaying any previous configure/start operation.
    if (
      e2eTunnelClientExecutable() === undefined &&
      (connector.tunnelClient.executablePath !==
        path.join(directory, TUNNEL_CLIENT.entry) ||
        connector.tunnelClient.executableSha256 !== TUNNEL_CLIENT.sha256)
    ) {
      const selected = await verifyTunnelClientExecutable(
        path.join(directory, TUNNEL_CLIENT.entry),
      );
      if (!selected.ok) return selected;
      if (!startPermitted()) return startRefusal();
      snapshot = configuration()!.snapshot();
      if (
        snapshot.status !== "ready" ||
        !snapshot.settings.connectors.secureMcp.tunnelClient
      )
        return configurationFailure("SETTINGS_UNAVAILABLE");
      connector = snapshot.settings.connectors.secureMcp;
    }
    if (!connector.tunnelClient || !connector.tunnelId)
      return configurationFailure("CONNECTOR_CONFIGURE_FAILED");
    // Settings pin canonical bytes, not just a command pathname. Recheck
    // before configure/doctor/start can execute the saved selection.
    try {
      await verifySelectedTunnelClient(connector.tunnelClient);
    } catch (error) {
      const refusal =
        error instanceof Error &&
        error.message === "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE"
          ? "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE"
          : "TUNNEL_CLIENT_EXECUTABLE_UNSAFE";
      if (resumeAfterQuit) {
        const stopped = await configuration()!.recordSecureMcpStopped(refusal);
        if (!stopped.ok) return ProductConfigurationResultSchema.parse(stopped);
      }
      return configurationFailure(refusal);
    }
    let credentialReference: string;
    if (!startPermitted()) return startRefusal();
    try {
      credentialReference = await connectorCredentialStore()!.reference();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "CONNECTOR_CREDENTIAL_MISSING") {
        await configuration()!.recordSecureMcpCredential("missing");
        return configurationFailure("CONNECTOR_CREDENTIAL_REQUIRED");
      }
      return configurationFailure("CONNECTOR_CREDENTIAL_STORE_FAILED");
    }

    if (!startPermitted()) return startRefusal();
    const runtimeId = randomUUID();
    const verificationChallenge = randomUUID();
    const verificationChallengeSha256 = createHash("sha256")
      .update(verificationChallenge)
      .digest("hex");
    let launchFile: string;
    let launchContractSha256: string;
    try {
      await clearConnectorVerificationReceipt(statePaths().secureMcpLaunch);
      if (!startPermitted()) return startRefusal();
      const intentDigest = createHash("sha256")
        .update(
          JSON.stringify({
            buildId: buildIdentity.buildId,
            runtimeId,
            computerGeneration: snapshot.settings.computer.generation,
            connectorGeneration: connector.generation,
            challengeSha256: verificationChallengeSha256,
          }),
        )
        .digest("hex");
      const opened = await core.openComputerConnector(
        runtimeId,
        intentDigest,
        verificationChallengeSha256,
        statePaths().secureMcpLaunch,
        recoveryFrom,
      );
      if (!opened.launchFile || !opened.launchSha256)
        throw new Error("COMPUTER_MCP_GO_LAUNCH_UNAVAILABLE");
      launchFile = opened.launchFile;
      launchContractSha256 = opened.launchSha256;
      // An earlier Quit/update may have stopped admission while the contract
      // was being written. Do not clear its stop marker with a later prepare.
      if (!startPermitted()) return startRefusal();
      await computerMcpLifecycle().prepare(launchContractSha256);
    } catch (error) {
      if (error instanceof ConnectorHostError) {
        const connectorAttempt = {
          method: "computer.connector.open" as const,
          requestId: error.requestId,
          operationId: error.operationId,
          outcome: error.outcome,
        };
        if (error.outcome === "unknown") {
          // The Go operation may have published before its reply was lost.
          // Retain the original IDs in the caller result and a sticky runtime
          // generation in the existing settings owner, never another open.
          const generation = createHash("sha256")
            .update([error.requestId, error.operationId].join("\0"))
            .digest("hex");
          try {
            const recorded = await recordConnectorRuntime(
              "outcome_unknown",
              generation,
              snapshot.settings.computer.generation,
            );
            if (recorded && !recorded.ok)
              return ProductConfigurationResultSchema.parse({
                ...recorded,
                connectorAttempt,
              });
          } catch {
            return configurationFailure(
              "SETTINGS_WRITE_FAILED",
              connectorAttempt,
            );
          }
          return configurationFailure(
            "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
            connectorAttempt,
          );
        }
        return configurationFailure("CONNECTOR_START_FAILED", connectorAttempt);
      }
      const code = error instanceof Error ? error.message : "";
      if (code.startsWith("COMPUTER_MCP_")) {
        return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
      }
      if (code === "SECURE_MCP_WORKSPACE_REQUIRED") {
        return configurationFailure("CONNECTOR_WORKSPACE_REQUIRED");
      }
      if (code === "SECURE_MCP_WORKSPACE_LIMIT") {
        return configurationFailure("CONNECTOR_WORKSPACE_LIMIT");
      }
      return configurationFailure("CONNECTOR_START_FAILED");
    }

    const beforeConnectorEffect = () => {
      // Quit latches admission closed before aborting the captured start signal.
      if (desktopAdmission.closed() || !recoveryPermitted()) {
        throw new Error("CONNECTOR_ADMISSION_WITHDRAWN");
      }
    };
    const attempt = (phase: string) =>
      connectorAttemptGeneration({
        connectorGeneration: connector.generation,
        computerGeneration: snapshot.settings.computer.generation,
        launchContractSha256,
        phase,
      });
    if (!startPermitted()) return startRefusal();
    try {
      const resources = installedUpdates.resources();
      await resources.recheck();
      if (!startPermitted()) return startRefusal();
      await secureMcpConnectorRuntime()!.configure({
        beforeEffect: beforeConnectorEffect,
        executablePath: connector.tunnelClient.executablePath,
        tunnelId: connector.tunnelId,
        credentialReference,
        mcp: {
          electronPath: resources.executable,
          entryPath: path.join(resources.directory, "computer-mcp.cjs"),
          launchContractPath: launchFile,
        },
      });
    } catch (error) {
      const unknown = error instanceof ConnectorRuntimeEffectUnknown;
      const failed = await recordConnectorRuntime(
        unknown ? "outcome_unknown" : "unreachable",
        attempt("configure"),
        snapshot.settings.computer.generation,
      );
      if (failed) return failed;
      return configurationFailure(
        unknown
          ? "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"
          : "CONNECTOR_CONFIGURE_FAILED",
      );
    }
    if (!startPermitted()) return startRefusal();
    try {
      await secureMcpConnectorRuntime()!.doctor({
        beforeEffect: beforeConnectorEffect,
        executablePath: connector.tunnelClient.executablePath,
      });
    } catch {
      const failed = await recordConnectorRuntime(
        "unreachable",
        attempt("doctor"),
        snapshot.settings.computer.generation,
      );
      if (failed) return failed;
      return configurationFailure("CONNECTOR_DOCTOR_FAILED");
    }

    let started;
    // Quit closes new admission first. If it arrived while configure or
    // doctor was pending, do not launch a tunnel after its drain began.
    if (!startPermitted()) return startRefusal();
    try {
      started = await secureMcpConnectorRuntime()!.start({
        beforeEffect: beforeConnectorEffect,
        executablePath: connector.tunnelClient.executablePath,
        executableSha256: connector.tunnelClient.executableSha256,
        connectorGeneration: connector.generation,
        computerGeneration: snapshot.settings.computer.generation,
        buildId: buildIdentity.buildId,
        launchContractSha256,
      });
    } catch {
      // Withdrawal ends waiting, not child ownership. Quit's original Stop and
      // receipt decide closure; do not publish it as an unreachable/retryable start.
      if (!startPermitted()) return startRefusal();
      const failed = await recordConnectorRuntime(
        "unreachable",
        attempt("start"),
        snapshot.settings.computer.generation,
      );
      if (failed) return failed;
      return configurationFailure("CONNECTOR_START_FAILED");
    }
    const failed = await recordConnectorRuntime(
      started.state,
      started.runtimeGeneration,
      snapshot.settings.computer.generation,
    );
    if (failed) return failed;
    if (started.state === "unreachable") {
      return configurationFailure("CONNECTOR_RUNTIME_UNREACHABLE");
    }
    if (started.state === "outcome_unknown") {
      return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
    }
    // Retain an already-issued Start's real result even when its observation was
    // invalidated. That completion cannot authorize a new challenge publication.
    if (!startPermitted()) return startRefusal();
    const challenged = await configuration()!.recordSecureMcpChallenge({
      challenge: verificationChallenge,
      runtimeGeneration: started.runtimeGeneration,
      computerGeneration: snapshot.settings.computer.generation,
      buildId: buildIdentity.buildId,
    });
    if (!challenged.ok) {
      try {
        await stopAndConfirmComputerMcp();
      } catch {
        return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
      }
      await configuration()!
        .recordSecureMcpStopped()
        .catch(() => undefined);
      return ProductConfigurationResultSchema.parse(challenged);
    }
    const afterChallenge = configuration()!.snapshot();
    const retainedSelection =
      afterChallenge.status === "ready"
        ? restartedConnectorAppSelection(afterChallenge.settings)
        : null;
    if (
      retainedSelection &&
      afterChallenge.status === "ready" &&
      selectedConnectorApp(afterChallenge.settings.connectors.secureMcp) ===
        null
    ) {
      if (!startPermitted()) return startRefusal();
      const selected =
        await configuration()!.selectSecureMcpChatGptApp(retainedSelection);
      if (!selected.ok) return ProductConfigurationResultSchema.parse(selected);
    }
    return ProductConfigurationResultSchema.parse({
      ok: true,
      snapshot: configuration()!.snapshot(),
      evidence: {
        kind: "connector.runtime",
        state: "ready",
        runtimeGeneration: started.runtimeGeneration,
        computerGeneration: snapshot.settings.computer.generation,
        buildId: buildIdentity.buildId,
      },
    });
  }

  return {
    recordConnectorRuntime,
    startSecureMcpConnector,
    startSecureMcpConnectorObserved,
    observeConnectorStart,
    startAdmittedSecureMcpConnector,
  };
}
