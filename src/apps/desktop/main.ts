import "../../../apps/desktop/bridge/e2e-window-bootstrap.ts";
import {
  createInstalledUpdateHost,
  withInstalledStartupFence,
} from "../../../apps/desktop/update/host";
import { createStartup } from "../../../apps/desktop/host/startup";
import { readLaunchArguments } from "../../../apps/desktop/host/launch";
import { selectBootIdentity } from "../../../apps/desktop/host/identity";
import { selectChatGptHome } from "../../../apps/desktop/chat/home";
import { admissionLease } from "../../../apps/desktop/host/lease";
import { createConfigurationService } from "../../../apps/desktop/configuration/service";
import { UPDATE_IDLE_CHECK_MS } from "../../modules/release/app/installed-updater";
import { DesktopAdmission } from "../../../apps/desktop/host/admission";
import { mainWindow } from "../../../apps/desktop/window/main";
import { taskSurfaces } from "../../../apps/desktop/window/surface";
import { guardDiagnosticPipes } from "./diagnostic-pipes";
import { openStartupSplash, type StartupSplash } from "./startup-splash";
import { preventEmbeddedWindowDrag } from "./embedded-web-drag";
import { prepareConnectorCheckDocument } from "../../../apps/desktop/bridge/connector-check-readiness";
import type { SeparateAppVerificationScope } from "../../pkg/product-settings/contract";
import {
  recordedModelTurn,
  recordedCompaction,
} from "../../../apps/desktop/operations/model-turn";
import { desktopStatePaths } from "../../../apps/desktop/host/paths";
import { OperationsStore } from "../../../apps/desktop/operations/store";
import {
  ProcessAuditCollector,
  ProcessAuditObserver,
} from "../../../apps/desktop/operations/process-audit-collector";
import { observeOperation } from "../../../apps/desktop/operations/observe";
import { recordInterruptedCommand } from "../../../apps/desktop/operations/interrupted-command";
import { type SetupCompletionContext } from "../../ui/setup-completion";

import {
  ABOUT_PANEL_SIZE,
  DesktopAboutPanel,
} from "../../../apps/desktop/about-panel";
import {
  DesktopUpdatesPanel,
  UPDATES_PANEL_SIZE,
} from "../../../apps/desktop/updates-panel";
import { connectorRuntimeUncertain } from "../../pkg/product-settings/connector-uncertainty";

import { connectorWorkspaceSelection } from "../../pkg/product-settings/connector-workspace-selection";
import { connectorVerificationProof } from "./connector-verification-proof";
import { ConnectorSetupReplies } from "../../../apps/desktop/connector-setup-host";
import {
  startDesktopGoCore,
  type DesktopGoCore,
} from "../../../apps/desktop/go-core-host";
import { goCoreQuitClosers } from "../../../apps/desktop/go-core-quit-closers";
import type {
  ChatComputerAdmissionResponse,
  SettingsDeliveryResult,
} from "../../../apps/desktop/bridge/wire";
import {
  connectorAppBindingCurrent,
  createConnectorCheck,
} from "../../../apps/desktop/connector/check";
import {
  createConnectorStart,
  reportConnectorTransport,
} from "../../../apps/desktop/connector/start";
import { createConnectorStop } from "../../../apps/desktop/connector/stop";
import { createConnectorVerify } from "../../../apps/desktop/connector/verify";
import { createWorkspaceHost } from "../../../apps/desktop/configuration/workspace";
import { createWorkspaceCommands } from "../../../apps/desktop/configuration/files";
import { createExecutableHost } from "../../../apps/desktop/host/executable";
import {
  createProductAgentHost,
  type ProductAgentSession,
} from "../../../apps/desktop/task/agent";
import { createTaskCommands } from "../../../apps/desktop/task/command";
import { createChatGptSession } from "../../../apps/desktop/chat/session";
import { createReadonlyHost } from "../../../apps/desktop/chat/readonly";
import { createPreviewRuntime } from "../../../apps/desktop/runtime/host";
import { createTaskPersist } from "../../../apps/desktop/task/persist";
import { createTaskRoutes } from "../../../apps/desktop/task/route";
import { createTaskSurface } from "../../../apps/desktop/task/surface";
import { connectorSupervisor } from "../../../apps/desktop/connector/supervisor";
import { createCoreReporters } from "../../../apps/desktop/core/report";
import { startGoCore } from "../../../apps/desktop/core/start";
import { createDesktopChatBrowser } from "../../../apps/desktop/go-chat-host";
import { GoChatBrowserDriver } from "../../../apps/desktop/go-chat-browser";
import {
  captureChatStartupProfile,
  chatWorkerInitialUrl,
} from "../../../apps/desktop/go-chat-startup-profile";
import { ReadConversationClient } from "../../../apps/desktop/bridge/read-conversation";
import { readChatHistoryView } from "../../../apps/desktop/chat-history-view";
import { runSelfTestCommand } from "../../../apps/desktop/self-test-ipc";
import { recoverDeepTestAttempts } from "./deep-test-recovery";
import { readRetiredRepliesView } from "../../../apps/desktop/retired-replies-view";
import { BridgeError } from "../../../apps/desktop/bridge/client";
import { NativeViewVisibility } from "../../../apps/desktop/bridge/native-view-visibility";

import { ReadAccountConfirmation } from "../../../apps/desktop/read-account-confirmation";
import { AccountObservationConfirmation } from "../../../apps/desktop/account-observation-confirmation";
import { ReadAccountCommands } from "../../../apps/desktop/read-account-commands";
declare const __FAROL_GO_CORE__: unknown;
declare const __FAROL_GO_RESOURCES__: unknown;
declare const __FAROL_GO_SHELL__: {
  readonly support: unknown;
  readonly watchdogSourceBase64: string;
} | null;
import { createMenuBar, menuBarIconState } from "./menu-bar";
import {
  aboutCommand,
  applicationMenu,
} from "../../../apps/desktop/shell/menu";
import { createBridge } from "../../../apps/desktop/runtime/bridge";
import { createModelHost } from "../../../apps/desktop/runtime/model";
import { createRuntimeStatus } from "../../../apps/desktop/runtime/status";
import { createContextFixture } from "../../../apps/desktop/dev/fixture";
import { createContextHost } from "../../../apps/desktop/task/context";
import { createIpc } from "../../../apps/desktop/shell/ipc";
import {
  createInstance,
  secondInstanceResultPrefix,
} from "../../../apps/desktop/host/instance";
import { surfaceNavigation } from "../../../apps/desktop/shell/navigation";
import { promises as rawFs } from "original-fs";
import {
  announceDrainedQuit,
  createDesktopHelperLifetime,
} from "../../modules/release/infra/native/desktop-helper-lifetime";
import { publishManualInstallStartupProof } from "./manual-install-startup-proof";
import {
  createInstalledUpdateRuntime,
  waitForInstalledUpdateRelaunch,
} from "./installed-update-runtime";
import { InstalledUpdateCommandSchema } from "../../modules/release/contract/installed-update";
import { selectedConnectorApp } from "../../pkg/product-settings/connector-app-selection";
import { ReadCodexModelCatalogue } from "../../modules/chat/app/service/read-codex-model-catalogue";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  session,
  shell,
  WebContentsView,
} from "electron";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  observeLocalRuntime,
  type LocalRuntimeLifetime,
} from "./local-runtime-lifetime";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { exactProject } from "../../modules/chat/app/service/persistent-codex-handoff";
import { PhysicalCodexHandoffAuthority } from "../../modules/chat/infra/native/physical-codex-handoff-authority";
import { SharedCodexProxyHost } from "../../modules/chat/infra/native/shared-codex-proxy-host";
import { PersistentChatGptHandoff } from "../../modules/chat/app/service/persistent-chatgpt-handoff";
import { PrivateSavedChatJournal } from "../../modules/chat/infra/repo/private-saved-chat-journal";
import { Sha256SavedChatDigester } from "../../modules/chat/infra/native/sha256-saved-chat-digester";
import { FAROL_PROVIDER_ID } from "../../pkg/model-route/contract";
import { ClientEventSchema } from "../../modules/chat/contract/client-event";
import type { ContextBinding } from "../../modules/chat/domain/context-continuity";
import { buildHostCompactionHandoff } from "../../modules/chat/infra/client/host-compaction-codec";
import {
  ProductTaskCommandResultSchema,
  ProductTaskCommandSchema,
  ProductTasksStateSchema,
  type ProductTask,
  type ProductTaskAgent,
  type ProductTaskCommandResult,
} from "../../modules/chat/contract/product-task";
import { LiveTaskRegistry } from "./live-task-registry";
import { journalUnderPromotionLease } from "./chatgpt-journal-lease";
import {
  workspaceDescriptor,
  type VerifiedProductWorkspaceResult,
} from "./workspace-descriptor";
import { createCodexContextController } from "./codex-context-runtime";
import { channels } from "../../pkg/ipc/channels";
import {
  defaultNavigationShortcuts,
  type NavigationShortcuts,
} from "../../pkg/ipc/navigation-shortcuts";
import {
  ProductConfigurationResultSchema,
  type ApprovedProductWorkspace,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
  type ProductSettings,
  type WorkspaceRootIdentity,
} from "../../pkg/product-settings/contract";
import { initialSetupPresentation } from "../../pkg/product-settings/setup-entry";
import {
  compactBrowserSelected,
  embeddedBrowserSelected,
} from "../../pkg/product-settings/browser-presentation";
import {
  type ShellOverlay,
  type SidebarMode,
  type SurfaceSection,
} from "../../pkg/ipc/shell-state";
import {
  containWindowOpenFailure,
  WindowOpenCoordinator,
  windowAllClosedAction,
} from "./lifecycle-policy";
import {
  createInstanceRequest,
  foreignAcknowledgementCount,
  readBuildLaunchIdentity,
  waitForInstanceAcknowledgement,
  writeInstanceAcknowledgement,
} from "./single-instance";
import {
  PrimaryStartup,
  devReopenPrimaryRefused,
  emitStartupStage,
  type StartupStage,
} from "./primary-startup";
import { readRuntimeBuildIdentity } from "./build-identity";
import {
  currentConnectorAttachment,
  waitForConnectorAppReceipt,
} from "./connector-app-receipt-wait";
import {
  ProductConfigurationService,
  workspaceCheckEvidence,
} from "./product-configuration";
import { shellGeometry } from "./surface-layout";
import {
  NativeReadonlyWorkspace,
  SAFE_OPEN_HELPER,
} from "../../modules/computer/infra/native/native-readonly-workspace";
import { discoverWorkspaceGitMetadata } from "../../modules/computer/infra/native/native-verification-command";
import {
  CHATGPT_HOME,
  canonicalChatGptConversationUrl,
} from "./chatgpt-page-policy";
import {
  ChatGptRoute,
  ChatGptSignInBlockLedger,
  type ChatGptRouteOptions,
  type ChatGptSignInOutcomeDiagnostic,
  type ChatGptSignInStatus,
} from "./chatgpt-route";
import { startSavedChatBridge } from "./saved-chat-bridge";
import { PrivateLiveTaskStore } from "./live-task-store";
import { RunReadonlyComputerAction } from "../../modules/computer/app/service/run-readonly-computer-action";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type AuthorityCapability,
  type ComputerApproval,
  type TaskAdmission,
} from "../../modules/computer/domain/execution-authority";
import { InMemoryAuthorityRepository } from "../../modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../modules/computer/infra/repo/in-memory-computer-approvals";
import { startCodexCallerRelay } from "./codex-caller-relay";
import { configurationAdmission } from "./configuration-admission";
import { ownerComputerConsentDigest } from "../../modules/computer/infra/repo/owner-computer-consent";
import { clearAndConfirmOriginalConnectorVerificationReceipt } from "../../modules/computer/infra/mcp/connector-verification-receipt";
import { createConfigurationPipeline } from "../../../apps/desktop/configuration/pipeline";
import { createConfigurationObserved } from "../../../apps/desktop/configuration/observed";
import { createConfigurationDrain } from "../../../apps/desktop/configuration/drain";
import { createConfigurationConnector } from "../../../apps/desktop/configuration/connector";
import {
  createConfigurationHost,
  type ActiveCodexAgentCheck,
} from "../../../apps/desktop/configuration/host";
import { createConfigurationComputer } from "../../../apps/desktop/configuration/computer";
import { createConfigurationModel } from "../../../apps/desktop/configuration/model";
import { createConfigurationSupport } from "../../../apps/desktop/configuration/support";
import { createConfigurationDeep } from "../../../apps/desktop/configuration/deep";
import { createConfigurationDispatch } from "../../../apps/desktop/configuration/dispatch";
import { createDevProof } from "../../../apps/desktop/dev/proof";
import {
  createConfigurationChatgpt,
  type DirectChatStart,
  type GoReadonlyConversation,
  type PendingChatGptAttachmentTask,
  type PendingChatGptReadonlyTask,
} from "../../../apps/desktop/configuration/chatgpt";
import type {
  PendingWorkspacePickValue,
  VerificationWorkspaceAction,
} from "../../../apps/desktop/configuration/computer";
import { type WorkspaceConfigurationCommand } from "./workspace-configuration-drain";
import {
  confirmSeparateAppVerificationAttempt,
  connectorAppVerificationAttemptExists,
  prepareConnectorAppVerificationAttempt,
} from "./connector-app-verification-attempt";
import {
  WORKSPACE_EDIT_ACK_HOLD_ENV,
  WORKSPACE_EDIT_ACK_HOLD_INVALID,
  createConfigurationReplyFault,
  e2eBudget,
} from "./configuration-reply-fault";
import {
  createQuitDrain,
  type OwnedCloser,
  type QuitDrainReceipt,
} from "./quit-drain";
import {
  createGracefulQuitSignals,
  type GracefulQuitSignals,
} from "./quit-signal";
import { writeQuitReceipt } from "./quit-receipt-store";
import {
  createQuitTrace,
  type QuitTrace,
  type QuitTracePhase,
} from "../../../apps/desktop/quit/trace";
import { createQuitProgressWindow } from "../../../apps/desktop/quit/panel";
import { removeRunMarker } from "./run-marker";
import { computerConnectorAdmission } from "./summary-fence-recovery";
import { deleteTaskContext } from "./task-context-cleanup";
import { createRouteBTaskLifecycle } from "./route-b-task-lifecycle";
import { TaskMutationGate } from "./task-mutation-gate";
import { runCodexChatGptHostRoute } from "./codex-chatgpt-host-route";
import { runRouteBHostCheck } from "./route-b-host-check";
import {
  ROUTE_B_MODEL,
  startRouteBRuntime,
  type RouteBSurfaceAdmission,
  type RouteBTaskSurfaces,
} from "./route-b-runtime";
import { type PendingWorkspaceEdit } from "./workspace-edit";
import { writeSupportExport } from "./support-export";
import {
  cleanupChatGptAttachmentStaging,
  discardChatGptAttachments,
  stageChatGptAttachments,
  verifyStagedChatGptAttachments,
} from "./chatgpt-attachment-staging";
import {
  PrivateChatGptTaskJournal,
  type ChatGptTaskJournalRecord,
  type ChatGptTaskJournalResult,
} from "./chatgpt-task-journal";
import {
  PrivateChatGptConversationStore,
  type ChatGptConversationRecord,
} from "./chatgpt-conversation-store";
import { probeCodexHost } from "./codex-host-probe";
import {
  discoverExecutables,
  type DiscoveryCandidate,
} from "./executable-discovery";
import { launchCodexAppServer } from "./codex-app-server-process";
import { runCodexHostSmoke } from "./codex-host-smoke";
import { runCodexNativeAgentCheck } from "./codex-native-agent-check";
import { CodexAgentWorkspaceProbe } from "./codex-agent-workspace-probe";
import type { ReadonlyWorkspace } from "../../modules/computer/app/port/readonly-workspace";
import { CodexNativeAgentHost } from "../../modules/agent/infra/native/codex-native-agent-host";
import { PrivateAssignmentStore } from "../../modules/agent/infra/repo/private-assignment-store";
import { AcknowledgeAgentResult } from "../../modules/agent/app/service/acknowledge-agent-result";
import { CancelAgentAssignment } from "../../modules/agent/app/service/cancel-agent-assignment";
import { runProductAgentAssignment } from "./product-agent-assignment";
import {
  PrivateProductAgentStore,
  type ProductAgentInput,
} from "./product-agent-store";
import { type ProductAgentContext } from "./product-agent-context";
import { PrivateConnectorKeyStore } from "./connector-key-store";
import { FarolModelLifecycle } from "./farol-model-lifecycle";
import {
  routeBModelCompactionHandler,
  routeBModelTurnHandler,
} from "./farol-model-endpoint";
import {
  applyFarolModelConfigBlock,
  applyFarolModelProviderSelection,
  previewFarolModelConfigBlock,
  previewFarolModelProviderSelection,
  rollbackFarolModelConfigBlock,
  rollbackFarolModelProviderSelection,
  type FarolModelProviderSpec,
} from "./farol-model-config-block";
import { detectCodexHostPresence } from "./farol-model-host-presence";
import {
  FAROL_BACKED_PRODUCT_AGENT_ENABLED,
  FAROL_MODEL_ENABLED,
  farolBackedProductAgentRoute,
} from "./foundation-feature-gates";
import {
  probeTunnelClient,
  verifySelectedTunnelClient,
} from "./tunnel-client-probe";
import { resumeComputerConnector } from "./connector-resume-policy";
import { identityBoundWorkspaces } from "./identity-bound-workspaces";
import { AuthorityTransitionReservation } from "./authority-transition";
import { SecureMcpConnectorRuntime } from "./secure-mcp-connector-runtime";
import { clearConnectorVerificationReceipt } from "../../modules/computer/infra/mcp/connector-verification-receipt";
import { PrivateExecutionFence } from "../../modules/computer/infra/mcp/execution-fence";
import { PrivateMcpLifecycle } from "../../modules/computer/infra/mcp/private-mcp-lifecycle";
import {
  DEV_MCP_PROOF_ALLOWED_PATH,
  DEV_MCP_PROOF_DENIED_PATH,
  claimDevMcpProofAttempt,
  createDevMcpProofFixture,
  readDevMcpProofPreparation,
  readDevMcpProofReceipt,
  writeDevMcpProofPreparation,
} from "../../modules/computer/infra/mcp/dev-mcp-proof";
import {
  desktopCodexChildHomes,
  desktopCodexConfigPath,
  isolatedDevMcpProofAllowed,
} from "./desktop-environment";
import {
  runDesktopStartupBoundary,
  startupNoticeAllowed,
  terminateDesktopStartup,
} from "./desktop-startup-failure";
import { observeRendererLifecycle } from "../../../apps/desktop/renderer-lifecycle-observation";

