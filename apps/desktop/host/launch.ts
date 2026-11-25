import {
  parseAllowPrimaryDisplay,
  parseBuiltInDisplayOnly,
  parseDevDisplay,
  parsePreviewWindowMode,
  parsePreviewWindowSize,
  parseSidecarDisplayOnly,
} from "../../../src/apps/desktop/window-placement";
import { previewStartupDelay } from "../../../src/apps/desktop/primary-startup";

// Launch arguments: what this process was asked to be by its command line and
// environment, read once at import time. Pure: it reads only the values it is
// given and throws the same codes, in the same order, that main threw inline.
// Storage identity and paths are not chosen here; they stay with the boot
// identity, which redirects Electron's paths before anything else runs.

const demoTasks = [
  {
    ownerId: "demo-local-preview",
    taskId: "task-atlantic",
    sessionId: "session-atlantic",
    turnId: "turn-atlantic-1",
    generation: 1,
    label: "Demo · Atlantic workspace check",
    hasComputer: true,
  },
  {
    ownerId: "demo-local-preview",
    taskId: "task-harbor",
    sessionId: "session-harbor",
    turnId: "turn-harbor-1",
    generation: 1,
    label: "Demo · Harbor research stream",
    hasComputer: false,
  },
] as const;

export type LaunchEnvironment = Readonly<{
  FAROL_E2E?: string | undefined;
  FAROL_E2E_LEGACY_SETUP?: string | undefined;
}>;

export function readLaunchArguments(
  argv: readonly string[],
  env: LaunchEnvironment,
  buildEnvironment: string,
) {
  const e2e = env.FAROL_E2E === "1";
  const ownerBackgroundOnly = argv.includes("--owner-background-only");
  if (ownerBackgroundOnly && parsePreviewWindowMode(argv) !== "hidden") {
    throw new Error("OWNER_BACKGROUND_PRESENTATION_INVALID");
  }
  const startupDelayMs = previewStartupDelay(argv, e2e);
  const demoMode = argv.includes("--demo");
  // Only the fixture lane can exercise the retained legacy journey explicitly.
  // A normal packaged preview always selects the integrated Setup.
  const legacySetupTestMode = e2e && env.FAROL_E2E_LEGACY_SETUP === "1";
  const devSecondaryDisplay = parseDevDisplay(argv);
  if (devSecondaryDisplay && buildEnvironment !== "dev")
    throw new Error("DEV_DISPLAY_ARGUMENT_INVALID");
  const windowMode = devSecondaryDisplay
    ? "secondary-visible"
    : parsePreviewWindowMode(argv);
  // Explicit-only: the owner-handed overnight run passes this itself. Its
  // absence keeps every display-selection outcome exactly as before.
  const allowPrimaryDisplay = parseAllowPrimaryDisplay(argv);
  const builtInDisplayOnly = parseBuiltInDisplayOnly(argv);
  const sidecarDisplayOnly = parseSidecarDisplayOnly(argv);
  const initialWindowSize = parsePreviewWindowSize(argv, windowMode);
  const explicitPreviewWindowSize = argv.some((argument) =>
    argument.startsWith("--preview-window-size="),
  );
  return {
    ownerBackgroundOnly,
    startupDelayMs,
    demoMode,
    legacySetupTestMode,
    devSecondaryDisplay,
    windowMode,
    allowPrimaryDisplay,
    builtInDisplayOnly,
    sidecarDisplayOnly,
    initialWindowSize,
    explicitPreviewWindowSize,
    expectedTasks: demoMode ? demoTasks : [],
  } as const;
}
