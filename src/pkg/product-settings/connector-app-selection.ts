import type { SecureMcpConnector } from "./contract";

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
