import { computerSetup } from "./computer-setup";
import { setupCompletionChecks } from "../setup-completion";
import { setupStepCheck } from "./setup-gate";
import { signInPresentation } from "./sign-in-presentation";
import { setupSections } from "./setup-checklist";
import type { SetupCheckpoint, SetupChecklistEntry } from "./setup-checklist";
import type { Intent, SetupStep, WindowSnapshot } from "./contract";

export const setupSteps = setupSections;

/** Saved completion and current health are distinct; gates stay current-only. */
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
  const completed = settings?.setup.journey.dismissed === true;
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
      // Live health cannot retain verification through UNKNOWN or stale evidence.
      const verified =
        check.allowed ||
        // A read-only recheck reports its own outcome in Activity. It cannot
        // revoke a still-current attachment merely by waiting or refusing.
        (step === "attachment" &&
          confirmed[step] &&
          check.state === "refused" &&
          !inputsChanged &&
          settings?.connectors.secureMcp.challenge === null &&
          [...Object.values(snapshot.intents), ...local].some((intent) =>
            /^settings:connector\.verify-app:[a-f0-9]{64}$/u.test(intent.id),
          )) ||
        (check.state === "pending" &&
          confirmed[step] &&
          !(inputsChanged && (step === "connection" || step === "attachment")));
      const liveState = verified
        ? "verified"
        : check.state === "pending"
          ? "pending"
          : check.state === "unknown"
            ? "unknown"
            : "needed";
      return {
        step,
        label,
        description: completed
          ? "Completed during setup. " + check.cause
          : check.cause,
        optional: false,
        state: completed ? "verified" : liveState,
        liveState,
        status: completed
          ? "Completed during setup"
          : step === "signin"
            ? verified
              ? "Sign-in checked"
              : signInPresentation(snapshot).label
            : check.cause,
        action: completed || verified ? "Review" : "Set up",
      };
    });
  return {
    completed,
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
