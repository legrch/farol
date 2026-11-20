import { createHash, randomUUID } from "node:crypto";

import type {
  ProductConfigurationCommand,
  ProductConfigurationResult,
  ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import type {
  ContinuityDrainCommand,
  WorkspaceConfigurationCommand,
} from "../../../src/apps/desktop/workspace-configuration-drain";
import { WorkspaceConfigurationDrain } from "../../../src/apps/desktop/workspace-configuration-drain";

import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import type { KnownStop } from "../../../src/apps/desktop/workspace-continuity-sequence";
import { BridgeError } from "../bridge/client";
import type { DesktopGoCore } from "../go-core-host";
import type { DesktopAdmission } from "../host/admission";
import type { startSavedChatBridge } from "../../../src/apps/desktop/saved-chat-bridge";
import type { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";

export type WorkspaceAuthorityChangeKind =
  ProductConfigurationCommand["kind"] | ContinuityDrainCommand["kind"];

export type ContinuityDrainResult =
  | KnownStop
  | Readonly<{
      state: "refused" | "unknown";
      phase: "stop" | "record-stopped";
    }>;

type ComputerMcpLifecycle = Readonly<{
  hasUnconfirmedStop(): Promise<boolean>;
  confirmedOriginalStop(): Readonly<{
    lifecycleId: string;
    stopRevision: string;
    preparationRevision: string;
  }> | null;
}>;

type OriginalConnectorCleanupProof = Readonly<{
  parentOperationId: string;
  effectId: string;
  readback: "verified-absent";
  digest: string;
}>;

export type ConfigurationDrainPorts = Readonly<{
  configuration: () => ProductConfigurationService | null;
  secureMcpConnectorRuntime: () => SecureMcpConnectorRuntime | null;
  desktopGoCore: () => DesktopGoCore | null;
  desktopAdmission: Pick<DesktopAdmission, "occupied" | "acquire" | "closed">;
  connectorStartInFlight: () => Promise<void> | null;
  transitionRefusal: () => ProductConfigurationResult;
  configurationFailure: (
    error: Extract<ProductConfigurationResult, { ok: false }>["error"],
    connectorAttempt?: Extract<
      ProductConfigurationResult,
      { ok: false }
    >["connectorAttempt"],
  ) => ProductConfigurationResult;
  authorityTransitions: AuthorityTransitionReservation;
  activeAuthorityChangeKind: () => WorkspaceAuthorityChangeKind | null;
  setActiveAuthorityChangeKind: (
    value: WorkspaceAuthorityChangeKind | null,
  ) => void;
  codexAgentOperationActive: () => boolean;
  computerMcpLifecycle: () => ComputerMcpLifecycle;
  stopAndConfirmComputerMcp: (
    connector: SecureMcpConnectorRuntime | null,
    inFlightStart: Promise<void> | null,
    core: DesktopGoCore | null,
    savedChat: Awaited<ReturnType<typeof startSavedChatBridge>> | null,
    reason?: "owner_stop",
    originalStopParent?: string,
    quitStartDeadlineAt?: number,
  ) => Promise<void>;
  savedChatBridgeRuntime: () => Awaited<
    ReturnType<typeof startSavedChatBridge>
  > | null;
  statePaths: () => Readonly<{ secureMcpLaunch: string }>;
  configureAdmittedProduct: (
    command: ProductConfigurationCommand,
  ) => Promise<ProductConfigurationResult>;
  ownerComputerConsentDigest: (settings: ProductSettings) => string;
  connectorRuntimeUncertain: (settings: ProductSettings) => boolean;
  clearAndConfirmOriginalConnectorVerificationReceipt: (
    root: string,
    parentOperationId: string,
    effectId: string,
  ) => Promise<OriginalConnectorCleanupProof>;
}>;

export function createConfigurationDrain(
  ports: ConfigurationDrainPorts,
): Readonly<{
  configureDrainedWorkspaceChange: (
    command: WorkspaceConfigurationCommand,
  ) => Promise<ProductConfigurationResult>;
  drainContinuityPrerequisite: (
    command: ContinuityDrainCommand,
  ) => Promise<ContinuityDrainResult>;
}> {
  async function runDrain<Result>(
    command: WorkspaceConfigurationCommand | ContinuityDrainCommand,
    apply: (stopped: KnownStop) => Promise<Result>,
    fail: (
      state: "refused" | "unknown",
      phase: "stop" | "record-stopped",
      error?: Extract<ProductConfigurationResult, { ok: false }>["error"],
    ) => Result,
  ): Promise<Result> {
    const owner = ports.configuration();
    const connector = ports.secureMcpConnectorRuntime();
    const core = ports.desktopGoCore();
    const original = owner?.snapshot();
    if (
      !owner ||
      !connector ||
      !core ||
      original?.status !== "ready" ||
      ports.desktopAdmission.occupied("connector-task") ||
      ports.connectorStartInFlight() !== null
    )
      return fail("refused", "stop");
    const connectorAdmission = ports.desktopAdmission.acquire("connector-task");
    if (!connectorAdmission) return fail("refused", "stop");
    try {
      try {
        const custody = await core.observeComputerContinuity();
        if (custody.restricted || custody.pendingOperationId !== undefined)
          return fail("refused", "stop", "AUTHORITY_CHANGE_IN_PROGRESS");
      } catch {
        return fail("refused", "stop", "AUTHORITY_CHANGE_IN_PROGRESS");
      }
      const requestedId =
        "workspaceId" in command ? command.workspaceId : undefined;
      const target =
        requestedId === undefined
          ? undefined
          : original.settings.computer.workspaces.find(
              (item) => item.workspaceId === requestedId,
            );
      const connectorBinding = core.currentComputerConnectorBinding();
      if (
        (requestedId !== undefined && !target) ||
        !connectorBinding ||
        !connector.isRunning()
      )
        return fail("refused", "stop", "AUTHORITY_CHANGE_IN_PROGRESS");
      const sha = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const originalStopId = randomUUID();
      const stopEffectId = randomUUID();
      const settingsEffectId = randomUUID();
      const cleanupEffectId = randomUUID();
      const originalConsent = ports.ownerComputerConsentDigest(
        original.settings,
      );
      const request = {
        operationId: originalStopId,
        requestDigest: sha({
          command,
          revision: original.settings.revision,
          computerGeneration: original.settings.computer.generation,
          connectorGeneration:
            original.settings.connectors.secureMcp.generation,
        }),
        commandKind: command.kind,
        commandDigest: sha(command),
        purpose: "workspace-change" as const,
        ...(target
          ? { workspaceId: target.workspaceId, root: target.root }
          : {}),
        consentDigest: originalConsent,
        expectedRevision: String(original.settings.revision),
        computerGeneration: String(original.settings.computer.generation),
        connectorGeneration: String(
          original.settings.connectors.secureMcp.generation,
        ),
        settingsDigest: sha(original.settings),
        stopEffectId,
        settingsEffectId,
        cleanupEffectId,
        ...("childOperationId" in command
          ? {
              childOperationId: command.childOperationId,
              childMode:
                command.kind === "computer.confirm-workspace"
                  ? ("legacy-confirm" as const)
                  : ("enrolled-rebind" as const),
            }
          : {}),
      };
      const computerGeneration = original.settings.computer.generation;
      const connectorGeneration =
        original.settings.connectors.secureMcp.generation;
      let revision = original.settings.revision;
      let stoppedReceipt: KnownStop | undefined;
      let phaseFailure: "SETTINGS_WRITE_FAILED" | undefined;

      const current = () => {
        const snapshot = owner.snapshot();
        return (
          ports.configuration() === owner &&
          ports.secureMcpConnectorRuntime() === connector &&
          ports.desktopGoCore() === core &&
          ports.authorityTransitions.current() === "authority-change" &&
          ports.activeAuthorityChangeKind() === command.kind &&
          ports.desktopAdmission.occupied("connector-task") &&
          !ports.desktopAdmission.closed() &&
          !ports.codexAgentOperationActive() &&
          !connector.hasUnresolvedEffect() &&
          snapshot.status === "ready" &&
          snapshot.settings.revision === revision &&
          snapshot.settings.computer.generation === computerGeneration &&
          snapshot.settings.connectors.secureMcp.generation ===
            connectorGeneration &&
          ports.ownerComputerConsentDigest(snapshot.settings) ===
            originalConsent &&
          !ports.connectorRuntimeUncertain(snapshot.settings)
        );
      };
      const drain = new WorkspaceConfigurationDrain(command, {
        current,
        stop: async () => {
          if (await ports.computerMcpLifecycle().hasUnconfirmedStop())
            throw new Error("CONNECTOR_STOP_UNCONFIRMED");
          if (!current()) return false;
          const admitted = await core
            .beginOriginalStop(request)
            .catch((error: unknown) => {
              if (
                "childOperationId" in command &&
                error instanceof BridgeError &&
                error.state === "refused"
              )
                return null;
              throw error;
            });
          if (admitted === null) return false;
          if (
            admitted.runtimeId !== connectorBinding.runtimeId ||
            admitted.backendGeneration !== connectorBinding.backendGeneration ||
            admitted.buildId !== connectorBinding.buildId ||
            ("childOperationId" in command && !current())
          )
            throw new Error("CONNECTOR_STOP_UNCONFIRMED");
          await ports.stopAndConfirmComputerMcp(
            connector,
            null,
            core,
            ports.savedChatBridgeRuntime(),
            undefined,
            originalStopId,
          );
          const lifecycle = ports
            .computerMcpLifecycle()
            .confirmedOriginalStop();
          const closure = core.computerConnectorClosureReceipt();
          if (
            !lifecycle ||
            !closure ||
            !closure.result.closed ||
            closure.result.binding.runtimeId !== admitted.runtimeId ||
            closure.result.binding.backendGeneration !==
              admitted.backendGeneration
          )
            throw new Error("CONNECTOR_STOP_UNCONFIRMED");
          await core.advanceOriginalStop({
            parentOperationId: originalStopId,
            phase: "stop_ack",
            closure: {
              effectId: stopEffectId,
              backendGeneration: admitted.backendGeneration,
              runtimeId: admitted.runtimeId,
              lifecycleId: lifecycle.lifecycleId,
              stopRevision: lifecycle.stopRevision,
              preparationRevision: lifecycle.preparationRevision,
              closureOperationId: closure.operationId,
              closureDigest: sha(closure.result),
            },
          });
          return true;
        },
        recordStopped: async () => {
          const originalCurrent = () => {
            const snap = owner.snapshot();
            return (
              ports.configuration() === owner &&
              ports.secureMcpConnectorRuntime() === connector &&
              ports.desktopGoCore() === core &&
              ports.authorityTransitions.current() === "authority-change" &&
              ports.desktopAdmission.occupied("connector-task") &&
              !ports.desktopAdmission.closed() &&
              !ports.codexAgentOperationActive() &&
              !connector.hasUnresolvedEffect() &&
              snap.status === "ready" &&
              snap.settings.computer.generation === computerGeneration &&
              snap.settings.connectors.secureMcp.generation ===
                connectorGeneration &&
              !ports.connectorRuntimeUncertain(snap.settings)
            );
          };
          const stopped = await owner.commitOriginalStoppedSettings(
            {
              effectId: settingsEffectId,
              expectedRevision: revision,
              expectedDigest: request.settingsDigest,
              computerGeneration,
              connectorGeneration,
              consentDigest: request.consentDigest,
            },
            async (plan) => {
              await core.advanceOriginalStop({
                parentOperationId: originalStopId,
                phase: "settings_intent",
                settingsIntent: plan,
              });
            },
            originalCurrent,
          );
          if (stopped.status !== "committed") {
            phaseFailure = "SETTINGS_WRITE_FAILED";
            return "unknown";
          }
          await core.advanceOriginalStop({
            parentOperationId: originalStopId,
            phase: "settings_ack",
            settingsAck: stopped.receipt,
          });
          revision = stopped.settings.revision;
          if (!current()) return "unknown";
          await core.advanceOriginalStop({
            parentOperationId: originalStopId,
            phase: "cleanup_intent",
          });
          const cleanupProof =
            await ports.clearAndConfirmOriginalConnectorVerificationReceipt(
              ports.statePaths().secureMcpLaunch,
              originalStopId,
              cleanupEffectId,
            );
          if (
            cleanupProof.parentOperationId !== originalStopId ||
            cleanupProof.effectId !== cleanupEffectId ||
            cleanupProof.readback !== "verified-absent"
          )
            throw new Error("CONNECTOR_ATTACHMENT_INVALID");
          await core.advanceOriginalStop({
            parentOperationId: originalStopId,
            phase: "cleanup_ack",
            cleanupAck: {
              effectId: cleanupEffectId,
              backendGeneration: connectorBinding.backendGeneration,
              runtimeId: connectorBinding.runtimeId,
              digest: cleanupProof.digest,
            },
          });
          await core.advanceOriginalStop({
            parentOperationId: originalStopId,
            phase: "prerequisite_complete",
          });
          stoppedReceipt = {
            state: "confirmed",
            operationId: originalStopId,
            revision: stopped.settings.revision,
            generation: stopped.settings.computer.generation,
          };
          return true;
        },
        apply: () => {
          if (!stoppedReceipt) throw new Error("CONNECTOR_STOP_UNCONFIRMED");
          return apply(stoppedReceipt);
        },
      });
      const outcome = await drain.run();
      if (
        outcome.status === "completed" ||
        (outcome.status === "stale" && outcome.phase === "apply")
      )
        return outcome.result;
      const phase =
        outcome.phase === "stop" || outcome.phase === "admission"
          ? "stop"
          : "record-stopped";
      if (
        outcome.status === "unknown" ||
        ("childOperationId" in command &&
          (outcome.status === "stale" || phase === "record-stopped"))
      )
        return fail(
          "unknown",
          phase,
          phaseFailure ??
            (phase === "stop"
              ? "CONNECTOR_STOP_UNCONFIRMED"
              : "SETTINGS_WRITE_FAILED"),
        );
      return fail("refused", phase);
    } finally {
      connectorAdmission.release();
    }
  }

  function configureDrainedWorkspaceChange(
    command: WorkspaceConfigurationCommand,
  ) {
    return runDrain(
      command,
      () => ports.configureAdmittedProduct(command),
      (_state, _phase, error) =>
        error ? ports.configurationFailure(error) : ports.transitionRefusal(),
    );
  }

  async function drainContinuityPrerequisite(
    command: ContinuityDrainCommand,
  ): Promise<ContinuityDrainResult> {
    if (
      command.kind !== "computer.confirm-workspace" &&
      command.kind !== "computer.rebind-workspace"
    )
      return { state: "refused", phase: "stop" };
    return runDrain<ContinuityDrainResult>(
      command,
      async (stopped) => stopped,
      (state, phase) => ({ state, phase }),
    );
  }

  return Object.freeze({
    configureDrainedWorkspaceChange,
    drainContinuityPrerequisite,
  });
}
