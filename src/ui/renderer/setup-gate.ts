import { allFoldersChecked } from "../folder-access-state";
import { selectedConnectorApp } from "../../pkg/product-settings/connector-app-selection";
import { dependencyFences } from "./command-eligibility";
import { computerSetup } from "./computer-setup";
import { signInPresentation } from "./sign-in-presentation";
import type { Intent, WindowSnapshot } from "./contract";
import type { SetupCheckpoint } from "./setup-checklist";

export type SetupResultState =
  "success" | "stale" | "unknown" | "pending" | "refused" | "missing";
type SetupAction = Readonly<{
  kind: "refresh" | "guide";
  label: string;
  destination?: "setup-guide" | "tunnels";
}>;
export type SetupCheckResult = Readonly<{
  state: SetupResultState;
  allowed: boolean;
  cause: string;
  action: SetupAction | null;
  actionError: Readonly<{ cause: string; action: SetupAction }> | null;
}>;
const labels: Record<SetupCheckpoint, string> = {
  signin: "Sign-in",
  folders: "Workspace access",
  connection: "Connection",
  attachment: "ChatGPT app",
};
const commands: Record<SetupCheckpoint, readonly string[]> = {
  signin: ["chatgpt.verify", "chatgpt.open-sign-in"],
  folders: ["computer.", "connector.stop"],
  connection: [
    "connector.discover-client",
    "connector.configure",
    "connector.save-and-connect",
    "connector.start",
    "connector.stop",
    "connector.repair",
    "connector.check-health",
  ],
  attachment: [
    "connector.select-chatgpt-app",
    "connector.verify-app",
    "connector.check-attachment",
  ],
};

const confirmingCommands: Record<SetupCheckpoint, readonly string[]> = {
  signin: ["chatgpt.verify"],
  folders: ["computer.verify-workspace"],
  connection: ["connector.check-health"],
  attachment: ["connector.verify-app", "connector.check-attachment"],
};

