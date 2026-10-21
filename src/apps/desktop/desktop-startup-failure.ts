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
  "core_resources_unqualified",
  "core_resources_deadline_expired",
  "shell_runtime_unqualified",
  "shell_runtime_deadline_expired",
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
  "SIDECAR_DISPLAY_UNAVAILABLE",
  "VISIBLE_TEST_DISPLAY_CONFLICT",
  "PREVIEW_WINDOW_SIZE_INVALID",
  "BUILT_IN_DISPLAY_UNAVAILABLE",
  "SECONDARY_DISPLAY_UNAVAILABLE",
  "WINDOW_DISPLAY_UNAVAILABLE",
  "WINDOW_PRIMARY_DISPLAY_MISSING",
  "WINDOW_DISPLAY_GEOMETRY_INVALID",
  "VISIBLE_TEST_VIEWPORT_UNAVAILABLE",
]);
// The app's own files were not changed; checking them took longer than the
// startup budget. Rebuilding would not help, and a later launch usually passes.
const QUALIFICATION_DEADLINE_CODES = new Set([
  "GO_CORE_CORE_RESOURCES_DEADLINE_EXPIRED",
  "GO_CORE_SHELL_RUNTIME_DEADLINE_EXPIRED",
]);
const PREVIOUS_DRAIN_FAILURE_CODES = new Set([
  "DESKTOP_PREVIOUS_QUIT_UNCONFIRMED",
  "GO_CORE_PREVIOUS_HOST_DRAIN_UNCONFIRMED",
]);

// First-launch adoption failures are the one startup failure a recipient can
// act on, and the process has no window yet: these are shown in a native error
// box and repeated in the stderr remedy. Keyed by closed code, never by text.
const USER_NOTICES: ReadonlyMap<
  string,
  Readonly<{ title: string; message: string }>
> = new Map([
  [
    "UPDATE_ADOPTION_NETWORK_FAILURE",
    {
      title: "Farol can't verify this copy yet",
      message:
        "Connect to the internet to verify Farol on first launch, then open Farol again.",
    },
  ],
  [
    "UPDATE_ADOPTION_RELEASE_NOT_FOUND",
    {
      title: "Farol isn't a published release",
      message:
        "This copy of Farol isn't a published release. Download Farol from its releases page.",
    },
  ],
  [
    "UPDATE_ADOPTION_TREE_MISMATCH",
    {
      title: "Farol doesn't match its release",
      message:
        "This copy of Farol doesn't match its published release. Download it again.",
    },
  ],
  [
    "UPDATE_ADOPTION_RELEASE_MISMATCH",
    {
      title: "Farol doesn't match its release",
      message:
        "This copy of Farol doesn't match its published release. Download it again.",
    },
  ],
]);

/** The user-facing notice for a recoverable startup code, or null. */
export function desktopStartupFailureNotice(
  code: string,
): Readonly<{ title: string; message: string }> | null {
  return USER_NOTICES.get(code) ?? null;
}

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
  const product =
    environment === "dev"
      ? "Farol Dev"
      : environment === "owner-preview"
        ? "Farol Preview"
        : "Farol";
  const notice = desktopStartupFailureNotice(code);
  const remedy = notice
    ? notice.message
    : QUALIFICATION_DEADLINE_CODES.has(code)
      ? "Checking the app's files took longer than the startup allows. Open the app again; if the Mac is busy, wait for it to settle first."
      : PREVIOUS_DRAIN_FAILURE_CODES.has(code)
        ? "The previous session did not confirm shutdown. Preserve the existing profile and its recovery records; rebuilding the app does not settle this state. Use a qualified recovery procedure before reopening that profile."
        : DISPLAY_PRECONDITION_CODES.has(code)
          ? "The visible-test display requirements are not met. Check available displays and the requested viewport before launching again. Use hidden mode only for an equivalent check."
          : environment === "owner-preview" &&
              code === "OWNER_PREVIEW_PROFILE_DIRECTORY_UNSAFE"
            ? "The Preview profile or its parent is aliased or unsafe. Preserve the existing directories and resolve their physical separation before another launch; rebuilding does not repair this state."
            : environment === "dev" &&
                code === "DEV_PROFILE_DIRECTORY_AMBIGUOUS"
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

// A native notice is modal: it holds the exit until someone dismisses it. A
// launch nobody is watching (E2E harness, CI, an explicit non-interactive
// run) must never get one, or it would block instead of exiting.
export function startupNoticeAllowed(env: NodeJS.ProcessEnv): boolean {
  return (
    env.FAROL_NEXT_E2E !== "1" &&
    env.FAROL_NEXT_NONINTERACTIVE !== "1" &&
    (env.CI === undefined || env.CI === "" || env.CI === "false")
  );
}

export function terminateDesktopStartup(
  error: unknown,
  environment: DesktopEnvironment,
  sink: Readonly<{
    write: (message: string) => void;
    exit: (code: number) => void;
    // Optional native notice for recoverable first-launch failures only. It is
    // shown once and never retried. It cannot skip the exit, but a modal notice
    // delays it until dismissed, so callers pass it only for an interactive
    // launch (`startupNoticeAllowed`).
    notify?: (title: string, message: string) => void;
  }>,
): void {
  try {
    sink.write(desktopStartupFailureReport(error, environment));
    const notice = desktopStartupFailureNotice(
      desktopStartupFailureCode(error),
    );
    if (notice && sink.notify) {
      try {
        sink.notify(notice.title, notice.message);
      } catch {
        // The report above already carries the remedy; the exit still follows.
      }
    }
  } finally {
    // Startup has not been accepted as ready, so there is no useful process
    // to keep alive. Electron's default uncaught-exception path can otherwise
    // show a native JavaScript dialog and leave the main process running.
    sink.exit(1);
  }
}
