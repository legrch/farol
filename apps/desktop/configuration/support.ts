import {
  ProductConfigurationResultSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import type { BuildIdentity } from "../../../src/pkg/build-info/identity";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import { onboardingHelpUrl } from "../../../src/apps/desktop/onboarding-help";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import {
  createSupportExport,
  type SupportRuntimeErrorCode,
  type writeSupportExport,
} from "../../../src/apps/desktop/support-export";
import {
  setupCompletionAllowed,
  type SetupCompletionContext,
} from "../../../src/ui/setup-completion";
import type { DesktopAdmission } from "../host/admission";
import type { OperationsStore } from "../operations/store";

export type SupportConfigurationCommand = Extract<
  ProductConfigurationCommand,
  {
    kind:
      | "onboarding.open-help"
      | "support.export"
      | "general.update"
      | "setup.progress";
  }
>;

type SupportExportInput = Parameters<typeof createSupportExport>[0];
type SetupRoute = Pick<
  ChatGptRoute,
  "observeSignInStatus" | "isCurrentSignInStatus"
>;

// Main owns the mutable state and the helper definitions. Everything here is a
// late getter or callback, bound to its real receiver at call time; the module
// copies no state and constructs no owner of its own. `buildIdentity` and the
// three task maps are `const` in main and are shared by reference.
export type ConfigurationSupportPorts = Readonly<{
  configuration: () => ProductConfigurationService | null;
  configurationFailure: (
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  openExternal: (url: string) => Promise<void>;
  selectedSupportExportTarget: () => Promise<string | null>;
  productTasksState: () => Readonly<{ tasks: readonly unknown[] }>;
  operationsStore: () => Pick<OperationsStore, "snapshot">;
  writeSupportExport: typeof writeSupportExport;
  buildIdentity: BuildIdentity;
  runtimeState: () => "starting" | "ready" | "offline" | "failed";
  runtimeError: () => string | null;
  runtime: () => Readonly<{
    identity: SupportExportInput["runtime"]["identity"];
  }> | null;
  productAgentCapabilityAvailable: () => boolean;
  routeBRuntime: () => object | null;
  taskCountsBeforeRuntimeExit: () => Readonly<{
    running: number;
    waiting: number;
    failed: number;
  }> | null;
  streamControllers: Readonly<{ size: number }>;
  pendingComputer: Readonly<{ size: number }>;
  taskSurfaceFailures: Readonly<{ size: number }>;
  chatGptRoute: () => SetupRoute | null;
  setupSignInCheck: () => SetupCompletionContext["signInCheck"];
  desktopAdmission: Pick<DesktopAdmission, "closed" | "occupied">;
  activeAuthorityChangeKind: () => ProductConfigurationCommand["kind"] | null;
}>;

export function supportRuntimeErrorCode(
  error: string | null,
): SupportRuntimeErrorCode | null {
  if (error === null) return null;
  if (error === "RUNTIME_PROCESS_EXITED") return "process_exited";
  if (error === "RUNTIME_PROCESS_FAILED") return "process_failed";
  if (error === "RUNTIME_START_TIMEOUT") return "start_timeout";
  if (error === "RUNTIME_TASK_MANIFEST_MISMATCH") return "manifest_mismatch";
  if (
    error === "RUNTIME_EXITED" ||
    error === "RUNTIME_START_FAILED" ||
    /^RUNTIME_START_FAILED_-?\d+$/u.test(error)
  ) {
    return "startup_failed";
  }
  return "other";
}

export function createConfigurationSupport(ports: ConfigurationSupportPorts) {
  const {
    configuration,
    configurationFailure,
    openExternal,
    selectedSupportExportTarget,
    productTasksState,
    operationsStore,
    writeSupportExport,
    buildIdentity,
    runtimeState,
    runtimeError,
    runtime,
    productAgentCapabilityAvailable,
    routeBRuntime,
    taskCountsBeforeRuntimeExit,
    streamControllers,
    pendingComputer,
    taskSurfaceFailures,
    chatGptRoute,
    setupSignInCheck,
    desktopAdmission,
    activeAuthorityChangeKind,
  } = ports;

  // Main retains parsed-command admission and its settings-availability guard,
  // so `configuration()` is present for every command that reaches here.
  async function configureAdmittedSupport(
    command: SupportConfigurationCommand,
  ): Promise<ProductConfigurationResult> {
    switch (command.kind) {
      case "onboarding.open-help": {
        try {
          await openExternal(onboardingHelpUrl(command.destination));
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
          });
        } catch {
          return configurationFailure("ONBOARDING_HELP_OPEN_FAILED");
        }
      }
      case "support.export": {
        try {
          const target = await selectedSupportExportTarget();
          if (target === null) {
            return configurationFailure("SUPPORT_EXPORT_CANCELLED");
          }
          const tasks = productTasksState().tasks;
          const supportConfiguration = configuration()!.snapshot();
          const receipt = await writeSupportExport(
            target,
            createSupportExport({
              operations: await operationsStore().snapshot(),
              generatedAt: new Date().toISOString(),
              build: buildIdentity,
              configuration: supportConfiguration,
              runtime: {
                state: runtimeState(),
                errorCode: supportRuntimeErrorCode(runtimeError()),
                identity: runtime()?.identity ?? null,
              },
              capabilities: {
                nativeFilesystem: true,
                nativeAgent: productAgentCapabilityAvailable(),
                liveProvider: routeBRuntime() !== null,
              },
              embedded: {
                node: process.versions.node,
                electron: process.versions.electron ?? null,
                chrome: process.versions.chrome ?? null,
              },
              tasks:
                runtimeState() === "failed" && taskCountsBeforeRuntimeExit()
                  ? {
                      total: tasks.length,
                      ...taskCountsBeforeRuntimeExit()!,
                      countsFrom: "before_runtime_exit" as const,
                    }
                  : {
                      total: tasks.length,
                      running: streamControllers.size,
                      waiting: pendingComputer.size,
                      failed: taskSurfaceFailures.size,
                      countsFrom: "current" as const,
                    },
            }),
            supportConfiguration.status === "ready"
              ? supportConfiguration.settings.computer.workspaces
              : [],
          );
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
            evidence: { kind: "support.exported", ...receipt },
          });
        } catch (error) {
          return configurationFailure(
            error instanceof Error &&
              error.message === "SUPPORT_EXPORT_TOO_LARGE"
              ? "SUPPORT_EXPORT_TOO_LARGE"
              : "SUPPORT_EXPORT_FAILED",
          );
        }
      }
      case "general.update":
        return ProductConfigurationResultSchema.parse(
          await configuration()!.updateGeneral({
            openAtLaunch: command.openAtLaunch,
            sidebarDefault: command.sidebarDefault,
            activityDetail: command.activityDetail,
          }),
        );
      case "setup.progress": {
        const route = chatGptRoute();
        const check = setupSignInCheck();
        // Read only the existing document. No sign-in or provider effect is retried.
        const observation = command.dismissed
          ? await route?.observeSignInStatus().catch(() => null)
          : null;
        return ProductConfigurationResultSchema.parse(
          await configuration()!.setSetupJourney(
            { currentStep: command.currentStep, dismissed: command.dismissed },
            (settings) =>
              setupCompletionAllowed(settings, {
                buildId: buildIdentity.buildId,
                current:
                  runtimeState() === "ready" &&
                  !desktopAdmission.closed() &&
                  !desktopAdmission.occupied("connector-task") &&
                  !desktopAdmission.occupied("workspace-mutation") &&
                  activeAuthorityChangeKind() === null &&
                  chatGptRoute() === route &&
                  setupSignInCheck() === check &&
                  observation != null &&
                  route?.isCurrentSignInStatus(observation) === true,
                signInObservation: observation
                  ? {
                      ...observation,
                      buildId: buildIdentity.buildId,
                      pending: false,
                    }
                  : null,
                signInCheck: check,
              }),
          ),
        );
      }
    }
  }

  return Object.freeze({ configureAdmittedSupport });
}
