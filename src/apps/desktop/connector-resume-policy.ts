import type { ProductConfigurationSnapshot } from "../../pkg/product-settings/contract";
import { identityBoundWorkspaces } from "./identity-bound-workspaces";

/** Restore a confirmed, same-session update drain only after admission releases.
 * This never retries a task, a refused start, or an unknown stop/helper effect.
 * The normal connector start still checks the selected executable and grants.
 */
export function createUpdateAbortConnectorRecovery(
  ports: Readonly<{
    before: ProductConfigurationSnapshot;
    wasRunning: boolean;
    current(): ProductConfigurationSnapshot | null;
    releaseAdmission(): Promise<void>;
    resumeConnector(): Promise<void>;
  }>,
): Readonly<{
  recordDrained(snapshot: ProductConfigurationSnapshot): void;
  release(): Promise<void>;
}> {
  let drained: ProductConfigurationSnapshot | null = null;
  let releasing: Promise<void> | null = null;
  return {
    recordDrained(snapshot) {
      if (
        !ports.wasRunning ||
        ports.before.status !== "ready" ||
        snapshot.status !== "ready"
      )
        return;
      const before = ports.before.settings;
      const stopped = snapshot.settings;
      const prior = before.connectors.secureMcp.runtime;
      const runtime = stopped.connectors.secureMcp.runtime;
      if (
        prior?.state === "ready" &&
        prior.connectorGeneration === before.connectors.secureMcp.generation &&
        prior.computerGeneration === before.computer.generation &&
        !before.setup.connect.outcomeUnknown &&
        !before.setup.computer.outcomeUnknown &&
        before.computer.pendingEdit === null &&
        stopped.revision === before.revision + 1 &&
        stopped.setup.connect.unavailable === "CONNECTOR_UPDATE_DRAINED" &&
        runtime?.state === "unreachable" &&
        runtime.runtimeGeneration === prior.runtimeGeneration &&
        runtime.buildId === prior.buildId &&
        runtime.connectorGeneration === prior.connectorGeneration &&
        runtime.computerGeneration === prior.computerGeneration
      )
        drained = snapshot;
    },
    release: () =>
      (releasing ??= (async () => {
        await ports.releaseAdmission();
        const current = ports.current();
        if (drained?.status !== "ready" || current?.status !== "ready") return;
        const expected = drained.settings;
        const settings = current.settings;
        const runtime = settings.connectors.secureMcp.runtime;
        if (
          settings.revision === expected.revision &&
          settings.setup.connect.unavailable === "CONNECTOR_UPDATE_DRAINED" &&
          !settings.setup.connect.outcomeUnknown &&
          !settings.setup.computer.outcomeUnknown &&
          runtime?.state === "unreachable" &&
          runtime.runtimeGeneration ===
            expected.connectors.secureMcp.runtime?.runtimeGeneration &&
          runtime.connectorGeneration ===
            settings.connectors.secureMcp.generation &&
          runtime.computerGeneration === settings.computer.generation
        )
          await ports.resumeConnector();
      })()),
  };
}

// Resume only a previously ready Computer-only route after confirmed shutdown,
// including a generation-bound update drain that withdrew its live proof.
// The ordinary Dev or preview identity must match its build: a development
// build using the preview profile cannot inherit that profile's connection.
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
    input.environment !== input.buildEnvironment ||
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
