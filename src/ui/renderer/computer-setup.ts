import {
  onboardingFacts,
  externalConnectorChallengeAllowed,
} from "../guided-onboarding";
import { routeReadiness } from "../setup-presentation";
import type { WindowSnapshot } from "./contract";

/** Read-only presentation of existing authority and receipts; never a grant. */
export function computerSetup(snapshot: WindowSnapshot) {
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  const buildId = snapshot.buildId ?? "";
  const facts = onboardingFacts(settings, buildId);
  const connector = settings?.connectors.secureMcp;
  const runtime = connector?.runtime;
  const verified = settings?.setup.computer.verified;
  // Never substitute the first saved grant for the verified workspace.
  const workspace =
    settings?.computer.workspaces.find(
      (item) => item.workspaceId === verified?.workspaceId,
    ) ?? null;
  const pending = Object.values(snapshot.intents).some(
    (intent) => intent.state === "pending",
  );
  const unknown =
    Object.values(snapshot.intents).some(
      (intent) => intent.state === "unknown",
    ) ||
    Boolean(
      settings &&
      Object.values(settings.setup).some(
        (step) => "outcomeUnknown" in step && step.outcomeUnknown,
      ),
    ) ||
    facts.outcomeUnknown;
  const current =
    snapshot.status === "current" &&
    snapshot.runtime === "ready" &&
    settings !== null &&
    buildId !== "";
  const admissible =
    current && !pending && !unknown && !settings?.computer.pendingEdit;
  const folderCurrent =
    facts.folder === "ready" &&
    workspace !== null &&
    verified?.buildId === buildId &&
    verified.configRevision === settings?.computer.generation;
  const configured =
    facts.client && facts.credentialStored && facts.tunnelId !== null;
  const runtimeIdentityCurrent =
    runtime != null &&
    runtime.buildId === buildId &&
    runtime.computerGeneration === settings?.computer.generation &&
    runtime.connectorGeneration === connector?.generation;
  const challenge = connector?.challenge;
  const challengeCurrent =
    challenge != null &&
    runtimeIdentityCurrent &&
    facts.runtimeCurrent &&
    challenge.buildId === buildId &&
    challenge.computerGeneration === settings?.computer.generation &&
    challenge.runtimeGeneration === runtime?.runtimeGeneration;
  const attachment = connector?.attachment;
  const witness = settings?.setup.connect.verified;
  const attachmentCurrent =
    facts.attachmentCurrent &&
    witness != null &&
    witness.buildId === buildId &&
    witness.configRevision === connector?.generation &&
    witness.runtimeGeneration === runtime?.runtimeGeneration &&
    witness.workspaceId === workspace?.workspaceId &&
    (challenge == null ||
      (challengeCurrent &&
        attachment?.challengeSha256 === challenge.challengeSha256));
  const ready = admissible && folderCurrent && attachmentCurrent;
  const externalChallenge =
    admissible &&
    folderCurrent &&
    challengeCurrent &&
    externalConnectorChallengeAllowed(facts) &&
    workspace !== null &&
    challenge != null
      ? {
          value: challenge.value,
          workspaceId: workspace.workspaceId,
          root: workspace.root,
          tunnelId: facts.tunnelId,
        }
      : null;
  const embedded =
    settings && current
      ? routeReadiness(settings.setup.chatgpt, {
          stale: settings.setup.chatgpt.verified?.buildId !== buildId,
        })
      : "not-configured";
  return {
    facts,
    ready,
    externalChallenge,
    embeddedChatGPT:
      embedded === "ready"
        ? "Ready"
        : embedded === "outcome-unknown"
          ? "Outcome unknown"
          : "Sign-in check needed",
    label: unknown
      ? "Outcome unknown"
      : pending
        ? "Connection check pending"
        : !current
          ? "Connection check needed"
          : ready
            ? "Computer ready"
            : !folderCurrent || !configured
              ? "Setup needed"
              : "Connection check needed",
    canStart:
      admissible && folderCurrent && configured && connector?.runtime === null,
    canReconnect:
      admissible &&
      folderCurrent &&
      configured &&
      runtimeIdentityCurrent &&
      (runtime?.state === "ready" || runtime?.state === "unreachable"),
    canCheckAttachment: admissible && folderCurrent && facts.runtimeCurrent,
    canVerifyEmbeddedApp:
      admissible && folderCurrent && challengeCurrent && embedded === "ready",
    next: unknown
      ? "Inspect the existing outcome. Do not repeat an unknown action."
      : pending
        ? "Wait for the pending action before changing the connection."
        : !current
          ? "Refresh the current state before changing the connection."
          : settings?.computer.pendingEdit
            ? "Observe the existing folder edit before changing the connection."
            : !folderCurrent
              ? "Approve a folder, choose optional write and command access, then verify the workspace."
              : !configured
                ? "Choose the tunnel client and save the tunnel connection."
                : !facts.runtimeCurrent
                  ? "Start a stopped connection, or explicitly reconnect a current runtime."
                  : !ready
                    ? "Attach this tunnel in ChatGPT, use the current challenge once, then check attachment."
                    : "Current folder, connection and attachment checks passed.",
  };
}