guardDiagnosticPipes([process.stdout, process.stderr]);
const directory = __dirname;
// A legacy build has no Go declaration; a Go build never falls back after a
// failed launch, publication or operation. The builder supplies this constant.
const compiledGoCore =
  typeof __FAROL_GO_CORE__ === "undefined" ? null : __FAROL_GO_CORE__;
const compiledGoResources =
  typeof __FAROL_GO_RESOURCES__ === "undefined" ? null : __FAROL_GO_RESOURCES__;
const compiledGoShell =
  typeof __FAROL_GO_SHELL__ === "undefined" || __FAROL_GO_SHELL__ === null
    ? undefined
    : {
        support: __FAROL_GO_SHELL__.support,
        watchdogSource: Buffer.from(
          __FAROL_GO_SHELL__.watchdogSourceBase64,
          "base64",
        ),
      };
let desktopGoCore: DesktopGoCore | null = null;
const buildIdentity = readRuntimeBuildIdentity(directory);
const productName = buildIdentity.product;
const bundleId = buildIdentity.bundleId;
const {
  buildEnvironment,
  runtimeEnvironment,
  isolatedE2EHome,
  activeDesktopIdentity,
  displayProductName,
  displayEdition,
  displayWindowTitle,
} = selectBootIdentity({
  app,
  env: process.env,
  argv: process.argv,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
});
// The profile's state layout, read at call time because the identity setup
// above redirects `userData` before any state path is used.
function statePaths() {
  return desktopStatePaths({
    userData: app.getPath("userData"),
    tmpdir: os.tmpdir(),
  });
}
// UX34-08: a dedicated, clearly-Farol-owned sign-in surface. DEV embeds it in
// the main window; Preview keeps its existing window presentation.
const SIGN_IN_WINDOW_TITLE = `Sign in to ChatGPT — ${displayProductName}`;
const launchIdentity = readBuildLaunchIdentity(
  directory,
  buildEnvironment,
  buildIdentity,
);
const nativeWorkspace = new NativeReadonlyWorkspace({
  get helperPath() {
    return path.join(
      installedUpdates.resources().directory,
      "computer-safe-open.py",
    );
  },
  helper: SAFE_OPEN_HELPER,
});
const {
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
  expectedTasks,
} = readLaunchArguments(process.argv, process.env, buildEnvironment);
const instanceRequest = createInstanceRequest(
  launchIdentity,
  ownerBackgroundOnly,
);
const startupStage = (stage: StartupStage) => {
  const enabled = process.env.FAROL_E2E === "1";
  emitStartupStage(stage, enabled, (line) => process.stderr.write(line));
  // Playwright can attach after early stderr tokens have passed. Persist only
  // fixed stage tokens in this run's private disposable E2E home.
  if (!enabled) return;
  try {
    const home = process.env.HOME;
    if (!home || !/^farol-e2e-home-[A-Za-z0-9]{6,}$/u.test(path.basename(home)))
      return;
    if (realpathSync(path.dirname(home)) !== realpathSync(os.tmpdir())) return;
    const info = lstatSync(home);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      return;
    const marker =
      stage === "lock-secondary"
        ? ".farol-secondary-lock-stage"
        : stage === "delay-complete"
          ? ".farol-delay-complete-stage"
          : stage.startsWith("connector-resume") ||
              stage === "connector-resumed"
            ? ".farol-connector-resume-stage"
            : ".farol-startup-stage";
    const target = path.join(home, marker);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const file = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK,
      0o600,
    );
    try {
      writeSync(
        file,
        stage === "lock-secondary" || stage === "delay-complete"
          ? `${stage}:${process.hrtime.bigint()}\n`
          : `${stage}\n`,
      );
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    try {
      renameSync(temporary, target);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
  } catch {
    // Missing diagnostic evidence must not change startup behavior.
  }
};
const primaryStartup = new PrimaryStartup();
const contextOwnerId = "owner-desktop";
const contextProviderProfileId = "profile-isolated-farol";
const contextModel = ROUTE_B_MODEL;

const readySchema = z.strictObject({
  kind: z.literal("runtime.ready"),
  identity: z.enum([
    "farol-runtime",
    "farol-dev-runtime",
    "farol-owner-preview-runtime",
  ]),
  port: z.number().int().min(1).max(65_535),
  token: z.string().min(32),
  tasks: z.array(
    z.strictObject({
      taskId: z.string(),
      ownerId: z.string(),
      sessionId: z.string(),
      turnId: z.string(),
      generation: z.number().int().nonnegative(),
      label: z.string(),
      hasComputer: z.boolean(),
      readToken: z.string().min(32),
    }),
  ),
  embeddedNode: z.string(),
  embeddedElectron: z.string(),
});
const controlSchema = z.strictObject({
  taskId: z.string(),
  action: z.enum([
    "release-tool",
    "finish-demo",
    "compact-context-fixture",
    "confirm-context-fixture",
  ]),
});

type RuntimeReady = z.infer<typeof readySchema>;
app.setName(activeDesktopIdentity.applicationName);
// Darwin process.title erases argv. Dev stop authorization needs its original
// entrypoint and explicit profile assertion; the Dev-only bundle owns display naming.
if (buildEnvironment !== "dev")
  process.title = activeDesktopIdentity.applicationName;
if (process.platform === "win32")
  app.setAppUserModelId(activeDesktopIdentity.applicationId);
if (process.platform === "darwin") {
  // macOS's default About panel otherwise reads the raw release identity
  // (app.getName()); this is display-only and does not touch that
  // identity or the bundle ID.
  app.setAboutPanelOptions({
    applicationName: displayProductName,
    applicationVersion: displayEdition
      ? `${buildIdentity.version} (${displayEdition})`
      : buildIdentity.version,
    version: "",
  });
}

let window: BrowserWindow | null = null;
let aboutPanel: DesktopAboutPanel | null = null;
const updatesPanel = new DesktopUpdatesPanel(
  () =>
    !desktopAdmission.closed() &&
    (buildEnvironment !== "preview" ||
      (installedUpdates.updater !== null &&
        installedUpdates.updater.ownerHandoffSafe())),
);
const ownedLocalRuntimes = new Map<LocalRuntimeLifetime, string>();
let runtime: RuntimeReady | null = null;
let runtimeState: "starting" | "ready" | "offline" | "failed" = "starting";
let runtimeError: string | null = null;
let runtimeStopping = false;
let section: SurfaceSection = "browser";
let selectedTaskId: string = expectedTasks[0]?.taskId ?? "";
let setupOpen = true;
let sidebarMode: SidebarMode = "full";
let sidebarWidth: number = shellGeometry.pageListDefault;
let shellOverlay: ShellOverlay = "none";
let navigationShortcuts: NavigationShortcuts = {
  ...defaultNavigationShortcuts,
};
let configuration: ProductConfigurationService | null = null;
let connectorCredentialStore: PrivateConnectorKeyStore | null = null;
let secureMcpConnectorRuntime: SecureMcpConnectorRuntime | null = null;
let modelLifecycle: FarolModelLifecycle | null = null;
// Pending owners are read lazily; construction does not observe later state.
const desktopAdmission = new DesktopAdmission({
  chatGptReadonlyTask: () => pendingChatGptReadonlyTask !== null,
  directChatStart: () => directChatStart !== null,
  chatGptAttachmentTask: () => pendingChatGptAttachmentTask !== null,
  workspaceEdit: () => pendingWorkspaceEdit !== null,
  computer: () => pendingComputer.size > 0,
  codexAgent: () => codexAgentOperationActive(),
  hostCheck: () => hostCheckClients.size > 0,
  connectorStart: () => connectorStartInFlight !== null,
});
// Presentation spans workspace admission, tunnel startup and the app check.
// It conveys no authority and is never restored from Activity or saved settings.
let startupConnectionChecking = true;
let connectorStartInFlight: Promise<void> | null = null;
let connectorStartCancellation: AbortController | null = null;
let startupConnectorResumeCancelled = false;
// Connector supervision reads each owner below when a predicate runs. It is
// built where its status tracker always was; see apps/desktop/connector.
const {
  connectorAttemptGeneration,
  captureConnectorStop,
  ownerStoppedCurrent,
  completedOwnerStop,
  connectionAdmissionInProgress,
  connectorConnection,
  captureConnectionStatus,
  connectionStatusCurrent,
  currentConnectionStatus,
  observedConnectorHealth,
  connectorTransportWatch,
  connectorTransportTimer,
  connectorStatusTimer,
  startConnectorTransportWatch,
} = connectorSupervisor({
  configuration: () => configuration,
  secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
  desktopGoCore: () => desktopGoCore,
  window: () => window,
  quitInProgress: () => desktopAdmission.quitInProgress,
  installedUpdateAdmission: () => desktopAdmission.installedUpdateAdmission,
  connectorTaskAdmission: () => desktopAdmission.occupied("connector-task"),
  reserveConnectorTask: () =>
    desktopAdmission.reserveAdmitted("connector-task"),
  connectorTaskAdmissionPurpose: () =>
    desktopAdmission.connectorTaskAdmissionPurpose,
  connectorStartInFlight: () => connectorStartInFlight,
  configurationRequests: () => desktopAdmission.configurationRequests,
  summaryFenceRecovery: () => contextHost.recovery.get(),
  workspaceMutationAdmission: () =>
    desktopAdmission.occupied("workspace-mutation"),
  codexAgentOperationActive,
  authorityTransitions: () => authorityTransitions,
  operationsStore,
  buildId: buildIdentity.buildId,
  isolatedE2EHome,
  powerMonitor: () => powerMonitor,
  computerMcpLifecycle,
  stopAndConfirmComputerMcp,
  observeConnectorStart: (work) => connectorStart().observeConnectorStart(work),
  startAdmittedSecureMcpConnector: (...args) =>
    connectorStart().startAdmittedSecureMcpConnector(...args),
  recordConnectorRuntime: (...args) =>
    connectorStart().recordConnectorRuntime(...args),
  reportConnectorTransport,
  transitionRefusal,
  configurationFailure,
});

// F3-1b: one authority transition at a time. A command that changes Computer
// authority holds it through its commit; a connector start and an Agent
// admission hold it from reading the settings until they run, so neither can
// start with authority that a concurrent change is about to replace.
const authorityTransitions = new AuthorityTransitionReservation();
const installedUpdates = createInstalledUpdateHost({
  buildEnvironment,
  sidecarOnly:
    windowMode === "secondary-visible" &&
    sidecarDisplayOnly &&
    !allowPrimaryDisplay,
  directory,
  build: buildIdentity,
  goCoreArtifact: compiledGoCore,
  physicalFiles: rawFs,
  createRuntime: createInstalledUpdateRuntime,
  idleCheckMs: UPDATE_IDLE_CHECK_MS,
  createHelperLifetime: createDesktopHelperLifetime,
  operations: operationsStore,
  userData: () => app.getPath("userData"),
  quit: () => app.quit(),
  publish: (view) => {
    window?.webContents.send(channels.installedUpdateState, view);
  },
  configurationChanged: () => {
    if (window && !window.isDestroyed())
      window.webContents.send(channels.configurationChanged);
  },
  admission: desktopAdmission,
  configuration: () => configuration,
  authorityTransitions,
  taskMutations: () => taskMutations,
  connector: () => secureMcpConnectorRuntime,
  routes: () => [
    ...managedChatGptRoutes,
    ...(chatGptRoute ? [chatGptRoute] : []),
  ],
  persistence: () => liveTaskPersistence,
  launchRoot: () => statePaths().secureMcpLaunch,
  stopConnector: stopAndConfirmComputerMcp,
  startConnector: (...args) =>
    connectorStart().startSecureMcpConnector(...args),
  stage: startupStage,
  applyLayout: () => applyLayout(),
});
let activeAuthorityChangeKind: ProductConfigurationCommand["kind"] | null =
  null;

// Whichever of an authority change, a connector start or an Agent admission
// holds the reservation, the loser is told that a transition is in progress
// and to retry: "stop the connector" or "stop the Agent task" would name an
// action the owner cannot take while that start is still underway.
function transitionRefusal(): ProductConfigurationResult {
  return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
}
let chatGptRoute: ChatGptRoute | null = null;
// The most recent content-free block the sign-in surface reported (host,
// permission name, or load-failure code only — see
// `ChatGptSignInBlockedDiagnostic`). The ledger starts every sign-in attempt
// clean, so a stale block from a previous attempt is never shown as current
// (UX34-07); the rule itself is unit-tested with the ledger.
const chatGptSignInBlocked = new ChatGptSignInBlockLedger();
// S35-R7: why the LAST sign-in outcome came out the way it did — the same
// content-free contract as the block above (a fixed reason token, the page
// state the read classified, how long it ran, which trigger started it;
// never a URL, page text or error message). Kept only in memory and
// cleared when a new sign-in surface is opened, so a stale explanation is
// never read as this attempt's. It explains an outcome; it never changes
// one, and `recordChatGptSignInOutcome` still writes nothing for
// "unknown".
let chatGptSignInOutcome: ChatGptSignInOutcomeDiagnostic | null = null;
// Explicit Setup check for the current build and browser document; never durable.
let setupSignInCheck: SetupCompletionContext["signInCheck"] = null;
// S35-TA-16 (U1 seam): each sign-in attempt gets the next number, and the
// published outcome carries that attempt's number. A delayed return therefore
// reports the OLDER generation, which is how a recipient tells a late event
// from a current one without guessing from timing.
let chatGptSignInGeneration = 0;
let chatGptSignInOpenGeneration: number | null = null;
// Live counters are cleared when the runtime exits; a support report made
// after that uses the counts taken just before the exit.
let taskCountsBeforeRuntimeExit: Readonly<{
  running: number;
  waiting: number;
  failed: number;
}> | null = null;
// The relay and the saved-chat bridge own their handles; main reads and clears
// them through the cells the owner exposes.
const bridge = createBridge({
  statePaths,
  isolatedE2EHome,
  runtimeEnvironment,
  activeDesktopIdentity,
  buildIdentity,
  env: process.env,
  configuration: () => configuration,
  summaryExecutionFence: () => contextHost.fence.get(),
  window: () => window,
  chatGptHomeUrl: () => chatGptHomeUrl,
  chatGptE2eOrigin: () => chatGptE2eOrigin,
  createManagedChatGptRoute,
  showMessageBox: (owner, options) => dialog.showMessageBox(owner, options),
  startCodexCallerRelay,
  startSavedChatBridge,
  createSavedChatHandoff: (root, canonical, browser, approve) =>
    new PersistentChatGptHandoff(
      new PrivateSavedChatJournal(root, canonical),
      browser,
      new Sha256SavedChatDigester(),
      canonical,
      approve,
    ),
});
if (process.env.FAROL_E2E === "1") {
  // Main-process metadata readback only: no token, socket client or control API.
  Object.defineProperty(app, "__farolE2ERelayDirectory", {
    get: () => bridge.directoryWitness.get(),
  });
}
// S35-03/2: takes the SAME cross-process lease a promotion holds from
// before its drain check through placement, for the whole durable admission
// — not merely a synchronous check of it (see `live-task-registry.ts`'s
// `PromotionLeaseGuard`). An unsafe or unreadable lease state refuses
// admission rather than surfacing the lease error as an unrelated crash;
// `verify` fences the durable write against a lease file replaced by hand.
const liveTaskRegistry = new LiveTaskRegistry(
  5,
  admissionLease(() => app.getPath("userData"), buildIdentity.buildId),
);
const liveTaskRoutes = new Map<string, ChatGptRoute>();
const managedChatGptRoutes = new Set<ChatGptRoute>();
const SIGN_IN_SURFACE_ID = "farol-sign-in";
let browserHomeSurfaceOpen = false;
let checkFeedbackVisible = false;
// Surface navigation writes the layout state above and reads each owner when
// a function runs; see apps/desktop/shell/navigation.ts.
const {
  publishLayout,
  publishShellAction,
  focusForLayoutAfterRendererCommit,
  requestQuickSwitcher,
  requestSidebarToggle,
  handleShortcut,
  applyRendererLayout,
  currentSurfaceLayout,
  applyLayout,
} = surfaceNavigation({
  state: {
    get section() {
      return section;
    },
    set section(value) {
      section = value;
    },
    get selectedTaskId() {
      return selectedTaskId;
    },
    set selectedTaskId(value) {
      selectedTaskId = value;
    },
    get setupOpen() {
      return setupOpen;
    },
    set setupOpen(value) {
      setupOpen = value;
    },
    get checkFeedbackVisible() {
      return checkFeedbackVisible;
    },
    set checkFeedbackVisible(value) {
      checkFeedbackVisible = value;
    },
    get sidebarMode() {
      return sidebarMode;
    },
    set sidebarMode(value) {
      sidebarMode = value;
    },
    get sidebarWidth() {
      return sidebarWidth;
    },
    set sidebarWidth(value) {
      sidebarWidth = value;
    },
    get shellOverlay() {
      return shellOverlay;
    },
    set shellOverlay(value) {
      shellOverlay = value;
    },
    get browserHomeSurfaceOpen() {
      return browserHomeSurfaceOpen;
    },
    get navigationShortcuts() {
      return navigationShortcuts;
    },
  },
  window: () => window,
  quitInProgress: () => desktopAdmission.quitInProgress,
  installedUpdateAdmission: () => desktopAdmission.installedUpdateAdmission,
  runtimeState: () => runtimeState,
  taskViews: () => taskViews,
  taskViewKinds: () => taskViewKinds,
  nativeViewVisibility: () => nativeViewVisibility,
  liveTaskRoutes,
  signInSurfaceId: SIGN_IN_SURFACE_ID,
  compactBrowser: () =>
    compactBrowserSelected({
      environment: runtimeEnvironment,
      demoMode,
      legacySetupTestMode,
    }),
  productTasksState,
  attachTaskView: (taskId, view, bounds) =>
    attachTaskView(taskId, view, bounds),
  openLiveTaskSurface,
  requestSettings,
});
const liveTaskConversationUrls = new Map<string, string | null>();
let liveTaskStore: PrivateLiveTaskStore | null = null;
let productAgentStore: PrivateProductAgentStore | null = null;
// True once the saved task registry was read and restored for real; only
// then is a stored context with no live task known to be an orphan.
let liveTaskRegistryRestored = false;
let liveTaskPersistence: Promise<void> = Promise.resolve();
const taskMutations = new TaskMutationGate();
let chatGptHomeUrl = CHATGPT_HOME;
let chatGptE2eOrigin: string | null = null;
let pendingChatGptReadonlyTask: PendingChatGptReadonlyTask | null = null;
let goChatStartupProfile: ReturnType<typeof captureChatStartupProfile> = null;
let goReadonlyConversation: GoReadonlyConversation | null = null;
let directChatStart: DirectChatStart | null = null;
const readonlyAccountCommands = new ReadAccountCommands();
const readonlyAccountConfirmations = new WeakMap<
  PendingChatGptReadonlyTask,
  ReadAccountConfirmation
>();
const readonlyDiscardAttempts = new WeakMap<
  PendingChatGptReadonlyTask,
  Promise<boolean>
>();
let pendingChatGptAttachmentTask: PendingChatGptAttachmentTask | null = null;
let attachmentStagingReady = true;
let chatGptTaskJournal: PrivateChatGptTaskJournal | null = null;
let recoverableChatGptTask: ChatGptTaskJournalRecord | null = null;
let recoverableDeepTests: readonly ChatGptTaskJournalRecord[] = [];
let deepTestRecoveryReady = false;
const deepTestRequests = new Map<
  string,
  {
    taskId: string;
    test: "connection" | "deep";
    promise: Promise<ProductConfigurationResult>;
  }
>();
const deepTestAcknowledgements = new Map<
  string,
  Promise<ProductConfigurationResult>
>();
let recoverableChatGptObservationPersisted = false;
let chatGptConversationStore: PrivateChatGptConversationStore | null = null;
let chatGptConversation: ChatGptConversationRecord | null = null;
let pendingWorkspaceEdit: PendingWorkspaceEdit | null = null;
let windowPresentationReady = false;
let activeCodexAgentCheck: ActiveCodexAgentCheck | null = null;
// App Servers a one-off host check started. The check keeps its client in a
// local variable, so quit can wait for it only through this set.
const hostCheckClients = new Set<
  Awaited<ReturnType<typeof launchCodexAppServer>>
>();
type ActiveProductAgentSession = ProductAgentSession<ProductTaskCommandResult>;
let activeProductAgentSession: ActiveProductAgentSession | null = null;
let persistedProductAgentExpiry: Readonly<{
  taskId: string;
  timer: NodeJS.Timeout;
}> | null = null;

function pendingProductAgentTaskId(): string | null {
  return (
    liveTaskRegistry
      .snapshot()
      .tasks.find(
        (task) =>
          task.agent?.phase === "running" ||
          (task.agent?.phase === "completed" &&
            task.agent.parentDelivery !== "acknowledged"),
      )?.taskId ?? null
  );
}

function codexAgentOperationActive(): boolean {
  return (
    activeCodexAgentCheck !== null ||
    activeProductAgentSession !== null ||
    pendingProductAgentTaskId() !== null
  );
}

function chatGptReadonlyTaskPreview(
  pending: PendingChatGptReadonlyTask,
): Readonly<Record<string, unknown>> {
  return readonlyHost().chatGptReadonlyTaskPreview(pending);
}

function readonlyAccountCurrent(
  pending: PendingChatGptReadonlyTask,
  route: ChatGptRoute,
  core: DesktopGoCore,
): boolean {
  const snapshot = configuration?.snapshot();
  if (
    pendingChatGptReadonlyTask !== pending ||
    chatGptRoute !== route ||
    desktopGoCore !== core ||
    !pending.goAdmission ||
    Date.now() >= pending.expiresAt ||
    snapshot?.status !== "ready"
  )
    return false;
  const settings = snapshot.settings;
  return (
    !settings.setup.chatgpt.outcomeUnknown &&
    pending.chatGptVerification.buildId === buildIdentity.buildId &&
    isDeepStrictEqual(
      settings.setup.chatgpt.verified,
      pending.chatGptVerification,
    ) &&
    settings.computer.generation === pending.computerGeneration &&
    settings.computer.workspaces.some(
      (workspace) => workspace.workspaceId === pending.workspaceId,
    ) &&
    settings.setup.computer.verified?.workspaceId === pending.workspaceId &&
    settings.setup.computer.verified.configRevision ===
      pending.computerGeneration
  );
}

function chatGptAttachmentTaskPreview(
  pending: PendingChatGptAttachmentTask,
): Readonly<Record<string, unknown>> {
  return readonlyHost().chatGptAttachmentTaskPreview(pending);
}

function verificationWorkspaceAction(
  settings: ProductSettings,
  workspace: ApprovedProductWorkspace,
  expiresAt: number,
): VerificationWorkspaceAction | null {
  if (settings.computer.commands === "none") return null;
  const ownerId = "owner-desktop";
  const sessionId = "desktop-command-session";
  const taskId = "desktop-command-task";
  const participantId = "desktop-command-main";
  const approvalCapabilities: AuthorityCapability[] = [
    "workspace.list",
    "workspace.read",
    "workspace.search",
    "verification.run",
    ...(settings.computer.workspaces.some(
      (candidate) => candidate.access === "write",
    )
      ? (["workspace.write"] as const)
      : []),
  ];
  const bound = identityBoundWorkspaces(settings.computer.workspaces);
  const approval: ComputerApproval = {
    ownerId,
    computerId: settings.computer.computerId,
    generation: settings.computer.generation,
    workspaces: bound.map((candidate) => ({
      workspaceId: candidate.workspaceId,
      root: candidate.root,
      access: candidate.access,
      rootIdentity: candidate.rootIdentity,
      ...(candidate.gitMetadata ? { gitMetadata: candidate.gitMetadata } : {}),
    })),
    excludedPaths: bound.flatMap((candidate) =>
      candidate.excludedPaths.map((excluded) => ({
        workspaceId: candidate.workspaceId,
        path: excluded,
      })),
    ),
    capabilities: approvalCapabilities,
    network: "none",
    commands: settings.computer.commands,
    expiresAt,
  };
  const admission: TaskAdmission = {
    authorityId: `desktop-command-authority-${settings.computer.generation}`,
    ownerId,
    sessionId,
    taskId,
    taskEpoch: settings.computer.generation,
    computerId: settings.computer.computerId,
    computerGeneration: settings.computer.generation,
    workspaces: [
      {
        workspaceId: workspace.workspaceId,
        mode: "subtree",
        root: workspace.root,
        access: "read",
      },
    ],
    excludedPaths: workspace.excludedPaths.map((excluded) => ({
      workspaceId: workspace.workspaceId,
      path: excluded,
    })),
    capabilities: ["verification.run"],
    network: "none",
    commands: settings.computer.commands,
    expiresAt,
  };
  const grant = deriveTaskGrant(approval, admission, Date.now());
  if (!grant.ok) return null;
  const participant = createParticipantAuthority(grant.value, {
    participantId,
    role: "main",
    mutationOwnership: "none",
  });
  if (!participant.ok) return null;
  return new RunReadonlyComputerAction(
    new InMemoryAuthorityRepository([participant.value]),
    new InMemoryComputerApprovalRepository([approval]),
    nativeWorkspace,
    { now: () => Date.now() },
  );
}

const windowOpenCoordinator = new WindowOpenCoordinator();
const taskViews = new Map<string, WebContentsView>();
const taskViewKinds = new Map<string, "runtime" | "chatgpt">();
const nativeViewVisibility = new NativeViewVisibility<WebContentsView>();
const streamControllers = new Map<string, AbortController>();
const taskSurfaceFailures = new Map<string, string>();
const pendingComputer = new Map<
  string,
  Extract<z.infer<typeof ClientEventSchema>, { kind: "computer.requested" }>
>();

// Window and task-surface adapters borrow their owners through live accessors.
const desktopWindowState = {
  get window() {
    return window;
  },
  set window(value) {
    window = value;
  },
  get windowPresentationReady() {
    return windowPresentationReady;
  },
  set windowPresentationReady(value) {
    windowPresentationReady = value;
  },
  get runtime() {
    return runtime;
  },
  get runtimeState() {
    return runtimeState;
  },
  get quitInProgress() {
    return desktopAdmission.quitInProgress;
  },
  get installedUpdateAdmission() {
    return desktopAdmission.installedUpdateAdmission;
  },
  get selectedTaskId() {
    return selectedTaskId;
  },
  get browserHomeSurfaceOpen() {
    return browserHomeSurfaceOpen;
  },
  set browserHomeSurfaceOpen(value) {
    browserHomeSurfaceOpen = value;
  },
};
const windowSurfaces = taskSurfaces({
  state: desktopWindowState,
  WebContentsView,
  taskViews,
  taskViewKinds,
  nativeViewVisibility,
  streamControllers,
  taskSurfaceFailures,
  pendingComputer,
  runtimePartition: activeDesktopIdentity.runtimePartition,
  signInSurfaceId: SIGN_IN_SURFACE_ID,
  session,
  runtimeBase,
  currentSurfaceLayout,
  applyLayout,
  handleShortcut,
  preventEmbeddedWindowDrag,
  operationsStore,
  fetch,
});
const {
  attachTaskView,
  liveChatGptSurfaceFactory,
  signInChatGptSurfaceFactory,
  disposeTaskViews,
  stopStreams,
  publishTaskSurfaceStatus,
} = windowSurfaces;
const {
  currentWindowState,
  selectedVisibleTestPlacement,
  chatGptWindowPresentationOption,
  reconcileVisibleTestDisplay,
  recoverWindowOpenFailure,
  ensureWindow,
  reopenWindow,
} = mainWindow({
  state: desktopWindowState,
  BrowserWindow,
  surfaces: windowSurfaces,
  pendingComputer,
  taskSurfaceFailures,
  coordinator: windowOpenCoordinator,
  nativeViewVisibility,
  buildEnvironment,
  buildIdentity,
  displayWindowTitle,
  initialWindowSize,
  windowMode,
  devSecondaryDisplay,
  allowPrimaryDisplay,
  builtInDisplayOnly,
  sidecarDisplayOnly,
  explicitPreviewWindowSize,
  screen,
  managedChatGptRoutes,
  aboutPanel: () => aboutPanel,
  updatesPanel: () => updatesPanel,
  liveTaskRoutes,
  demoMode,
  platform: process.platform,
  writeLog: (line) => process.stderr.write(line),
  desktopExecutionResources: installedUpdates.resources,
  observeRendererLifecycle,
  handleShortcut,
  applyLayout,
  focusForLayoutAfterRendererCommit,
  openLiveTaskSurface,
  closeStartupSplash,
});

function demoShellTasks(): readonly ProductTask[] {
  return (runtime?.tasks ?? expectedTasks).map((task) => ({
    taskId: task.taskId,
    sessionId: task.sessionId,
    turnId: task.turnId,
    label: task.label,
    provider: "fixture" as const,
    requestedModel: "Synthetic local fixture",
    observedModel: "Synthetic local fixture",
    requestedMode: "Deterministic demo",
    observedMode: "Deterministic demo",
    hasComputer: task.hasComputer,
    pinned: false,
    lifecycle: "event_driven" as const,
  }));
}

function productTasksState() {
  return demoMode
    ? ProductTasksStateSchema.parse({ revision: 0, tasks: demoShellTasks() })
    : liveTaskRegistry.snapshot();
}

function runtimeStatus() {
  return (runtimeStatusCache ??= createRuntimeStatus({
    runtime: () => runtime,
    runtimeState: () => runtimeState,
    runtimeError: () => runtimeError,
    window: () => window,
    desktopGoCore: () => desktopGoCore,
    configuration: () => configuration,
    selectedTaskId: () => selectedTaskId,
    chatGptRoute: () => chatGptRoute,
    liveTaskRoutes,
    recoverableChatGptTask: () => recoverableChatGptTask,
    chatGptSignInOutcome: () => chatGptSignInOutcome,
    chatGptSignInBlocked,
    nativeImage,
    fetch: (input, init) => fetch(input, init),
    directory,
    env: process.env,
    versions: process.versions,
    productName,
    bundleId,
    activeDesktopIdentity,
    buildIdentity,
    demoMode,
    legacySetupTestMode,
    compiledGoCore,
    WORKSPACE_EDIT_ACK_HOLD_ENV,
    WORKSPACE_EDIT_ACK_HOLD_INVALID,
    e2eBudget,
    productTasksState,
    currentConnectionStatus,
    chatGptConversationState,
    productAgentCapabilityAvailable,
    currentWindowState,
  }));
}
let runtimeStatusCache: ReturnType<typeof createRuntimeStatus> | null = null;

function runtimeBase(): string | null {
  return runtimeStatus().runtimeBase();
}

function bootstrap() {
  return runtimeStatus().bootstrap();
}

function publishTasksState(): void {
  taskSurface().publishTasksState();
}

function taskFailure(
  error: Extract<ProductTaskCommandResult, { ok: false }>["error"],
): ProductTaskCommandResult {
  return taskSurface().taskFailure(error);
}

function taskSuccess(taskId: string | null): ProductTaskCommandResult {
  return taskSurface().taskSuccess(taskId);
}

function surfaceLiveTaskPersistenceFailure(taskId: string): void {
  taskSurface().surfaceLiveTaskPersistenceFailure(taskId);
}

function setLiveTaskLifecycle(
  taskId: string,
  lifecycle: ProductTask["lifecycle"],
): void {
  taskSurface().setLiveTaskLifecycle(taskId, lifecycle);
}

// S35-03: a later turn of an existing task becomes the `TASK_RUNNING`
// obligation a promotion's drain check refuses on the moment it is durably
// running, so it takes the same cross-process lease a first turn's admission
// takes (`admitDurable`); a live promotion refuses the turn before submission
// instead of racing its placement.
//
// S35-TA-1: the leased body itself is `LiveTaskRegistry.markRunningDurable`,
// beside `admitDurable`, so the fence a stolen-lease test exercises is the
// one this call site runs. What stays here is what only `main.ts` can do:
// publish the surface and surface a persistence failure.
async function markLiveTaskRunningDurable(taskId: string): Promise<boolean> {
  return taskPersist().markRunningDurable(taskId);
}

function chatGptTaskAdmissionReady(): boolean {
  const snapshot = configuration?.snapshot();
  if (!snapshot || snapshot.status !== "ready") return false;
  const readiness = snapshot.settings.setup.chatgpt;
  return (
    readiness.reachable === "reachable" &&
    readiness.configured &&
    !readiness.outcomeUnknown &&
    readiness.verified !== null
  );
}

function persistLiveTaskState(): Promise<void> {
  return taskPersist().persist();
}

function createManagedChatGptRoute(options: ChatGptRouteOptions): ChatGptRoute {
  return taskRoutes().managed(options);
}

function createLiveChatGptRoute(
  taskId: string,
  label: string,
  initialUrl?: string,
): ChatGptRoute {
  return taskRoutes().live(taskId, label, initialUrl);
}

function contextBinding(taskId: string): ContextBinding {
  return contextHost.binding(taskId);
}

function createContextSummaryFallbackRoute(
  binding: ContextBinding,
  recoveredConversationUrl?: string,
): ChatGptRoute {
  return taskRoutes().contextSummaryFallback(binding, recoveredConversationUrl);
}

// The sign-in surface (chatgpt-route.ts) reports its outcome exactly once,
// when its window closes — never while it stays open, and never a repeat.
// "unknown" (the page could not be read, e.g. a load failure) is recorded
// nowhere: it is not the same claim as an observed signed-out page, and an
// unverifiable outcome must not silently overwrite a previously verified
// one.
//
// The owner is brought back to Setup only when they were not already
// there: the first-run Setup wizard (setupOpen) is itself a "Setup"
// surface, and jumping to the standalone Settings screen out from under
// an in-progress wizard step would abandon it, not return the owner to
// it. Inside the wizard, its own "chatgpt" step already re-reads
// configuration state on the owner's next explicit check.
async function recordChatGptSignInOutcome(
  generation: number | null,
  status: ChatGptSignInStatus,
): Promise<void> {
  if (configuration && status !== "unknown") {
    try {
      await configuration.recordChatGptObservation(
        status === "authenticated"
          ? {
              state: "authenticated",
              profile: "chatgpt.app-partition/1",
              runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
              buildId: buildIdentity.buildId,
              protocol: "chatgpt-page-readiness/1",
            }
          : { state: "signed_out" },
        true,
      );
    } catch {
      // Not a request a renderer is blocked on; the next explicit "Check
      // connection" or sign-in attempt tries again.
    }
  }
  // Guided Setup owns the computer section with the legacy wizard closed.
  // Its restored step receives readiness without another Settings navigation.
  // Outside either Setup surface, the existing Settings return still applies.
  publishShellAction(
    runtimeEnvironment === "dev" || setupOpen || section === "computer"
      ? "sign-in-returned"
      : "open-settings",
    "auth-window-closed",
    generation,
  );
}

// The first turn of a Codex host thread admits its task like a new Browser
// task: a route, a saved task and an opened surface. The lifecycle above it
// decides when a thread reaches this path.
async function admitRouteBTask(
  threadId: string,
): Promise<RouteBSurfaceAdmission> {
  return contextHost.admitRouteBTask(threadId);
}

const routeBTaskLifecycle = createRouteBTaskLifecycle({
  owns: (taskId) => contextHost.routeB.get()?.owns(taskId) ?? false,
  existingSurface: (taskId) => liveTaskRoutes.get(taskId) ?? null,
  liveTask: (taskId) => liveTaskRegistry.get(taskId) !== null,
  markRunning: (taskId) => markLiveTaskRunningDurable(taskId),
  mutationInFlight: () => taskMutations.inFlight(),
  admissionReady: () => chatGptTaskAdmissionReady(),
  admitTask: admitRouteBTask,
  removeAgentInput: async (taskId) => {
    await productAgentStore?.remove(taskId);
  },
  snapshotTasks: () => liveTaskRegistry.snapshot(),
  removeTask: (taskId) => liveTaskRegistry.remove(taskId) !== null,
  rollbackTasks: (snapshot) => liveTaskRegistry.rollback(snapshot),
  persist: () => persistLiveTaskState(),
  deleteContext: (taskId) => {
    const controller = contextHost.controller.get();
    return controller
      ? deleteTaskContext(
          controller.store,
          contextBinding(taskId),
          contextHost.fence.get() ?? undefined,
        )
      : Promise.resolve("none");
  },
  disposeRoute: (taskId) => {
    const route = liveTaskRoutes.get(taskId);
    liveTaskRoutes.delete(taskId);
    liveTaskConversationUrls.delete(taskId);
    route?.dispose();
  },
});

const routeBTaskSurfaces: RouteBTaskSurfaces = {
  surfaceFor: (threadId) => routeBTaskLifecycle.surfaceFor(threadId),
  settled: (threadId, state) => {
    setLiveTaskLifecycle(
      threadId,
      state === "outcome_unknown" ? "outcome_unknown" : "idle",
    );
  },
};

// The context controller, its execution fence, the last fence recovery and the
// Route B runtime own their handles; main reads and clears them through the
// cells the owner exposes.
const contextHost = createContextHost({
  statePaths,
  contextOwnerId,
  contextProviderProfileId,
  contextModel,
  taskMutations,
  liveTaskRegistry,
  liveTaskRoutes,
  liveTaskConversationUrls,
  liveTaskStore: () => liveTaskStore,
  liveTaskRegistryRestored: () => liveTaskRegistryRestored,
  routeBTaskSurfaces,
  callerRelay: () => bridge.relay.get(),
  persistLiveTaskState,
  publishTasksState,
  openLiveTaskSurface,
  createLiveChatGptRoute,
  createContextSummaryFallbackRoute,
  createExecutionFence: (root) => new PrivateExecutionFence({ root }),
  createCodexContextController,
  startRouteBRuntime,
});

// Includes the bounded Go retirement/ACK, exact child exit and terminal recorder.
const QUIT_DRAIN_DEADLINE_MS = 60_000;
const QUIT_PREPARATION_MS = 10_000;
const QUIT_RECORD_RESERVE_MS = 2_000;
// Leave at least 40 seconds of the normal post-preparation drain for Go core
// and recording. This bounds the whole dependent close, not a renewed budget.
const CONNECTOR_START_QUIT_BUDGET_MS = 8_000;

// The outcome of the last quit's drain: F3-3's reader (the tooling-side
// `promotion-obligations.mjs` and its `promotion-lease.ts` counterpart) both
// insist on a private regular file with no symlink standing in for it.
//
// S35-TA-8: that discipline now lives in `quit-receipt-store.ts`, where it
// can be tested. The version here claimed parity with `live-task-store.ts`
// in a comment while skipping three of the things the store does — the
// private-root check, the replaceable-target check and the directory sync
// after the rename — and nothing could catch that, because `main.ts` exports
// nothing and no test loads it. The bytes still come from the shared
// `quit-receipt.ts` contract, so writer and reader cannot disagree about a
// field the way they once did about `at`.
// Diagnostic only: the last stage a Quit reached, never authority.
let quitTrace: QuitTrace | null = null;
let quitTracePhase: QuitTracePhase = "startup";
// Set once the drain receipt says nothing is left; lets the launcher end an
// exit teardown that hangs (Electron 44, 2026-11-23).
let quitDrained = false;

async function recordQuitReceipt(receipt: QuitDrainReceipt): Promise<void> {
  await writeQuitReceipt(statePaths().state, receipt, new Date().toISOString());
}

async function initializeLiveTaskState(): Promise<void> {
  return taskPersist().initialize();
}

async function openLiveTaskSurface(taskId: string): Promise<boolean> {
  return taskSurface().openLiveTaskSurface(taskId);
}

function productAgentCapabilityAvailable(): boolean {
  return productAgentHost().productAgentCapabilityAvailable();
}

function persistProductAgentSummary(
  taskId: string,
  summary: ProductTaskAgent,
): Promise<boolean> {
  return productAgentHost().persistProductAgentSummary(taskId, summary);
}

function productAgentUnknownSummaryFromTask(
  agent: ProductTaskAgent,
): ProductTaskAgent {
  return productAgentHost().productAgentUnknownSummaryFromTask(agent);
}

function productAgentAssignmentBinding(input: ProductAgentInput): string {
  return productAgentHost().productAgentAssignmentBinding(input);
}

function productAgentAssignmentMatches(
  agent: ProductTaskAgent,
  input: ProductAgentInput,
): boolean {
  return productAgentHost().productAgentAssignmentMatches(agent, input);
}

function recoverProductAgentExpiry(): Promise<void> {
  return productAgentHost().recoverProductAgentExpiry();
}

function cancelProductAgentTask(
  task: ProductTask,
): Promise<ProductTaskCommandResult> {
  return productAgentHost().cancelProductAgentTask(task);
}

function executeProductAgent(
  task: ProductTask,
  input: ProductAgentInput,
  context: ProductAgentContext,
  admission: "new" | "rejoin",
): Promise<ProductTaskCommandResult> {
  return productAgentHost().executeProductAgent(
    task,
    input,
    context,
    admission,
  );
}

function runProductTaskCommand(
  value: unknown,
): Promise<ProductTaskCommandResult> {
  const parsed = ProductTaskCommandSchema.safeParse(value);
  if (!parsed.success) return runProductTaskCommandObserved(value);
  return observeOperation(
    operationsStore(),
    { source: "Codex", kind: `task.${parsed.data.kind}`, target: {} },
    () => runProductTaskCommandObserved(value),
  );
}
function runProductTaskCommandObserved(
  value: unknown,
): Promise<ProductTaskCommandResult> {
  return taskCommands().run(value);
}

function configurationFailure(
  error: Extract<ProductConfigurationResult, { ok: false }>["error"],
  connectorAttempt?: Extract<
    ProductConfigurationResult,
    { ok: false }
  >["connectorAttempt"],
): ProductConfigurationResult {
  return ProductConfigurationResultSchema.parse({
    ok: false,
    error,
    ...(connectorAttempt ? { connectorAttempt } : {}),
    snapshot: configuration?.snapshot() ?? {
      status: "error",
      error: "SETTINGS_READ_FAILED",
    },
  });
}

// The model route's small readers and the Codex host path helpers live in the
// owner; main keeps these thin wrappers because the configuration, connector
// and product-agent factories take them as ports.
const modelHost = createModelHost({
  env: process.env,
  app,
  dialog,
  os,
  window: () => window,
  configuration: () => configuration,
  modelLifecycle: () => modelLifecycle,
  statePaths,
  buildIdentity,
  buildEnvironment,
  activeDesktopIdentity,
  FAROL_MODEL_ENABLED,
  FAROL_PROVIDER_ID,
  ROUTE_B_MODEL,
  desktopCodexConfigPath,
  desktopCodexChildHomes,
  detectCodexHostPresence,
});

async function selectedSupportExportTarget(): Promise<string | null> {
  return modelHost.selectedSupportExportTarget();
}

function farolModelCodexConfigPath(): string {
  return modelHost.farolModelCodexConfigPath();
}

function syntheticModelTurnHandler(
  text: string,
): NonNullable<
  ConstructorParameters<typeof FarolModelLifecycle>[0]["handler"]
> {
  return modelHost.syntheticModelTurnHandler(text);
}

async function farolModelProviderSpec(): Promise<FarolModelProviderSpec | null> {
  return modelHost.farolModelProviderSpec();
}

async function farolModelCodexHostPresence(): Promise<
  "running" | "not_running" | "unknown"
> {
  return modelHost.farolModelCodexHostPresence();
}

function computerMcpLifecycle(): PrivateMcpLifecycle {
  return connectorStop().computerMcpLifecycle();
}

async function stopAndConfirmComputerMcp(
  ...args: Parameters<
    ReturnType<typeof connectorStop>["stopAndConfirmComputerMcp"]
  >
): Promise<void> {
  return connectorStop().stopAndConfirmComputerMcp(...args);
}

async function codexHostRuntimeRoot(): Promise<string> {
  return modelHost.codexHostRuntimeRoot();
}

async function codexHostHomeOption(): Promise<
  Readonly<{ codexHomePath?: string }>
> {
  return modelHost.codexHostHomeOption();
}

async function codexHostProcessHomePath(): Promise<string> {
  return modelHost.codexHostProcessHomePath();
}

function chatGptConversationState():
  "new" | "retained" | "review_required" | "unavailable" {
  return chatGptSession().conversationState();
}

function chatGptConversationAdmissionFailure(): ProductConfigurationResult | null {
  return chatGptSession().admissionFailure();
}

function chatGptConversationContinuity():
  "retained" | "not_observed" | "review_required" | "unavailable" {
  return chatGptSession().continuity();
}

function chatGptAppPreSubmitObservation(code: string | null) {
  return chatGptSession().preSubmitObservation(code);
}

function retainChatGptConversation(
  operationId: string,
  taskState:
    | "completed"
    | "not_authenticated"
    | "failed_before_submit"
    | "outcome_unknown",
): Promise<"retained" | "not_observed" | "review_required" | "unavailable"> {
  return chatGptSession().retain(operationId, taskState);
}

function chatGptJournalObservation(result: ChatGptTaskJournalResult) {
  return chatGptSession().journalObservation(result);
}

function discardPreparedChatGptTask(operationId: string): Promise<boolean> {
  return chatGptSession().discardPrepared(operationId);
}

function withdrawGoReadonlyAdmission(
  admission: ChatComputerAdmissionResponse | undefined,
): Promise<boolean> {
  return readonlyHost().withdrawGoReadonlyAdmission(admission);
}

function discardPreparedReadonlyTask(
  pending: PendingChatGptReadonlyTask,
): Promise<boolean> {
  return readonlyHost().discardPreparedReadonlyTask(pending);
}

function selectedChatGptAttachmentPaths(): Promise<
  readonly string[] | "cancelled" | "invalid"
> {
  return chatGptSession().selectedAttachmentPaths();
}

function attachmentStagingFailure(error: unknown): ProductConfigurationResult {
  return chatGptSession().attachmentStagingFailure(error);
}

// The workspace selection and launch-drift code lives in
// apps/desktop/configuration/workspace.ts; these wrappers keep the names every
// consumer already calls.
function measuredRootIdentity(
  root: string,
): Promise<WorkspaceRootIdentity | null> {
  return workspaceHost().measuredRootIdentity(root);
}

function withdrawDriftedWorkspaceChecksAtLaunch(): Promise<boolean> {
  return workspaceHost().withdrawDriftedWorkspaceChecksAtLaunch();
}

function selectedWorkspace(): ReturnType<
  ReturnType<typeof workspaceHost>["selectedWorkspace"]
> {
  return workspaceHost().selectedWorkspace();
}

// A native choice is held only in this process. The renderer receives an
// opaque short-lived reference, so cancellation never stops a live connector.
let pendingWorkspacePick: PendingWorkspacePickValue | null = null;

function reverifyDiscoveredCandidate(
  kind: "codex" | "tunnel-client",
  requestedPath: string,
): Promise<DiscoveryCandidate | "stale" | "declined"> {
  return workspaceHost().reverifyDiscoveredCandidate(kind, requestedPath);
}

// The Codex and tunnel-client selection and verification live in
// apps/desktop/host/executable.ts; these wrappers keep the names every consumer
// already calls.
function e2eCodexExecutable(): string | "invalid" | undefined {
  return executableHost().e2eCodexExecutable();
}

function selectedCodexExecutable(): Promise<string | "cancelled" | "invalid"> {
  return executableHost().selectedCodexExecutable();
}

function verifyCodexExecutable(
  executablePath: string,
  expectedDiscovery?: Readonly<{ canonicalPath: string; sha256: string }>,
): Promise<ProductConfigurationResult> {
  return executableHost().verifyCodexExecutable(
    executablePath,
    expectedDiscovery,
  );
}

function e2eTunnelClientExecutable(): string | "invalid" | undefined {
  return executableHost().e2eTunnelClientExecutable();
}

function selectedTunnelClientExecutable(): Promise<
  string | "cancelled" | "invalid"
> {
  return executableHost().selectedTunnelClientExecutable();
}

function verifyTunnelClientExecutable(
  executablePath: string,
  expectedDiscovery?: Readonly<{ canonicalPath: string; sha256: string }>,
): Promise<ProductConfigurationResult> {
  return executableHost().verifyTunnelClientExecutable(
    executablePath,
    expectedDiscovery,
  );
}

// Built once, here, where the function declarations they replace stood. Every
// call site is inside main() or a later closure, and main() is first called
// near the end of this module, so each one reads the same built functions.
const { reportQualificationObservation, reportOwnedBackendLifecycle } =
  createCoreReporters({ runtimeEnvironment, buildIdentity, operationsStore });

function verifySecureMcpApp(
  separate?: SeparateAppVerificationScope,
): Promise<ProductConfigurationResult> {
  return connectorVerify().verifySecureMcpApp(separate);
}

function connectorStart() {
  return (connectorStartCache ??= createConnectorStart({
    configuration: () => configuration,
    connectorCredentialStore: () => connectorCredentialStore,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    desktopGoCore: () => desktopGoCore,
    summaryFenceRecovery: () => contextHost.recovery.get(),
    connectorStartCancellation: () => connectorStartCancellation,
    setConnectorStartCancellation: (value) => {
      connectorStartCancellation = value;
    },
    setConnectorStartInFlight: (value) => {
      connectorStartInFlight = value;
    },
    desktopAdmission,
    authorityTransitions,
    buildIdentity,
    randomUUID,
    directory,
    installedUpdates,
    operationsStore,
    statePaths,
    configurationFailure,
    transitionRefusal,
    stopAndConfirmComputerMcp,
    computerMcpLifecycle,
    e2eTunnelClientExecutable,
    verifyTunnelClientExecutable,
    verifySelectedTunnelClient,
    clearConnectorVerificationReceipt,
    connectorAttemptGeneration,
  }));
}
let connectorStartCache: ReturnType<typeof createConnectorStart> | null = null;

function connectorStop() {
  return (connectorStopCache ??= createConnectorStop({
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    desktopGoCore: () => desktopGoCore,
    saved: bridge.saved,
    operationsStore,
    statePaths,
    createLifecycle: (secureMcpLaunch) =>
      new PrivateMcpLifecycle(secureMcpLaunch),
  }));
}
let connectorStopCache: ReturnType<
  typeof createConnectorStop<PrivateMcpLifecycle>
> | null = null;

function workspaceHost() {
  return (workspaceHostCache ??= createWorkspaceHost({
    configuration: () => configuration,
    authorityTransitions,
    desktopAdmission,
    codexAgentOperationActive,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    workspaceCheckEvidence,
    window: () => window,
    showOpenDialog: (owner, options) => dialog.showOpenDialog(owner, options),
    showMessageBox: (owner, options) => dialog.showMessageBox(owner, options),
    discoverExecutables,
    env: process.env,
  }));
}
let workspaceHostCache: ReturnType<typeof createWorkspaceHost> | null = null;

function executableHost() {
  return (executableHostCache ??= createExecutableHost({
    configuration: () => configuration,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    window: () => window,
    showOpenDialog: (owner, options) => dialog.showOpenDialog(owner, options),
    statePaths,
    buildIdentity,
    directory,
    configurationFailure,
    probeCodexHost,
    probeTunnelClient,
    env: process.env,
  }));
}
let executableHostCache: ReturnType<typeof createExecutableHost> | null = null;

function taskPersist() {
  return (taskPersistCache ??= createTaskPersist({
    liveTaskStore: () => liveTaskStore,
    setLiveTaskStore: (value) => {
      liveTaskStore = value;
    },
    liveTaskPersistence: () => liveTaskPersistence,
    setLiveTaskPersistence: (value) => {
      liveTaskPersistence = value;
    },
    setLiveTaskRegistryRestored: (value) => {
      liveTaskRegistryRestored = value;
    },
    setSelectedTaskId: (value) => {
      selectedTaskId = value;
    },
    chatGptHomeUrl: () => chatGptHomeUrl,
    liveTaskRegistry,
    liveTaskRoutes,
    liveTaskConversationUrls,
    statePaths,
    createLiveChatGptRoute,
    openStore: (root, hooks) => new PrivateLiveTaskStore({ root }, hooks),
    publishTasksState,
    surfaceLiveTaskPersistenceFailure,
    env: process.env,
  }));
}
let taskPersistCache: ReturnType<typeof createTaskPersist> | null = null;

function taskRoutes() {
  return (taskRoutesCache ??= createTaskRoutes({
    window: () => window,
    chatGptHomeUrl: () => chatGptHomeUrl,
    chatGptE2eOrigin: () => chatGptE2eOrigin,
    managedChatGptRoutes,
    liveTaskRegistry,
    liveTaskConversationUrls,
    activeDesktopIdentity,
    channels,
    displayProductName,
    runtimeEnvironment,
    persistLiveTaskState,
    surfaceLiveTaskPersistenceFailure,
    setLiveTaskLifecycle,
    chatGptWindowPresentationOption,
    liveChatGptSurfaceFactory,
    openRoute: (options) => new ChatGptRoute(options),
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
  }));
}
let taskRoutesCache: ReturnType<typeof createTaskRoutes<ChatGptRoute>> | null =
  null;

function taskSurface() {
  return (taskSurfaceCache ??= createTaskSurface<ProductTaskCommandResult>({
    currentWindow: () => window,
    demoMode,
    channels,
    desktopAdmission,
    liveTaskRegistry,
    liveTaskRoutes,
    taskSurfaceFailures,
    parseResult: (candidate) => ProductTaskCommandResultSchema.parse(candidate),
    persistLiveTaskState,
    publishTaskSurfaceStatus,
    applyLayout,
    focusForLayoutAfterRendererCommit,
  }));
}
let taskSurfaceCache: ReturnType<
  typeof createTaskSurface<ProductTaskCommandResult>
> | null = null;

function chatGptSession() {
  return (chatGptSessionCache ??=
    createChatGptSession<ProductConfigurationResult>({
      chatGptConversationStore: () => chatGptConversationStore,
      setChatGptConversationStore: (value) => {
        chatGptConversationStore = value;
      },
      chatGptConversation: () => chatGptConversation,
      setChatGptConversation: (value) => {
        chatGptConversation = value;
      },
      chatGptRoute: () => chatGptRoute,
      goReadonlyConversation: () => goReadonlyConversation,
      directChatStart: () => directChatStart,
      chatGptTaskJournal: () => chatGptTaskJournal,
      window: () => window,
      activeDesktopIdentity,
      buildIdentity,
      configurationFailure,
      showOpenDialog: (owner, options) => dialog.showOpenDialog(owner, options),
      env: process.env,
    }));
}
let chatGptSessionCache: ReturnType<
  typeof createChatGptSession<ProductConfigurationResult>
> | null = null;

function readonlyHost() {
  return (readonlyHostCache ??= createReadonlyHost({
    goChatStartupProfile: () => goChatStartupProfile,
    desktopGoCore: () => desktopGoCore,
    readonlyAccountConfirmations,
    readonlyDiscardAttempts,
    pendingChatGptReadonlyTask: () => pendingChatGptReadonlyTask,
    setPendingChatGptReadonlyTask: (value) => {
      pendingChatGptReadonlyTask = value;
    },
    discardPreparedChatGptTask,
  }));
}
let readonlyHostCache: ReturnType<typeof createReadonlyHost> | null = null;

function previewRuntime() {
  return (previewRuntimeCache ??= createPreviewRuntime<RuntimeReady>({
    desktopAdmission,
    ownedLocalRuntimes,
    runtimeStopping: () => runtimeStopping,
    setRuntimeStopping: (value) => {
      runtimeStopping = value;
    },
    setRuntime: (value) => {
      runtime = value;
    },
    setRuntimeState: (value) => {
      runtimeState = value;
    },
    setRuntimeError: (value) => {
      runtimeError = value;
    },
    setTaskCountsBeforeRuntimeExit: (value) => {
      taskCountsBeforeRuntimeExit = value;
    },
    installedUpdates,
    activeDesktopIdentity,
    demoMode,
    expectedTasks,
    readySchema,
    streamControllers,
    pendingComputer,
    taskSurfaceFailures,
    stopStreams,
    disposeTaskViews,
    publishRuntimeStatus,
    observeLocalRuntime,
    setTimeout,
    clearTimeout,
    env: process.env,
    argv: process.argv,
  }));
}
let previewRuntimeCache: ReturnType<
  typeof createPreviewRuntime<RuntimeReady>
> | null = null;

function taskCommands() {
  return (taskCommandsCache ??= createTaskCommands<ProductTaskCommandResult>({
    parseCommand: (value) => ProductTaskCommandSchema.safeParse(value),
    taskFailure,
    taskSuccess,
    desktopAdmission,
    demoMode,
    taskMutations,
    liveTaskRegistry,
    liveTaskRoutes,
    liveTaskConversationUrls,
    selectedTaskId: () => selectedTaskId,
    setSelectedTaskId: (value) => {
      selectedTaskId = value;
    },
    setSection: (value) => {
      section = value;
    },
    setShellOverlay: (value) => {
      shellOverlay = value;
    },
    setSetupOpen: (value) => {
      setupOpen = value;
    },
    liveTaskStore: () => liveTaskStore,
    setLiveTaskStore: (value) => {
      liveTaskStore = value;
    },
    productAgentEnabled: FAROL_BACKED_PRODUCT_AGENT_ENABLED,
    activeProductAgentSession: () => activeProductAgentSession,
    persistedProductAgentExpiry: () => persistedProductAgentExpiry,
    setPersistedProductAgentExpiry: (value) => {
      persistedProductAgentExpiry = value;
    },
    configuration: () => configuration,
    productAgentStore: () => productAgentStore,
    chatGptRoute: () => chatGptRoute,
    routeBTaskLifecycle,
    buildId: buildIdentity.buildId,
    randomUUID,
    now: () => Date.now(),
    applyLayout,
    publishLayout,
    publishTasksState,
    openLiveTaskSurface,
    persistLiveTaskState,
    surfaceLiveTaskPersistenceFailure,
    chatGptTaskAdmissionReady,
    createLiveChatGptRoute,
    pendingProductAgentTaskId,
    productAgentAssignmentBinding,
    productAgentAssignmentMatches,
    productAgentUnknownSummaryFromTask,
    persistProductAgentSummary,
    executeProductAgent,
    cancelProductAgentTask,
  }));
}
let taskCommandsCache: ReturnType<
  typeof createTaskCommands<ProductTaskCommandResult>
> | null = null;

function productAgentHost() {
  return (productAgentHostCache ??=
    createProductAgentHost<ProductTaskCommandResult>({
      taskFailure,
      taskSuccess,
      productAgentEnabled: FAROL_BACKED_PRODUCT_AGENT_ENABLED,
      farolBackedProductAgentRoute: () => farolBackedProductAgentRoute(),
      buildIdentity,
      configuration: () => configuration,
      productAgentStore: () => productAgentStore,
      liveTaskRegistry,
      taskMutations,
      authorityTransitions,
      activeProductAgentSession: () => activeProductAgentSession,
      setActiveProductAgentSession: (value) => {
        activeProductAgentSession = value;
      },
      persistedProductAgentExpiry: () => persistedProductAgentExpiry,
      setPersistedProductAgentExpiry: (value) => {
        persistedProductAgentExpiry = value;
      },
      persistLiveTaskState,
      publishTasksState,
      statePaths,
      nativeWorkspace,
      tempPath: () => app.getPath("temp"),
      codexHostRuntimeRoot,
      codexHostProcessHomePath,
      codexHostHomeOption,
      probeCodexHost,
      launchCodexAppServer,
      runProductAgentAssignment,
      CodexNativeAgentHost,
      CodexAgentWorkspaceProbe,
      PrivateAssignmentStore,
      CancelAgentAssignment,
      AcknowledgeAgentResult,
      randomUUID,
      clock: () => Date.now(),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => {
        clearTimeout(timer);
      },
    }));
}
let productAgentHostCache: ReturnType<
  typeof createProductAgentHost<ProductTaskCommandResult>
> | null = null;

function connectorCheck() {
  return (connectorCheckCache ??= createConnectorCheck({
    configuration: () => configuration,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    desktopGoCore: () => desktopGoCore,
    chatGptRoute: () => chatGptRoute,
    window: () => window,
    selectedTaskId: () => selectedTaskId,
    liveTaskRoutes,
    desktopAdmission,
    buildIdentity,
    randomUUID,
    connectorVerificationProof,
    statePaths,
    configurationFailure,
    embeddedBrowserEnabled,
    connectorAppVerificationAttemptExists,
    connectorConnection,
    currentConnectionStatus,
  }));
}
let connectorCheckCache: ReturnType<typeof createConnectorCheck> | null = null;

function connectorVerify() {
  return (connectorVerifyCache ??= createConnectorVerify({
    configuration: () => configuration,
    chatGptRoute: () => chatGptRoute,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    desktopGoCore: () => desktopGoCore,
    window: () => window,
    selectedTaskId: () => selectedTaskId,
    desktopAdmission,
    buildIdentity,
    runtimeEnvironment,
    randomUUID,
    statePaths,
    configurationFailure,
    embeddedBrowserEnabled,
    chatGptTaskAdmissionReady,
    showMessageBox: (owner, options) => dialog.showMessageBox(owner, options),
    connectorCheck,
    connectorConnection,
    currentConnectionStatus,
    connectorVerificationProof,
    connectorAppVerificationAttemptExists,
    confirmSeparateAppVerificationAttempt,
    prepareConnectorAppVerificationAttempt,
    prepareConnectorCheckDocument,
    waitForConnectorAppReceipt,
  }));
}
let connectorVerifyCache: ReturnType<typeof createConnectorVerify> | null =
  null;

function devProof() {
  return (devProofCache ??= createDevProof({
    buildEnvironment,
    runtimeEnvironment,
    isolatedDevMcpProofAllowed,
    configuration: () => configuration,
    chatGptRoute: () => chatGptRoute,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    runtime: () => runtime,
    desktopAdmission,
    buildIdentity,
    statePaths,
    configurationFailure,
    configurationAdmission,
    codexAgentOperationActive,
    chatGptTaskAdmissionReady,
    measuredRootIdentity,
    workspaceDescriptor,
    nativeWorkspace,
    DEV_MCP_PROOF_ALLOWED_PATH,
    DEV_MCP_PROOF_DENIED_PATH,
    readDevMcpProofPreparation,
    writeDevMcpProofPreparation,
    createDevMcpProofFixture,
    claimDevMcpProofAttempt,
    readDevMcpProofReceipt,
  }));
}
let devProofCache: ReturnType<typeof createDevProof> | null = null;

// The owner-workspace read, list, inspect, file-pick and failure-mapping code
// lives in apps/desktop/configuration/files.ts; these wrappers keep the names
// every configuration factory already takes as ports. The composition of the
// verified workspace itself is `workspace-descriptor.ts` (S35-TA-4); what main
// supplies is each current owner, read at the moment it is needed.
function workspaceCommands() {
  return (workspaceCommandsCache ??= createWorkspaceCommands({
    configuration: () => configuration,
    configurationFailure,
    desktopGoCore: () => desktopGoCore,
    compiledGoCore: () => compiledGoCore,
    nativeWorkspace,
    window: () => window,
    showOpenDialog: (owner, options) => dialog.showOpenDialog(owner, options),
    env: process.env,
  }));
}
let workspaceCommandsCache: ReturnType<typeof createWorkspaceCommands> | null =
  null;

function verifiedProductWorkspace(
  workspaceId: string,
): VerifiedProductWorkspaceResult {
  return workspaceCommands().verifiedProductWorkspace(workspaceId);
}

function selectedWorkspaceFile(
  workspace: ApprovedProductWorkspace,
  labels: Readonly<{ title: string; buttonLabel: string }>,
): Promise<string | "cancelled" | "invalid"> {
  return workspaceCommands().selectedWorkspaceFile(workspace, labels);
}

function workspaceReadFailure(code: string): ProductConfigurationResult {
  return workspaceCommands().workspaceReadFailure(code);
}

function codexAgentCheckWorkspace(
  settings: ProductSettings,
): ReadonlyWorkspace {
  return workspaceCommands().codexAgentCheckWorkspace(settings);
}

function inspectOwnerWorkspace(
  generation: number,
  workspace: Pick<ApprovedProductWorkspace, "workspaceId" | "root">,
  identity: WorkspaceRootIdentity | null,
  diagnosticAction: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  return workspaceCommands().inspectOwnerWorkspace(
    generation,
    workspace,
    identity,
    diagnosticAction,
  );
}

function listOwnerWorkspace(
  generation: number,
  workspace: Pick<ApprovedProductWorkspace, "workspaceId" | "root">,
  savedIdentity: unknown,
  relativePath: string,
  diagnosticAction?: string,
): Promise<
  | { ok: true; entries: string[]; truncated: boolean }
  | { ok: false; code: string }
> {
  return workspaceCommands().listOwnerWorkspace(
    generation,
    workspace,
    savedIdentity,
    relativePath,
    diagnosticAction,
  );
}

function workspaceCommandFailure(code: string): ProductConfigurationResult {
  return workspaceCommands().workspaceCommandFailure(code);
}

function workspaceMutationFailure(code: string): ProductConfigurationResult {
  return workspaceCommands().workspaceMutationFailure(code);
}

function goWorkspaceEditResult(
  delivery: SettingsDeliveryResult,
  redelivered: boolean,
): ProductConfigurationResult {
  return workspaceCommands().goWorkspaceEditResult(delivery, redelivered);
}

const connectorSetupReplies = new ConnectorSetupReplies();

let operationsLog: OperationsStore | undefined;
let processAuditCollector: ProcessAuditCollector | undefined;
let processAuditObserver: ProcessAuditObserver | undefined;
function operationsStore(): OperationsStore {
  return (operationsLog ??= new OperationsStore(statePaths().operations));
}
function configureProduct(value: unknown): Promise<ProductConfigurationResult> {
  return configurationDispatch().configureProduct(value);
}

function configurationPipeline() {
  return (configurationPipelineCache ??= createConfigurationPipeline({
    configuration: () => configuration,
    desktopGoCore: () => desktopGoCore,
    connectorRunning: () => secureMcpConnectorRuntime?.isRunning() === true,
    connectorStartInFlight: () => connectorStartInFlight,
    desktopAdmission,
    authorityTransitions,
    activeAuthorityChangeKind: () => activeAuthorityChangeKind,
    setActiveAuthorityChangeKind: (value) => {
      activeAuthorityChangeKind = value;
    },
    codexAgentOperationActive,
    configurationFailure,
    computerMcpLifecycle,
    configureDrainedWorkspaceChange,
    deliverConfigurationReply,
    configureAdmittedProduct,
    transitionRefusal,
  }));
}
let configurationPipelineCache: ReturnType<
  typeof createConfigurationPipeline
> | null = null;

function configurationDrain() {
  return (configurationDrainCache ??= createConfigurationDrain({
    configuration: () => configuration,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    desktopGoCore: () => desktopGoCore,
    desktopAdmission,
    connectorStartInFlight: () => connectorStartInFlight,
    transitionRefusal,
    configurationFailure,
    authorityTransitions,
    activeAuthorityChangeKind: () => activeAuthorityChangeKind,
    setActiveAuthorityChangeKind: (value) => {
      activeAuthorityChangeKind = value;
    },
    codexAgentOperationActive,
    computerMcpLifecycle,
    stopAndConfirmComputerMcp,
    savedChatBridgeRuntime: () => bridge.saved.get(),
    statePaths,
    configureAdmittedProduct,
    ownerComputerConsentDigest,
    connectorRuntimeUncertain,
    clearAndConfirmOriginalConnectorVerificationReceipt,
  }));
}
let configurationDrainCache: ReturnType<
  typeof createConfigurationDrain
> | null = null;

function configurationComputer() {
  return (configurationComputerCache ??= createConfigurationComputer({
    configuration: () => configuration,
    codexAgentOperationActive,
    configurationFailure,
    getPendingWorkspacePick: () => pendingWorkspacePick,
    setPendingWorkspacePick: (value) => {
      pendingWorkspacePick = value;
    },
    selectedWorkspace,
    measuredRootIdentity,
    inspectOwnerWorkspace,
    buildIdentity: () => buildIdentity,
    workspaceReadFailure,
    desktopAdmission,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    runtime: () => runtime,
    verifiedProductWorkspace,
    listOwnerWorkspace,
    desktopGoCore: () => desktopGoCore,
    compiledGoCore: () => compiledGoCore,
    discoverWorkspaceGitMetadata,
    verificationWorkspaceAction,
    getPendingWorkspaceEdit: () => pendingWorkspaceEdit,
    setPendingWorkspaceEdit: (value) => {
      pendingWorkspaceEdit = value;
    },
    selectedWorkspaceFile,
    goWorkspaceEditResult,
    statePaths,
    workspaceMutationFailure,
    workspaceCommandFailure,
  }));
}
let configurationComputerCache: ReturnType<
  typeof createConfigurationComputer
> | null = null;

function configurationConnector() {
  return (configurationConnectorCache ??= createConfigurationConnector({
    authorityTransitions,
    setActiveAuthorityChangeKind: (value) => {
      activeAuthorityChangeKind = value;
    },
    observeConnectorStart: (work) =>
      connectorStart().observeConnectorStart(work),
    startAdmittedSecureMcpConnector: (...args) =>
      connectorStart().startAdmittedSecureMcpConnector(...args),
    configureAdmittedProduct,
    deliverConfigurationReply,
    configuration: () => configuration,
    connectorCredentialStore: () => connectorCredentialStore,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    desktopGoCore: () => desktopGoCore,
    buildIdentity: () => buildIdentity,
    desktopAdmission,
    configurationFailure,
    selectedTunnelClientExecutable,
    e2eTunnelClientExecutable,
    directory,
    verifyTunnelClientExecutable,
    startSecureMcpConnector: (...args) =>
      connectorStart().startSecureMcpConnector(...args),
    checkSecureMcpAttachment: (...args) =>
      connectorCheck().checkSecureMcpAttachment(...args),
    verifySecureMcpApp,
    recordConnectorRuntime: (...args) =>
      connectorStart().recordConnectorRuntime(...args),
    stopAndConfirmComputerMcp,
    statePaths,
    clearConnectorVerificationReceipt,
    captureConnectorStop,
    ownerStoppedCurrent,
    completedOwnerStop,
    observedConnectorHealth,
    connectorConnection,
    currentConnectionStatus,
  }));
}
let configurationConnectorCache: ReturnType<
  typeof createConfigurationConnector
> | null = null;

function configurationHost() {
  return (configurationHostCache ??= createConfigurationHost({
    configuration: () => configuration,
    desktopGoCore: () => desktopGoCore,
    compiledGoCore: () => compiledGoCore,
    routeBRuntime: () => contextHost.routeB.get(),
    activeCodexAgentCheck: () => activeCodexAgentCheck,
    setActiveCodexAgentCheck: (value) => {
      activeCodexAgentCheck = value;
    },
    activeProductAgentSession: () => activeProductAgentSession,
    pendingProductAgentTaskId,
    hostCheckClients,
    buildIdentity: () => buildIdentity,
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
    tempPath: () => app.getPath("temp"),
    ROUTE_B_MODEL,
    SharedCodexProxyHost,
    ReadCodexModelCatalogue,
    PhysicalCodexHandoffAuthority,
    exactProject,
    CodexNativeAgentHost,
    CodexAgentWorkspaceProbe,
    PrivateAssignmentStore,
    fileSystem: { chmod, lstat, mkdtemp, realpath, rm },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
  }));
}
let configurationHostCache: ReturnType<typeof createConfigurationHost> | null =
  null;

function configurationModel() {
  return (configurationModelCache ??= createConfigurationModel({
    configuration: () => configuration,
    modelLifecycle: () => modelLifecycle,
    configurationFailure,
    farolModelProviderSpec,
    farolModelCodexConfigPath,
    farolModelCodexHostPresence,
    previewFarolModelConfigBlock,
    previewFarolModelProviderSelection,
    applyFarolModelConfigBlock,
    applyFarolModelProviderSelection,
    rollbackFarolModelConfigBlock,
    rollbackFarolModelProviderSelection,
  }));
}
let configurationModelCache: ReturnType<
  typeof createConfigurationModel
> | null = null;

function configurationSupport() {
  return (configurationSupportCache ??= createConfigurationSupport({
    configuration: () => configuration,
    configurationFailure,
    openExternal: (url) => shell.openExternal(url),
    selectedSupportExportTarget,
    productTasksState,
    operationsStore,
    writeSupportExport,
    buildIdentity,
    runtimeState: () => runtimeState,
    runtimeError: () => runtimeError,
    runtime: () => runtime,
    productAgentCapabilityAvailable,
    routeBRuntime: () => contextHost.routeB.get(),
    taskCountsBeforeRuntimeExit: () => taskCountsBeforeRuntimeExit,
    streamControllers,
    pendingComputer,
    taskSurfaceFailures,
    chatGptRoute: () => chatGptRoute,
    setupSignInCheck: () => setupSignInCheck,
    desktopAdmission,
    activeAuthorityChangeKind: () => activeAuthorityChangeKind,
  }));
}
let configurationSupportCache: ReturnType<
  typeof createConfigurationSupport
> | null = null;

function configurationDeep() {
  return (configurationDeepCache ??= createConfigurationDeep({
    configuration: () => configuration,
    desktopGoCore: () => desktopGoCore,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    chatGptRoute: () => chatGptRoute,
    liveTaskRoutes,
    selectedTaskId: () => selectedTaskId,
    section: () => section,
    shellOverlay: () => shellOverlay,
    browserHomeSurfaceOpen: () => browserHomeSurfaceOpen,
    setBrowserHomeSurfaceOpen: (value) => {
      browserHomeSurfaceOpen = value;
    },
    deepTestRecoveryReady: () => deepTestRecoveryReady,
    setDeepTestRecoveryReady: (value) => {
      deepTestRecoveryReady = value;
    },
    recoverableDeepTests: () => recoverableDeepTests,
    setRecoverableDeepTests: (value) => {
      recoverableDeepTests = value;
    },
    pendingChatGptReadonlyTask: () => pendingChatGptReadonlyTask,
    pendingChatGptAttachmentTask: () => pendingChatGptAttachmentTask,
    recoverableChatGptTask: () => recoverableChatGptTask,
    connectorStartInFlight: () => connectorStartInFlight,
    summaryFenceRecovery: () => contextHost.recovery.get(),
    desktopAdmission,
    liveTaskRegistry,
    buildIdentity,
    statePaths,
    configurationFailure,
    chatGptConversationAdmissionFailure,
    currentSurfaceLayout,
    connectorRuntimeUncertain,
    computerConnectorAdmission,
    currentConnectorAttachment,
    selectedConnectorApp,
    connectorWorkspaceSelection,
    connectorAppBindingCurrent,
  }));
}
let configurationDeepCache: ReturnType<typeof createConfigurationDeep> | null =
  null;

function configurationChatgpt() {
  return (configurationChatgptCache ??= createConfigurationChatgpt({
    configuration: () => configuration,
    chatGptRoute: () => chatGptRoute,
    chatGptE2eOrigin: () => chatGptE2eOrigin,
    desktopGoCore: () => desktopGoCore,
    goChatStartupProfile: () => goChatStartupProfile,
    directChatStart: () => directChatStart,
    setDirectChatStart: (value) => {
      directChatStart = value;
    },
    goReadonlyConversation: () => goReadonlyConversation,
    setGoReadonlyConversation: (value) => {
      goReadonlyConversation = value;
    },
    pendingChatGptReadonlyTask: () => pendingChatGptReadonlyTask,
    setPendingChatGptReadonlyTask: (value) => {
      pendingChatGptReadonlyTask = value;
    },
    pendingChatGptAttachmentTask: () => pendingChatGptAttachmentTask,
    setPendingChatGptAttachmentTask: (value) => {
      pendingChatGptAttachmentTask = value;
    },
    recoverableChatGptTask: () => recoverableChatGptTask,
    setRecoverableChatGptTask: (value) => {
      recoverableChatGptTask = value;
    },
    recoverableChatGptObservationPersisted: () =>
      recoverableChatGptObservationPersisted,
    setRecoverableChatGptObservationPersisted: (value) => {
      recoverableChatGptObservationPersisted = value;
    },
    chatGptConversationStore: () => chatGptConversationStore,
    setChatGptConversation: (value) => {
      chatGptConversation = value;
    },
    chatGptTaskJournal: () => chatGptTaskJournal,
    chatGptSignInGeneration: () => chatGptSignInGeneration,
    setChatGptSignInGeneration: (value) => {
      chatGptSignInGeneration = value;
    },
    chatGptSignInOpenGeneration: () => chatGptSignInOpenGeneration,
    setChatGptSignInOpenGeneration: (value) => {
      chatGptSignInOpenGeneration = value;
    },
    setChatGptSignInOutcome: (value) => {
      chatGptSignInOutcome = value;
    },
    selectedTaskId: () => selectedTaskId,
    browserHomeSurfaceOpen: () => browserHomeSurfaceOpen,
    setBrowserHomeSurfaceOpen: (value) => {
      browserHomeSurfaceOpen = value;
    },
    setSetupSignInCheck: (value) => {
      setupSignInCheck = value;
    },
    attachmentStagingReady: () => attachmentStagingReady,
    setAttachmentStagingReady: (value) => {
      attachmentStagingReady = value;
    },
    desktopAdmission,
    chatGptSignInBlocked,
    liveTaskRoutes,
    liveTaskRegistry,
    readonlyAccountConfirmations,
    buildIdentity,
    activeDesktopIdentity,
    runtimeEnvironment,
    compiledGoCore,
    nativeWorkspace: {
      execute: async (request) => {
        const result = await nativeWorkspace.execute(request);
        if (!result.ok)
          return { ok: false, error: { code: result.error.code } };
        return result.value.kind === "workspace.text"
          ? {
              ok: true,
              value: {
                kind: "workspace.text",
                text: result.value.text,
                bytes: result.value.bytes,
              },
            }
          : { ok: true, value: { kind: "workspace.other" } };
      },
    },
    SIGN_IN_WINDOW_TITLE,
    statePaths,
    configurationFailure,
    embeddedBrowserEnabled,
    applyLayout,
    chatGptConversationContinuity,
    chatGptConversationAdmissionFailure,
    retainChatGptConversation,
    chatGptJournalObservation,
    chatGptAppPreSubmitObservation,
    chatGptAttachmentTaskPreview,
    chatGptReadonlyTaskPreview,
    attachmentStagingFailure,
    discardPreparedChatGptTask,
    discardPreparedReadonlyTask,
    withdrawGoReadonlyAdmission,
    readonlyAccountCurrent,
    selectedChatGptAttachmentPaths,
    selectedWorkspaceFile,
    workspaceReadFailure,
    captureChatStartupProfile,
    stageChatGptAttachments,
    verifyStagedChatGptAttachments,
    discardChatGptAttachments,
    ReadConversationClient,
    AccountObservationConfirmation,
    ReadAccountConfirmation,
  }));
}
let configurationChatgptCache: ReturnType<
  typeof createConfigurationChatgpt
> | null = null;

function configurationObserved() {
  return (configurationObservedCache ??= createConfigurationObserved({
    deepTestAcknowledgements,
    deepTestRequests,
    configureNewProductRequest,
    configurationFailure,
    cancelStartupConnectorResume: () => {
      startupConnectorResumeCancelled = true;
    },
    suppressConnectorTransportCurrent: () =>
      connectorTransportWatch.current?.suppressCurrent(),
    invalidateConnectorTransport: () =>
      connectorTransportWatch.current?.invalidate(),
    connectorSetupReplies,
    configureSaveAndConnect: (command) =>
      configurationConnector().configureSaveAndConnect(command),
    connectorSetupRefusal: (command, code) =>
      configurationConnector().connectorSetupRefusal(command, code),
    directChatStart: () => directChatStart,
    goReadonlyConversation: () => goReadonlyConversation,
    readonlyAccountCommands,
  }));
}
let configurationObservedCache: ReturnType<
  typeof createConfigurationObserved
> | null = null;

async function configureDrainedWorkspaceChange(
  command: WorkspaceConfigurationCommand,
): Promise<ProductConfigurationResult> {
  return configurationDrain().configureDrainedWorkspaceChange(command);
}

async function configureNewProductRequest(
  value: unknown,
): Promise<ProductConfigurationResult> {
  return configurationPipeline().configureNewProductRequest(value);
}

// The E2E reply fault: one process-wide budget of dropped replies, built once
// from the environment and lent to the dispatch by reference.
const configurationReplyFault = createConfigurationReplyFault(process.env);

function deliverConfigurationReply(
  commandKind: string,
  result: ProductConfigurationResult,
): ProductConfigurationResult | Promise<ProductConfigurationResult> {
  return configurationDispatch().deliverConfigurationReply(commandKind, result);
}

async function configureAdmittedProduct(
  command: ProductConfigurationCommand,
): Promise<ProductConfigurationResult> {
  return configurationDispatch().configureAdmittedProduct(command);
}

function configurationDispatch() {
  return (configurationDispatchCache ??= createConfigurationDispatch({
    configuration: () => configuration,
    configurationFailure,
    configureProductObserved: (value) =>
      configurationObserved().configureProductObserved(value),
    operationsStore,
    configurationReplyFault,
    connectorCheck: () => connectorCheck(),
    configurationDeep: () => configurationDeep(),
    configurationComputer: () => configurationComputer(),
    configurationChatgpt: () => configurationChatgpt(),
    configurationSupport: () => configurationSupport(),
    configurationConnector: () => configurationConnector(),
    devProof: () => devProof(),
    configurationHost: () => configurationHost(),
    configurationModel: () => configurationModel(),
  }));
}
let configurationDispatchCache: ReturnType<
  typeof createConfigurationDispatch
> | null = null;

function publishRuntimeStatus(): void {
  runtimeStatus().publishRuntimeStatus();
}

function desktopBrandImage() {
  return runtimeStatus().desktopBrandImage();
}

const requestAbout = aboutCommand({
  closed: () => desktopAdmission.closed(),
  openWindow: () =>
    containWindowOpenFailure(ensureWindow, recoverWindowOpenFailure),
  window: () => window,
  panel: () => (aboutPanel ??= new DesktopAboutPanel()),
  name: displayProductName,
  version: buildIdentity.version,
  builtAt: buildIdentity.builtAt,
  mode: windowMode,
  icon: () => desktopBrandImage().toDataURL(),
  place: () => selectedVisibleTestPlacement(ABOUT_PANEL_SIZE).bounds,
});

function requestUpdates(): void {
  if (desktopAdmission.closed()) return;
  void containWindowOpenFailure(async () => {
    await ensureWindow();
    if (desktopAdmission.closed() || !window || window.isDestroyed()) return;
    publishShellAction("open-updates", "update-command");
    window.webContents.focus();
  }, recoverWindowOpenFailure);
}

function requestSettings(): void {
  if (desktopAdmission.closed()) return;
  if (!window) return;
  publishShellAction("open-settings", "settings-command");
  window.webContents.focus();
}

function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenu({
        platform: process.platform,
        productName: displayProductName,
        sidebarShortcut: navigationShortcuts.sidebar,
        actions: {
          about: requestAbout,
          updates: requestUpdates,
          settings: requestSettings,
          toggleSidebar: requestSidebarToggle,
          quickSwitcher: requestQuickSwitcher,
        },
      }),
    ),
  );
}

