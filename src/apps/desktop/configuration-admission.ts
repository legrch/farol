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
  "computer.update-commands",
  "computer.verify-workspace",
]);

const connectorGuardedCommands = new Set<string>([
  "computer.rename",
  "computer.add-workspace",
  "computer.remove-workspace",
  "computer.update-exclusions",
  "computer.update-access",
  "computer.update-commands",
  "computer.verify-workspace",
]);

export type ConfigurationAdmission =
  "admitted" | "CODEX_HOST_TASK_IN_PROGRESS" | "CONNECTOR_STOP_REQUIRED";

export function configurationAdmission(
  kind: string,
  state: Readonly<{ agentActive: boolean; connectorRunning: boolean }>,
): ConfigurationAdmission {
  if (state.agentActive && agentGuardedCommands.has(kind)) {
    return "CODEX_HOST_TASK_IN_PROGRESS";
  }
  if (state.connectorRunning && connectorGuardedCommands.has(kind)) {
    return "CONNECTOR_STOP_REQUIRED";
  }
  return "admitted";
}

// A command that changes what the Computer authorizes: it holds the authority
// transition reservation from its admission through its commit (F3-1b).
export function changesComputerAuthority(kind: string): boolean {
  return agentGuardedCommands.has(kind) || connectorGuardedCommands.has(kind);
}
