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
    (settings.computer.workspaces.length === 0 ||
      (settings.setup.computer.reachable === "reachable" &&
        verification?.configRevision === settings.computer.generation &&
        identityBoundWorkspaces(settings.computer.workspaces).some(
          (workspace) => workspace.workspaceId === verification.workspaceId,
        )))
  );
}

/** Compose the existing workspace check before a new-build connector start.
 * Exactly empty workspace configuration needs no file verification.
 * The check must return a known success; readback cannot repair a lost reply.
 * It may refresh only the already bound workspace selected by clean resume.
 */
export async function resumeComputerConnector(
  input: Parameters<typeof shouldResumeComputerConnector>[0] & {
    buildId: string;
  },
  ports: Readonly<{
    current(): ProductConfigurationSnapshot;
    verifyWorkspace(workspaceId: string): Promise<{ ok: boolean }>;
    start(): Promise<{ ok: boolean }>;
  }>,
): Promise<"skipped" | "verification-refused" | "started" | "start-refused"> {
  if (!shouldResumeComputerConnector(input)) return "skipped";
  if (input.snapshot.status !== "ready") return "skipped";
  const settings = input.snapshot.settings;
  const verified = settings.setup.computer.verified;
  if (
    settings.computer.workspaces.length > 0 &&
    verified?.buildId !== input.buildId
  ) {
    if (!verified || verified.workspaceId === null) return "skipped";
    const workspaceId = verified.workspaceId;
    const computerGeneration = settings.computer.generation;
    const connectorGeneration = settings.connectors.secureMcp.generation;
    const runtimeGeneration =
      settings.connectors.secureMcp.runtime?.runtimeGeneration;
    const runtimeBuildId = settings.connectors.secureMcp.runtime?.buildId;
    const result = await ports.verifyWorkspace(workspaceId);
    if (!result.ok) return "verification-refused";
    const current = ports.current();
    if (
      !shouldResumeComputerConnector({ ...input, snapshot: current }) ||
      current.status !== "ready" ||
      current.settings.computer.generation !== computerGeneration ||
      current.settings.connectors.secureMcp.generation !==
        connectorGeneration ||
      current.settings.connectors.secureMcp.runtime?.runtimeGeneration !==
        runtimeGeneration ||
      current.settings.connectors.secureMcp.runtime?.buildId !==
        runtimeBuildId ||
      current.settings.computer.workspaces.length === 0 ||
      current.settings.setup.computer.verified?.workspaceId !== workspaceId ||
      current.settings.setup.computer.verified?.buildId !== input.buildId
    )
      return "verification-refused";
  }
  return (await ports.start()).ok ? "started" : "start-refused";
}
