import type { ProductConfigurationSnapshot } from "../../pkg/product-settings/contract";
import { identityBoundWorkspaces } from "./identity-bound-workspaces";

// Resume only a previously ready Computer-only route after confirmed shutdown,
// including a generation-bound update drain that withdrew its live proof.
// An explicit Stop clears the saved runtime. Unknown recovery and selected
// Codex routes require their own deliberate admission, never a startup replay.
export function shouldResumeComputerConnector(
  input: Readonly<{
    environment: "dev" | "preview";
    buildEnvironment: "dev" | "preview";
    previousRunClean: boolean;
    snapshot: ProductConfigurationSnapshot;
  }>,
): boolean {
  if (
    input.environment !== "preview" ||
    input.buildEnvironment !== "preview" ||
    !input.previousRunClean ||
    input.snapshot.status !== "ready"
  )
    return false;
  const settings = input.snapshot.settings;
  const connector = settings.connectors.secureMcp;
  const verification = settings.setup.computer.verified;
  return (
    settings.nativeHosts.taskRoute === null &&
    settings.computer.pendingEdit === null &&
    connector.credential === "stored" &&
    connector.tunnelId !== null &&
    connector.tunnelClient !== null &&
    (connector.runtime?.state === "ready" ||
      (connector.runtime?.state === "unreachable" &&
        settings.setup.connect.unavailable === "CONNECTOR_UPDATE_DRAINED")) &&
    connector.runtime.connectorGeneration === connector.generation &&
    connector.runtime.computerGeneration === settings.computer.generation &&
    !settings.setup.connect.outcomeUnknown &&
    !settings.setup.computer.outcomeUnknown &&
    settings.setup.computer.reachable === "reachable" &&
    verification?.configRevision === settings.computer.generation &&
    identityBoundWorkspaces(settings.computer.workspaces).some(
      (workspace) => workspace.workspaceId === verification.workspaceId,
    )
  );
}
