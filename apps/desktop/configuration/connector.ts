import path from "node:path";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import type { PrivateConnectorKeyStore } from "../../../src/apps/desktop/connector-key-store";
import { connectorRuntimeUncertain } from "../../../src/pkg/product-settings/connector-uncertainty";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
  type SeparateAppVerificationScope,
} from "../../../src/pkg/product-settings/contract";
import type { DesktopAdmission } from "../host/admission";
import type { DesktopGoCore } from "../go-core-host";
import { PollingObservationExpiredError } from "../bridge/client";
import { TUNNEL_CLIENT } from "../tunnel-client-contract";
import type {
  ConnectorHealth,
  connectorSupervisor,
} from "../connector/supervisor";

type Supervisor = ReturnType<typeof connectorSupervisor>;
export type ConnectorConfigurationCommand = Exclude<
  Extract<ProductConfigurationCommand, { kind: `connector.${string}` }>,
  { kind: "connector.test-connection" }
>;

// These are the original identity-bearing owners. Reading them is lazy; the
// module neither constructs an owner nor copies the supervisor's Stop receipt.
export type ConfigurationConnectorPorts = Pick<
  ConnectorHealth,
  | "captureConnectorStop"
  | "ownerStoppedCurrent"
  | "completedOwnerStop"
  | "observedConnectorHealth"
> &
  Readonly<{
    configuration: () => ProductConfigurationService | null;
    connectorCredentialStore: () => PrivateConnectorKeyStore | null;
    secureMcpConnectorRuntime: () => SecureMcpConnectorRuntime | null;
    desktopGoCore: () => DesktopGoCore | null;
    buildIdentity: () => Readonly<{ buildId: string }>;
    desktopAdmission: Pick<DesktopAdmission, "occupied" | "reserveAdmitted">;
    configurationFailure: (
      code: Extract<ProductConfigurationResult, { ok: false }>["error"],
    ) => ProductConfigurationResult;
    selectedTunnelClientExecutable: () => Promise<
      string | "cancelled" | "invalid"
    >;
    e2eTunnelClientExecutable: () => string | undefined;
    directory: string;
    verifyTunnelClientExecutable: (
      selected: string,
    ) => Promise<ProductConfigurationResult>;
    startSecureMcpConnector: (
      repair: boolean,
    ) => Promise<ProductConfigurationResult>;
    checkSecureMcpAttachment: () => Promise<ProductConfigurationResult>;
    verifySecureMcpApp: (
      expected?: SeparateAppVerificationScope,
    ) => Promise<ProductConfigurationResult>;
    recordConnectorRuntime: (
      state: "ready" | "unreachable" | "outcome_unknown",
      runtimeGeneration: string,
      computerGeneration: number,
    ) => Promise<ProductConfigurationResult | null>;
    stopAndConfirmComputerMcp: (
      connector: undefined,
      inFlightStart: null,
      core: undefined,
      savedChat: undefined,
      reason: "owner_stop",
    ) => Promise<void>;
    statePaths: () => { secureMcpLaunch: string };
    clearConnectorVerificationReceipt: (root: string) => Promise<void>;
    connectorConnection: Pick<
      Supervisor["connectorConnection"],
      "invalidate" | "sample"
    >;
    currentConnectionStatus: Supervisor["currentConnectionStatus"];
  }>;

