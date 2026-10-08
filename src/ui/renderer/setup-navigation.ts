import { computerSetup } from "./computer-setup";
import type { SettingsPage, SetupStep, WindowSnapshot } from "./contract";

export const setupSteps: readonly [SetupStep, string][] = [
  ["overview", "Overview"],
  ["folders", "Workspaces"],
  ["connection", "Connection"],
  ["attachment", "Add to ChatGPT"],
  ["finish", "Finish"],
];

/** Navigation only. Opening a step never checks, saves or replaces evidence. */
export function nextSetupStep(snapshot: WindowSnapshot): SetupStep {
  const setup = computerSetup(snapshot);
  if (setup.ready) return "finish";
  if (
    !setup.facts.client ||
    !setup.facts.credentialStored ||
    !setup.facts.tunnelId
  )
    return "connection";
  if (setup.facts.folder !== "ready") return "folders";
  return setup.facts.runtimeCurrent ? "attachment" : "connection";
}

export function setupPage(step: SetupStep): SettingsPage {
  return step === "overview"
    ? "general"
    : step === "folders"
      ? "folders"
      : step === "finish"
        ? "general"
        : "connection";
}
