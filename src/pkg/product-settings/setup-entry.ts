import type { SurfaceSection } from "../ipc/shell-state";
import type { ProductGeneralSettings, SetupStepId } from "./contract";

const setupStepOrder: readonly SetupStepId[] = [
  "chatgpt",
  "computer",
  "connect",
  "hosts",
  "verify",
];

export interface GuidedSetupSelection {
  readonly environment: "preview" | "dev";
  readonly demoMode?: boolean;
  readonly legacySetupTestMode?: boolean;
}

// Selects only the Setup surface. Runtime identity, private homes and Dev
// diagnostics retain their own environment boundaries.
export function guidedSetupSelected(input: GuidedSetupSelection): boolean {
  return input.demoMode !== true && input.legacySetupTestMode !== true;
}

export function initialSetupPresentation(
  input: Readonly<{
    environment: "preview" | "dev";
    demoMode?: boolean;
    legacySetupTestMode?: boolean;
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
  const connectionsFirst = guidedSetupSelected(input) && !input.dismissed;
  return {
    setupOpen: !input.dismissed && !connectionsFirst,
    setupStep,
    section: connectionsFirst ? "computer" : input.openAtLaunch,
  };
}
