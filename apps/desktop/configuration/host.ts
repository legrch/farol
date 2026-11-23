import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { describeTaskModels } from "../../../src/pkg/owner-config/contract";
import { FAROL_PROVIDER_ID } from "../../../src/pkg/model-route/contract";
import {
  ProductConfigurationResultSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
  type ProductSettings,
} from "../../../src/pkg/product-settings/contract";
import { activateAgentCheckSession } from "../../../src/apps/desktop/codex-agent-check-admission";
import type { AuthorityTransitionReservation } from "../../../src/apps/desktop/authority-transition";
import type { CodexAgentWorkspaceProbe } from "../../../src/apps/desktop/codex-agent-workspace-probe";
import type { launchCodexAppServer } from "../../../src/apps/desktop/codex-app-server-process";
import type { runCodexChatGptHostRoute } from "../../../src/apps/desktop/codex-chatgpt-host-route";
import type { probeCodexHost } from "../../../src/apps/desktop/codex-host-probe";
import type { runCodexHostSmoke } from "../../../src/apps/desktop/codex-host-smoke";
import type { runCodexNativeAgentCheck } from "../../../src/apps/desktop/codex-native-agent-check";
import {
  codexTaskRouteFailureCode,
  codexTaskRouteFailureRecord,
  codexTaskRouteRefusalRecord,
} from "../../../src/apps/desktop/codex-task-route-error";
import type {
  DiscoveryCandidate,
  discoverExecutables,
} from "../../../src/apps/desktop/executable-discovery";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { runRouteBHostCheck } from "../../../src/apps/desktop/route-b-host-check";
import type {
  ROUTE_B_MODEL,
  RouteBRuntime,
} from "../../../src/apps/desktop/route-b-runtime";
import type { DesktopAdmission } from "../host/admission";
import type { DesktopGoCore } from "../go-core-host";

export type HostConfigurationCommand = Extract<
  ProductConfigurationCommand,
  { kind: `host.${string}` }
>;

export type CodexAppServerClient = Awaited<
  ReturnType<typeof launchCodexAppServer>
>;

type Catalogue = Parameters<typeof describeTaskModels>[2];
type AgentCheckInput = Parameters<typeof runCodexNativeAgentCheck>[0];
type AgentCheckHost = AgentCheckInput["host"] & Readonly<{ dispose(): void }>;

// The Agent check session the one-off check keeps between polls. Main owns the
// slot that holds it (the quit and admission predicates read it too).
export type ActiveCodexAgentCheck = Readonly<{
  key: string;
  client: CodexAppServerClient;
  host: AgentCheckHost;
  boundedRunningObserved: boolean;
}>;

// The shared proxy as these commands use it. The real class also satisfies the
// catalogue and handoff host interfaces.
export type CodexProxy = Readonly<{
  request(
    method: string,
    params: unknown,
    deadlineAt?: number,
  ): Promise<unknown>;
  modelCatalogueScope?(): string;
  close(): void;
  closeAndWait(): Promise<boolean>;
}>;

type HandoffGrant = Readonly<{
  workspaceId: string;
  writerRoot: string;
  writerIdentity: Readonly<{ device: string; inode: string }>;
  projectRoot: string;
  projectIdentity: Readonly<{ device: string; inode: string }>;
  gitCommonDirectory: string;
  execution: Readonly<{
    sandbox: "read-only" | "workspace-write";
    approvalPolicy: "untrusted" | "on-request";
  }>;
}>;

type AgentHostOptions = Readonly<{
  model: "gpt-6-astra";
  runtimeRoot: string;
  spawnTimeoutMs: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  nonce: () => string;
  now: () => number;
}>;

