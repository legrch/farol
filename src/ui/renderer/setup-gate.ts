import { setupCompletionChecks } from "../setup-completion";
import { chatGptPreSubmitRemedy } from "../chatgpt-pre-submit-remedy";
import { dependencyFences } from "./command-eligibility";
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
    "connector.verify-separate-app",
    "connector.check-attachment",
  ],
};

const confirmingCommands: Record<SetupCheckpoint, readonly string[]> = {
  signin: ["chatgpt.verify"],
  folders: ["computer.verify-workspace"],
  connection: ["connector.check-health"],
  attachment: [
    "connector.verify-app",
    "connector.verify-separate-app",
    "connector.check-attachment",
  ],
};

export function connectorVerificationInFlight(
  snapshot: WindowSnapshot,
  local: readonly Intent[] = [],
): boolean {
  return (
    snapshot.activity.some(
      (entry) =>
        entry.kind === "connector.verify-app" &&
        entry.outcome === "pending" &&
        entry.inFlight === true,
    ) ||
    [...Object.values(snapshot.intents), ...local].some(
      (intent) =>
        /^settings:connector\.(?:verify-app|verify-separate-app):(?:[a-f0-9]{64})?$/u.test(
          intent.id,
        ) &&
        intent.state === "pending" &&
        intent.inFlight === true,
    )
  );
}

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
  const fence = dependencyFences(
    snapshot,
    step === "signin"
      ? "chat"
      : step === "attachment"
        ? "attachment"
        : "computer",
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
  const confirmed = setupCompletionChecks(settings, {
    buildId: snapshot.buildId ?? "",
    current:
      snapshot.status === "current" &&
      snapshot.runtime === "ready" &&
      snapshot.update.phase !== "applying",
    signInObservation: observation ?? null,
    signInCheck: check ?? null,
  })[step];
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
  const unknown =
    fence.unknown ||
    intents.some(
      (i) =>
        i.state === "unknown" &&
        !(
          step === "attachment" &&
          confirmed &&
          [
            "settings:connector.verify-app:",
            "settings:connector.verify-separate-app:",
          ].includes(i.id) &&
          i.code === "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN"
        ),
    );
  const browserCheckRunning =
    step === "signin" &&
    observation?.state === "unknown" &&
    connectorVerificationInFlight(snapshot, local);
  const pending =
    fence.pending ||
    (step === "signin" && observation?.pending === true) ||
    browserCheckRunning;
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
              ? "missing"
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
  const preSubmitRemedy =
    step === "attachment"
      ? chatGptPreSubmitRemedy(refusal?.code ?? null)
      : null;
  const refusalCause =
    preSubmitRemedy ??
    (helperMissing
      ? "Farol could not verify its bundled connection helper. Reinstall Farol from a trusted release."
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
                : step === "attachment"
                  ? "The ChatGPT check did not finish. Check that the app name below matches the app you added in ChatGPT and that it uses this tunnel."
                  : `${label} could not be checked. Review this step before continuing.`);
  const refusalAction: SetupAction = {
    kind: "guide",
    label: keyRejected
      ? "Create a new key in OpenAI Tunnels"
      : helperMissing
        ? "Read the installation guide"
        : "Read the setup guide",
    destination: keyRejected ? "tunnels" : "setup-guide",
  };
  const successCopy: Record<SetupCheckpoint, string> = {
    signin: "Your ChatGPT sign-in is confirmed. Continue to choose workspaces.",
    folders:
      "All listed workspaces passed their access checks. You can continue.",
    connection: "This Mac is connected. Continue to add your app in ChatGPT.",
    attachment:
      "ChatGPT reached this Mac and confirmed the approved workspace access.",
  };
  const staleCopy: Record<SetupCheckpoint, string> = {
    signin:
      "Sign-in needs a fresh check in this window. Choose Check sign-in to continue.",
    folders:
      "Workspace settings changed or their checks are no longer current. Review the access results below.",
    connection:
      "The connection details changed or need checking again. Connect using the current details.",
    attachment:
      "The selected app or connection changed. Check the current app before continuing.",
  };
  const cause =
    state === "success"
      ? successCopy[step]
      : state === "unknown"
        ? `${label} result could not be confirmed. Refresh its saved result; do not repeat the action.`
        : state === "pending"
          ? browserCheckRunning
            ? "The connection test is using ChatGPT. Sign-in will be checked again automatically when it finishes."
            : `${label} check is still in progress. Wait for its result.`
          : state === "refused"
            ? refusalCause
            : state === "stale"
              ? staleCopy[step]
              : step === "signin" && observation?.state === "unknown"
                ? "Farol could not read your ChatGPT sign-in status. Choose Check again to read the current session."
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
          : step === "signin" && observation?.state === "unknown"
            ? { kind: "refresh", label: "Check again" }
            : state === "refused"
              ? refusalAction
              : {
                  kind: "guide",
                  label: "Read the setup guide",
                  destination: "setup-guide",
                },
  };
}