function embeddedBrowserEnabled(): boolean {
  return embeddedBrowserSelected({
    environment: runtimeEnvironment,
    demoMode,
    legacySetupTestMode,
  });
}

function startRuntime(): Promise<void> {
  return previewRuntime().start();
}

function runtimeJson(
  pathname: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  return runtimeStatus().runtimeJson(pathname, method, body);
}

function contextFixture() {
  return (contextFixtureCache ??= createContextFixture({
    env: process.env,
    demoMode,
    liveTaskRegistry,
    contextHost,
    contextBinding,
    contextModel,
    buildHostCompactionHandoff,
  }));
}
let contextFixtureCache: ReturnType<typeof createContextFixture> | null = null;

function runContextFixtureControl(
  taskId: string,
  action: "compact-context-fixture" | "confirm-context-fixture",
): Promise<unknown> {
  return contextFixture().runContextFixtureControl(taskId, action);
}

function installIpc(): void {
  createIpc({
    ipcMain,
    window: () => window,
    updatesPanel,
    installedUpdates,
    desktopAdmission,
    windowMode,
    UPDATES_PANEL_SIZE,
    selectedVisibleTestPlacement,
    configuration: () => configuration,
    operationsStore,
    startupConnectionChecking: () => startupConnectionChecking,
    connectionAdmissionInProgress,
    runSelfTestCommand,
    desktopGoCore: () => desktopGoCore,
    installedUpdateCommandSchema: InstalledUpdateCommandSchema,
    bootstrap,
    runtimeJson,
    configureProduct,
    configurationFailure,
    readChatHistoryView,
    readRetiredRepliesView,
    runProductTaskCommand,
    taskFailure,
    setNavigationShortcuts: (value) => {
      navigationShortcuts = value;
    },
    installApplicationMenu,
    controlSchema,
    runContextFixtureControl,
    expectedTasks,
    runtime: () => runtime,
    taskSurfaceFailures,
    pendingComputer,
    section: () => section,
    setupOpen: () => setupOpen,
    shellOverlay: () => shellOverlay,
    selectedTaskId: () => selectedTaskId,
    chatGptRoute: () => chatGptRoute,
    liveTaskRoutes,
    applyRendererLayout,
  }).install();
}

