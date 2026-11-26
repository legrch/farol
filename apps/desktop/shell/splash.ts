import type { readLaunchArguments } from "../host/launch";
import type {
  StartupSplash,
  StartupSplashOptions,
} from "../../../src/apps/desktop/startup-splash";

// The startup splash open: an ordinary owner launch shows a window at once
// while the Go core, settings, journals and task state start. Hidden windows,
// background-only launches and the E2E lane keep their existing window policy
// and open nothing. A secondary-visible test window is placed on its display
// and never focused. Main keeps the `startupSplash` owner: this writes it
// through the setter at the point the open resolved, and a failure anywhere in
// the open (the icon, the placement, the window, the quit hook) clears the
// owner and never aborts startup. The gate and the placement are read when the
// call runs; the quit hook is registered only after the owner holds the
// splash, so a hook that cannot be registered leaves no splash behind.

export type SplashPorts = Readonly<{
  windowMode: ReturnType<typeof readLaunchArguments>["windowMode"];
  ownerBackgroundOnly: boolean;
  /** Read when the gate is checked: the E2E lane never shows a splash. */
  e2e: () => boolean;
  title: string;
  size: Readonly<{ width: number; height: number }>;
  iconDataUrl: () => string;
  placement: (
    size: Readonly<{ width: number; height: number }>,
  ) => Readonly<{ bounds: NonNullable<StartupSplashOptions["bounds"]> }>;
  open: (options: StartupSplashOptions) => StartupSplash;
  /** The owner write. */
  setSplash: (splash: StartupSplash | null) => void;
  /** Registers the close on the app's before-quit. */
  closeOnBeforeQuit: () => void;
}>;

export function openOwnerStartupSplash(ports: SplashPorts): void {
  if (ports.windowMode === "hidden" || ports.ownerBackgroundOnly || ports.e2e())
    return;
  try {
    ports.setSplash(
      ports.open({
        title: ports.title,
        width: ports.size.width,
        height: ports.size.height,
        iconDataUrl: ports.iconDataUrl(),
        ...(ports.windowMode === "secondary-visible"
          ? {
              bounds: ports.placement(ports.size).bounds,
              inactive: true,
            }
          : {}),
      }),
    );
    ports.closeOnBeforeQuit();
  } catch {
    ports.setSplash(null);
  }
}
