export type ComputerConnectorDrainPorts = Readonly<{
  beginStop(): Promise<void>;
  startInFlight: Promise<void> | null;
  waitForMcpStop(): Promise<void>;
  stopConnector(): Promise<void>;
  closeSavedChat(): Promise<void>;
  confirmStop(): Promise<void>;
}>;

export async function drainComputerConnector(
  ports: ComputerConnectorDrainPorts,
): Promise<void> {
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
