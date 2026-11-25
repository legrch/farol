import type { ConnectorVerifyPorts } from "../../apps/desktop/connector/verify";

// Ports for apps/desktop/connector/verify.ts read from one mutable fixture
// object under the names main.ts gives its own state and functions. A test
// changes a field and the next read sees it, the way main.ts lends its module
// state. A port the test did not script fails loudly at the call that needs
// it. Test-only: this grants no host authority and proves no native,
// filesystem or provider behavior.
export function connectorVerifyHost(
  fixture: Record<string, unknown>,
): ConnectorVerifyPorts {
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
  const dialog = () =>
    (fixture.dialog ?? missing("dialog")) as {
      showMessageBox: (...args: unknown[]) => unknown;
    };
  const host = {
    configuration: read("configuration"),
    chatGptRoute: read("chatGptRoute"),
    secureMcpConnectorRuntime: read("secureMcpConnectorRuntime"),
    desktopGoCore: read("desktopGoCore"),
    window: read("window"),
    selectedTaskId: read("selectedTaskId"),
    get desktopAdmission() {
      return owner("desktopAdmission");
    },
    get buildIdentity() {
      return owner("buildIdentity");
    },
    get connectorConnection() {
      return owner("connectorConnection");
    },
    runtimeEnvironment: String(fixture.runtimeEnvironment ?? "test"),
    randomUUID: call("randomUUID"),
    statePaths: call("statePaths"),
    configurationFailure: call("configurationFailure"),
    embeddedBrowserEnabled: call("embeddedBrowserEnabled"),
    chatGptTaskAdmissionReady: call("chatGptTaskAdmissionReady"),
    showMessageBox: (...args: unknown[]) => dialog().showMessageBox(...args),
    connectorCheck: call("connectorCheck"),
    currentConnectionStatus: call("currentConnectionStatus"),
    connectorVerificationProof: call("connectorVerificationProof"),
    connectorAppVerificationAttemptExists: call(
      "connectorAppVerificationAttemptExists",
    ),
    confirmSeparateAppVerificationAttempt: call(
      "confirmSeparateAppVerificationAttempt",
    ),
    prepareConnectorAppVerificationAttempt: call(
      "prepareConnectorAppVerificationAttempt",
    ),
    prepareConnectorCheckDocument: call("prepareConnectorCheckDocument"),
    waitForConnectorAppReceipt: call("waitForConnectorAppReceipt"),
  };
  return host as unknown as ConnectorVerifyPorts;
}
