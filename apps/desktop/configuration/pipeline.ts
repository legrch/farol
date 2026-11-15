import { DesktopAdmission } from "../host/admission";
import { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import { DesktopGoCore } from "../go-core-host";
import { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";

import {
  ProductConfigurationCommandSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import {
  changesComputerAuthority,
  configurationAdmission,
  isDrainedWorkspaceChange,
  workspaceConfigurationRoute,
} from "../../../src/apps/desktop/configuration-admission";
import { type WorkspaceConfigurationCommand } from "../../../src/apps/desktop/workspace-configuration-drain";
import { reportComputerCheckDiagnostic } from "../../../src/apps/desktop/computer-check-diagnostic";

export type ConfigurationPipelinePorts = Readonly<{
  configuration: () => ProductConfigurationService | null;
  desktopGoCore: () => Pick<DesktopGoCore, "observeOriginalStop"> | null;
  connectorRunning: () => boolean;
  connectorStartInFlight: () => Promise<void> | null;
  desktopAdmission: Pick<
    DesktopAdmission,
    "closed" | "withConfigurationRequest" | "occupied" | "reserveAdmitted"
  >;
  authorityTransitions: AuthorityTransitionReservation;
  activeAuthorityChangeKind: () => ProductConfigurationCommand["kind"] | null;
  setActiveAuthorityChangeKind: (
    value: ProductConfigurationCommand["kind"] | null,
  ) => void;
  codexAgentOperationActive: () => boolean;
  configurationFailure: (
    error: Extract<ProductConfigurationResult, { ok: false }>["error"],
    connectorAttempt?: Extract<
      ProductConfigurationResult,
      { ok: false }
    >["connectorAttempt"],
  ) => ProductConfigurationResult;
  computerMcpLifecycle: () => Readonly<{
    hasUnconfirmedStop(): Promise<boolean>;
    beginStop(): Promise<void>;
    confirmStop(): Promise<void>;
  }>;
  configureDrainedWorkspaceChange: (
    command: WorkspaceConfigurationCommand,
  ) => Promise<ProductConfigurationResult>;
  deliverConfigurationReply: (
    commandKind: string,
    result: ProductConfigurationResult,
  ) => ProductConfigurationResult | Promise<ProductConfigurationResult>;
  configureAdmittedProduct: (
    command: ProductConfigurationCommand,
  ) => Promise<ProductConfigurationResult>;
  transitionRefusal: () => ProductConfigurationResult;
}>;

export function createConfigurationPipeline(
  ports: ConfigurationPipelinePorts,
): Readonly<{
  configureNewProductRequest: (
    value: unknown,
  ) => Promise<ProductConfigurationResult>;
  configureUnfencedProduct: (
    value: unknown,
  ) => Promise<ProductConfigurationResult>;
}> {
  const {
    configuration,
    desktopGoCore,
    connectorRunning,
    connectorStartInFlight,
    desktopAdmission,
    authorityTransitions,
    activeAuthorityChangeKind,
    setActiveAuthorityChangeKind,
    codexAgentOperationActive,
    configurationFailure,
    computerMcpLifecycle,
    configureDrainedWorkspaceChange,
    deliverConfigurationReply,
    configureAdmittedProduct,
    transitionRefusal,
  } = ports;

  async function configureNewProductRequest(
    value: unknown,
  ): Promise<ProductConfigurationResult> {
    if (desktopAdmission.closed())
      return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
    return desktopAdmission.withConfigurationRequest(async () => {
      return await configureUnfencedProduct(value);
    });
  }

  async function configureUnfencedProduct(
    value: unknown,
  ): Promise<ProductConfigurationResult> {
    const cfg = configuration();
    if (!cfg) return configurationFailure("SETTINGS_UNAVAILABLE");
    const parsed = ProductConfigurationCommandSchema.safeParse(value);
    if (!parsed.success) return configurationFailure("SETTINGS_INPUT_INVALID");
    const command = parsed.data;
    // Browser presentation neither writes nor publishes configuration evidence.
    // Keep request/quit/update admission, without a Settings reply publication.
    if (command.kind === "chatgpt.present-browser")
      return configureAdmittedProduct(command);
    const admission = configurationAdmission(command.kind, {
      agentActive: codexAgentOperationActive(),
      connectorRunning:
        desktopAdmission.occupied("connector-task") || connectorRunning(),
      workspaceDrainAvailable:
        !desktopAdmission.occupied("connector-task") &&
        connectorStartInFlight() === null,
    });
    if (admission !== "admitted") return configurationFailure(admission);
    if (command.kind === "connector.configure") {
      // Credential replacement crosses the Settings and private-file writers.
      // Serialize it with connector start and authority changes from admission
      // through the terminal Settings result, without starting a second drain.
      const reserved = await authorityTransitions.withReservation(
        "authority-change",
        async () => {
          if (desktopAdmission.occupied("connector-task"))
            return configurationFailure("CONNECTOR_ALREADY_RUNNING");
          const connectorAdmission =
            desktopAdmission.reserveAdmitted("connector-task");
          setActiveAuthorityChangeKind(command.kind);
          try {
            // Credential replacement is a durable Settings/private-file
            // operation, not allowed to bypass unfinished original Stop custody.
            try {
              const custody = await desktopGoCore()?.observeOriginalStop();
              if (!custody || custody.restricted)
                return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
            } catch {
              return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
            }
            return await configureAdmittedProduct(command);
          } finally {
            connectorAdmission.release();
            setActiveAuthorityChangeKind(null);
          }
        },
      );
      return deliverConfigurationReply(
        command.kind,
        reserved.admitted ? reserved.value : transitionRefusal(),
      );
    }
    if (!changesComputerAuthority(command.kind)) {
      return deliverConfigurationReply(
        command.kind,
        await configureAdmittedProduct(command),
      );
    }
    const reservation = authorityTransitions.withReservation(
      "authority-change",
      async () => {
        setActiveAuthorityChangeKind(command.kind);
        try {
          if (isDrainedWorkspaceChange(command.kind)) {
            let route: ReturnType<typeof workspaceConfigurationRoute>;
            try {
              route = workspaceConfigurationRoute(
                await computerMcpLifecycle().hasUnconfirmedStop(),
                connectorRunning(),
              );
            } catch {
              return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
            }
            if (route === "unconfirmed")
              return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
            if (route === "drain")
              return await configureDrainedWorkspaceChange(
                command as WorkspaceConfigurationCommand,
              );
          }
          let stopStage: "begin-stop" | "confirm-stop" = "begin-stop";
          try {
            // This direct authority-change path predates C7 and otherwise
            // calls beginStop without a parent. Admit it only when Go confirms
            // there is no pending original prerequisite.
            const custody = await desktopGoCore()?.observeOriginalStop();
            if (!custody || custody.restricted)
              return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
            const lifecycle = computerMcpLifecycle();
            await lifecycle.beginStop();
            stopStage = "confirm-stop";
            await lifecycle.confirmStop();
          } catch (error) {
            reportComputerCheckDiagnostic(
              console.warn,
              `settings:${command.kind}${"workspaceId" in command ? `:${command.workspaceId}` : ""}`,
              stopStage,
              error,
            );
            return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
          }
          return await configureAdmittedProduct(command);
        } finally {
          setActiveAuthorityChangeKind(null);
        }
      },
    );
    // withReservation tries to acquire synchronously before its first await.
    // Capture the holder now: reading it after awaiting a refusal could name
    // a later transition, or none at all.
    const activeCommandAtAdmission = activeAuthorityChangeKind();
    const reserved = await reservation;
    if (!reserved.admitted) {
      console.warn(
        "farol.authority-transition-refused",
        JSON.stringify({
          requested: command.kind,
          heldBy: reserved.heldBy,
          activeCommand: activeCommandAtAdmission,
        }),
      );
    }
    return deliverConfigurationReply(
      command.kind,
      reserved.admitted ? reserved.value : transitionRefusal(),
    );
  }

  return Object.freeze({
    configureNewProductRequest,
    configureUnfencedProduct,
  });
}