export function createConfigurationConnector(
  ports: ConfigurationConnectorPorts,
) {
  const {
    configuration,
    connectorCredentialStore,
    secureMcpConnectorRuntime,
    desktopGoCore,
    buildIdentity,
    desktopAdmission,
    configurationFailure,
    selectedTunnelClientExecutable,
    e2eTunnelClientExecutable,
    directory,
    verifyTunnelClientExecutable,
    startSecureMcpConnector,
    checkSecureMcpAttachment,
    verifySecureMcpApp,
    recordConnectorRuntime,
    stopAndConfirmComputerMcp,
    statePaths,
    clearConnectorVerificationReceipt,
    captureConnectorStop,
    ownerStoppedCurrent,
    completedOwnerStop,
    observedConnectorHealth,
    connectorConnection,
    currentConnectionStatus,
  } = ports;

  // Main retains parsed-command admission and its settings-availability guard.
  async function configureAdmittedConnector(
    command: ConnectorConfigurationCommand,
  ): Promise<ProductConfigurationResult> {
    switch (command.kind) {
      case "connector.select-client": {
        const current = configuration()!.snapshot();
        if (
          current.status === "ready" &&
          (current.settings.connectors.secureMcp.runtime?.state ===
            "outcome_unknown" ||
            current.settings.setup.connect.outcomeUnknown)
        )
          return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
        const selected = await selectedTunnelClientExecutable();
        if (selected === "cancelled") {
          return configurationFailure("TUNNEL_CLIENT_PICKER_CANCELLED");
        }
        if (selected === "invalid") {
          return configurationFailure("TUNNEL_CLIENT_SELECTION_INVALID");
        }
        return verifyTunnelClientExecutable(selected);
      }
      case "connector.discover-client": {
        const current = configuration()!.snapshot();
        if (
          current.status === "ready" &&
          (current.settings.connectors.secureMcp.runtime?.state ===
            "outcome_unknown" ||
            current.settings.setup.connect.outcomeUnknown)
        )
          return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
        try {
          // The real UI still drives discovery. This exact E2E-only seam lets
          // that button verify the synthetic CLI fixture instead of
          // probing or starting any tunnel-client installed on the owner host.
          const testExecutable = e2eTunnelClientExecutable();
          if (testExecutable === "invalid") {
            return configurationFailure("TUNNEL_CLIENT_SELECTION_INVALID");
          }
          if (testExecutable !== undefined) {
            return verifyTunnelClientExecutable(testExecutable);
          }
          return verifyTunnelClientExecutable(
            path.join(directory, TUNNEL_CLIENT.entry),
          );
        } catch {
          return configurationFailure("TUNNEL_CLIENT_DISCOVERY_FAILED");
        }
      }
      case "connector.select-discovered-client": {
        // Retained requests cannot select an external executable in a bundled build.
        return configurationFailure("TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE");
      }
      case "connector.save-and-connect":
        // Combined requests enter only through the retained, reservation-owned route.
        return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
      case "connector.configure": {
        const current = configuration()!.snapshot();
        if (
          current.status === "ready" &&
          (current.settings.connectors.secureMcp.runtime?.state ===
            "outcome_unknown" ||
            current.settings.setup.connect.outcomeUnknown)
        )
          return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
        if (secureMcpConnectorRuntime()!?.hasUnresolvedEffect())
          return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
        if (
          !connectorCredentialStore()! ||
          secureMcpConnectorRuntime()!?.isRunning()
        ) {
          return configurationFailure(
            secureMcpConnectorRuntime()!?.isRunning()
              ? "CONNECTOR_STOP_REQUIRED"
              : "SETTINGS_UNAVAILABLE",
          );
        }
        try {
          if (command.runtimeKey !== null) {
            // Settings owns the admission fence before the private file can be
            // replaced. A failed sync after rename is an uncertain effect, not
            // a known credential refusal or permission to submit it again.
            const pending =
              await configuration()!.beginSecureMcpCredentialChange();
            if (!pending.ok)
              return ProductConfigurationResultSchema.parse(pending);
            if (pending.snapshot.status !== "ready")
              return configurationFailure(
                "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
              );
            const generation =
              pending.snapshot.settings.connectors.secureMcp.generation;
            try {
              await connectorCredentialStore()!.store(command.runtimeKey);
            } catch {
              return configurationFailure(
                "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
              );
            }
            const completed =
              await configuration()!.completeSecureMcpCredentialChange(
                { tunnelId: command.tunnelId },
                generation,
              );
            // Settings may have published the completed document even if its
            // first readback failed. Preserve its actual recovered snapshot and
            // error; do not claim a pending fence that was already cleared.
            return ProductConfigurationResultSchema.parse(completed);
          }
          const credentialStatus = await connectorCredentialStore()!.status();
          if (credentialStatus === "missing") {
            await configuration()!.recordSecureMcpCredential("missing");
            return configurationFailure("CONNECTOR_CREDENTIAL_REQUIRED");
          }
          const tunnel = await configuration()!.configureSecureMcpTunnel({
            tunnelId: command.tunnelId,
          });
          if (!tunnel.ok) return ProductConfigurationResultSchema.parse(tunnel);
          return ProductConfigurationResultSchema.parse(
            await configuration()!.recordSecureMcpCredential("stored"),
          );
        } catch {
          return configurationFailure("CONNECTOR_CREDENTIAL_STORE_FAILED");
        }
      }
      case "connector.select-chatgpt-app": {
        if (
          desktopAdmission.occupied("chatgpt-task") ||
          desktopAdmission.occupied("connector-task")
        )
          return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
        const connectorAdmission =
          desktopAdmission.reserveAdmitted("connector-task");
        try {
          return ProductConfigurationResultSchema.parse(
            await configuration()!.selectSecureMcpChatGptApp({
              name: command.name,
              tunnelId: command.tunnelId,
              connectorGeneration: command.connectorGeneration,
            }),
          );
        } finally {
          connectorAdmission.release();
        }
      }
      case "connector.start":
        return startSecureMcpConnector(false);
      case "connector.repair":
        return startSecureMcpConnector(true);
      case "connector.check-health": {
        if (!secureMcpConnectorRuntime()!)
          return configurationFailure("SETTINGS_UNAVAILABLE");
        if (desktopAdmission.occupied("connector-task"))
          return configurationFailure("CONNECTOR_ALREADY_RUNNING");
        const connectorAdmission =
          desktopAdmission.reserveAdmitted("connector-task");
        const originalConnector = secureMcpConnectorRuntime()!;
        const originalCore = desktopGoCore();
        const originalOwner = configuration()!;
        try {
          const before = configuration()!.snapshot();
          if (before.status !== "ready")
            return configurationFailure("SETTINGS_UNAVAILABLE");
          const connector = before.settings.connectors.secureMcp;
          const current = connector.runtime;
          if (
            !current ||
            current.state !== "ready" ||
            current.buildId !== buildIdentity().buildId ||
            current.computerGeneration !==
              before.settings.computer.generation ||
            current.connectorGeneration !== connector.generation
          )
            return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
          const healthy = await observedConnectorHealth(originalConnector);
          const after = originalOwner.snapshot();
          if (
            configuration()! !== originalOwner ||
            secureMcpConnectorRuntime()! !== originalConnector ||
            desktopGoCore() !== originalCore ||
            !originalCore?.backendAvailable ||
            after.status !== "ready" ||
            after.settings.computer.generation !==
              before.settings.computer.generation ||
            after.settings.connectors.secureMcp.generation !==
              connector.generation ||
            after.settings.connectors.secureMcp.runtime?.runtimeGeneration !==
              current.runtimeGeneration
          )
            return configurationFailure(
              "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
            );
          const terminal = originalConnector.getTunnelObservation();
          if (
            terminal &&
            terminal.runtimeGeneration !== current.runtimeGeneration
          )
            return configurationFailure(
              "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
            );
          if (terminal?.state === "outcome_unknown") {
            const failure = await recordConnectorRuntime(
              "outcome_unknown",
              current.runtimeGeneration,
              current.computerGeneration,
            );
            if (failure) return failure;
            return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
          }
          if (!healthy || terminal?.state === "exited") {
            const failure = await recordConnectorRuntime(
              "unreachable",
              current.runtimeGeneration,
              current.computerGeneration,
            );
            if (failure) return failure;
            return configurationFailure(
              terminal?.state === "exited"
                ? "CONNECTOR_TUNNEL_EXITED"
                : "CONNECTOR_DOCTOR_FAILED",
            );
          }
          const sameObservation = () => {
            const latest = configuration()!?.snapshot();
            return (
              configuration()! === originalOwner &&
              secureMcpConnectorRuntime()! === originalConnector &&
              desktopGoCore() === originalCore &&
              originalCore?.backendAvailable &&
              originalConnector.isRunning() &&
              originalConnector.getTunnelObservation() === null &&
              latest?.status === "ready" &&
              latest.settings.computer.generation ===
                current.computerGeneration &&
              latest.settings.connectors.secureMcp.generation ===
                current.connectorGeneration &&
              latest.settings.connectors.secureMcp.runtime?.state === "ready" &&
              latest.settings.connectors.secureMcp.runtime.runtimeGeneration ===
                current.runtimeGeneration
            );
          };
          const metrics = await originalConnector.observePolling();
          if (
            !metrics ||
            metrics.runtimeGeneration !== current.runtimeGeneration ||
            !sameObservation()
          )
            return configurationFailure(
              "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
            );
          const polling = await originalCore
            .observeComputerConnectorPolling(metrics.samples)
            .catch((error: unknown) => {
              if (error instanceof PollingObservationExpiredError) return null;
              throw error;
            });
          if (!sameObservation())
            return configurationFailure(
              "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
            );
          if (polling === null)
            return configurationFailure("CONNECTOR_POLLING_EXPIRED");
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
            evidence: {
              kind: "connector.polling",
              state: polling.state,
              observedAtMillis: polling.observedAtMillis,
              runtimeGeneration: current.runtimeGeneration,
              connectorGeneration: polling.binding.connectorGeneration,
              computerGeneration: current.computerGeneration,
              buildId: current.buildId,
            },
          });
        } finally {
          connectorAdmission.release();
        }
      }
      case "connector.check-attachment":
        return checkSecureMcpAttachment();
      case "connector.verify-app":
        return verifySecureMcpApp();
      case "connector.verify-separate-app":
        return verifySecureMcpApp(command.expected);
      case "connector.stop": {
        const current = configuration()!.snapshot();
        if (
          current.status === "ready" &&
          connectorRuntimeUncertain(current.settings)
        )
          return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
        if (!secureMcpConnectorRuntime()!) {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        if (desktopAdmission.occupied("connector-task")) {
          return configurationFailure("CONNECTOR_ALREADY_RUNNING");
        }
        const stopping = captureConnectorStop();
        const previousStop =
          completedOwnerStop.current &&
          ownerStoppedCurrent(completedOwnerStop.current)
            ? completedOwnerStop.current
            : null;
        completedOwnerStop.current = null;
        connectorConnection.invalidate();
        const connectorAdmission =
          desktopAdmission.reserveAdmitted("connector-task");
        try {
          try {
            await stopAndConfirmComputerMcp(
              undefined,
              null,
              undefined,
              undefined,
              "owner_stop",
            );
          } catch {
            return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
          }
          const stopped = await configuration()!.recordSecureMcpStopped();
          if (!stopped.ok)
            return ProductConfigurationResultSchema.parse(stopped);
          try {
            await clearConnectorVerificationReceipt(
              statePaths().secureMcpLaunch,
            );
          } catch {
            return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
          }
          const receipt =
            desktopGoCore()?.computerConnectorOwnerStoppedReceipt();
          if (
            stopping &&
            receipt &&
            Object.entries(stopping.binding).every(
              ([key, value]) =>
                receipt.result.binding[
                  key as keyof typeof receipt.result.binding
                ] === value,
            )
          ) {
            completedOwnerStop.current = Object.freeze({
              ...stopping,
              receipt,
            });
          } else if (previousStop && receipt === previousStop.receipt) {
            // A no-op Stop retains the exact previous acknowledged stop; it
            // neither creates a new receipt nor promotes a generic Close.
            completedOwnerStop.current = previousStop;
          }
          return ProductConfigurationResultSchema.parse(stopped);
        } finally {
          connectorAdmission.release();
          // Observe the acknowledged stop now. The passive transport timer runs
          // every 30 seconds; presentation must not wait for its next tick.
          void connectorConnection
            .sample()
            .then(currentConnectionStatus)
            .catch(() => undefined);
        }
      }
    }
    return configurationFailure("SETTINGS_INPUT_INVALID");
  }
  return Object.freeze({ configureAdmittedConnector });
}
