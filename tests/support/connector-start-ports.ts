import type { ConnectorStartPorts } from "../../apps/desktop/connector/start";

// Ports for apps/desktop/connector/start.ts read from one mutable fixture
// object under the names main.ts gives its own state and functions. A test
// changes a field and the next read sees it, the way main.ts lends its module
// state. The two start-flight fields are written back to the same object, as
// main assigns its own. A port the test did not script fails loudly at the
// call that needs it. Test-only: this grants no host authority and proves no
// native, filesystem or provider behavior.
export function connectorStartHost(
  fixture: Record<string, unknown>,
): ConnectorStartPorts {
  const missing = (name: string): never => {
    throw new Error(`PORT_UNSCRIPTED:${name}`);
  };
  // A shared owner that is read once when the module is built: a test that
  // never uses it gets a value that fails loudly the moment it is touched.
  const owner = (name: string): unknown =>
    name in fixture
      ? fixture[name]
      : new Proxy(
          {},
          {
            get: (_target, property) => missing(`${name}.${String(property)}`),
          },
        );
  const read =
    <T>(name: string) =>
    () =>
      (name in fixture ? fixture[name] : missing(name)) as T;
  const call =
    (name: string) =>
    (...args: unknown[]) => {
      const target = fixture[name];
      if (typeof target !== "function") return missing(name);
      return (target as (...values: unknown[]) => unknown)(...args);
    };
  const host = {
    configuration: read("configuration"),
    connectorCredentialStore: read("connectorCredentialStore"),
    secureMcpConnectorRuntime: read("secureMcpConnectorRuntime"),
    desktopGoCore: read("desktopGoCore"),
    summaryFenceRecovery: read("summaryFenceRecovery"),
    connectorStartCancellation: read("connectorStartCancellation"),
    setConnectorStartCancellation: (next: AbortController | null) => {
      fixture.connectorStartCancellation = next;
    },
    setConnectorStartInFlight: (next: Promise<void> | null) => {
      fixture.connectorStartInFlight = next;
    },
    // By reference in main (`const`), read once when the module is built.
    get desktopAdmission() {
      return owner("desktopAdmission");
    },
    get authorityTransitions() {
      return owner("authorityTransitions");
    },
    get buildIdentity() {
      return owner("buildIdentity");
    },
    get directory() {
      return owner("directory");
    },
    get installedUpdates() {
      return owner("installedUpdates");
    },
    randomUUID: call("randomUUID"),
    operationsStore: call("operationsStore"),
    statePaths: call("statePaths"),
    configurationFailure: call("configurationFailure"),
    transitionRefusal: call("transitionRefusal"),
    stopAndConfirmComputerMcp: call("stopAndConfirmComputerMcp"),
    computerMcpLifecycle: call("computerMcpLifecycle"),
    e2eTunnelClientExecutable: call("e2eTunnelClientExecutable"),
    verifyTunnelClientExecutable: call("verifyTunnelClientExecutable"),
    verifySelectedTunnelClient: call("verifySelectedTunnelClient"),
    clearConnectorVerificationReceipt: call(
      "clearConnectorVerificationReceipt",
    ),
    connectorAttemptGeneration: call("connectorAttemptGeneration"),
  };
  return host as unknown as ConnectorStartPorts;
}
