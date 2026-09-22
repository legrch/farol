import type { SurfaceSection } from "../ipc/shell-state";
import type { ProductGeneralSettings, SetupStepId } from "./contract";

const setupStepOrder: readonly SetupStepId[] = [
  "chatgpt",
  "computer",
  "connect",
  "hosts",
  "verify",
];

export function initialSetupPresentation(
  input: Readonly<{
    environment: "preview" | "dev";
    dismissed: boolean;
    currentStep: SetupStepId;
    openAtLaunch: ProductGeneralSettings["openAtLaunch"];
  }>,
): Readonly<{
  setupOpen: boolean;
  setupStep: number;
  section: SurfaceSection;
}> {
  const setupStep = Math.max(0, setupStepOrder.indexOf(input.currentStep));
  const connectionsFirst = input.environment === "dev" && !input.dismissed;
  return {
    setupOpen: !input.dismissed && !connectionsFirst,
    setupStep,
    section: connectionsFirst ? "computer" : input.openAtLaunch,
  };
}
