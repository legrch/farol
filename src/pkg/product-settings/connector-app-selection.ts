import type { ProductSettings, SecureMcpConnector } from "./contract";

// An explicit app label is a routing choice. A known ready restart of the
// same tunnel can carry that choice into its new generation, never its proof.
export function restartedConnectorAppSelection(settings: ProductSettings) {
  const connector = settings.connectors.secureMcp;
  const selected = connector.chatgptApp;
  const runtime = connector.runtime;
  if (
    !selected ||
    selected.tunnelId !== connector.tunnelId ||
    selected.connectorGeneration > connector.generation ||
    connector.appVerificationPending === true ||
    settings.setup.connect.outcomeUnknown ||
    runtime?.state !== "ready" ||
    runtime.connectorGeneration !== connector.generation ||
    runtime.computerGeneration !== settings.computer.generation
  )
    return null;
  return { ...selected, connectorGeneration: connector.generation };
}

// An app label is a routing choice, not proof of attachment. The local MCP
// challenge receipt still has to match the current build/runtime/workspace.
export function selectedConnectorApp(
  connector: SecureMcpConnector,
): string | null {
  const selected = connector.chatgptApp;
  return selected != null &&
    selected.tunnelId === connector.tunnelId &&
    selected.connectorGeneration === connector.generation
    ? selected.name
    : null;
}
