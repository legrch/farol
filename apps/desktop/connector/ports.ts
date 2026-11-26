import type { DesktopReservation } from "../host/admission";
import type { BrowserWindow, PowerMonitor } from "electron";
import type { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import type { SummaryFenceRecovery } from "../../../src/apps/desktop/summary-fence-recovery";
import type { ProductConfigurationResult } from "../../../src/pkg/product-settings/contract";
import type { ComputerConnectorBinding } from "../bridge/wire";
import type { DesktopGoCore } from "../go-core-host";
import type { OperationsStore } from "../operations/store";
import type { ConnectorTransportCapture } from "./capture";

/** Main-process state and owners, read at the moment a predicate runs. */
export type ConnectorSupervisorPorts = Readonly<{
  configuration(): ProductConfigurationService | null;
  secureMcpConnectorRuntime(): SecureMcpConnectorRuntime | null;
  desktopGoCore(): DesktopGoCore | null;
  window(): BrowserWindow | null;
  quitInProgress(): boolean;
  installedUpdateAdmission(): boolean;
  connectorTaskAdmission(): boolean;
  reserveConnectorTask(): DesktopReservation;
  connectorTaskAdmissionPurpose(): "manual-diagnostic" | null;
  connectorStartInFlight(): Promise<void> | null;
  configurationRequests(): number;
  summaryFenceRecovery(): SummaryFenceRecovery | null;
  workspaceMutationAdmission(): boolean;
  codexAgentOperationActive(): boolean;
  authorityTransitions(): AuthorityTransitionReservation;
  operationsStore(): OperationsStore;
  /** `buildIdentity.buildId` of this process. */
  buildId: string;
  /** The isolated native-test home, absent from ordinary owner launches. */
  isolatedE2EHome: string | undefined;
  powerMonitor(): Pick<PowerMonitor, "on" | "removeListener">;
  computerMcpLifecycle(): Readonly<{ hasUnconfirmedStop(): Promise<boolean> }>;
  stopAndConfirmComputerMcp(
    connector: SecureMcpConnectorRuntime,
    inFlightStart: null,
    core: DesktopGoCore,
  ): Promise<void>;
  observeConnectorStart(
    work: () => Promise<ProductConfigurationResult>,
  ): Promise<ProductConfigurationResult>;
  startAdmittedSecureMcpConnector(
    repair: boolean,
    resumeAfterQuit: boolean,
    recoveryFrom: ComputerConnectorBinding,
    recoveryCurrent: () => boolean,
  ): Promise<ProductConfigurationResult>;
  recordConnectorRuntime(
    state: "ready" | "unreachable" | "outcome_unknown",
    runtimeGeneration: string,
    computerGeneration: number,
  ): Promise<ProductConfigurationResult | null>;
  reportConnectorTransport(
    original: ConnectorTransportCapture,
    code: string,
  ): void;
  transitionRefusal(): ProductConfigurationResult;
  configurationFailure(
    error: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ): ProductConfigurationResult;
}>;
