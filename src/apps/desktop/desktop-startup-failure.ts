import type { DesktopEnvironment } from "./desktop-environment";
import { BridgeError } from "../../../apps/desktop/bridge/client";

export const DESKTOP_STARTUP_FAILURE_PREFIX = "FAROL_NEXT_STARTUP_FAILURE:";
export const DESKTOP_LAUNCH_RESULT_PREFIX =
  "FAROL_NEXT_SECOND_INSTANCE_RESULT:";

const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const STARTUP_PHASES = [
  "configuration",
  "go-core",
  "go-settings",
  "task-state",
  "context",
  "native-menu",
  "local-runtime",
  "main-window",
] as const;
type StartupPhase = (typeof STARTUP_PHASES)[number];
// Bridge codes are boundary data. Never copy a merely code-shaped provider
// string, native exception, or path into a startup report.
const BRIDGE_FAILURE_CODES = new Set([
  "previous_host_drain_unconfirmed",
  "core_host_build_mismatch",
  "core_host_artifact_mismatch",
  "native_profile_storage_invalid",
  "invalid_core_artifact",
  "core_artifact_changed",
  "invalid_computer_publication",
  "crossed_computer_publication",
  "computer_publication_unavailable",
  "host_settings_store_unavailable",
  "backend_unavailable",
  "backend_cleanup_unconfirmed",
  "profile_cleanup_unconfirmed",
]);
class StartupBoundaryFailure extends Error {
  constructor(
    readonly phase: StartupPhase,
    code: string,
  ) {
    super(code);
  }
}

/** Observes one existing startup call; never retries or changes its cleanup. */
export async function runDesktopStartupBoundary<T>(
  phase: StartupPhase,
  run: () => T | Promise<T>,
): Promise<T> {
  if (!STARTUP_PHASES.includes(phase))
    throw new Error("DESKTOP_STARTUP_PHASE_INVALID");
  try {
    return await run();
  } catch (error) {
    throw new StartupBoundaryFailure(phase, desktopStartupFailureCode(error));
  }
}
const DISPLAY_PRECONDITION_CODES = new Set([
  "BUILT_IN_DISPLAY_UNAVAILABLE",
  "SECONDARY_DISPLAY_UNAVAILABLE",
  "WINDOW_DISPLAY_UNAVAILABLE",
  "WINDOW_PRIMARY_DISPLAY_MISSING",
  "WINDOW_DISPLAY_GEOMETRY_INVALID",
  "VISIBLE_TEST_VIEWPORT_UNAVAILABLE",
]);
const PREVIOUS_DRAIN_FAILURE_CODES = new Set([
  "DESKTOP_PREVIOUS_QUIT_UNCONFIRMED",
  "GO_CORE_PREVIOUS_HOST_DRAIN_UNCONFIRMED",
]);

export function desktopStartupFailureCode(error: unknown): string {
  if (error instanceof BridgeError) {
    if (BRIDGE_FAILURE_CODES.has(error.code))
      return `GO_CORE_${error.code.toUpperCase()}`;
    switch (error.state) {
      case "unavailable":
        return "GO_CORE_UNAVAILABLE";
      case "unknown":
        return "GO_CORE_UNKNOWN";
      case "refused":
        return "GO_CORE_REFUSED";
      case "unsupported":
        return "GO_CORE_UNSUPPORTED";
      default:
        return "GO_CORE_FAILURE";
    }
  }
  const message = error instanceof Error ? error.message : "";
  return SAFE_FAILURE_CODE.test(message) ? message : "DESKTOP_STARTUP_FAILED";
}

export function desktopStartupFailureReport(
  error: unknown,
  environment: DesktopEnvironment,
): string {
  const code = desktopStartupFailureCode(error);
  const product = environment === "dev" ? "Farol Dev" : "Farol Next Preview";
  const remedy = PREVIOUS_DRAIN_FAILURE_CODES.has(code)
    ? "The previous session did not confirm shutdown. Preserve the existing profile and its recovery records; rebuilding the app does not settle this state. Use a qualified recovery procedure before reopening that profile."
    : DISPLAY_PRECONDITION_CODES.has(code)
      ? "The visible-test display requirements are not met. Check available displays and the requested viewport before launching again. Use hidden mode only for an equivalent check."
      : environment === "dev" && code === "DEV_PROFILE_DIRECTORY_AMBIGUOUS"
        ? "Two distinct Dev profiles exist. Stop here and choose a profile explicitly; neither was moved or merged."
        : environment === "dev"
          ? "Fix the reported local build or configuration issue, then run 'task dev' again."
          : "Rebuild the exact candidate, then launch it again.";
  return (
    `${product} main-process startup failed before the app became ready (${code}). ${remedy}\n` +
    (error instanceof StartupBoundaryFailure
      ? `FAROL_NEXT_STARTUP_FAILURE_STAGE:${error.phase}\n`
      : "") +
    `${DESKTOP_STARTUP_FAILURE_PREFIX}${code}\n` +
    `${DESKTOP_LAUNCH_RESULT_PREFIX}startup-failed\n`
  );
}

export function terminateDesktopStartup(
  error: unknown,
  environment: DesktopEnvironment,
  sink: Readonly<{
    write: (message: string) => void;
    exit: (code: number) => void;
  }>,
): void {
  try {
    sink.write(desktopStartupFailureReport(error, environment));
  } finally {
    // Startup has not been accepted as ready, so there is no useful process
    // to keep alive. Electron's default uncaught-exception path can otherwise
    // show a native JavaScript dialog and leave the main process running.
    sink.exit(1);
  }
}
