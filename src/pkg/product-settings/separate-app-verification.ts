import {
  SeparateAppVerificationScopeSchema,
  type ProductSettings,
  type SeparateAppVerificationScope,
} from "./contract";
import { connectorRuntimeUncertain } from "./connector-uncertainty";
import { connectorWorkspaceSelection } from "./connector-workspace-selection";
import { selectedConnectorApp } from "./connector-app-selection";

/** Select an explicit new check only; never settle or clear its predecessor. */
export function separateAppVerificationScopeCurrent(
  settings: ProductSettings,
  expected: SeparateAppVerificationScope,
  buildId: string,
): boolean {
  if (!SeparateAppVerificationScopeSchema.safeParse(expected).success)
    return false;
  const c = settings.connectors.secureMcp,
    runtime = c.runtime,
    challenge = c.challenge;
  return (
    c.appVerificationPending === true &&
    settings.setup.connect.outcomeUnknown &&
    !connectorRuntimeUncertain(settings) &&
    !settings.computer.pendingEdit &&
    !settings.setup.computer.outcomeUnknown &&
    !settings.setup.chatgpt.outcomeUnknown &&
    !settings.setup.hosts.outcomeUnknown &&
    !settings.setup.verify.outcomeUnknown &&
    c.credential === "stored" &&
    c.tunnelClient !== null &&
    c.tunnelId === expected.tunnelId &&
    selectedConnectorApp(c) === expected.appName &&
    c.generation === expected.connectorGeneration &&
    settings.computer.generation === expected.computerGeneration &&
    runtime?.state === "ready" &&
    runtime.connectorGeneration === c.generation &&
    runtime.computerGeneration === settings.computer.generation &&
    runtime.runtimeGeneration === expected.runtimeGeneration &&
    runtime.buildId === buildId &&
    expected.buildId === buildId &&
    challenge?.challengeSha256 === expected.challengeSha256 &&
    challenge.runtimeGeneration === expected.runtimeGeneration &&
    challenge.buildId === buildId &&
    challenge.computerGeneration === expected.computerGeneration &&
    connectorWorkspaceSelection(settings) === expected.workspaceId
  );
}
