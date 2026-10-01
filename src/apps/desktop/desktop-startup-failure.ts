import type { DesktopEnvironment } from "./desktop-environment";

export const DESKTOP_STARTUP_FAILURE_PREFIX = "FAROL_NEXT_STARTUP_FAILURE:";
export const DESKTOP_LAUNCH_RESULT_PREFIX =
  "FAROL_NEXT_SECOND_INSTANCE_RESULT:";

const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const DISPLAY_PRECONDITION_CODES = new Set([
  "BUILT_IN_DISPLAY_UNAVAILABLE",
  "SECONDARY_DISPLAY_UNAVAILABLE",
  "WINDOW_DISPLAY_UNAVAILABLE",
  "WINDOW_PRIMARY_DISPLAY_MISSING",
  "WINDOW_DISPLAY_GEOMETRY_INVALID",
  "VISIBLE_TEST_VIEWPORT_UNAVAILABLE",
]);

export function desktopStartupFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_FAILURE_CODE.test(message) ? message : "DESKTOP_STARTUP_FAILED";
}

export function desktopStartupFailureReport(
  error: unknown,
  environment: DesktopEnvironment,
): string {
  const code = desktopStartupFailureCode(error);
  const product = environment === "dev" ? "Farol Dev" : "Farol Next Preview";
  const remedy = DISPLAY_PRECONDITION_CODES.has(code)
    ? "The visible-test display requirements are not met. Check available displays and the requested viewport before launching again. Use hidden mode only for an equivalent check."
    : environment === "dev" && code === "DEV_PROFILE_DIRECTORY_AMBIGUOUS"
      ? "Two distinct Dev profiles exist. Stop here and choose a profile explicitly; neither was moved or merged."
      : environment === "dev"
        ? "Fix the reported local build or configuration issue, then run 'task dev' again."
        : "Rebuild the exact candidate, then launch it again.";
  return (
    `${product} main-process startup failed before the app became ready (${code}). ${remedy}\n` +
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
