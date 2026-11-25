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
import type { GracefulQuitSignals } from "../../../src/apps/desktop/quit-signal";
import { createMenuBar } from "../../../src/apps/desktop/menu-bar";
import { desktopCoreArtifactRoot } from "../dev-core-layout";
import { startDesktopGoRecovery } from "../recovery/core-host";
import { createStartupRecoverySession } from "../recovery/session";
import { beginStartupMaintenanceAttempt } from "../recovery/receipt";
import { preserveFreshStartHistory } from "../recovery/fresh-admission";
import { runStartupPreservedMaintenance } from "../recovery/maintenance";
import {
  maintenanceFailureCode,
  type MaintenanceObservation,
} from "../recovery/diagnostics";
import {
  openStartupRecoveryWindow,
  type StartupRecoveryWindow,
} from "../recovery/host";
import type { QuitTracePhase } from "../quit/trace";
import type { DesktopAdmission } from "./admission";
import type { Cell } from "./cell";
import { secondInstanceResultPrefix } from "./instance";

// Startup admission: what happens inside the installed-update startup fence,
// between Electron readiness and the run marker. It selects an ordinary fresh
// Go start, a qualified preserving maintenance, or the startup recovery window,
// and writes the run marker last. Main keeps every owner; each of its `let`s is
// a late getter here, so a Quit, a second launch or an update that arrives while
// startup waits is seen at the next check. Nothing here retries: a lost lease,
// an unqualified maintenance or a recovery Quit ends this attempt.

type UpdateRelaunch = Awaited<
  ReturnType<typeof waitForInstalledUpdateRelaunch>
>;
type RecoveryOptions = Parameters<typeof openStartupRecoveryWindow>[0];
type MaintenanceOptions = Parameters<typeof runStartupPreservedMaintenance>[0];
type RecoveryStart = Parameters<typeof startDesktopGoRecovery>[0];

export type StartupApp = Readonly<{
  whenReady: () => Promise<unknown>;
  getPath: (name: "userData" | "home") => string;
  hasSingleInstanceLock: () => boolean;
}>;

export type StartupPorts = Readonly<{
  app: StartupApp;
  stateRoot: string;
  directory: string;
  runtimeEnvironment: Parameters<typeof desktopCoreArtifactRoot>[1];
  windowMode: RecoveryOptions["mode"];
  quitSignals: GracefulQuitSignals;
  build: MaintenanceOptions["build"];
  compiledGoCore: MaintenanceOptions["compiledArtifact"];
  compiledGoResources: MaintenanceOptions["compiledResources"];
  installedUpdates: {
    resourcesOrigin: NonNullable<UpdateRelaunch>["resourcesOrigin"] | undefined;
    resources: () => Readonly<{ directory: string }>;
  };
  desktopAdmission: Pick<DesktopAdmission, "quitInProgress" | "beginQuit">;
  primaryInstanceLock: () => boolean;
  runtimeStopping: () => boolean;
  desktopGoCore: () => unknown;
  configuration: () => unknown;
  secureMcpConnectorRuntime: () => unknown;
  connectorStartInFlight: () => unknown;
  modelLifecycle: () => unknown;
  pendingComputer: Readonly<{ size: number }>;
  ownedLocalRuntimes: Readonly<{ size: number }>;
  startupRecovery: Cell<StartupRecoveryWindow | null>;
  quitTracePhase: (phase: QuitTracePhase) => void;
  startupStage: (stage: StartupStage) => void;
  nativeMenuBarEnabled: () => boolean;
  selectedVisibleTestPlacement: (
    size: Readonly<{ width: number; height: number }>,
  ) => Readonly<{ bounds: ReturnType<RecoveryOptions["placement"]> }>;
  reportMaintenanceObservation: (observation: MaintenanceObservation) => void;
  reportQualificationObservation: NonNullable<
    MaintenanceOptions["onQualificationObservation"]
  >;
  reportOwnedBackendLifecycle: NonNullable<
    RecoveryStart["onLifecycleObservation"]
  >;
  computerMcpLifecycle: () => Readonly<{
    confirmCleanHostStop: (admissionReady: boolean) => Promise<unknown>;
  }>;
}>;

