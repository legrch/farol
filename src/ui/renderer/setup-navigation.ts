import { computerSetup } from "./computer-setup";
import { setupCompletionChecks } from "../setup-completion";
import { setupStepCheck } from "./setup-gate";
import { signInPresentation } from "./sign-in-presentation";
import { setupSections } from "./setup-checklist";
import type { SetupCheckpoint, SetupChecklistEntry } from "./setup-checklist";
import type { Intent, SetupStep, WindowSnapshot } from "./contract";

export const setupSteps = setupSections;

/** Progress retains current receipts while the unchanged gate owns navigation. */
export function setupChecklist(
  snapshot: WindowSnapshot,
  inputsChanged = false,
  local: readonly Intent[] = [],
) {
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  const confirmed = setupCompletionChecks(settings, {
    buildId: snapshot.buildId ?? "",
    current:
      snapshot.status === "current" &&
      snapshot.runtime === "ready" &&
      snapshot.update.phase !== "applying",
    signInObservation: snapshot.signInObservation ?? null,
    signInCheck: snapshot.setupSignInCheck ?? null,
  });
  let allGatesAllowed = true;
  const entries: readonly SetupChecklistEntry[] = setupSections
    .filter(([step]) => step !== "overview")
    .map(([key, label]) => {
      const step = key as SetupCheckpoint;
      const check = setupStepCheck(
        snapshot,
        step,
        inputsChanged && (step === "connection" || step === "attachment"),
        local,
      );
      allGatesAllowed = allGatesAllowed && check.allowed;
      // A live chooser/save can block commands without invalidating a receipt.
      // Never retain progress through UNKNOWN, changed inputs or stale evidence.
      const verified =
        check.allowed ||
        (check.state === "pending" &&
          confirmed[step] &&
          !(inputsChanged && (step === "connection" || step === "attachment")));
      return {
        step,
        label,
        description: check.cause,
        optional: false,
        state: verified
          ? "verified"
          : check.state === "pending"
            ? "pending"
            : check.state === "unknown"
              ? "unknown"
              : "needed",
        status:
          step === "signin"
            ? verified
              ? "Sign-in checked"
              : signInPresentation(snapshot).label
            : check.cause,
        action: verified ? "Review" : "Set up",
      };
    });
  return {
    entries,
    ready: computerSetup(snapshot).ready && allGatesAllowed,
  };
}

/** Preserve the existing required-Computer routing. Sign-in stays optional. */
export function nextSetupStep(snapshot: WindowSnapshot): SetupStep {
  const setup = computerSetup(snapshot);
  if (setup.ready) return "overview";
  if (
    !setup.facts.client ||
    !setup.facts.credentialStored ||
    !setup.facts.tunnelId
  )
    return "connection";
  if (setup.facts.hasFolder && setup.facts.folder !== "ready") return "folders";
  return setup.facts.runtimeCurrent ? "attachment" : "connection";
}
