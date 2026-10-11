import {
  onboardingFacts,
  externalConnectorChallengeAllowed,
} from "../guided-onboarding";
import { routeReadiness } from "../setup-presentation";
import type { WindowSnapshot } from "./contract";
import { signInPresentation } from "./sign-in-presentation";
import { dependencyFences } from "./command-eligibility";

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
  const { pending, unknown } = dependencyFences(snapshot, "computer");
  const current =
    snapshot.status === "current" &&
    snapshot.runtime === "ready" &&
    settings !== null &&
    buildId !== "";
  const admissible =
    current && !pending && !unknown && !settings?.computer.pendingEdit;
  const fileAccessCurrent =
    facts.folder === "ready" &&
    workspace !== null &&
    verified?.buildId === buildId &&
    verified.configRevision === settings?.computer.generation;
  const configured =
    facts.client && facts.credentialStored && facts.tunnelId !== null;
  const folderCurrent = !facts.hasFolder || fileAccessCurrent;
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
    witness.workspaceId === (facts.hasFolder ? workspace?.workspaceId : null) &&
    (challenge == null ||
      (challengeCurrent &&
        attachment?.challengeSha256 === challenge.challengeSha256));
  const ready = admissible && folderCurrent && attachmentCurrent;
  const externalChallenge =
    admissible &&
    folderCurrent &&
    challengeCurrent &&
    externalConnectorChallengeAllowed(facts) &&
    challenge != null
      ? {
          value: challenge.value,
          workspaceId: workspace?.workspaceId ?? null,
          root: workspace?.root ?? null,
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
    workspacesVerified: admissible && fileAccessCurrent,
    localConnectionCurrent:
      admissible && runtimeIdentityCurrent && facts.runtimeCurrent,
    externalAccessVerified: admissible && attachmentCurrent,
    externalChallenge,
    embeddedChatGPT: signInPresentation(snapshot).label,
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
                    : facts.hasFolder
                      ? "Current folder, connection and attachment checks passed."
                      : "Connection verified. No workspace access is enabled.",
  };
}