let startupSplash: StartupSplash | null = null;
function closeStartupSplash(): void {
  const splash = startupSplash;
  startupSplash = null;
  splash?.close();
}

function nativeMenuBarEnabled(): boolean {
  return process.env.FAROL_E2E !== "1" && process.platform === "darwin";
}

function instance() {
  return (instanceCache ??= createInstance({
    app,
    stderr: process.stderr,
    desktopAdmission,
    launchIdentity,
    instanceRequest,
    primaryStartup,
    runtimeStopping: () => runtimeStopping,
    runtimeState: () => runtimeState,
    window: () => window,
    taskViewKinds,
    expectedTasks,
    ensureWindow,
    recoverWindowOpenFailure,
    writeInstanceAcknowledgement,
    waitForInstanceAcknowledgement,
    foreignAcknowledgementCount,
  }));
}
let instanceCache: ReturnType<typeof createInstance> | null = null;

function isPrimaryReady(): boolean {
  return instance().isPrimaryReady();
}

function stopRuntime(): void {
  runtimeStopping = true;
  stopStreams();
  pendingComputer.clear();
  taskSurfaceFailures.clear();
  for (const lifetime of ownedLocalRuntimes.keys()) lifetime.requestStop();
}

function disposeChatGptRoutes(): void {
  for (const route of [...managedChatGptRoutes]) route.dispose();
  managedChatGptRoutes.clear();
  liveTaskRoutes.clear();
}