/** The sole Setup gate: only confirmed success for current inputs can advance. */
export function setupStepCheck(
  snapshot: WindowSnapshot,
  step: SetupCheckpoint,
  inputsChanged = false,
  local: readonly Intent[] = [],
): SetupCheckResult {
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  const setup = computerSetup(snapshot);
  const fence = dependencyFences(
    snapshot,
    step === "signin" ? "chat" : "computer",
    local,
  );
  const intents = [...Object.values(snapshot.intents), ...local].filter(
    (intent) =>
      commands[step].some((command) =>
        intent.id.startsWith(
          `settings:${command}${command.endsWith(".") ? "" : ":"}`,
        ),
      ),
  );
  const observation = snapshot.signInObservation;
  const check = snapshot.setupSignInCheck;
  const saved = settings?.setup.chatgpt;
  const connector = settings?.connectors.secureMcp;
  const confirmed =
    step === "signin"
      ? signInPresentation(snapshot).signedIn &&
        check != null &&
        check.buildId === snapshot.buildId &&
        check.binding.documentGeneration ===
          observation?.binding?.documentGeneration &&
        observation.binding !== null &&
        observation.binding.sequence >= check.binding.sequence &&
        saved?.verified?.buildId === snapshot.buildId &&
        saved.reachable === "reachable"
      : step === "folders"
        ? setup.workspacesVerified &&
          settings !== null &&
          allFoldersChecked(settings, snapshot.buildId ?? "")
        : step === "connection"
          ? setup.localConnectionCurrent
          : setup.externalAccessVerified &&
            connector != null &&
            selectedConnectorApp(connector) === "Farol";
  const hasCheck =
    step === "signin"
      ? Boolean(check || saved?.verified)
      : step === "folders"
        ? Boolean(
            settings?.setup.computer.verified ||
            settings?.computer.workspaces.some((w) => w.accessCheck),
          )
        : step === "connection"
          ? connector?.runtime != null
          : connector?.attachment != null;
  const current =
    snapshot.status === "current" &&
    snapshot.runtime === "ready" &&
    Boolean(snapshot.buildId) &&
    settings !== null;
  // Unknown is sticky even through observation loss or edits. A new input never
  // licenses repeating an operation whose original outcome remains unknown.
  const unknown = fence.unknown || intents.some((i) => i.state === "unknown");
  const pending =
    fence.pending || (step === "signin" && observation?.pending === true);
  const latestConfirmation = Math.max(
    0,
    ...intents
      .filter(
        (intent) =>
          intent.state === "applied" &&
          confirmingCommands[step].some((command) =>
            intent.id.startsWith(`settings:${command}:`),
          ),
      )
      .map((intent) => snapshot.setupCheckOrder?.[intent.id] ?? 0),
  );
  const refusals = intents.filter(
    (intent) =>
      intent.state === "refused" &&
      // Missing order cannot establish that a refusal predates this check.
      (!snapshot.setupCheckOrder?.[intent.id] ||
        snapshot.setupCheckOrder[intent.id]! >= latestConfirmation),
  );
  // A known refusal cannot change the inputs of a confirmed check. Only a
  // refused confirming check withdraws that success; uncertain effects stay fenced.
  const blockingRefusal = refusals.find(
    (intent) =>
      !confirmed ||
      confirmingCommands[step].some((command) =>
        intent.id.startsWith(`settings:${command}:`),
      ),
  );
  const refusal = blockingRefusal ?? refusals[0];
  const refused = Boolean(blockingRefusal);
  const state: SetupResultState = unknown
    ? "unknown"
    : pending
      ? "pending"
      : refused
        ? "refused"
        : !current
          ? "missing"
          : inputsChanged
            ? "stale"
            : step === "signin" && observation?.state === "unknown"
              ? "unknown"
              : confirmed
                ? "success"
                : hasCheck
                  ? "stale"
                  : "missing";
  const label = labels[step];
  const keyRejected = /(?:KEY_REJECTED|AUTHENTICATION_FAILED)/u.test(
    refusal?.code ?? "",
  );
  const helperMissing =
    step === "connection" &&
    refusal?.id.startsWith("settings:connector.discover-client:") &&
    !connector?.tunnelClient;
  const refusalCause = helperMissing
    ? "This Mac could not find a usable connection helper. Install tunnel-client for this account."
    : keyRejected
      ? "OpenAI did not accept this key. It may be revoked or belong to another tunnel."
      : refusal?.code === "CONNECTOR_CREDENTIAL_STORE_FAILED"
        ? "Farol could not save the key on this Mac. Check this account’s key storage before connecting again."
        : refusal?.code === "CONNECTOR_POLLING_EXPIRED"
          ? "The connection started, but its health check did not finish. The connection is not confirmed."
          : confirmed && !blockingRefusal
            ? "The action could not be completed. Check the setup guide before trying again."
            : step === "folders"
              ? "Farol could not check this workspace. Make sure it still exists and this account can open it."
              : `${label} check was refused. Review the setup instructions before continuing.`;
  const refusalAction: SetupAction = {
    kind: "guide",
    label: keyRejected
      ? "Create a new key in OpenAI Tunnels"
      : helperMissing
        ? "How to install tunnel-client"
        : "Read the setup guide",
    destination: keyRejected ? "tunnels" : "setup-guide",
  };
  const cause =
    state === "success"
      ? `${label} check passed for the current inputs.`
      : state === "unknown"
        ? `${label} result could not be confirmed. Refresh its saved result; do not repeat the action.`
        : state === "pending"
          ? `${label} check is still in progress. Wait for its result.`
          : state === "refused"
            ? refusalCause
            : state === "stale"
              ? `${label} inputs changed or the previous check is no longer current. Check the current inputs before continuing.`
              : `${label} has no current confirmed check. Complete this step before continuing.`;
  return {
    state,
    allowed: state === "success",
    cause,
    actionError:
      state === "success" && refusals.length > 0
        ? {
            cause: refusalCause,
            action: refusalAction,
          }
        : null,
    action:
      state === "success"
        ? null
        : state === "unknown" || state === "pending"
          ? { kind: "refresh", label: "Refresh status" }
          : state === "refused"
            ? refusalAction
            : {
                kind: "guide",
                label: "Read the setup guide",
                destination: "setup-guide",
              },
  };
}