export function createStartup(ports: StartupPorts) {
  const {
    app,
    stateRoot,
    directory,
    runtimeEnvironment,
    windowMode,
    quitSignals,
    compiledGoCore,
    compiledGoResources,
    installedUpdates,
    desktopAdmission,
    primaryInstanceLock,
    runtimeStopping,
    desktopGoCore,
    configuration,
    secureMcpConnectorRuntime,
    connectorStartInFlight,
    modelLifecycle,
    pendingComputer,
    ownedLocalRuntimes,
    startupRecovery,
    quitTracePhase,
    startupStage,
    nativeMenuBarEnabled,
    selectedVisibleTestPlacement,
    reportMaintenanceObservation,
    reportQualificationObservation,
    reportOwnedBackendLifecycle,
    computerMcpLifecycle,
  } = ports;
  const buildIdentity = ports.build;
  let fresh = false;

  /** Runs inside `withInstalledStartupFence`; resolves whether the previous host stopped cleanly. */
  async function admit(
    updateRelaunch: UpdateRelaunch,
    verify: () => Promise<boolean>,
    lease: PromotionLeaseHandle,
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
    let admissionReady = clean;
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
    if (!fresh && compiledGoCore !== null && !clean) {
      const assertMaintenanceCurrent = async () => {
        await updateRelaunch?.recheck();
        if (
          !primaryInstanceLock() ||
          !app.hasSingleInstanceLock() ||
          desktopAdmission.quitInProgress ||
          runtimeStopping() ||
          desktopGoCore() !== null ||
          configuration() !== null ||
          startupRecovery.get() !== null ||
          secureMcpConnectorRuntime() !== null ||
          connectorStartInFlight() !== null ||
          modelLifecycle() !== null ||
          pendingComputer.size !== 0 ||
          ownedLocalRuntimes.size !== 0
        )
          throw Error("STARTUP_RECOVERY_HOST_UNCONFIRMED");
        if (!(await verify())) throw Error("STARTUP_PROMOTION_LEASE_LOST");
      };
      // Select maintenance before launching any current read-only child.
      // There is no child terminal fact to invent or infer from old receipts.
      // Saved Settings are loaded once and retained for the independent read
      // surface if this one attempt cannot qualify a fresh cold start.
      const savedSettings = await new ProductSettingsStore({
        root: stateRoot,
      })
        .loadExisting()
        .catch(() => null);
      if (savedSettings !== null) {
        try {
          const attempt =
            runtimeEnvironment === "dev" || process.env.FAROL_E2E === "1"
              ? await beginStartupMaintenanceAttempt({
                  stateRoot,
                  buildId: buildIdentity.buildId,
                  report: (notice) => {
                    try {
                      process.stderr.write(
                        "FAROL_STARTUP_MAINTENANCE_RECEIPT:" +
                          JSON.stringify({
                            schema: 1,
                            buildId: buildIdentity.buildId,
                            pid: process.pid,
                            ...notice,
                          }) +
                          "\n",
                      );
                    } catch {
                      /* Receipt output is not admission evidence. */
                    }
                  },
                })
              : undefined;
          await runStartupPreservedMaintenance({
            ...(attempt ? { attempt } : {}),
            ...(runtimeEnvironment === "dev" || process.env.FAROL_E2E === "1"
              ? {
                  onMaintenanceObservation: reportMaintenanceObservation,
                  onQualificationObservation: reportQualificationObservation,
                }
              : {}),
            userData: app.getPath("userData"),
            home: app.getPath("home"),
            computerId: savedSettings.computer.computerId,
            build: buildIdentity,
            artifactRoot: desktopCoreArtifactRoot(
              installedUpdates.resourcesOrigin?.execution.directory ??
                directory,
              runtimeEnvironment,
            ),
            compiledArtifact: compiledGoCore,
            compiledResources: compiledGoResources,
            startup: {
              lease,
              verify,
              assertCurrent: assertMaintenanceCurrent,
            },
          });
          await assertMaintenanceCurrent();
          admissionReady = true;
          startupStage("preserved-recovery-prepared");
        } catch (error) {
          if (runtimeEnvironment === "dev" || process.env.FAROL_E2E === "1") {
            try {
              process.stderr.write(
                "FAROL_STARTUP_MAINTENANCE_FAILURE:" +
                  JSON.stringify({
                    schema: 1,
                    buildId: buildIdentity.buildId,
                    pid: process.pid,
                    code: maintenanceFailureCode(error),
                  }) +
                  "\n",
              );
            } catch {
              /* The original unconfirmed branch remains selected. */
            }
          }
          // No retry or marker repair. The existing read-only composition
          // can still expose saved Settings and independently safe reads.
          startupStage("preserved-recovery-unconfirmed");
        }
      }
      if (!admissionReady) {
        // Keep the original exclusion through recovery and its exact child
        // cleanup. Existing Settings and owner reads have their own narrow
        // composition; no old marker, operation or handoff is retired here.
        await updateRelaunch?.recheck();
        if (!(await verify())) throw new Error("STARTUP_PROMOTION_LEASE_LOST");
        const assertRecoveryCurrent = async () => {
          await updateRelaunch?.recheck();
          if (!(await verify()))
            throw new Error("STARTUP_PROMOTION_LEASE_LOST");
        };
        const session = createStartupRecoverySession({
          load: async () => savedSettings,
          assertCurrent: assertRecoveryCurrent,
          start: (settings) =>
            startDesktopGoRecovery({
              compiledArtifact: compiledGoCore,
              compiledResources: compiledGoResources,
              build: buildIdentity,
              artifactRoot: desktopCoreArtifactRoot(
                installedUpdates.resourcesOrigin?.execution.directory ??
                  directory,
                runtimeEnvironment,
              ),
              stateRoot,
              home: app.getPath("home"),
              settings,
              onLifecycleObservation: reportOwnedBackendLifecycle,
            }),
        });
        try {
          quitTracePhase("recovery");
          const opened = openStartupRecoveryWindow({
            directory: installedUpdates.resources().directory,
            session,
            ...(nativeMenuBarEnabled()
              ? {
                  menuBar: (actions) =>
                    createMenuBar(actions, () => ({
                      label: desktopAdmission.quitInProgress
                        ? "Farol · Closing recovery"
                        : "Farol · Startup recovery required",
                      current: null,
                      icon: "attention",
                    })),
                }
              : {}),
            mode: windowMode,
            placement: () =>
              selectedVisibleTestPlacement({ width: 640, height: 520 }).bounds,
            quitSignals,
            onQuitting: () => {
              desktopAdmission.beginQuit();
            },
          });
          startupRecovery.set(opened);
          await opened.ready;
          process.stderr.write(
            `${secondInstanceResultPrefix}primary-recovery\n`,
          );
          await opened.quitRequested;
        } finally {
          try {
            await session.close();
          } finally {
            startupRecovery.get()?.dispose();
          }
        }
        return false;
      }
    }
    if (compiledGoCore !== null && !fresh) {
      // Admission is either a confirmed predecessor Quit or the separate
      // qualified preserving-maintenance handoff. The latter keeps the old
      // ACK/terminal unobserved; it never manufactures a clean Quit receipt.
      await computerMcpLifecycle().confirmCleanHostStop(admissionReady);
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
    return admissionReady;
  }

  return {
    admit,
    /** True once admission selected an ordinary fresh Go start. */
    freshStartup: () => fresh,
  };
}