// Main owns the mutable state and the helper definitions. Everything here is a
// late getter or callback, bound to its real receiver at call time; the module
// copies no state and constructs no owner of its own.
export type ConfigurationHostPorts = Readonly<{
  configuration: () => ProductConfigurationService | null;
  desktopGoCore: () => DesktopGoCore | null;
  compiledGoCore: () => unknown;
  routeBRuntime: () => RouteBRuntime | null;
  activeCodexAgentCheck: () => ActiveCodexAgentCheck | null;
  setActiveCodexAgentCheck: (value: ActiveCodexAgentCheck | null) => void;
  activeProductAgentSession: () => object | null;
  pendingProductAgentTaskId: () => string | null;
  hostCheckClients: Set<CodexAppServerClient>;
  buildIdentity: () => Readonly<{ buildId: string; version: string }>;
  desktopAdmission: Pick<DesktopAdmission, "occupied" | "reserveAdmitted">;
  authorityTransitions: Pick<AuthorityTransitionReservation, "tryReserve">;
  configurationFailure: (
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  transitionRefusal: () => ProductConfigurationResult;
  codexAgentOperationActive: () => boolean;
  selectedCodexExecutable: () => Promise<string | "cancelled" | "invalid">;
  e2eCodexExecutable: () => string | "invalid" | undefined;
  verifyCodexExecutable: (
    executablePath: string,
    expectedDiscovery?: Readonly<{ canonicalPath: string; sha256: string }>,
  ) => Promise<ProductConfigurationResult>;
  reverifyDiscoveredCandidate: (
    kind: "codex" | "tunnel-client",
    requestedPath: string,
  ) => Promise<DiscoveryCandidate | "stale" | "declined">;
  discoverExecutables: typeof discoverExecutables;
  probeCodexHost: typeof probeCodexHost;
  statePaths: () => Readonly<{
    codexHostProbe: string;
    codexAgentAssignments: string;
  }>;
  chatGptTaskAdmissionReady: () => boolean;
  runRouteBHostCheck: typeof runRouteBHostCheck;
  runCodexChatGptHostRoute: typeof runCodexChatGptHostRoute;
  runCodexHostSmoke: typeof runCodexHostSmoke;
  runCodexNativeAgentCheck: typeof runCodexNativeAgentCheck;
  launchCodexAppServer: typeof launchCodexAppServer;
  codexHostRuntimeRoot: () => Promise<string>;
  codexHostProcessHomePath: () => Promise<string>;
  codexHostHomeOption: () => Promise<Readonly<{ codexHomePath?: string }>>;
  codexAgentCheckWorkspace: (
    settings: ProductSettings,
  ) => ConstructorParameters<typeof CodexAgentWorkspaceProbe>[1];
  tempPath: () => string;
  ROUTE_B_MODEL: typeof ROUTE_B_MODEL;
  SharedCodexProxyHost: Readonly<{
    attach: (
      input: Readonly<{
        executablePath: string;
        executableSha256: string;
        socketPath: string;
        cwd: string;
        expectedCodexHome: string;
      }>,
    ) => Promise<CodexProxy>;
  }>;
  ReadCodexModelCatalogue: new (
    host: CodexProxy,
    now: () => number,
  ) => Readonly<{
    read: (
      options: Readonly<{ fresh: true; deadlineAt: number }>,
    ) => Promise<Catalogue>;
  }>;
  PhysicalCodexHandoffAuthority: new (
    grant: HandoffGrant,
  ) => Readonly<{ resolve: (workspaceId: string) => Promise<unknown> }>;
  exactProject: (
    host: CodexProxy,
    projectId: string,
    root: string,
  ) => Promise<boolean>;
  CodexNativeAgentHost: new (
    client: CodexAppServerClient,
    options: AgentHostOptions,
    workspaceProbe: CodexAgentWorkspaceProbe,
  ) => AgentCheckHost;
  CodexAgentWorkspaceProbe: typeof CodexAgentWorkspaceProbe;
  PrivateAssignmentStore: new (
    input: Readonly<{ root: string }>,
  ) => AgentCheckInput["assignments"];
  fileSystem: Readonly<{
    chmod: typeof chmod;
    lstat: typeof lstat;
    mkdtemp: typeof mkdtemp;
    realpath: typeof realpath;
    rm: typeof rm;
  }>;
  writeStderr: (text: string) => void;
}>;

export function createConfigurationHost(ports: ConfigurationHostPorts) {
  const {
    configuration,
    desktopGoCore,
    compiledGoCore,
    routeBRuntime,
    activeCodexAgentCheck,
    setActiveCodexAgentCheck,
    activeProductAgentSession,
    pendingProductAgentTaskId,
    hostCheckClients,
    buildIdentity,
    desktopAdmission,
    authorityTransitions,
    configurationFailure,
    transitionRefusal,
    codexAgentOperationActive,
    selectedCodexExecutable,
    e2eCodexExecutable,
    verifyCodexExecutable,
    reverifyDiscoveredCandidate,
    discoverExecutables,
    probeCodexHost,
    statePaths,
    chatGptTaskAdmissionReady,
    runRouteBHostCheck,
    runCodexChatGptHostRoute,
    runCodexHostSmoke,
    runCodexNativeAgentCheck,
    launchCodexAppServer,
    codexHostRuntimeRoot,
    codexHostProcessHomePath,
    codexHostHomeOption,
    codexAgentCheckWorkspace,
    tempPath,
    ROUTE_B_MODEL,
    SharedCodexProxyHost,
    ReadCodexModelCatalogue,
    PhysicalCodexHandoffAuthority,
    exactProject,
    CodexNativeAgentHost,
    CodexAgentWorkspaceProbe,
    PrivateAssignmentStore,
    fileSystem,
    writeStderr,
  } = ports;
  const { chmod, lstat, mkdtemp, realpath, rm } = fileSystem;

  // Main retains parsed-command admission, the retired-model refusal of the
  // smoke and Agent checks, and its settings-availability guard.
  async function configureAdmittedHost(
    command: HostConfigurationCommand,
  ): Promise<ProductConfigurationResult> {
    switch (command.kind) {
      case "host.select-codex": {
        if (codexAgentOperationActive()) {
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        }
        const selected = await selectedCodexExecutable();
        if (selected === "cancelled") {
          return configurationFailure("CODEX_HOST_PICKER_CANCELLED");
        }
        if (selected === "invalid") {
          return configurationFailure("CODEX_HOST_SELECTION_INVALID");
        }
        return verifyCodexExecutable(selected);
      }
      case "host.discover-codex": {
        try {
          // Discovery is read-only. The owner selects a candidate explicitly
          // before verification can change the host or Computer authority.
          // E2E discovery never scans the owner's installed Codex binaries.
          const testExecutable = e2eCodexExecutable();
          if (testExecutable === "invalid") {
            return configurationFailure("CODEX_HOST_SELECTION_INVALID");
          }
          const discovered =
            testExecutable === undefined
              ? await discoverExecutables("codex")
              : { candidates: [], searched: [] };
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
            evidence: {
              kind: "host.codex-discovery",
              candidates: discovered.candidates,
              searched: discovered.searched,
            },
          });
        } catch {
          return configurationFailure("CODEX_HOST_DISCOVERY_FAILED");
        }
      }
      case "host.select-discovered-codex": {
        if (codexAgentOperationActive()) {
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        }
        const candidate = await reverifyDiscoveredCandidate(
          "codex",
          command.path,
        );
        if (candidate === "stale") {
          return configurationFailure("CODEX_HOST_DISCOVERY_CANDIDATE_STALE");
        }
        if (candidate === "declined") {
          return configurationFailure("CODEX_HOST_PICKER_CANCELLED");
        }
        if (!candidate.sha256) {
          return configurationFailure("CODEX_HOST_DISCOVERY_CANDIDATE_STALE");
        }
        return verifyCodexExecutable(candidate.path, {
          canonicalPath: candidate.path,
          sha256: candidate.sha256,
        });
      }
      case "host.verify-codex": {
        if (codexAgentOperationActive()) {
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        }
        const snapshot = configuration()!.snapshot();
        if (
          snapshot.status !== "ready" ||
          !snapshot.settings.nativeHosts.codex
        ) {
          return configurationFailure("CODEX_HOST_NOT_CONFIGURED");
        }
        return verifyCodexExecutable(
          snapshot.settings.nativeHosts.codex.executablePath,
        );
      }
      case "host.refresh-codex-task-models": {
        if (
          desktopAdmission.occupied("codex-host-task") ||
          codexAgentOperationActive()
        )
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready")
          return configurationFailure("SETTINGS_UNAVAILABLE");
        const settings = snapshot.settings;
        const selected = settings.nativeHosts.codex;
        const route = settings.nativeHosts.taskRoute;
        if (
          !selected?.localVerification ||
          !route ||
          route.expiresAt <= Date.now() ||
          route.hostGeneration !== settings.nativeHosts.generation ||
          route.computerGeneration !== settings.computer.generation
        )
          return configurationFailure("CODEX_TASK_ROUTE_UNAVAILABLE");
        const codexAdmission =
          desktopAdmission.reserveAdmitted("codex-host-task");
        let proxy: CodexProxy | null = null;
        let scratch: string | null = null;
        let result: Catalogue = {
          status: "unavailable",
          code: "TASK_MODEL_CATALOG_UNAVAILABLE",
        };
        let cleaned = true;
        try {
          scratch = await realpath(
            await mkdtemp(path.join(os.tmpdir(), "farol-model-catalogue-")),
          );
          await chmod(scratch, 0o700);
          proxy = await SharedCodexProxyHost.attach({
            executablePath: selected.executablePath,
            executableSha256: selected.executableSha256,
            socketPath: route.socketPath,
            cwd: scratch,
            expectedCodexHome: route.expectedCodexHome,
          });
          result = await new ReadCodexModelCatalogue(proxy, Date.now).read({
            fresh: true,
            deadlineAt: route.expiresAt,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "CODEX_PROXY_CLEANUP_UNVERIFIED"
          )
            cleaned = false;
          result = {
            status: "unavailable",
            code: "TASK_MODEL_CATALOG_UNAVAILABLE",
          };
        } finally {
          if (proxy) cleaned = await proxy.closeAndWait().catch(() => false);
          if (scratch && cleaned)
            await rm(scratch, { recursive: true, force: true }).catch(() => {
              cleaned = false;
            });
          codexAdmission.release();
        }
        const current = configuration()!.snapshot();
        if (
          !cleaned ||
          current.status !== "ready" ||
          current.settings.revision !== settings.revision ||
          route.expiresAt <= Date.now()
        )
          result = {
            status: "unavailable",
            code: "TASK_MODEL_CATALOG_CHANGED",
          };
        const core = desktopGoCore();
        let view;
        if (compiledGoCore() === null) {
          // Explicit controller compatibility only. A selected Go error never
          // invokes this legacy policy implementation.
          view = describeTaskModels(
            current.status === "ready" ? current.settings.tasks : undefined,
            "codex",
            result,
          );
        } else {
          if (!core)
            return configurationFailure("CODEX_TASK_ROUTE_UNAVAILABLE");
          try {
            view = await core.describeTaskModels(
              current.status === "ready"
                ? current.settings.revision
                : settings.revision,
              current.status === "ready" ? current.settings.tasks : undefined,
              "codex",
              result,
            );
          } catch {
            return configurationFailure("CODEX_TASK_ROUTE_UNAVAILABLE");
          }
          const latest = configuration()!.snapshot();
          if (
            desktopGoCore() !== core ||
            route.expiresAt <= Date.now() ||
            latest.status !== current.status ||
            (latest.status === "ready" &&
              current.status === "ready" &&
              latest.settings.revision !== current.settings.revision)
          )
            return configurationFailure("CODEX_TASK_ROUTE_REFUSED");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: current,
          evidence: {
            kind: "host.task-models",
            view,
          },
        });
      }
      case "host.configure-codex-tasks": {
        const refuseRoute = (
          phase: Parameters<typeof codexTaskRouteRefusalRecord>[0],
        ) => {
          writeStderr(
            `farol-codex-task-route ${codexTaskRouteRefusalRecord(phase)}\n`,
          );
          return configurationFailure("CODEX_TASK_ROUTE_REFUSED");
        };
        if (
          desktopAdmission.occupied("codex-host-task") ||
          codexAgentOperationActive()
        ) {
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        }
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready") {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        const settings = snapshot.settings;
        const resolvedModel = await configuration()!.resolveTaskModel({
          harness: "codex",
        });
        const afterModel = configuration()!.snapshot();
        if (
          resolvedModel.status !== "ready" ||
          afterModel.status !== "ready" ||
          afterModel.settings.revision !== settings.revision
        ) {
          return refuseRoute("model_policy");
        }
        const selected = settings.nativeHosts.codex;
        const workspace = settings.computer.workspaces.find(
          (entry) => entry.workspaceId === command.workspaceId,
        );
        if (!selected?.localVerification) {
          return configurationFailure("CODEX_HOST_NOT_CONFIGURED");
        }
        if (
          !workspace?.rootIdentity ||
          !workspace.gitMetadata ||
          settings.setup.computer.verified?.workspaceId !==
            command.workspaceId ||
          settings.setup.computer.verified.configRevision !==
            settings.computer.generation ||
          (command.sandbox === "workspace-write" &&
            workspace.access !== "write")
        ) {
          return refuseRoute("workspace_identity");
        }
        // Go policy awaited above. Claim the host lane synchronously so a later
        // reply cannot enter alongside an admitted setup or a newly active Agent.
        if (
          desktopAdmission.occupied("codex-host-task") ||
          codexAgentOperationActive()
        )
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        const codexAdmission =
          desktopAdmission.reserveAdmitted("codex-host-task");
        let proxy: CodexProxy | null = null;
        let scratch: string | null = null;
        try {
          const projectStat = await lstat(command.projectRoot, {
            bigint: true,
          });
          if (
            !projectStat.isDirectory() ||
            projectStat.isSymbolicLink() ||
            (await realpath(command.projectRoot)) !== command.projectRoot
          ) {
            return refuseRoute("project_root");
          }
          // Path-bound approval: freeze the writer folder's live identity now;
          // the saved pair is diagnostic and goes stale when a reboot renumbers
          // the volume. Every later admission re-measures against this witness.
          const writerStat = await lstat(workspace.root, { bigint: true });
          if (
            !writerStat.isDirectory() ||
            writerStat.isSymbolicLink() ||
            (await realpath(workspace.root)) !== workspace.root
          ) {
            return refuseRoute("workspace_identity");
          }
          const authority = new PhysicalCodexHandoffAuthority({
            workspaceId: command.workspaceId,
            writerRoot: workspace.root,
            writerIdentity: {
              device: String(writerStat.dev),
              inode: String(writerStat.ino),
            },
            projectRoot: command.projectRoot,
            projectIdentity: {
              device: String(projectStat.dev),
              inode: String(projectStat.ino),
            },
            gitCommonDirectory: workspace.gitMetadata.commonDirectory,
            execution: {
              sandbox: command.sandbox,
              approvalPolicy: command.approvalPolicy,
            },
          });
          if (!(await authority.resolve(command.workspaceId))) {
            return refuseRoute("git_identity");
          }
          scratch = await realpath(
            await mkdtemp(
              path.join(os.tmpdir(), "farol-codex-task-selection-"),
            ),
          );
          await chmod(scratch, 0o700);
          proxy = await SharedCodexProxyHost.attach({
            executablePath: selected.executablePath,
            executableSha256: selected.executableSha256,
            socketPath: command.socketPath,
            cwd: scratch,
            expectedCodexHome: command.expectedCodexHome,
          });
          if (
            !(await exactProject(proxy, command.projectId, command.projectRoot))
          ) {
            return refuseRoute("project_catalogue");
          }
          if (command.observeThreadId) {
            const response = await proxy.request("thread/read", {
              threadId: command.observeThreadId,
              includeTurns: false,
            });
            const thread =
              response &&
              typeof response === "object" &&
              !Array.isArray(response)
                ? (response as { thread?: unknown }).thread
                : null;
            if (
              !thread ||
              typeof thread !== "object" ||
              Array.isArray(thread) ||
              (thread as { id?: unknown }).id !== command.observeThreadId ||
              (thread as { projectId?: unknown }).projectId !==
                command.projectId ||
              (thread as { cwd?: unknown }).cwd !== workspace.root ||
              !(await authority.resolve(command.workspaceId))
            )
              return configurationFailure("CODEX_TASK_OBSERVATION_REFUSED");
          }
          // The proxy and catalogue queries take time; save the route only if
          // the writer folder is still the one measured at setup.
          const writerNow = await lstat(workspace.root, { bigint: true }).catch(
            () => null,
          );
          if (
            writerNow === null ||
            !writerNow.isDirectory() ||
            writerNow.isSymbolicLink() ||
            writerNow.dev !== writerStat.dev ||
            writerNow.ino !== writerStat.ino ||
            (await realpath(workspace.root).catch(() => null)) !==
              workspace.root
          )
            return refuseRoute("workspace_identity");
          const approvedAt = new Date().toISOString();
          return ProductConfigurationResultSchema.parse(
            await configuration()!.recordCodexTaskRoute(
              {
                transport: "codex-shared-proxy/v1",
                socketPath: command.socketPath,
                expectedCodexHome: command.expectedCodexHome,
                workspaceId: command.workspaceId,
                projectId: command.projectId,
                ...(command.observeThreadId === undefined
                  ? {}
                  : { observeThreadId: command.observeThreadId }),
                ...(command.observeTurnId === undefined
                  ? {}
                  : { observeTurnId: command.observeTurnId }),
                projectRoot: command.projectRoot,
                projectIdentity: {
                  device: String(projectStat.dev),
                  inode: String(projectStat.ino),
                },
                writerIdentity: {
                  device: String(writerStat.dev),
                  inode: String(writerStat.ino),
                },
                gitCommonDirectory: workspace.gitMetadata.commonDirectory,
                execution: {
                  sandbox: command.sandbox,
                  approvalPolicy: command.approvalPolicy,
                },
                harness: "codex",
                computerGeneration: settings.computer.generation,
                hostGeneration: settings.nativeHosts.generation,
                approvedAt,
                expiresAt: Date.parse(approvedAt) + 12 * 60 * 60 * 1_000,
              },
              settings.revision,
            ),
          );
        } catch (error) {
          writeStderr(
            `farol-codex-task-route ${codexTaskRouteFailureRecord(error)}\n`,
          );
          return configurationFailure(codexTaskRouteFailureCode(error));
        } finally {
          proxy?.close();
          if (scratch) {
            await rm(scratch, { recursive: true, force: true }).catch(
              () => undefined,
            );
          }
          codexAdmission.release();
        }
      }
      case "host.clear-codex-tasks":
        if (desktopAdmission.occupied("codex-host-task")) {
          return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
        }
        return ProductConfigurationResultSchema.parse(
          await configuration()!.clearCodexTaskRoute(),
        );
      case "host.run-route-b-check": {
        if (
          desktopAdmission.occupied("codex-host-task") ||
          codexAgentOperationActive()
        ) {
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        }
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready") {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        const selected = snapshot.settings.nativeHosts.codex;
        if (!selected) return configurationFailure("CODEX_HOST_NOT_CONFIGURED");
        const codexAdmission =
          desktopAdmission.reserveAdmitted("codex-host-task");
        // The check closes its host itself; quit reaches it meanwhile.
        const routeBCheckClients: CodexAppServerClient[] = [];
        try {
          const probe = await probeCodexHost({
            executablePath: selected.executablePath,
            scratchRoot: statePaths().codexHostProbe,
          }).catch(() => null);
          if (
            probe === null ||
            probe.executableSha256 !== selected.executableSha256 ||
            probe.schemaSha256 !== selected.schemaSha256 ||
            probe.version !== selected.version ||
            probe.protocol !== selected.protocol
          ) {
            const invalidated =
              await configuration()!.recordCodexHostFailure("unreachable");
            if (!invalidated.ok) {
              return ProductConfigurationResultSchema.parse(invalidated);
            }
            return configurationFailure("CODEX_HOST_RECHECK_REQUIRED");
          }
          if (!chatGptTaskAdmissionReady()) {
            return configurationFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
          }
          const checkRouteB = routeBRuntime();
          if (!checkRouteB) return configurationFailure("ROUTE_B_UNAVAILABLE");
          const endpoint = checkRouteB.endpoint;
          const toolCallsBefore = checkRouteB.provider.diagnostics().toolCalls;
          const checked = await runRouteBHostCheck(
            {
              executablePath: selected.executablePath,
              runtimeRoot: await codexHostRuntimeRoot(),
              homePath: await codexHostProcessHomePath(),
              tempPath: tempPath(),
              clientVersion: buildIdentity().version,
              endpoint,
            },
            {
              launch: async (input) => {
                const client = await launchCodexAppServer(input);
                hostCheckClients.add(client);
                routeBCheckClients.push(client);
                return client;
              },
              route: (client, input) => runCodexChatGptHostRoute(client, input),
            },
          );
          if (checked.status === "failed") {
            return configurationFailure("ROUTE_B_HOST_START_FAILED");
          }
          if (checked.status === "outcome_unknown") {
            return configurationFailure("ROUTE_B_OUTCOME_UNKNOWN");
          }
          if (
            checkRouteB.provider.diagnostics().toolCalls !== toolCallsBefore
          ) {
            return configurationFailure("ROUTE_B_CHECK_TOOL_USED");
          }
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
            evidence: {
              kind: "host.route-b",
              provider: FAROL_PROVIDER_ID,
              model: ROUTE_B_MODEL,
              deltaCount: checked.deltaCount,
              observedCharacters: checked.observedCharacters,
            },
          });
        } finally {
          for (const client of routeBCheckClients)
            hostCheckClients.delete(client);
          codexAdmission.release();
        }
      }
      case "host.run-codex-smoke": {
        if (
          desktopAdmission.occupied("codex-host-task") ||
          codexAgentOperationActive()
        ) {
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        }
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready") {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        const selected = snapshot.settings.nativeHosts.codex;
        if (!selected) {
          return configurationFailure("CODEX_HOST_NOT_CONFIGURED");
        }
        const codexAdmission =
          desktopAdmission.reserveAdmitted("codex-host-task");
        let client: CodexAppServerClient | null = null;
        try {
          const probe = await probeCodexHost({
            executablePath: selected.executablePath,
            scratchRoot: statePaths().codexHostProbe,
          });
          const sameContract =
            probe.executableSha256 === selected.executableSha256 &&
            probe.schemaSha256 === selected.schemaSha256 &&
            probe.version === selected.version &&
            probe.protocol === selected.protocol;
          const recordedContract = await configuration()!.recordCodexHost({
            executablePath: probe.executablePath,
            executableSha256: probe.executableSha256,
            version: probe.version,
            protocol: probe.protocol,
            schemaSha256: probe.schemaSha256,
            taskSource: probe.taskSource,
            buildId: buildIdentity().buildId,
          });
          if (!recordedContract.ok) {
            return ProductConfigurationResultSchema.parse(recordedContract);
          }
          if (!sameContract) {
            return configurationFailure("CODEX_HOST_RECHECK_REQUIRED");
          }
          const runtimeRoot = await codexHostRuntimeRoot();
          client = await launchCodexAppServer({
            executablePath: selected.executablePath,
            cwd: runtimeRoot,
            homePath: await codexHostProcessHomePath(),
            tempPath: tempPath(),
            clientVersion: buildIdentity().version,
            toolProfile: "dynamic-only",
            ...(await codexHostHomeOption()),
          });
          hostCheckClients.add(client);
          const live = await runCodexHostSmoke(client, {
            model: "gpt-6-astra",
            cwd: runtimeRoot,
            nonce: randomUUID(),
            timeoutMs: 120_000,
          });
          const recorded =
            await configuration()!.recordCodexHostLiveVerification({
              model: live.model,
              executableSha256: probe.executableSha256,
              schemaSha256: probe.schemaSha256,
              buildId: buildIdentity().buildId,
            });
          if (!recorded.ok) {
            return ProductConfigurationResultSchema.parse(recorded);
          }
          return ProductConfigurationResultSchema.parse({
            ...recorded,
            evidence: {
              kind: "host.codex-live",
              ...live,
              executableSha256: probe.executableSha256,
              schemaSha256: probe.schemaSha256,
            },
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          const outcomeUnknown = new Set([
            "CODEX_APP_SERVER_EXITED",
            "CODEX_APP_SERVER_FAILED",
            "CODEX_APP_SERVER_REQUEST_TIMEOUT",
            "CODEX_HOST_SMOKE_CORRELATION",
            "CODEX_HOST_SMOKE_OUTCOME_UNKNOWN",
            "CODEX_HOST_SMOKE_TIMEOUT",
          ]).has(code);
          const failureState =
            code === "CODEX_HOST_MODEL_UNAVAILABLE"
              ? "model_unavailable"
              : outcomeUnknown
                ? "outcome_unknown"
                : "failed";
          const recorded =
            await configuration()!.recordCodexHostLiveFailure(failureState);
          if (!recorded.ok) {
            return ProductConfigurationResultSchema.parse(recorded);
          }
          if (code === "CODEX_HOST_MODEL_UNAVAILABLE") {
            return configurationFailure("CODEX_HOST_MODEL_UNAVAILABLE");
          }
          return configurationFailure(
            outcomeUnknown
              ? "CODEX_HOST_LIVE_OUTCOME_UNKNOWN"
              : "CODEX_HOST_LIVE_FAILED",
          );
        } finally {
          await client?.close().catch(() => undefined);
          if (client) hostCheckClients.delete(client);
          codexAdmission.release();
        }
      }
      case "host.run-codex-agent-check": {
        if (
          desktopAdmission.occupied("codex-host-task") ||
          activeProductAgentSession() ||
          pendingProductAgentTaskId()
        ) {
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        }
        const snapshot = configuration()!.snapshot();
        if (snapshot.status !== "ready") {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        const selected = snapshot.settings.nativeHosts.codex;
        if (!selected) {
          return configurationFailure("CODEX_HOST_NOT_CONFIGURED");
        }
        if (
          !selected.liveVerification ||
          selected.liveVerification.executableSha256 !==
            selected.executableSha256 ||
          selected.liveVerification.schemaSha256 !== selected.schemaSha256 ||
          selected.liveVerification.buildId !== buildIdentity().buildId
        ) {
          return configurationFailure("CODEX_HOST_RECHECK_REQUIRED");
        }
        const computerVerification = snapshot.settings.setup.computer.verified;
        const workspace = computerVerification
          ? snapshot.settings.computer.workspaces.find(
              (candidate) =>
                candidate.workspaceId === computerVerification.workspaceId,
            )
          : null;
        if (
          !computerVerification ||
          computerVerification.configRevision !==
            snapshot.settings.computer.generation ||
          computerVerification.buildId !== buildIdentity().buildId ||
          snapshot.settings.setup.computer.reachable !== "reachable" ||
          snapshot.settings.setup.computer.outcomeUnknown ||
          !workspace
        ) {
          const recorded = await configuration()!.recordCodexAgentFailure(
            "workspace_not_verified",
          );
          if (!recorded.ok) {
            return ProductConfigurationResultSchema.parse(recorded);
          }
          return configurationFailure("CODEX_AGENT_WORKSPACE_NOT_VERIFIED");
        }
        const checkKey = JSON.stringify([
          selected.executablePath,
          selected.executableSha256,
          selected.schemaSha256,
          buildIdentity().buildId,
          snapshot.settings.computer.computerId,
          snapshot.settings.computer.generation,
          workspace.workspaceId,
        ]);
        const activeCheck = activeCodexAgentCheck();
        if (activeCheck && activeCheck.key !== checkKey) {
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        }
        // The check carries the authority read above; it holds the transition
        // reservation until it is active, and refuses when that authority
        // changed after it was read.
        const agentAdmission =
          authorityTransitions.tryReserve("agent-admission");
        if (!agentAdmission) {
          return transitionRefusal();
        }
        const current = configuration()!.snapshot();
        if (
          current.status !== "ready" ||
          current.settings.revision !== snapshot.settings.revision
        ) {
          agentAdmission.release();
          return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
        }

        const codexAdmission =
          desktopAdmission.reserveAdmitted("codex-host-task");
        let session = activeCodexAgentCheck();
        let closeSession = false;
        try {
          let settings = snapshot.settings;
          // Bound before the closure: the narrowing at the top of this
          // function does not survive into one.
          const settingsService = configuration()!;
          // The reservation covers reading the authority and binding it to the
          // session that carries it. It closes as soon as that session is
          // active, on both paths: the poll below binds nothing and can run
          // for hundreds of cycles.
          const activation = await activateAgentCheckSession<
            ActiveCodexAgentCheck,
            ProductConfigurationResult
          >(agentAdmission, session, async () => {
            const probe = await probeCodexHost({
              executablePath: selected.executablePath,
              scratchRoot: statePaths().codexHostProbe,
            });
            const sameContract =
              probe.executableSha256 === selected.executableSha256 &&
              probe.schemaSha256 === selected.schemaSha256 &&
              probe.version === selected.version &&
              probe.protocol === selected.protocol;
            const recordedContract = await settingsService.recordCodexHost({
              executablePath: probe.executablePath,
              executableSha256: probe.executableSha256,
              version: probe.version,
              protocol: probe.protocol,
              schemaSha256: probe.schemaSha256,
              taskSource: probe.taskSource,
              buildId: buildIdentity().buildId,
            });
            if (!recordedContract.ok) {
              return {
                active: false,
                refusal:
                  ProductConfigurationResultSchema.parse(recordedContract),
              };
            }
            if (!sameContract) {
              return {
                active: false,
                refusal: configurationFailure("CODEX_HOST_RECHECK_REQUIRED"),
              };
            }
            if (recordedContract.snapshot.status !== "ready") {
              return {
                active: false,
                refusal: configurationFailure("SETTINGS_UNAVAILABLE"),
              };
            }
            settings = recordedContract.snapshot.settings;
            const runtimeRoot = await codexHostRuntimeRoot();
            const client = await launchCodexAppServer({
              executablePath: selected.executablePath,
              cwd: runtimeRoot,
              homePath: await codexHostProcessHomePath(),
              tempPath: tempPath(),
              clientVersion: buildIdentity().version,
              toolProfile: "native-agent",
              ...(await codexHostHomeOption()),
            });
            const host = new CodexNativeAgentHost(
              client,
              {
                model: "gpt-6-astra",
                runtimeRoot,
                spawnTimeoutMs: 120_000,
                waitTimeoutMs: 250,
                pollIntervalMs: 25,
                nonce: randomUUID,
                now: () => Date.now(),
              },
              new CodexAgentWorkspaceProbe(
                settings,
                codexAgentCheckWorkspace(settings),
                () => Date.now(),
              ),
            );
            const started: ActiveCodexAgentCheck = {
              key: checkKey,
              client,
              host,
              boundedRunningObserved: false,
            };
            setActiveCodexAgentCheck(started);
            return { active: true, session: started };
          });
          if (!activation.active) return activation.refusal;
          session = activation.session;

          const check = await runCodexNativeAgentCheck({
            host: session.host,
            assignments: new PrivateAssignmentStore({
              root: statePaths().codexAgentAssignments,
            }),
            settings,
            workspaceId: workspace.workspaceId,
            executableSha256: selected.executableSha256,
            schemaSha256: selected.schemaSha256,
            buildId: buildIdentity().buildId,
            now: () => Date.now(),
            pause: async () => {
              await delay(25);
            },
            maximumWaitCycles: 480,
            boundedRunningObserved: session.boundedRunningObserved,
          });
          if (check.status === "completed") {
            const { kind: _kind, ...evidence } = check.evidence;
            const recorded =
              await configuration()!.recordCodexAgentVerification(evidence);
            closeSession = true;
            if (!recorded.ok) {
              return ProductConfigurationResultSchema.parse(recorded);
            }
            return ProductConfigurationResultSchema.parse({
              ...recorded,
              evidence: check.evidence,
            });
          }
          if (check.status === "running") {
            setActiveCodexAgentCheck({
              ...session,
              boundedRunningObserved: true,
            });
            const recorded =
              await configuration()!.recordCodexAgentFailure("running");
            if (!recorded.ok) {
              return ProductConfigurationResultSchema.parse(recorded);
            }
            return configurationFailure("CODEX_AGENT_STILL_RUNNING");
          }
          closeSession = true;
          const recorded = await configuration()!.recordCodexAgentFailure(
            check.status === "workspace_not_verified"
              ? "workspace_not_verified"
              : check.status === "outcome_unknown"
                ? "outcome_unknown"
                : "failed",
          );
          if (!recorded.ok) {
            return ProductConfigurationResultSchema.parse(recorded);
          }
          return configurationFailure(
            check.status === "workspace_not_verified"
              ? "CODEX_AGENT_WORKSPACE_NOT_VERIFIED"
              : check.status === "outcome_unknown"
                ? "CODEX_AGENT_LIVE_OUTCOME_UNKNOWN"
                : "CODEX_AGENT_LIVE_FAILED",
          );
        } catch {
          closeSession = true;
          const outcomeUnknown = session !== null;
          const recorded = await configuration()!.recordCodexAgentFailure(
            outcomeUnknown ? "outcome_unknown" : "failed",
          );
          if (!recorded.ok) {
            return ProductConfigurationResultSchema.parse(recorded);
          }
          return configurationFailure(
            outcomeUnknown
              ? "CODEX_AGENT_LIVE_OUTCOME_UNKNOWN"
              : "CODEX_AGENT_LIVE_FAILED",
          );
        } finally {
          if (closeSession && session) {
            session.host.dispose();
            await session.client.close().catch(() => undefined);
            if (activeCodexAgentCheck() === session) {
              setActiveCodexAgentCheck(null);
            }
          }
          codexAdmission.release();
          agentAdmission.release();
        }
      }
      case "host.remove-codex":
        if (codexAgentOperationActive()) {
          return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
        }
        return ProductConfigurationResultSchema.parse(
          await configuration()!.clearCodexHost(),
        );
    }
  }

  return Object.freeze({ configureAdmittedHost });
}
