import type { ConnectorSupervisorPorts } from "../../apps/desktop/connector/supervisor";

// Ports for apps/desktop/connector/supervisor.ts read from one mutable fixture
// object under the names main.ts gives its own state and functions. A test
// changes a field and the next predicate sees it, the way main.ts lends its
// module state. A missing function fails at the call that needs it.
export function connectorHost(
  fixture: Record<string, unknown>,
): ConnectorSupervisorPorts {
  const read =
    <T>(name: string) =>
    () =>
      fixture[name] as T;
  const call =
    (name: string) =>
    (...args: unknown[]) =>
      (fixture[name] as (...values: unknown[]) => unknown)(...args);
  const host = {
    configuration: read("configuration"),
    secureMcpConnectorRuntime: read("secureMcpConnectorRuntime"),
    desktopGoCore: read("desktopGoCore"),
    window: read("window"),
    quitInProgress: read("quitInProgress"),
    installedUpdateAdmission: read("installedUpdateAdmission"),
    connectorTaskAdmission: read("connectorTaskAdmission"),
    setConnectorTaskAdmission: (value: boolean) => {
      fixture.connectorTaskAdmission = value;
    },
    connectorTaskAdmissionPurpose: read("connectorTaskAdmissionPurpose"),
    connectorStartInFlight: read("connectorStartInFlight"),
    configurationRequests: read("configurationRequests"),
    summaryFenceRecovery: read("summaryFenceRecovery"),
    workspaceMutationAdmission: read("workspaceMutationAdmission"),
    authorityTransitions: read("authorityTransitions"),
    powerMonitor: read("powerMonitor"),
    get buildId() {
      return (fixture.buildIdentity as { buildId: string }).buildId;
    },
    get isolatedE2EHome() {
      return fixture.isolatedE2EHome as string | undefined;
    },
    codexAgentOperationActive: call("codexAgentOperationActive"),
    operationsStore: call("operationsStore"),
    computerMcpLifecycle: call("computerMcpLifecycle"),
    stopAndConfirmComputerMcp: call("stopAndConfirmComputerMcp"),
    observeConnectorStart: call("observeConnectorStart"),
    startAdmittedSecureMcpConnector: call("startAdmittedSecureMcpConnector"),
    recordConnectorRuntime: call("recordConnectorRuntime"),
    reportConnectorTransport: call("reportConnectorTransport"),
    transitionRefusal: call("transitionRefusal"),
    configurationFailure: call("configurationFailure"),
  };
  return host as unknown as ConnectorSupervisorPorts;
}
