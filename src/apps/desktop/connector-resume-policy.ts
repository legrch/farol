import type {
  ProductConfigurationSnapshot,
  ProductSettings,
} from "../../pkg/product-settings/contract";
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
    environment: "dev" | "preview" | "owner-preview";
    buildEnvironment: "dev" | "preview" | "owner-preview";
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

// Re-verification can legitimately change effective Shell authority: workspaces
// still carrying the old build's check become stale. The settings owner advances
// both generations and withdraws the old runtime. Admit that single known write,
// while preserving every saved grant and connector selection. A concurrent Stop,
// settings edit or second write changes the revision and must win over resume.
// A separate intent fence also catches a no-op Stop after runtime withdrawal.
function isOwnVerificationRefresh(
  before: ProductSettings,
  after: ProductSettings,
  workspaceId: string,
  buildId: string,
): boolean {
  const delta = after.computer.generation - before.computer.generation;
  const check = after.setup.computer.verified;
  const selected = after.computer.workspaces.find(
    (workspace) => workspace.workspaceId === workspaceId,
  );
  if (
    after.revision !== before.revision + 1 ||
    (delta !== 0 && delta !== 1) ||
    after.nativeHosts.taskRoute !== null ||
    after.computer.pendingEdit !== null ||
    after.setup.connect.outcomeUnknown ||
    after.setup.computer.outcomeUnknown ||
    after.setup.computer.reachable !== "reachable" ||
    check?.workspaceId !== workspaceId ||
    check.buildId !== buildId ||
    check.configRevision !== after.computer.generation ||
    selected?.accessCheck?.buildId !== buildId ||
    selected.accessCheck.computerGeneration !== after.computer.generation ||
    JSON.stringify(selected.accessCheck.rootIdentity) !==
      JSON.stringify(selected.rootIdentity)
  )
    return false;
  const grants = (settings: ProductSettings) => {
    const {
      generation: _generation,
      workspaces,
      ...computer
    } = settings.computer;
    return {
      ...computer,
      workspaces: workspaces.map(
        ({ accessCheck: _check, ...workspace }) => workspace,
      ),
    };
  };
  const selection = (settings: ProductSettings) => {
    const {
      generation: _generation,
      runtime: _runtime,
      challenge: _challenge,
      attachment: _attachment,
      ...connector
    } = settings.connectors.secureMcp;
    return connector;
  };
  if (
    JSON.stringify(grants(before)) !== JSON.stringify(grants(after)) ||
    JSON.stringify(selection(before)) !== JSON.stringify(selection(after))
  )
    return false;
  const prior = before.connectors.secureMcp;
  const current = after.connectors.secureMcp;
  if (delta === 0)
    return (
      current.generation === prior.generation &&
      JSON.stringify(current.runtime) === JSON.stringify(prior.runtime) &&
      JSON.stringify(current.challenge) === JSON.stringify(prior.challenge) &&
      JSON.stringify(current.attachment) === JSON.stringify(prior.attachment)
    );
  return (
    current.generation ===
      prior.generation + (prior.runtime === null ? 0 : 1) &&
    current.runtime === null &&
    current.challenge === null &&
    current.attachment === null &&
    after.setup.connect.configured &&
    after.setup.connect.reachable === "unknown" &&
    after.setup.connect.verified === null &&
    after.setup.connect.unavailable === null
  );
}

/** Compose the existing workspace check before a new-build connector start.
 * Exactly empty workspace configuration needs no file verification.
 * The check must return a known success; readback cannot repair a lost reply.
 * Refresh already bound workspaces only, with the selected workspace last.
 * Otherwise a stale secondary workspace would prevent the shared Shell scope.
 */
export async function resumeComputerConnector(
  input: Parameters<typeof shouldResumeComputerConnector>[0] & {
    buildId: string;
  },
  ports: Readonly<{
    current(): ProductConfigurationSnapshot;
    mayContinue(): boolean;
    verifyWorkspace(workspaceId: string): Promise<{ ok: boolean }>;
    start(): Promise<{ ok: boolean }>;
  }>,
): Promise<"skipped" | "verification-refused" | "started" | "start-refused"> {
  if (!ports.mayContinue() || !shouldResumeComputerConnector(input))
    return "skipped";
  if (input.snapshot.status !== "ready") return "skipped";
  const settings = input.snapshot.settings;
  const verified = settings.setup.computer.verified;
  if (
    settings.computer.workspaces.length > 0 &&
    verified?.buildId !== input.buildId
  ) {
    if (!verified || verified.workspaceId === null) return "skipped";
    const selectedId = verified.workspaceId;
    const workspaces = identityBoundWorkspaces(settings.computer.workspaces);
    const ids = [
      ...workspaces
        .filter((workspace) => workspace.workspaceId !== selectedId)
        .map((workspace) => workspace.workspaceId),
      selectedId,
    ];
    let before = structuredClone(settings);
    for (const workspaceId of ids) {
      const result = await ports.verifyWorkspace(workspaceId);
      if (!result.ok || !ports.mayContinue()) return "verification-refused";
      const current = ports.current();
      if (
        current.status !== "ready" ||
        !isOwnVerificationRefresh(
          before,
          current.settings,
          workspaceId,
          input.buildId,
        )
      )
        return "verification-refused";
      before = structuredClone(current.settings);
    }
  }
  if (!ports.mayContinue()) return "start-refused";
  return (await ports.start()).ok ? "started" : "start-refused";
}
