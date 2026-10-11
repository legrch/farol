import { signInPresentation } from "./sign-in-presentation";
import { computerSetup } from "./computer-setup";
import { dependencyFences } from "./command-eligibility";
import {
  projectSetupChecklist,
  setupSections,
  visibleSetupSection,
} from "./setup-checklist";
import type { SetupActivity } from "./setup-checklist";
import type { SettingsPage, SetupStep, WindowSnapshot } from "./contract";

export const setupSteps = setupSections;

/** Read-only projection. Uses the same evidence for sidebar and overview. */
export function setupChecklist(snapshot: WindowSnapshot) {
  const setup = computerSetup(snapshot);
  const computer = dependencyFences(snapshot, "computer");
  const signIn = signInPresentation(snapshot);
  const activity = (fence: {
    unknown: boolean;
    pending: boolean;
  }): SetupActivity =>
    fence.unknown ? "unknown" : fence.pending ? "pending" : "settled";
  const checklist = projectSetupChecklist({
    current:
      snapshot.status === "current" &&
      snapshot.runtime === "ready" &&
      Boolean(snapshot.buildId) &&
      snapshot.configuration?.status === "ready",
    signedIn: signIn.signedIn,
    hasWorkspaces: setup.facts.hasFolder,
    workspacesVerified: setup.workspacesVerified,
    localConnectionCurrent: setup.localConnectionCurrent,
    externalAccessVerified: setup.externalAccessVerified,
    computerReady: setup.ready,
    signInActivity: signIn.unknown
      ? "unknown"
      : signIn.pending
        ? "pending"
        : "settled",
    computerActivity: activity(computer),
  });
  return {
    ...checklist,
    entries: checklist.entries.map((entry) =>
      entry.step === "signin"
        ? {
            ...entry,
            status: signIn.label,
            action:
              signIn.signedIn || signIn.outcomeUnknown
                ? ("Review" as const)
                : ("Set up" as const),
          }
        : entry,
    ),
  };
}

/** Preserve the existing required-Computer routing. Sign-in stays optional. */
export function nextSetupStep(snapshot: WindowSnapshot): SetupStep {
  const setup = computerSetup(snapshot);
  if (setup.ready) return "finish";
  if (
    !setup.facts.client ||
    !setup.facts.credentialStored ||
    !setup.facts.tunnelId
  )
    return "connection";
  if (setup.facts.hasFolder && setup.facts.folder !== "ready") return "folders";
  return setup.facts.runtimeCurrent ? "attachment" : "connection";
}

export function setupPage(step: SetupStep): SettingsPage {
  const visible = visibleSetupSection(step);
  return visible === "overview"
    ? "general"
    : visible === "folders"
      ? "folders"
      : "connection";
}
