import { computerSetup } from "./computer-setup";
import { setupStepCheck } from "./setup-gate";
import { signInPresentation } from "./sign-in-presentation";
import { setupSections, visibleSetupSection } from "./setup-checklist";
import type { SetupCheckpoint, SetupChecklistEntry } from "./setup-checklist";
import type {
  Intent,
  SettingsPage,
  SetupStep,
  WindowSnapshot,
} from "./contract";

export const setupSteps = setupSections;

/** Sidebar, step success and navigation all consume the same gate. */
export function setupChecklist(
  snapshot: WindowSnapshot,
  inputsChanged = false,
  local: readonly Intent[] = [],
) {
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
      return {
        step,
        label,
        description: check.cause,
        optional: false,
        state: check.allowed
          ? "verified"
          : check.state === "pending"
            ? "pending"
            : check.state === "unknown"
              ? "unknown"
              : "needed",
        status:
          step === "signin"
            ? check.allowed
              ? "Sign-in checked"
              : signInPresentation(snapshot).label
            : check.cause,
        action: check.allowed ? "Review" : "Set up",
      };
    });
  return {
    entries,
    ready:
      computerSetup(snapshot).ready &&
      entries.every((entry) => entry.state === "verified"),
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
