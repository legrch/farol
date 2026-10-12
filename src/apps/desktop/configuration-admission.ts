// Commands that change what the Computer authorizes. A running native Agent
// holds a snapshot of that authority for its whole task, so none of them (nor
// a re-verification, which rebinds it) may run until the owner stops the Agent
// from its task: stop first, then revoke. A running connector carries the same
// authority into ChatGPT and must be stopped for the same reason.
const agentGuardedCommands = new Set<string>([
  "computer.rename",
  "computer.add-workspace",
  "computer.remove-workspace",
  "computer.update-exclusions",
  "computer.update-access",
  "computer.update-git-history",
  "computer.update-commands",
  "computer.update-file-policy",
  "computer.verify-workspace",
  "dev-proof.prepare",
  "host.configure-codex-tasks",
  "host.clear-codex-tasks",
]);

const connectorGuardedCommands = new Set<string>([
  "computer.rename",
  "computer.add-workspace",
  "computer.remove-workspace",
  "computer.update-exclusions",
  "computer.update-access",
  "computer.update-git-history",
  "computer.update-commands",
  "computer.update-file-policy",
  "computer.verify-workspace",
  "dev-proof.prepare",
  "host.select-codex",
  "host.select-discovered-codex",
  "host.verify-codex",
  "host.remove-codex",
  "host.configure-codex-tasks",
  "host.clear-codex-tasks",
]);

export type ConfigurationAdmission =
  "admitted" | "CODEX_HOST_TASK_IN_PROGRESS" | "CONNECTOR_STOP_REQUIRED";

// These commands may borrow the existing host's admitted stop/change sequence.
// This selection grants nothing; the caller must retain the authority reservation.
export function isDrainedWorkspaceChange(kind: string): boolean {
  return (
    kind === "computer.add-workspace" ||
    kind === "computer.remove-workspace" ||
    kind === "computer.update-access" ||
    kind === "computer.update-commands" ||
    kind === "computer.update-file-policy"
  );
}

// Child liveness cannot settle a retained MCP stop. Select inside the original
// authority reservation, before either the live-drain or already-stopped path.
export function workspaceConfigurationRoute(
  unconfirmedStop: boolean,
  connectorRunning: boolean,
): "unconfirmed" | "drain" | "configure-stopped" {
  if (unconfirmedStop) return "unconfirmed";
  return connectorRunning ? "drain" : "configure-stopped";
}

export function configurationAdmission(
  kind: string,
  state: Readonly<{
    agentActive: boolean;
    connectorRunning: boolean;
    workspaceDrainAvailable?: boolean;
  }>,
): ConfigurationAdmission {
  if (state.agentActive && agentGuardedCommands.has(kind)) {
    return "CODEX_HOST_TASK_IN_PROGRESS";
  }
  if (state.connectorRunning && connectorGuardedCommands.has(kind)) {
    if (state.workspaceDrainAvailable && isDrainedWorkspaceChange(kind))
      return "admitted";
    return "CONNECTOR_STOP_REQUIRED";
  }
  return "admitted";
}

// A command that changes what the Computer authorizes: it holds the authority
// transition reservation from its admission through its commit (F3-1b).
export function changesComputerAuthority(kind: string): boolean {
  return agentGuardedCommands.has(kind) || connectorGuardedCommands.has(kind);
}
