import { lstat } from "node:fs/promises";
import path from "node:path";
import type { PromotionLeaseHandle } from "../../../src/apps/desktop/promotion-lease";
import type { waitForInstalledUpdateRelaunch } from "../../../src/apps/desktop/installed-update-runtime";
import { ProductSettingsStore } from "../../../src/apps/desktop/product-configuration";
import {
  currentBootTimeMs,
  readProcessStart,
  writeRunMarker,
} from "../../../src/apps/desktop/run-marker";
import type { StartupStage } from "../../../src/apps/desktop/primary-startup";
import { preserveFreshStartHistory } from "../recovery/fresh-admission";
import type { DesktopAdmission } from "./admission";

// Startup admission: what happens inside the installed-update startup fence,
// between Electron readiness and the run marker. With a compiled Go core every
// start is a fresh start: after an unclean predecessor it requires saved
// Settings and moves the old history aside before any new work. It writes the
// run marker last. Main keeps every owner; each of its `let`s is a late getter
// here, so a Quit, a second launch or an update that arrives while startup
// waits is seen at the next check. Nothing here retries: a lost lease or a
// refused history move ends this attempt.

type UpdateRelaunch = Awaited<
  ReturnType<typeof waitForInstalledUpdateRelaunch>
>;

export type StartupApp = Readonly<{
  whenReady: () => Promise<unknown>;
  hasSingleInstanceLock: () => boolean;
}>;

export type StartupPorts = Readonly<{
  app: StartupApp;
  stateRoot: string;
  /** Only its presence matters: a compiled core makes every start fresh. */
  compiledGoCore: unknown;
  installedUpdates: {
    resourcesOrigin: NonNullable<UpdateRelaunch>["resourcesOrigin"] | undefined;
  };
  desktopAdmission: Pick<DesktopAdmission, "quitInProgress">;
  primaryInstanceLock: () => boolean;
  runtimeStopping: () => boolean;
  startupStage: (stage: StartupStage) => void;
}>;

export function createStartup(ports: StartupPorts) {
  const {
    app,
    stateRoot,
    compiledGoCore,
    installedUpdates,
    desktopAdmission,
    primaryInstanceLock,
    runtimeStopping,
    startupStage,
  } = ports;
  let fresh = false;

  /** Runs inside `withInstalledStartupFence`; resolves whether the previous host stopped cleanly. */
  async function admit(
    updateRelaunch: UpdateRelaunch,
    verify: () => Promise<boolean>,
    _lease: PromotionLeaseHandle,
  ): Promise<boolean> {
    installedUpdates.resourcesOrigin = updateRelaunch?.resourcesOrigin;
    await updateRelaunch?.recheck();
    startupStage("before-ready");
    await app.whenReady();
    startupStage("ready");
    // Startup participates in the updater's existing exclusion before
    // readiness and until its durable runtime obligation is published.
    // A busy promotion refuses this launch; it never waits to resurrect
    // potentially displaced code or modifies the predecessor's marker.
    // Presence is inspected without reading or repairing an old marker.
    // An access error is never treated as absence.
    const clean = await lstat(path.join(stateRoot, "running.json")).then(
      () => false,
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    // Ordinary Go startup creates current work independently of old sessions.
    // Permanent lock files exclude owners; their presence selects no mode.
    fresh = compiledGoCore !== null;
    if (fresh) {
      if (!clean) {
        // Current Settings integrity remains mandatory; no default/repair path.
        const saved = await new ProductSettingsStore({
          root: stateRoot,
        }).loadExisting();
        if (!saved) throw Error("FRESH_START_SETTINGS_UNAVAILABLE");
      }
      if (!clean)
        await preserveFreshStartHistory(stateRoot, async () => {
          await updateRelaunch?.recheck();
          if (
            !primaryInstanceLock() ||
            !app.hasSingleInstanceLock() ||
            desktopAdmission.quitInProgress ||
            runtimeStopping() ||
            !(await verify())
          )
            throw Error("FRESH_START_CURRENT_OWNER_UNCONFIRMED");
        });
    }
    await updateRelaunch?.recheck();
    if (!(await verify())) {
      throw new Error("STARTUP_PROMOTION_LEASE_LOST");
    }
    await writeRunMarker(stateRoot, {
      pid: process.pid,
      now: Date.now(),
      bootTime: currentBootTimeMs(),
      processStart: readProcessStart(process.pid),
    });
    startupStage("run-marker");
    return clean;
  }

  return {
    admit,
    /** True once admission selected an ordinary fresh Go start. */
    freshStartup: () => fresh,
  };
}