async function main(quitSignals: GracefulQuitSignals): Promise<void> {
  // First listener of the process, so startup and recovery Quits are traced
  // too. Observational: it never prevents, delays or changes a Quit.
  try {
    quitTrace = createQuitTrace({
      directory: statePaths().state,
      pid: process.pid,
    });
    app.prependListener("before-quit", () =>
      quitTrace?.record({ stage: "before-quit", during: quitTracePhase }),
    );
  } catch {
    quitTrace = null;
  }
  instance().listenForSecondInstance();
  const observeUpdateRelaunch = () =>
    waitForInstalledUpdateRelaunch({
      args: process.argv,
      directory,
      userData: app.getPath("userData"),
      build: buildIdentity,
      physicalFiles: rawFs,
      copyApp: (source, destination) =>
        rawFs.cp(source, destination, {
          recursive: true,
          force: false,
          errorOnExist: true,
          verbatimSymlinks: true,
          preserveTimestamps: true,
        }),
    });
  const stateRoot = statePaths().state;
  const startup = createStartup({
    app,
    stateRoot,
    compiledGoCore,
    installedUpdates,
    desktopAdmission,
    primaryInstanceLock: () => primaryInstanceLock,
    runtimeStopping: () => runtimeStopping,
    startupStage,
  });

  const previousHostAdmissionReady = await withInstalledStartupFence(
    process.argv,
    app.getPath("userData"),
    buildIdentity.buildId,
    observeUpdateRelaunch,
    startup.admit,
  );
  const freshStartup = startup.freshStartup();
  if (process.platform === "darwin") {
    app.dock?.setIcon(desktopBrandImage());
  }
  // Ordinary owner launch only: show a window at once while Go core,
  // settings, journals and task state start. Tests and background
  // launches keep their existing window policy.
  if (
    windowMode !== "hidden" &&
    !ownerBackgroundOnly &&
    process.env.FAROL_E2E !== "1"
  ) {
    try {
      startupSplash = openStartupSplash({
        title: displayWindowTitle,
        width: initialWindowSize.width,
        height: initialWindowSize.height,
        iconDataUrl: desktopBrandImage().toDataURL(),
        ...(windowMode === "secondary-visible"
          ? {
              bounds: selectedVisibleTestPlacement(initialWindowSize).bounds,
              inactive: true,
            }
          : {}),
      });
      app.once("before-quit", closeStartupSplash);
    } catch {
      startupSplash = null;
    }
  }
  // N03/D2: the run marker is this generation's first durable runtime obligation and the
  // last thing it removes — only after a quit whose drain was confirmed (see
  // the quit drain's `record` below and `run-marker.ts`). A promotion that
  // finds it decides between "still running" (a live pid on this boot) and
  // "stopped without confirming its drain" (a dead pid, or another boot)
  // instead of trusting the previous quit's clean receipt after a crash. A
  // marker that cannot be written fails startup like any other state-root
  // failure would: an unmarked generation is one whose crash would go
  // unnoticed.
  // The startup lease has been released before configuration and ordinary
  // admission take the same lease. No nested owner or second lock is used.
  try {
    await cleanupChatGptAttachmentStaging(statePaths().attachmentStaging);
  } catch {
    attachmentStagingReady = false;
  }
  configuration = createConfigurationService({
    root: statePaths().state,
    desktopGoCore: () => desktopGoCore,
    promotionLease: admissionLease(
      () => app.getPath("userData"),
      buildIdentity.buildId,
    ),
  });
  await runDesktopStartupBoundary("configuration", () =>
    configuration!.initialize(),
  );
  const { url: chatGptUrl, e2eOrigin: e2eChatGptOrigin } = selectChatGptHome(
    process.env,
  );
  chatGptHomeUrl = chatGptUrl;
  chatGptE2eOrigin = e2eChatGptOrigin;
  try {
    const snapshot = configuration.snapshot();
    goChatStartupProfile =
      snapshot.status === "ready"
        ? captureChatStartupProfile({
            environment: runtimeEnvironment,
            e2e: process.env.FAROL_E2E === "1",
            origin: chatGptE2eOrigin,
            tasks: snapshot.settings.tasks,
          })
        : null;
  } catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    goChatStartupProfile = null;
  }
  // Configuration faults remain observable in the recovery UI. Without the
  // configured Computer identity, do not provision or start a Go profile.
  // Selected Go operations still refuse when their host is unavailable.
  if (compiledGoCore !== null && configuration.snapshot().status === "ready") {
    const currentSettings = () => {
      const snapshot = configuration!.snapshot();
      if (snapshot.status !== "ready") throw new Error("SETTINGS_UNAVAILABLE");
      return snapshot.settings;
    };
    desktopGoCore = await runDesktopStartupBoundary("go-core", () =>
      startGoCore({
        startDesktopGoCore,
        operationsStore,
        compiledArtifact: compiledGoCore,
        compiledResources: compiledGoResources,
        compiledShell: compiledGoShell,
        runtimeEnvironment,
        directory,
        executablePath: () => process.execPath,
        realpathSync,
        freshStartup: () => freshStartup,
        previousHostAdmissionReady,
        computerMcpLifecycle,
        buildIdentity,
        installedUpdates,
        stateRoot,
        home: () => app.getPath("home"),
        settings: currentSettings,
        reportOwnedBackendLifecycle,
        reportQualificationObservation,
        browser: (context) =>
          createDesktopChatBrowser({
            context,
            partition: activeDesktopIdentity.chatGptPartition,
            // Public control profiles still require native qualification before a
            // production model may be admitted. The normal host owns this adapter;
            // a missing profile cannot select the legacy browser executor instead.
            driver: (lookup) =>
              new GoChatBrowserDriver({
                operations: operationsStore(),
                lookup,
                translations: goChatStartupProfile?.snapshot.translations ?? [],
                ...(goChatStartupProfile
                  ? { e2eOrigin: goChatStartupProfile.origin }
                  : {}),
              }),
            create: async (input) => {
              const initialUrl = chatWorkerInitialUrl(
                chatGptHomeUrl,
                input.target.mode === "owned-saved"
                  ? input.target.conversationId
                  : undefined,
              );
              const route = createManagedChatGptRoute({
                ...(goChatStartupProfile?.route ?? {}),
                homeUrl: chatGptHomeUrl,
                initialUrl,
                e2eOrigin: chatGptE2eOrigin,
                parent: () => null,
                windowPresentation: { mode: "hidden" },
                title: `ChatGPT · ${displayProductName}`,
              });
              const opened = await route.open();
              if (opened.status !== "opened")
                throw new BridgeError(
                  "unknown",
                  "host_chat_browser_open_unconfirmed",
                );
              return route.chatPhysical();
            },
          }),
      }),
    );
    try {
      await recordInterruptedCommand(
        desktopGoCore,
        operationsStore(),
        computerMcpLifecycle().hasInterruptedShellHistory,
      );
    } catch {
      // Observation failure cannot turn old uncertainty into a startup fence.
      console.warn("The interrupted command notice is unavailable.");
    }
    const auditCore = desktopGoCore;
    const auditContext = auditCore.historyContext;
    if (auditContext) {
      processAuditCollector = new ProcessAuditCollector(
        operationsStore(),
        Date.now,
        auditContext.backendGeneration,
      );
      processAuditObserver = new ProcessAuditObserver(
        processAuditCollector,
        () => operationsStore().snapshot(),
        auditCore.processAudit,
        () => desktopGoCore === auditCore,
      );
      processAuditObserver.start();
    }
    if (runtimeEnvironment === "dev")
      console.info(
        "FAROL_DEV_SHELL:" +
          JSON.stringify({
            schema: 1,
            buildId: buildIdentity.buildId,
            available: desktopGoCore.shellAvailable,
          }),
      );
    await runDesktopStartupBoundary("go-settings", () => {
      const settingsOwner = configuration!;
      const settingsCore = desktopGoCore!;
      settingsOwner.attachComputerAuthority(() => settingsCore.withdraw());
      settingsCore.connectSettingsStore((profileId) => {
        const store = settingsOwner.attachSettingsDeliveryStore({
          profileId,
          ownerId: "owner-desktop",
        });
        return {
          read: (input) => store.read(input.deadlineMillis),
          replace: (input) => store.replace(input.change, input.deadlineMillis),
          fence: () => {
            const observationWindow = window;
            const outcome = store.fence();
            if (
              configuration === settingsOwner &&
              desktopGoCore === settingsCore &&
              !desktopAdmission.closed() &&
              window === observationWindow &&
              observationWindow &&
              !observationWindow.isDestroyed()
            ) {
              try {
                observationWindow.webContents.send(
                  channels.configurationChanged,
                );
              } catch {
                // Renderer delivery must not replace the original fence outcome.
              }
            }
            return outcome;
          },
        };
      });
    });
  }
  productAgentStore = new PrivateProductAgentStore({
    root: statePaths().productAgentInputs,
  });
  connectorCredentialStore = new PrivateConnectorKeyStore({
    root: statePaths().secureMcpCredential,
  });
  secureMcpConnectorRuntime = new SecureMcpConnectorRuntime(
    {
      root: statePaths().secureMcpConnector,
      homePath: await codexHostProcessHomePath(),
      tempPath: app.getPath("temp"),
      electronPath: installedUpdates.resources().executable,
      recheckExecution: installedUpdates.resources().recheck,
    },
    { onLifecycleObservation: reportOwnedBackendLifecycle },
  );
  // Starts with the app, on the persisted port, and never autospawns a
  // host: see Decisions.md N04, item 1. The real chat-turn route (packet
  // N04c) is the already-running Route B provider: `routeBModelTurnHandler`
  // reads `routeBRuntime` at call time (it starts after this endpoint does,
  // via `contextHost.initializeRouteBRuntime()` below, and can also close before it), so
  // a request before start or after close still answers
  // FAROL_MODEL_ROUTE_UNAVAILABLE, never silently dropped or fabricated.
  // The one exception is this exact E2E seam: with FAROL_E2E=1 *and*
  // FAROL_MODEL_E2E_SYNTHETIC_REPLY set, requests get a synthetic
  // completed reply instead — proof that the "connected" indicator only
  // lights up once a request is actually served, with no real Codex or
  // ChatGPT account involved. It never activates outside that double gate.
  const modelSyntheticReply =
    process.env.FAROL_E2E === "1"
      ? process.env.FAROL_MODEL_E2E_SYNTHETIC_REPLY
      : undefined;
  if (FAROL_MODEL_ENABLED) {
    modelLifecycle = new FarolModelLifecycle({
      stateRoot: statePaths().modelEndpoint,
      model: ROUTE_B_MODEL,
      handler: recordedModelTurn(
        operationsStore(),
        modelSyntheticReply
          ? syntheticModelTurnHandler(modelSyntheticReply)
          : routeBModelTurnHandler(
              () => contextHost.routeB.get()?.endpoint ?? null,
            ),
      ),
      compactionHandler: recordedCompaction(
        operationsStore(),
        routeBModelCompactionHandler(
          () => contextHost.routeB.get()?.endpoint ?? null,
        ),
      ),
    });
    try {
      await modelLifecycle.start();
    } catch {
      // Model failure does not abort unrelated app startup.
    }
  }
  try {
    const credential = await connectorCredentialStore.status();
    const snapshot = configuration.snapshot();
    if (
      snapshot.status === "ready" &&
      snapshot.settings.connectors.secureMcp.credential !== credential
    ) {
      await configuration.recordSecureMcpCredential(credential);
    }
  } catch {
    connectorCredentialStore = null;
  }
  try {
    const journal = new PrivateChatGptTaskJournal({
      root: statePaths().chatGptTaskJournal,
    });
    const retained = freshStartup
      ? await journal.load()
      : await journal.reconcileAfterRestart();
    // Fresh Go generations keep legacy history read-only, without redelivery
    // or a writer that could acknowledge or replace an earlier operation.
    chatGptTaskJournal = freshStartup && retained !== null ? null : journal;
    recoverableChatGptTask = freshStartup ? null : retained;
    if (!freshStartup && recoverableChatGptTask?.result) {
      const recorded = await configuration.recordChatGptObservation(
        chatGptJournalObservation(recoverableChatGptTask.result),
      );
      recoverableChatGptObservationPersisted = recorded.ok;
    }
  } catch {
    chatGptTaskJournal = null;
    recoverableChatGptTask = null;
    recoverableChatGptObservationPersisted = false;
  }
  let chatGptInitialUrl = chatGptUrl;
  try {
    recoverableDeepTests = await recoverDeepTestAttempts(
      statePaths().state,
      (work) => journalUnderPromotionLease(liveTaskRegistry, work),
    );
    deepTestRecoveryReady = true;
  } catch {
    deepTestRecoveryReady = false;
  }
  try {
    chatGptConversationStore = new PrivateChatGptConversationStore({
      root: statePaths().chatGptConversation,
    });
    chatGptConversation = await chatGptConversationStore.load();
    if (chatGptConversation?.state === "retained") {
      const conversationUrl = chatGptConversation.conversationUrl;
      if (conversationUrl === null) {
        throw new Error("CHATGPT_CONVERSATION_STATE_CORRUPT");
      }
      const canonical = canonicalChatGptConversationUrl(
        conversationUrl,
        e2eChatGptOrigin,
      );
      if (canonical !== conversationUrl) {
        throw new Error("CHATGPT_CONVERSATION_STATE_CORRUPT");
      }
      chatGptInitialUrl = canonical;
    }
  } catch {
    chatGptConversationStore = null;
    chatGptConversation = null;
  }
  chatGptRoute = createManagedChatGptRoute({
    homeUrl: chatGptUrl,
    initialUrl: chatGptInitialUrl,
    onNavigationHistoryChanged: (state) =>
      window?.webContents.send(channels.browserHistoryState, {
        taskId: "",
        ...state,
      }),
    e2eOrigin: e2eChatGptOrigin,
    parent: () => window,
    ...chatGptWindowPresentationOption(),
    ...(embeddedBrowserEnabled()
      ? { surfaceFactory: signInChatGptSurfaceFactory() }
      : {}),
    ...(process.env.FAROL_E2E === "1" && chatGptE2eOrigin !== null
      ? { taskTimeoutMs: 5_000, taskPollMs: 50 }
      : {}),
    onSignInOutcome: (status, diagnostic) => {
      chatGptSignInOutcome = diagnostic;
      const closing = chatGptSignInOpenGeneration;
      chatGptSignInOpenGeneration = null;
      void recordChatGptSignInOutcome(closing, status);
    },
    onSignInBlocked: (diagnostic) => {
      chatGptSignInBlocked.record(diagnostic);
    },
    ...(runtimeEnvironment === "dev"
      ? {
          onSignInStatusDiagnostic: (
            value: Readonly<{
              reason: string;
              opening: boolean;
              taskInFlight: boolean;
              loading: boolean;
              pageState: string | null;
            }>,
          ) =>
            console.error("FAROL_SIGN_IN_OBSERVATION:" + JSON.stringify(value)),
        }
      : {}),
    onLoadStateChanged: (state) => {
      if (!embeddedBrowserEnabled()) return;
      // Retained document readiness survives concealment and sign-in. Current
      // layout alone decides whether its native surface is visible or focused.
      applyLayout();
      window?.webContents.send(channels.browserRouteState, { state });
    },
  });
  await runDesktopStartupBoundary("task-state", async () => {
    await initializeLiveTaskState();
    await recoverProductAgentExpiry();
  });
  await runDesktopStartupBoundary("context", async () => {
    await contextHost.initializeCodexContextController();
    await contextHost.reconcileContextAfterRestart();
    await bridge.initializeCallerRelay();
    await bridge.initializeSavedChatBridge();
    await contextHost.initializeRouteBRuntime();
  });
  const configured = configuration.snapshot();
  const initialSettings =
    configured.status === "ready" ? configured.settings : null;
  const initialSetup = initialSetupPresentation({
    environment: activeDesktopIdentity.environment,
    demoMode,
    legacySetupTestMode,
    dismissed: initialSettings?.setup.journey.dismissed ?? false,
    currentStep: initialSettings?.setup.journey.currentStep ?? "chatgpt",
    openAtLaunch: initialSettings?.general.openAtLaunch ?? "home",
  });
  section = initialSetup.section;
  setupOpen = initialSetup.setupOpen;
  if (initialSettings) sidebarMode = initialSettings.general.sidebarDefault;
  if (startupDelayMs > 0) {
    startupStage("before-delay");
    await delay(startupDelayMs);
    startupStage("delay-complete");
  }
  installIpc();
  installApplicationMenu();
  // Hidden tests own no visible status item. Ordinary owner launch gets one.
  let disposeMenuBarOnQuit: (() => void) | null = null;
  if (nativeMenuBarEnabled()) {
    const disposeMenuBar = await runDesktopStartupBoundary("native-menu", () =>
      createMenuBar(
        {
          open: () => {
            void reopenWindow();
          },
          current: () => {
            const task = productTasksState().tasks.find(
              (item) => item.lifecycle === "running",
            );
            if (task) {
              selectedTaskId = task.taskId;
              section = "browser";
              shellOverlay = "none";
              applyLayout();
              publishLayout();
            }
            void reopenWindow();
          },
          updates: () => {
            requestUpdates();
          },
          quit: () => {
            app.quit();
          },
        },
        () => {
          const status = currentConnectionStatus();
          const capture = captureConnectionStatus();
          const snapshot = configuration?.snapshot();
          const attached =
            status.state === "recent_transport" &&
            capture?.kind === "running" &&
            connectionStatusCurrent(capture) &&
            snapshot?.status === "ready" &&
            !desktopAdmission.occupied("workspace-mutation") &&
            !connectorRuntimeUncertain(snapshot.settings) &&
            snapshot.settings.computer.pendingEdit === null &&
            !snapshot.settings.setup.computer.outcomeUnknown &&
            currentConnectorAttachment(
              snapshot.settings,
              buildIdentity.buildId,
            ) !== null;
          return {
            label: "Farol · " + status.label,
            icon: menuBarIconState(status.state, attached),
            current:
              productTasksState().tasks.find(
                (task) => task.lifecycle === "running",
              )?.label ?? null,
          };
        },
      ),
    );
    disposeMenuBarOnQuit = disposeMenuBar;
    app.once("will-quit", disposeMenuBar);
  }
  await runDesktopStartupBoundary("local-runtime", startRuntime);
  await runDesktopStartupBoundary("main-window", ensureWindow);
  // Warm the retained browser in its isolated profile while Setup is visible.
  // The existing layout owns visibility; this never signs in or submits a turn.
  if (embeddedBrowserEnabled()) void chatGptRoute?.preload().catch(() => {});
  screen.on("display-added", reconcileVisibleTestDisplay);
  screen.on("display-removed", reconcileVisibleTestDisplay);
  screen.on("display-metrics-changed", reconcileVisibleTestDisplay);
  app.on("activate", reopenWindow);
  // Quit waits, up to one deadline, for every owned child to confirm it
  // stopped, then quits for real; what did not confirm is recorded instead
  // of being reported as drained.
  const quitProgress = createQuitProgressWindow({
    deadlineMs: QUIT_DRAIN_DEADLINE_MS,
    visible: () => windowMode !== "hidden",
    ...(windowMode === "secondary-visible"
      ? {
          placement: () =>
            selectedVisibleTestPlacement({ width: 380, height: 220 }).bounds,
        }
      : {}),
  });
  const quitDrain = createQuitDrain({
    deadlineMs: QUIT_DRAIN_DEADLINE_MS,
    observe: (stage) => {
      quitTrace?.record(stage);
      quitProgress.observe(stage);
    },
    // Latched once, after the attempt is claimed and before the first
    // synchronous preparation step: the updater's effect fence and every
    // closer then see Quit in progress. A throwing step is an unconfirmed
    // stop, never a skipped drain.
    onClaim: [
      { name: "admission", run: () => desktopAdmission.beginQuit() },
      {
        name: "connector-resume",
        run: () => {
          startupConnectorResumeCancelled = true;
        },
      },
      {
        name: "connector-start",
        run: () => connectorStartCancellation?.abort(),
      },
      { name: "process-audit", run: () => processAuditObserver?.stop() },
      {
        name: "transport-watch",
        run: () => connectorTransportWatch.current?.close(),
      },
      {
        name: "transport-timer",
        run: () => {
          if (connectorTransportTimer.current)
            clearInterval(connectorTransportTimer.current);
        },
      },
      { name: "connection", run: () => connectorConnection.close() },
      {
        name: "e2e-observer",
        run: () => {
          if (isolatedE2EHome !== undefined)
            process.removeAllListeners("farol-e2e-observe-connection");
        },
      },
      {
        name: "status-timer",
        run: () => {
          if (connectorStatusTimer.current)
            clearInterval(connectorStatusTimer.current);
        },
      },
      { name: "update-timer", run: () => installedUpdates.stopTimer() },
    ],
    preparationMs: QUIT_PREPARATION_MS,
    recordReserveMs: QUIT_RECORD_RESERVE_MS,
    prepare: installedUpdates.quitPreparation.prepare,
    // The receipt first, then — only for a confirmed drain — the run marker
    // written at start (N03/D2). An undrained quit, or a receipt that could
    // not be written, leaves the marker in place, and the next promotion
    // reads that as a stop that never confirmed, never as a clean quit.
    record: async (receipt) => {
      // Child close observers have settled. Flush their final metadata before
      // real Quit can truncate the asynchronous writer, inside the existing
      // absolute recording deadline. Logging supplies no child-drain authority.
      if (operationsLog) {
        let flushed = false;
        try {
          if (
            processAuditCollector &&
            !(await processAuditCollector.drain(QUIT_RECORD_RESERVE_MS / 4))
          ) {
            try {
              console.warn("FAROL_PROCESS_AUDIT_DRAIN_UNCONFIRMED");
            } catch {
              // Diagnostics cannot prevent the remaining journal flush.
            }
          }
        } catch {
          // An unavailable audit observer must not suppress the journal flush.
        }
        try {
          // Reserve half of Quit's existing recording budget for final metadata.
          // A populated Activity journal can need more than 250 ms to fsync and
          // prune; a stalled writer still times out before the receipt reserve.
          flushed = await operationsLog.shutdown(QUIT_RECORD_RESERVE_MS / 2);
        } catch {
          // Preserve the original child-drain result even on journal failure.
        }
        if (!flushed) {
          try {
            console.warn("FAROL_OPERATIONS_LOG_FLUSH_UNCONFIRMED");
          } catch {
            // A closed diagnostic sink cannot suppress the Quit receipt.
          }
        }
      }
      await recordQuitReceipt(receipt);
      quitDrained = receipt.drained;
      if (receipt.drained) {
        try {
          const marker = await removeRunMarker(statePaths().state, process.pid);
          quitTrace?.record({
            stage: "marker",
            result: marker?.removed === true ? "removed" : "kept",
          });
        } catch (error) {
          quitTrace?.record({ stage: "marker", result: "failed" });
          throw error;
        }
      } else {
        quitTrace?.record({ stage: "marker", result: "kept" });
      }
    },
    // QuitDrain has already waited for owned children and recorded the result.
    // A second soft Quit can remain held by Electron windows/native handlers;
    // finish this exact attempt without reopening the drain or another update.
    quit: () => {
      try {
        // app.exit skips will-quit; release the owned tray explicitly. The
        // progress window is destroyed by the terminal exit itself.
        disposeMenuBarOnQuit?.();
      } finally {
        if (quitDrained) announceDrainedQuit();
        app.exit(0);
      }
    },
    collect: (context) => {
      const closers: OwnedCloser[] = [
        {
          name: "installed-updater",
          close: () => installedUpdates.close(),
        },
      ];
      const attachmentTask = pendingChatGptAttachmentTask;
      pendingChatGptAttachmentTask = null;
      if (attachmentTask) {
        void discardChatGptAttachments(
          statePaths().attachmentStaging,
          attachmentTask.operationId,
        );
      }
      const agentCheck = activeCodexAgentCheck;
      activeCodexAgentCheck = null;
      agentCheck?.host.dispose();
      if (agentCheck) {
        closers.push({
          name: "agent-check",
          close: () => agentCheck.client.close(),
        });
      }
      const productAgent = activeProductAgentSession;
      activeProductAgentSession = null;
      if (persistedProductAgentExpiry) {
        clearTimeout(persistedProductAgentExpiry.timer);
        persistedProductAgentExpiry = null;
      }
      if (productAgent?.expiryTimer) clearTimeout(productAgent.expiryTimer);
      productAgent?.host.dispose();
      if (productAgent) {
        closers.push({
          name: "product-agent",
          close: () => productAgent.client.close(),
        });
      }
      for (const client of hostCheckClients) {
        closers.push({ name: "host-check", close: () => client.close() });
      }
      const connector = secureMcpConnectorRuntime;
      const core = desktopGoCore;
      const savedChat = bridge.saved.get();
      const quitStartDeadlineAt =
        connector && (connectorStartInFlight || startupConnectionChecking)
          ? Math.min(
              context.deadlineAt,
              Date.now() + CONNECTOR_START_QUIT_BUDGET_MS,
            )
          : undefined;
      connectorStartCancellation?.abort();
      let beforeCore: OwnedCloser | null = null;
      if (connector) {
        const inFlightStart = connectorStartInFlight;
        beforeCore = {
          name: "connector",
          close: async () => {
            try {
              await stopAndConfirmComputerMcp(
                connector,
                inFlightStart,
                core,
                savedChat,
                undefined,
                undefined,
                quitStartDeadlineAt,
              );
            } finally {
              // Even an unconfirmed MCP drain must close account admission.
              // close() waits for already admitted work; it does not cancel Send
              // or turn the rejected connector close into a confirmed drain.
              if (savedChat) {
                await savedChat.close();
                if (bridge.saved.get() === savedChat) bridge.saved.set(null);
              }
            }
          },
        };
      } else if (savedChat) {
        bridge.saved.set(null);
        beforeCore = {
          name: "saved-chat-bridge",
          close: () => savedChat.close(),
        };
      }
      closers.push(
        ...goCoreQuitClosers(
          beforeCore,
          core
            ? () =>
                observeOperation(
                  operationsStore(),
                  { source: "You", kind: "hub.stop", target: {} },
                  () => core.close(),
                )
            : null,
          () => Date.now() < context.deadlineAt,
          quitStartDeadlineAt,
        ),
      );
      const model = modelLifecycle;
      modelLifecycle = null;
      if (model) {
        closers.push({ name: "model-endpoint", close: () => model.stop() });
      }
      const routeB = contextHost.routeB.get();
      contextHost.routeB.set(null);
      if (routeB)
        closers.push({ name: "route-b", close: () => routeB.close() });
      const relay = bridge.relay.get();
      bridge.relay.set(null);
      if (relay)
        closers.push({ name: "caller-relay", close: () => relay.close() });
      disposeChatGptRoutes();
      disposeTaskViews("runtime");
      for (const [lifetime, name] of ownedLocalRuntimes) {
        closers.push({ name, close: () => lifetime.close() });
      }
      stopRuntime();
      return closers;
    },
  });
  // The pre-drain steps run once as the drain's claim steps, before
  // preparation can wait (see onClaim above). Abort is idempotent;
  // re-entrant Quit cannot create a new start, Stop, drain or cancellation.
  app.on("before-quit", (event) => quitDrain.onBeforeQuit(event));
  quitTracePhase = "running";
  app.on("window-all-closed", () => {
    if (windowAllClosedAction(process.platform) === "quit") app.quit();
  });
  quitSignals.ready();
  void installedUpdates.initialize();
  // A reboot can renumber the startup volume; with path-bound approval that no
  // longer refuses calls, so the connector resumes normally. A folder that is
  // gone has its check withdrawn first; if that withdrawal fails, do not
  // resume at all.
  const driftSettled = await withdrawDriftedWorkspaceChecksAtLaunch();
  const beforeConnectorResume = configuration.snapshot();
  void resumeComputerConnector(
    {
      environment: runtimeEnvironment,
      buildEnvironment,
      buildId: buildIdentity.buildId,
      previousRunClean: previousHostAdmissionReady,
      snapshot: beforeConnectorResume,
    },
    {
      current: () => configuration!.snapshot(),
      mayContinue: () =>
        driftSettled &&
        !startupConnectorResumeCancelled &&
        !desktopAdmission.closed(),
      // The normal command retains authority reservation, physical-root and
      // Go inspection checks. No synthetic verification receipt is written.
      verifyWorkspace: (workspaceId) =>
        configureProduct({ kind: "computer.verify-workspace", workspaceId }),
      start: () => connectorStart().startSecureMcpConnector(false, true),
    },
  )
    .then(
      (status) => {
        startupStage(
          status === "started"
            ? "connector-resumed"
            : status === "skipped"
              ? "connector-resume-skipped"
              : "connector-resume-refused",
        );
        if (!desktopAdmission.quitInProgress && window && !window.isDestroyed())
          window.webContents.send(channels.configurationChanged);
        startConnectorTransportWatch();
        // Restore only the local connection. ChatGPT verification sends are
        // explicit owner actions; a routine restart never repeats onboarding.
        return undefined;
      },
      () => {
        startupStage("connector-resume-failed");
        startConnectorTransportWatch();
      },
    )
    .finally(() => {
      startupConnectionChecking = false;
      if (!desktopAdmission.quitInProgress && window && !window.isDestroyed())
        window.webContents.send(channels.configurationChanged);
    });
}

