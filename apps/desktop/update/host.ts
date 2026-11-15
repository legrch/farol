import type { ProductConfigurationResult } from "../../../src/pkg/product-settings/contract";
import type { BuildIdentity } from "../../../src/pkg/build-info/identity";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { SecureMcpConnectorRuntime } from "../../../src/apps/desktop/secure-mcp-connector-runtime";
import type { TaskMutationGate } from "../../../src/apps/desktop/task-mutation-gate";
import type { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import type { DesktopAdmission } from "../host/admission";
import type { OperationsRecorder } from "../renderer/operations-contract";
import { createQuitUpdatePreparation } from "../../../src/apps/desktop/quit-update-preparation";
import { createUpdateAbortConnectorRecovery } from "../../../src/apps/desktop/connector-resume-policy";
import { drainInstalledComputer } from "../../../src/apps/desktop/installed-computer-drain";
import type {
  InstalledUpdateRuntimeOptions,
  InstalledUpdateResourcesOrigin,
} from "../../../src/apps/desktop/installed-update-runtime";
import {
  InstalledUpdateCommandSchema,
  isRetiredInstalledUpdateCommand,
  type InstalledUpdateView,
  type NormalQuitApplyContext,
  type NormalQuitUpdateRequest,
  type NormalQuitUpdateReceipt,
  type InstalledUpdateCommand,
  type AutomaticUpdatePreferenceResult,
  type InstallOnQuitPreferenceResult,
} from "../../../src/modules/release/contract/installed-update";
import {
  acquirePromotionLease,
  verifyPromotionLease,
  releasePromotionLease,
  type PromotionLeaseHandle,
} from "../../../src/apps/desktop/promotion-lease";
import { withStartupPromotionLease } from "../../../src/apps/desktop/startup-promotion-lease";

export type InstalledUpdateOwner = Readonly<{
  snapshot(): InstalledUpdateView;
  initialize(): Promise<void>;
  scheduledCheck(): Promise<void>;
  close(): Promise<void>;
  ownerHandoffSafe(): boolean;
  manualCheck(): Promise<void>;
  download(): Promise<void>;
  skip(): Promise<void>;
  later(): Promise<void>;
  acknowledgeNotice(key: string): Promise<void>;
  setAutomaticUpdatePreference(
    enabled: boolean,
    scope: Extract<
      InstalledUpdateCommand,
      { kind: "set-automatic-update-preference" }
    >["scope"],
  ): Promise<AutomaticUpdatePreferenceResult>;
  setInstallOnQuitPreference(
    enabled: boolean,
  ): Promise<InstallOnQuitPreferenceResult>;
  restartConfirmed(version: string): Promise<void>;
  restart(): Promise<void>;
  applyOnNormalQuit(
    request: NormalQuitUpdateRequest,
  ): Promise<NormalQuitUpdateReceipt>;
}>;

type UpdateRoute = Pick<
  ChatGptRoute,
  "acquireUpdateIdle" | "acquireUpdateClose"
>;
export type InstalledUpdateHostPorts = Readonly<{
  buildEnvironment: string;
  sidecarOnly: boolean;
  directory: string;
  build: BuildIdentity;
  goCoreArtifact: unknown;
  physicalFiles: NonNullable<InstalledUpdateRuntimeOptions["physicalFiles"]>;
  createRuntime(
    options: InstalledUpdateRuntimeOptions,
  ): Promise<InstalledUpdateOwner | null>;
  idleCheckMs: number;
  createHelperLifetime(): NonNullable<
    InstalledUpdateRuntimeOptions["helperLifetime"]
  >;
  operations(): OperationsRecorder;
  userData(): string;
  quit(): void;
  publish(view: InstalledUpdateView): void;
  configurationChanged(): void;
  admission: Pick<
    DesktopAdmission,
    "quitInProgress" | "updateBlocker" | "enterUpdate"
  >;
  configuration(): Pick<
    ProductConfigurationService,
    "snapshot" | "recordSecureMcpDrainedForUpdate"
  > | null;
  authorityTransitions: AuthorityTransitionReservation;
  taskMutations(): Pick<TaskMutationGate, "tryEnter">;
  connector(): Pick<SecureMcpConnectorRuntime, "isRunning"> | null;
  routes(): Iterable<UpdateRoute>;
  persistence(): Promise<void>;
  launchRoot(): string;
  stopConnector(): Promise<void>;
  startConnector(
    repair: boolean,
    resumeAfterQuit: boolean,
  ): Promise<ProductConfigurationResult>;
  stage(stage: string): void;
  applyLayout(): void;
}>;

// One installed-update owner per desktop. Construction reads no late host state;
// every callback below observes its original call-time owners through ports.
export function createInstalledUpdateHost(host: InstalledUpdateHostPorts) {
  let installedUpdater: InstalledUpdateOwner | null = null;
  let installedResourcesOrigin: InstalledUpdateResourcesOrigin | undefined;

  // Every delayed bundled execution keeps the independently authenticated image.
  function desktopExecutionResources() {
    return {
      directory:
        installedResourcesOrigin?.execution.directory ?? host.directory,
      executable:
        installedResourcesOrigin?.execution.executable ?? process.execPath,
      recheck: installedResourcesOrigin?.recheck ?? (async () => undefined),
    };
  }

  const quitUpdatePreparation = createQuitUpdatePreparation(
    () => installedUpdater,
  );
  let installedUpdaterInitialization: Promise<void> | null = null;
  let installedUpdateTimer: NodeJS.Timeout | null = null;
  let installedUpdateView: InstalledUpdateView = {
    phase: "unavailable",
    code: "UPDATE_NOT_INSTALLED",
  };

  function publishInstalledUpdate(view: InstalledUpdateView): void {
    installedUpdateView = view;
    host.publish(view);
  }
  async function installedUpdateCommand(
    value: unknown,
  ): Promise<InstalledUpdateView> {
    if (isRetiredInstalledUpdateCommand(value))
      return { phase: "unavailable", code: "UPDATE_FORWARD_ONLY" };
    const command = InstalledUpdateCommandSchema.safeParse(value);
    if (!command.success || !installedUpdater || host.admission.quitInProgress)
      return installedUpdateView;
    if (command.data.kind === "check") await installedUpdater.manualCheck();
    else if (command.data.kind === "download")
      await installedUpdater.download();
    else if (command.data.kind === "skip") await installedUpdater.skip();
    else if (command.data.kind === "later") await installedUpdater.later();
    else if (command.data.kind === "notice-seen")
      await installedUpdater.acknowledgeNotice(command.data.noticeKey);
    else if (command.data.kind === "set-automatic-update-preference") {
      await installedUpdater.setAutomaticUpdatePreference(
        command.data.enabled,
        command.data.scope,
      );
      return installedUpdater.snapshot();
    } else if (command.data.kind === "set-install-on-quit-preference") {
      await installedUpdater.setInstallOnQuitPreference(command.data.enabled);
      return installedUpdater.snapshot();
    } else if (command.data.kind === "restart-confirmed")
      await installedUpdater.restartConfirmed(command.data.version);
    else if (command.data.kind === "restart") await installedUpdater.restart();
    return installedUpdateView;
  }
  async function initializeInstalledUpdater(): Promise<void> {
    // Owner Preview is an on-demand artifact, never an installed update owner.
    // Refuse before constructing a runtime or inspecting installed resources.
    if (host.buildEnvironment !== "preview") return;
    try {
      installedUpdater = await host.createRuntime({
        ...(host.sidecarOnly
          ? { relaunchPresentation: "sidecar-only" as const }
          : {}),
        helperLifetime: host.createHelperLifetime(),
        operations: host.operations(),
        directory: host.directory,
        userData: host.userData(),
        build: host.build,
        ...(host.goCoreArtifact === null
          ? {}
          : { goCoreArtifact: host.goCoreArtifact }),
        physicalFiles: host.physicalFiles,
        ...(installedResourcesOrigin
          ? { resourcesOrigin: installedResourcesOrigin }
          : {}),
        copyApp: (source, destination) =>
          host.physicalFiles.cp(source, destination, {
            recursive: true,
            force: false,
            errorOnExist: true,
            verbatimSymlinks: true,
            preserveTimestamps: true,
          }),
        removeDirectory: (directory, force) =>
          host.physicalFiles.rm(directory, { recursive: true, force }),
        publish: publishInstalledUpdate,
        quit: () => host.quit(),
        canStartNormalQuitEffect: () =>
          host.admission.quitInProgress &&
          quitUpdatePreparation.effectAllowed(),
        acquireAdmission: async (
          desktopWorkSettled,
          quit?: NormalQuitApplyContext,
          confirmation?: Parameters<
            InstalledUpdateRuntimeOptions["acquireAdmission"]
          >[2],
        ) => {
          // Only the host's original preparation may borrow the Quit admission.
          // New IPC work remains fenced by quitInProgress throughout preparation.
          const admissionCurrent = () =>
            quit === undefined
              ? !host.admission.quitInProgress
              : host.admission.quitInProgress &&
                quitUpdatePreparation.admissionAllowed(quit);
          const blocker = host.admission.updateBlocker(admissionCurrent());
          if (blocker) return { ok: false, code: blocker };
          const snapshot = host.configuration()?.snapshot();
          if (!snapshot || snapshot.status !== "ready")
            return { ok: false, code: "UPDATE_STATE_UNREADABLE" };
          const transition =
            host.authorityTransitions.tryReserve("authority-change");
          if (!transition) return { ok: false, code: "UPDATE_WORK_PENDING" };
          const taskClaim = host.taskMutations().tryEnter();
          if (!taskClaim) {
            transition.release();
            return { ok: false, code: "UPDATE_WORK_PENDING" };
          }
          const updateAdmission = host.admission.enterUpdate();
          if (!updateAdmission) {
            taskClaim.release();
            transition.release();
            return { ok: false, code: "UPDATE_WORK_PENDING" };
          }
          // Hide embedded input before any asynchronous probe; IPC and configuration
          // admission above stay reserved through the final helper handoff.
          host.applyLayout();
          const browserAdmissions: Array<
            Extract<
              Awaited<ReturnType<ChatGptRoute["acquireUpdateIdle"]>>,
              { ok: true }
            >
          > = [];
          const recheck = async () => {
            if (!admissionCurrent())
              return { ok: false as const, code: "UPDATE_WORK_PENDING" };
            for (const browser of browserAdmissions) {
              const result = await browser.recheck();
              if (!result.ok) return result;
              if (!admissionCurrent())
                return { ok: false as const, code: "UPDATE_WORK_PENDING" };
            }
            return { ok: true as const };
          };
          let lease: Awaited<ReturnType<typeof acquirePromotionLease>> = null;
          let browserReleaseUnconfirmed = false;
          const recovery = createUpdateAbortConnectorRecovery({
            before: snapshot,
            wasRunning: host.connector()?.isRunning() ?? false,
            current: () => host.configuration()?.snapshot() ?? null,
            releaseAdmission: async () => {
              for (const browser of browserAdmissions) await browser.release();
              if (browserReleaseUnconfirmed)
                throw new Error("UPDATE_BROWSER_RELEASE_UNCONFIRMED");
              if (lease) await releasePromotionLease(lease);
              taskClaim.release();
              transition.release();
              updateAdmission.release();
              host.applyLayout();
            },
            resumeConnector: async () => {
              if (host.admission.quitInProgress) return;
              try {
                const result = await host.startConnector(false, true);
                host.stage(
                  result.ok
                    ? "update-abort-connector-resumed"
                    : "update-abort-connector-resume-refused",
                );
              } catch {
                host.stage("update-abort-connector-resume-failed");
              }
              if (!host.admission.quitInProgress) host.configurationChanged();
            },
          });
          const release = recovery.release;
          const abort = async (code: string) => {
            try {
              await release();
              return { ok: false as const, code };
            } catch {
              return {
                ok: false as const,
                code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
              };
            }
          };
          try {
            const routes = new Set(host.routes());
            for (const route of routes) {
              if (!admissionCurrent()) return abort("UPDATE_WORK_PENDING");
              const browser = confirmation
                ? await route.acquireUpdateClose()
                : await route.acquireUpdateIdle(
                    quit
                      ? {
                          deadlineAt: quit.deadlineAt,
                          canStartEffect: admissionCurrent,
                        }
                      : undefined,
                  );
              if (!browser.ok) {
                browserReleaseUnconfirmed =
                  browser.code === "UPDATE_BROWSER_RELEASE_UNCONFIRMED";
                return abort(browser.code);
              }
              browserAdmissions.push(browser);
              if (!admissionCurrent()) return abort("UPDATE_WORK_PENDING");
            }
            if (!admissionCurrent()) return abort("UPDATE_WORK_PENDING");
            lease = await acquirePromotionLease(
              host.userData(),
              host.build.buildId,
              "promotion",
            );
            if (!lease || !(await verifyPromotionLease(lease))) {
              return abort("UPDATE_WORK_PENDING");
            }
            await host.persistence();
            if (!admissionCurrent()) return abort("UPDATE_WORK_PENDING");
            const drained = await drainInstalledComputer({
              root: host.launchRoot(),
              settings: snapshot.settings,
              ...(quit ? { deadlineAt: quit.deadlineAt } : {}),
              desktopWorkSettled,
              stillCurrent: () => {
                const current = host.configuration()?.snapshot();
                return (
                  admissionCurrent() &&
                  current?.status === "ready" &&
                  current.settings.revision === snapshot.settings.revision
                );
              },
              stopOwnedClients: async () => {
                if (!admissionCurrent())
                  throw new Error("UPDATE_QUIT_DEADLINE_EXPIRED");
                await host.stopConnector();
                if (!admissionCurrent())
                  throw new Error("UPDATE_QUIT_DEADLINE_EXPIRED");
                // Preserve route, grants, selected app and credentials. Only the
                // runtime attachment becomes stopped after a verified drain.
                const recorded = await host
                  .configuration()
                  ?.recordSecureMcpDrainedForUpdate();
                if (!recorded?.ok)
                  throw new Error("UPDATE_CONNECTOR_DRAIN_UNCONFIRMED");
                recovery.recordDrained(recorded.snapshot);
              },
            });
            if (!drained.ok) {
              return abort(drained.code);
            }
            if (!admissionCurrent()) return abort("UPDATE_WORK_PENDING");
            return { ok: true, release, recheck };
          } catch {
            return abort("UPDATE_STATE_UNREADABLE");
          }
        },
      });
      if (!installedUpdater) return;
      if (host.admission.quitInProgress) {
        await installedUpdater.close();
        return;
      }
      publishInstalledUpdate(installedUpdater.snapshot());
      await installedUpdater.initialize();
      if (host.admission.quitInProgress) {
        await installedUpdater.close();
        return;
      }
      void installedUpdater.scheduledCheck();
      installedUpdateTimer = setInterval(() => {
        void installedUpdater?.scheduledCheck();
      }, host.idleCheckMs);
      installedUpdateTimer.unref();
    } catch {
      publishInstalledUpdate({
        phase: "failed",
        code: "UPDATE_INITIALIZATION_FAILED",
        recoveryRequired: true,
      });
    }
  }

  return {
    get updater() {
      return installedUpdater;
    },
    get view() {
      return installedUpdateView;
    },
    get resourcesOrigin() {
      return installedResourcesOrigin;
    },
    set resourcesOrigin(value: InstalledUpdateResourcesOrigin | undefined) {
      installedResourcesOrigin = value;
    },
    quitPreparation: quitUpdatePreparation,
    resources: desktopExecutionResources,
    command: installedUpdateCommand,
    initialize(): Promise<void> {
      return (installedUpdaterInitialization ??= initializeInstalledUpdater());
    },
    stopTimer(): void {
      if (installedUpdateTimer) clearInterval(installedUpdateTimer);
    },
    async close(): Promise<void> {
      await installedUpdater?.close();
      // Creation can still be reading private state when Quit starts. The
      // initializer closes that late lifetime before this join completes.
      await installedUpdaterInitialization;
      await installedUpdater?.close();
    },
  };
}

export async function withInstalledStartupFence<Update, T>(
  args: readonly string[],
  userData: string,
  generation: string,
  observe: () => Promise<Update>,
  start: (
    update: Update,
    verify: () => Promise<boolean>,
    lease: PromotionLeaseHandle,
  ) => Promise<T>,
  promotion: typeof withStartupPromotionLease = withStartupPromotionLease,
): Promise<T> {
  // Match the updater's hint detection, including malformed hints: its parser
  // must reject those before a lease can block an explicit helper relaunch.
  const hint = "--farol-installed-update-relaunch";
  const explicit = args.some(
    (arg) => arg === hint || arg.startsWith(hint + "="),
  );
  const relaunch = explicit ? await observe() : undefined;
  return promotion(userData, generation, async (verify, lease) =>
    start(explicit ? relaunch! : await observe(), verify, lease),
  );
}
