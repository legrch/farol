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
    completedPreviously?: boolean;
    currentStep: SetupStepId;
    openAtLaunch: ProductGeneralSettings["openAtLaunch"];
  }>,
): Readonly<{
  setupOpen: boolean;
  setupStep: number;
  section: SurfaceSection;
}> {
  const setupStep = Math.max(0, setupStepOrder.indexOf(input.currentStep));
  // A saved app-check witness means this is a returning user even when an
  // older Setup flow never persisted dismissal. This controls navigation only:
  // fresh runtime checks and the selected launch preference remain unchanged.
  const firstSetup = !input.dismissed && input.completedPreviously !== true;
  const connectionsFirst = guidedSetupSelected(input) && firstSetup;
  return {
    setupOpen: firstSetup && !connectionsFirst,
    setupStep,
    section: connectionsFirst ? "computer" : input.openAtLaunch,
  };
}
