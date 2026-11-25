import type {
  SidebarMode,
  SurfaceSection,
} from "../../../src/pkg/ipc/shell-state";
import type {
  ProductGeneralSettings,
  SetupStepId,
} from "../../../src/pkg/product-settings/contract";
import { initialSetupPresentation } from "../../../src/pkg/product-settings/setup-entry";

// The shell's entry state at startup: which section opens, whether the Setup
// panel is open and which sidebar mode the owner chose. Only the persisted
// journey completion fact, the launch preference and the sidebar default are
// read from saved settings; with no ready settings the first-run defaults
// apply and the sidebar stays as main already had it (`null`).

export type StartupEntryPorts = Readonly<{
  environment: "preview" | "dev" | "owner-preview";
  demoMode: boolean;
  legacySetupTestMode: boolean;
  settings: Readonly<{
    setup: Readonly<{
      journey: Readonly<{ dismissed: boolean; currentStep: SetupStepId }>;
    }>;
    general: Readonly<{
      openAtLaunch: ProductGeneralSettings["openAtLaunch"];
      sidebarDefault: SidebarMode;
    }>;
  }> | null;
}>;

export function startupEntry(ports: StartupEntryPorts): Readonly<{
  section: SurfaceSection;
  setupOpen: boolean;
  sidebarMode: SidebarMode | null;
}> {
  const settings = ports.settings;
  const presentation = initialSetupPresentation({
    environment: ports.environment,
    demoMode: ports.demoMode,
    legacySetupTestMode: ports.legacySetupTestMode,
    dismissed: settings?.setup.journey.dismissed ?? false,
    currentStep: settings?.setup.journey.currentStep ?? "chatgpt",
    openAtLaunch: settings?.general.openAtLaunch ?? "home",
  });
  return {
    section: presentation.section,
    setupOpen: presentation.setupOpen,
    sidebarMode: settings ? settings.general.sidebarDefault : null,
  };
}
