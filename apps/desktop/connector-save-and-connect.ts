import {
  connectorSetupStepResult,
  readConnectorSetupIdentity,
  type ConnectorSetupIdentity,
  type ConnectorSetupReceipt,
  type ConnectorSetupStep,
  type ConnectorSetupStage,
  type ConnectorSetupStepResult,
} from "../../src/pkg/product-settings/connector-setup-receipt";

/**
 * Two fixed host-owned steps, not an authority service or a recovery journal.
 *
 * The composition root supplies the existing admission/credential/start owners.
 * It must retain their native receipts and durable UNKNOWN fences. This adapter
 * does not start processes, inspect credentials, save settings, retry a step,
 * provide a timeout/cancellation mechanism, or assert external attachment.
 */
export type ConnectorSetupPorts = Readonly<{
  /**
   * Revalidate actual profile/build/generations, Quit/update state and ownership.
   * This port must not perform a save/start, clear an UNKNOWN, or claim a grant.
   * The host must keep its existing reservation across check -> native effect;
   * this callback by itself is not a lock and cannot prevent a TOCTOU race.
   */
  admit(
    step: ConnectorSetupStep,
    identity: ConnectorSetupIdentity,
  ): Promise<unknown>;
  /** Must call the durable credential owner, not the key file directly. */
  saveCredentials(identity: ConnectorSetupIdentity): Promise<unknown>;
  /** Must call the existing admitted start owner, never a retry or fallback. */
  connect(identity: ConnectorSetupIdentity): Promise<unknown>;
}>;

/**
 * Construct ONCE for one already-admitted request. Every run() call joins the
 * same promise, including after a known refusal. Re-instantiation is not replay
 * protection: the composition root still owns request identity/admission.
 * Ports close over the secret only where required; no secret belongs in identity,
 * result, error, telemetry or a retained renderer intent.
 */
export function createConnectorSaveAndConnect(
  identity: ConnectorSetupIdentity,
  ports: ConnectorSetupPorts,
): Readonly<{ run(): Promise<ConnectorSetupReceipt> }> {
  const captured = readConnectorSetupIdentity(identity);
  if (!captured) throw new Error("CONNECTOR_SETUP_IDENTITY_INVALID");
  const selected: ConnectorSetupIdentity = captured;
  // Capture method references; a caller cannot replace a later stage while an
  // earlier one is awaiting its original result. Receiver identity is preserved.
  const admit = ports.admit.bind(ports);
  const saveCredentials = ports.saveCredentials.bind(ports);
  const connect = ports.connect.bind(ports);
  let original: Promise<ConnectorSetupReceipt> | undefined;
  const observe = async (
    read: () => Promise<unknown>,
    allowConnectorAttempt = false,
  ) => {
    try {
      const result = connectorSetupStepResult(await read());
      return !allowConnectorAttempt && "connectorAttempt" in result
        ? connectorSetupStepResult(null)
        : result;
    } catch {
      // Never include exception.message, stack, a response body or the command.
      return connectorSetupStepResult(null);
    }
  };
  function receipt(
    stoppedAt: ConnectorSetupStage,
    result: ConnectorSetupStepResult,
    credentials: ConnectorSetupReceipt["credentials"],
    connection: ConnectorSetupReceipt["connection"],
  ): ConnectorSetupReceipt {
    return Object.freeze({
      kind: "connector.save-and-connect",
      ...selected,
      state: result.state,
      stoppedAt,
      credentials,
      connection,
      code: result.code,
      externalVerification: "not-proven",
      ...("connectorAttempt" in result && result.connectorAttempt
        ? { connectorAttempt: result.connectorAttempt }
        : {}),
    });
  }
  async function execute(): Promise<ConnectorSetupReceipt> {
    const admitted = await observe(() => admit("credentials", selected));
    if (admitted.state !== "completed")
      return receipt(
        "credential-admission",
        admitted,
        "not-started",
        "not-started",
      );
    const saved = await observe(() => saveCredentials(selected));
    if (saved.state !== "completed")
      return receipt("credentials", saved, saved.state, "not-started");
    const current = await observe(() => admit("connection", selected));
    if (current.state !== "completed")
      return receipt("connection-admission", current, "saved", "not-started");
    const connected = await observe(() => connect(selected), true);
    if (connected.state !== "completed")
      return receipt("connection", connected, "saved", connected.state);
    return receipt("complete", connected, "saved", "connected");
  }
  return Object.freeze({
    run() {
      // Install the latch BEFORE any callback (including synchronous throws or
      // re-entrant run calls). There is no detached step or Promise.race timeout.
      original ??= Promise.resolve().then(execute);
      return original;
    },
  });
}
