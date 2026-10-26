export type ComputerConnectorDrainPorts = Readonly<{
  beginStop(): Promise<void>;
  startInFlight: Promise<void> | null;
  waitForMcpStop(): Promise<void>;
  stopConnector(): Promise<void>;
  closeSavedChat(): Promise<void>;
  confirmStop(): Promise<void>;
}>;

const stopFailureCodes = new Set([
  "COMPUTER_MCP_INSTANCE_CLEANUP_UNVERIFIED",
  "COMPUTER_MCP_SHELL_CLEANUP_UNVERIFIED",
  "COMPUTER_MCP_LIFECYCLE_STOP_UNVERIFIED",
  "COMPUTER_MCP_LIFECYCLE_UNVERIFIED",
  "CONNECTOR_STOP_UNCONFIRMED",
]);

function classifiedStopFailure(error: unknown): unknown {
  try {
    if (!(error instanceof Error)) return error;
    // These local adapters historically throw a closed code as an Error message.
    // Read only an own data property; never call an exception getter or record
    // arbitrary exception text, stacks, paths or causes in Operations.
    const message = Object.getOwnPropertyDescriptor(error, "message");
    const code = message && "value" in message ? message.value : undefined;
    if (typeof code !== "string" || !stopFailureCodes.has(code)) return error;
    return Object.assign(new Error(code, { cause: error }), {
      state: "outcome_unknown" as const,
      code,
    });
  } catch {
    return error;
  }
}

export async function drainComputerConnector(
  ports: ComputerConnectorDrainPorts,
): Promise<void> {
  try {
    await drain(ports);
  } catch (error) {
    // Classification supplies diagnostics only, never a Stop acknowledgement.
    // Preserve unclassified exceptions and retain the original classified cause.
    throw classifiedStopFailure(error);
  }
}

async function drain(ports: ComputerConnectorDrainPorts): Promise<void> {
  try {
    await ports.beginStop();
    await ports.startInFlight;
    try {
      await ports.waitForMcpStop();
    } finally {
      await ports.stopConnector();
    }
  } finally {
    // Withdraw account admission on every stop outcome, while waiting for
    // already admitted work. A failed MCP/connector drain remains a failure.
    await ports.closeSavedChat();
  }
  await ports.confirmStop();
}
