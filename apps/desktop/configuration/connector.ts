import { runAdmittedConnectorSetup } from "../connector-setup-host";
import type { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import path from "node:path";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import {
  ConnectorKeyNotReplacedError,
  connectorKeyDigest,
  type PrivateConnectorKeyStore,
} from "../../../src/apps/desktop/connector-key-store";
import { secureMcpCredentialChangeCompletable } from "./tunnel";
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

export type ConnectorSetupCommand = Extract<
  ProductConfigurationCommand,
  { kind: "connector.save-and-connect" }
>;

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
    desktopAdmission: Pick<
      DesktopAdmission,
      "occupied" | "reserveAdmitted" | "closed" | "withConfigurationRequest"
    >;
    authorityTransitions: AuthorityTransitionReservation;
    setActiveAuthorityChangeKind: (
      value: ProductConfigurationCommand["kind"] | null,
    ) => void;
    observeConnectorStart: (
      work: () => Promise<ProductConfigurationResult>,
    ) => Promise<ProductConfigurationResult>;
    startAdmittedSecureMcpConnector: (
      repair: boolean,
    ) => Promise<ProductConfigurationResult>;
    configureAdmittedProduct: (
      command: ProductConfigurationCommand,
    ) => Promise<ProductConfigurationResult>;
    deliverConfigurationReply: (
      kind: string,
      result: ProductConfigurationResult,
    ) => ProductConfigurationResult | Promise<ProductConfigurationResult>;
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
    authorityTransitions,
    setActiveAuthorityChangeKind,
    observeConnectorStart,
    startAdmittedSecureMcpConnector,
    configureAdmittedProduct,
    deliverConfigurationReply,
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

  // The credential owner settles the fence it set whenever it KNOWS the
  // outcome. A settlement that itself failed is kept here, in this process
  // only, and retried by the next credential command; it is dropped as soon as
  // the fence it names is gone. An unknown key-store outcome records nothing
  // and stays fenced: nothing in memory can prove what the disk holds.
  // Both kinds are bound to the exact fenced document (generation and the
  // revision the begin step published). Any other Settings write moves the
  // revision, after which the owner can no longer prove it owns the fence.
  type RetainedFence = Readonly<{
    owner: ProductConfigurationService;
    generation: number;
    revision: number;
  }> &
    (
      | Readonly<{ kind: "release" }>
      | Readonly<{ kind: "complete"; digest: string; tunnelId: string }>
    );
  let retainedFence: RetainedFence | null = null;

  function retainedFenceStillOwned(
    current: ReturnType<ProductConfigurationService["snapshot"]>,
  ): RetainedFence | null {
    const retained = retainedFence;
    if (retained === null) return null;
    if (retained.owner !== configuration() || current.status !== "ready") {
      retainedFence = null;
      return null;
    }
    const settings = current.settings;
    const owned =
      retained.kind === "release"
        ? settings.setup.connect.outcomeUnknown &&
          settings.connectors.secureMcp.generation === retained.generation &&
          settings.revision === retained.revision
        : secureMcpCredentialChangeCompletable(
            settings,
            retained.generation,
            retained.revision,
          );
    if (!owned) retainedFence = null;
    return owned ? retained : null;
  }

  async function releaseFence(
    owner: ProductConfigurationService,
    generation: number,
    revision: number,
  ): Promise<ProductConfigurationResult> {
    retainedFence = { kind: "release", owner, generation, revision };
    const released = await owner.releaseSecureMcpCredentialChange({
      generation,
      revision,
    });
    const { durableSourceChanged, ...result } = released;
    if (result.ok || durableSourceChanged) retainedFence = null;
    // A refusal may also mean the cache moved on; a recovery that can no longer
    // prove it owns the fence is dropped, never retried blindly.
    else retainedFenceStillOwned(owner.snapshot());
    return ProductConfigurationResultSchema.parse(result);
  }

  // The key is known to be the new one; only the completion save failed. A
  // retry re-reads the stored key and settles only when it is still exactly
  // the value that was written.
  async function completeRetainedFence(
    retained: Extract<RetainedFence, { kind: "complete" }>,
    command: Extract<
      ConnectorConfigurationCommand,
      { kind: "connector.configure" }
    >,
  ): Promise<ProductConfigurationResult | null> {
    // The retry must repeat the change that was fenced: the same key and the
    // same tunnel, and the file must still hold that key. Anything else is
    // refused and the fence stays.
    if (
      command.runtimeKey === null ||
      command.tunnelId !== retained.tunnelId ||
      connectorKeyDigest(command.runtimeKey) !== retained.digest
    )
      return null;
    if ((await connectorCredentialStore()!.digest()) !== retained.digest)
      return null;
    const completed = await retained.owner.completeSecureMcpCredentialChange(
      { tunnelId: retained.tunnelId },
      retained.generation,
      retained.revision,
    );
    const { durableSourceChanged, ...result } = completed;
    if (result.ok || durableSourceChanged) retainedFence = null;
    else retainedFenceStillOwned(retained.owner.snapshot());
    return ProductConfigurationResultSchema.parse(result);
  }

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
        const retained = retainedFenceStillOwned(current);
        if (
          current.status === "ready" &&
          (current.settings.connectors.secureMcp.runtime?.state ===
            "outcome_unknown" ||
            (current.settings.setup.connect.outcomeUnknown &&
              retained === null))
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
          if (retained?.kind === "complete") {
            const settled = await completeRetainedFence(retained, command);
            return (
              settled ??
              configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN")
            );
          }
          if (retained?.kind === "release") {
            const released = await releaseFence(
              retained.owner,
              retained.generation,
              retained.revision,
            );
            if (!released.ok) return released;
          }
          if (command.runtimeKey !== null) {
            const owner = configuration()!;
            const before = owner.snapshot();
            // Settings owns the admission fence before the private file can be
            // replaced. A failed sync after rename is an uncertain effect, not
            // a known credential refusal or permission to submit it again.
            const pending = await owner.beginSecureMcpCredentialChange();
            if (!pending.ok) {
              // A failed readback may still have published the fence. When the
              // reloaded document is exactly the begin step's output, the key
              // store never ran and the owner may release it.
              if (
                before.status === "ready" &&
                pending.snapshot.status === "ready" &&
                !before.settings.setup.connect.outcomeUnknown &&
                pending.snapshot.settings.setup.connect.outcomeUnknown &&
                pending.snapshot.settings.connectors.secureMcp.generation ===
                  before.settings.connectors.secureMcp.generation + 1 &&
                pending.snapshot.settings.revision ===
                  before.settings.revision + 1
              ) {
                const released = await releaseFence(
                  owner,
                  pending.snapshot.settings.connectors.secureMcp.generation,
                  pending.snapshot.settings.revision,
                );
                if (!released.ok) return released;
                // The begin write failed; report that failure over the released state.
                return ProductConfigurationResultSchema.parse({
                  ...pending,
                  snapshot: owner.snapshot(),
                });
              }
              return ProductConfigurationResultSchema.parse(pending);
            }
            if (pending.snapshot.status !== "ready")
              return configurationFailure(
                "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
              );
            const generation =
              pending.snapshot.settings.connectors.secureMcp.generation;
            try {
              await connectorCredentialStore()!.store(command.runtimeKey);
            } catch (error) {
              // Only a failure the store proves happened before its rename
              // leaves the old key in place. Anything later, or a store that
              // cannot say, keeps the fence and is never replayed.
              if (error instanceof ConnectorKeyNotReplacedError) {
                const released = await releaseFence(
                  owner,
                  generation,
                  pending.snapshot.settings.revision,
                );
                if (!released.ok) return released;
                return configurationFailure(
                  "CONNECTOR_CREDENTIAL_STORE_FAILED",
                );
              }
              return configurationFailure(
                "CONNECTOR_CREDENTIAL_OUTCOME_UNKNOWN",
              );
            }
            const revision = pending.snapshot.settings.revision;
            retainedFence = {
              kind: "complete",
              owner,
              generation,
              revision,
              digest: connectorKeyDigest(command.runtimeKey),
              tunnelId: command.tunnelId,
            };
            const settled = await owner.completeSecureMcpCredentialChange(
              { tunnelId: command.tunnelId },
              generation,
              revision,
            );
            const { durableSourceChanged, ...completed } = settled;
            if (completed.ok || durableSourceChanged) retainedFence = null;
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
  function connectorSetupRefusal(
    command: ConnectorSetupCommand,
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ): Promise<ProductConfigurationResult> {
    return runAdmittedConnectorSetup(
      { operationId: command.operationId, buildId: command.buildId },
      command.tunnelId,
      {
        admission: () => configurationFailure(code),
        current: () => configurationFailure(code).snapshot,
        save: async () => configurationFailure(code),
        start: async () => configurationFailure(code),
      },
    );
  }

  async function configureSaveAndConnect(
    command: ConnectorSetupCommand,
  ): Promise<ProductConfigurationResult> {
    const { reply } = await desktopAdmission.withConfigurationRequest(
      async () => {
        const reserved = await authorityTransitions.withReservation(
          "authority-change",
          async () => {
            if (desktopAdmission.occupied("connector-task"))
              return connectorSetupRefusal(
                command,
                "CONNECTOR_ALREADY_RUNNING",
              );
            const connectorAdmission =
              desktopAdmission.reserveAdmitted("connector-task");
            setActiveAuthorityChangeKind(command.kind);
            try {
              // The combined Save+Connect writes credentials before Start. Fence
              // it against a pending original Stop before either effect starts.
              try {
                const custody = await desktopGoCore()?.observeOriginalStop();
                if (!custody || custody.restricted)
                  return connectorSetupRefusal(
                    command,
                    "AUTHORITY_CHANGE_IN_PROGRESS",
                  );
              } catch {
                return connectorSetupRefusal(
                  command,
                  "AUTHORITY_CHANGE_IN_PROGRESS",
                );
              }
              return await observeConnectorStart(() =>
                runAdmittedConnectorSetup(
                  {
                    operationId: command.operationId,
                    buildId: command.buildId,
                  },
                  command.tunnelId,
                  {
                    admission: () => {
                      if (command.buildId !== buildIdentity().buildId)
                        return configurationFailure(
                          "CONNECTOR_SETUP_BINDING_CHANGED",
                        );
                      if (desktopAdmission.closed())
                        return configurationFailure(
                          "AUTHORITY_CHANGE_IN_PROGRESS",
                        );
                      if (
                        !configuration()! ||
                        !connectorCredentialStore()! ||
                        !secureMcpConnectorRuntime()!
                      )
                        return configurationFailure("SETTINGS_UNAVAILABLE");
                      const current = configuration()!.snapshot();
                      if (current.status !== "ready")
                        return configurationFailure("SETTINGS_UNAVAILABLE");
                      if (
                        secureMcpConnectorRuntime()!.hasUnresolvedEffect() ||
                        // A fence the credential owner itself still holds
                        // recovery state for is admitted so the save step can
                        // settle it; every other unknown outcome is refused.
                        (current.settings.setup.connect.outcomeUnknown &&
                          retainedFenceStillOwned(current) === null) ||
                        current.settings.connectors.secureMcp.runtime?.state ===
                          "outcome_unknown"
                      )
                        return configurationFailure(
                          "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
                        );
                      if (secureMcpConnectorRuntime()!.isRunning())
                        return configurationFailure("CONNECTOR_STOP_REQUIRED");
                      return { ok: true, snapshot: current };
                    },
                    current: () => configuration()!!.snapshot(),
                    save: () =>
                      configureAdmittedProduct({
                        kind: "connector.configure",
                        tunnelId: command.tunnelId,
                        runtimeKey: command.runtimeKey,
                      }),
                    start: () => startAdmittedSecureMcpConnector(false),
                  },
                ),
              );
            } finally {
              connectorAdmission.release();
              setActiveAuthorityChangeKind(null);
            }
          },
        );
        // A deliberately dropped IPC reply must not retain configuration admission.
        // Return a value wrapper so the counter follows work, not reply delivery.
        return {
          reply: deliverConfigurationReply(
            command.kind,
            reserved.admitted
              ? reserved.value
              : await connectorSetupRefusal(
                  command,
                  "AUTHORITY_CHANGE_IN_PROGRESS",
                ),
          ),
        };
      },
    );
    return reply;
  }

  return Object.freeze({
    configureAdmittedConnector,
    connectorSetupRefusal,
    configureSaveAndConnect,
  });
}