const primaryInstanceLock = app.requestSingleInstanceLock(instanceRequest);
startupStage(primaryInstanceLock ? "lock-primary" : "lock-secondary");
if (
  devReopenPrimaryRefused(runtimeEnvironment, process.argv, primaryInstanceLock)
) {
  instance().refuseDevReopen();
} else if (!primaryInstanceLock) {
  instance().settleSecondInstance();
} else {
  const quitSignals = createGracefulQuitSignals({
    signals: process,
    requestQuit: () => app.quit(),
    isQuitting: () => desktopAdmission.quitInProgress,
    observe: (signal, ignored) =>
      quitTrace?.record({ stage: "signal", signal, ignored }),
  });
  const initialization = main(quitSignals);
  const readiness = initialization.then(() => {
    if (!isPrimaryReady()) throw new Error("PRIMARY_STARTUP_INCOMPLETE");
  });
  primaryStartup.begin(readiness);
  void initialization
    .then(() => {
      if (isPrimaryReady()) {
        try {
          publishManualInstallStartupProof(
            process.argv,
            buildIdentity,
            process.pid,
          );
        } catch {
          process.stderr.write("INSTALL_STARTUP_PROOF_UNCONFIRMED\n");
        }
      }
      closeStartupSplash();
      startupStage("startup-complete");
      process.stderr.write(
        `${secondInstanceResultPrefix}${isPrimaryReady() ? "primary-started" : "reopen-failed"}\n`,
      );
    })
    .catch(async (error: unknown) => {
      closeStartupSplash();
      try {
        await desktopGoCore?.abortStartup();
      } catch {
        error = new Error("GO_CORE_STARTUP_CLEANUP_UNCONFIRMED");
      }
      terminateDesktopStartup(error, runtimeEnvironment, {
        write: (message) => process.stderr.write(message),
        exit: (code) => app.exit(code),
        // A recipient who just opened the app sees nothing else: this is the
        // only window-less surface Electron allows before ready. It is modal,
        // so a non-interactive launch never gets it and exits at once.
        ...(startupNoticeAllowed(process.env)
          ? {
              notify: (title: string, message: string) =>
                dialog.showErrorBox(title, message),
            }
          : {}),
      });
    });
}
