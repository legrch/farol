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
  await ports.beginStop();
  await ports.startInFlight;
  try {
    await ports.waitForMcpStop();
  } finally {
    await ports.stopConnector();
  }
  await ports.closeSavedChat();
  await ports.confirmStop();
}
