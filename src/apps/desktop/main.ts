import "../../../apps/desktop/bridge/e2e-window-bootstrap.ts";
import {
  createInstalledUpdateHost,
  withInstalledStartupFence,
} from "../../../apps/desktop/update/host";
import { UPDATE_IDLE_CHECK_MS } from "../../modules/release/app/installed-updater";
import { DesktopAdmission } from "../../../apps/desktop/host/admission";
import { mainWindow } from "../../../apps/desktop/window/main";
import { taskSurfaces } from "../../../apps/desktop/window/surface";
import { guardDiagnosticPipes } from "./diagnostic-pipes";
import { openStartupSplash, type StartupSplash } from "./startup-splash";
import { preventEmbeddedWindowDrag } from "./embedded-web-drag";
import { separateAppVerificationScopeCurrent } from "../../pkg/product-settings/separate-app-verification";
import { prepareConnectorCheckDocument } from "../../../apps/desktop/bridge/connector-check-readiness";
import type { SeparateAppVerificationScope } from "../../pkg/product-settings/contract";
import type { SeparateAppVerification } from "./connector-app-verification-attempt";
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
import {
  configurationOperation,
  configurationResultTarget,
} from "../../../apps/desktop/operations/configuration";
import { type SetupCompletionContext } from "../../ui/setup-completion";

import { startDesktopGoRecovery } from "../../../apps/desktop/recovery/core-host";
import { createStartupRecoverySession } from "../../../apps/desktop/recovery/session";
import { beginStartupMaintenanceAttempt } from "../../../apps/desktop/recovery/receipt";
import { preserveFreshStartHistory } from "../../../apps/desktop/recovery/fresh-admission";
import { runStartupPreservedMaintenance } from "../../../apps/desktop/recovery/maintenance";
import {
  openStartupRecoveryWindow,
  type StartupRecoveryWindow,
} from "../../../apps/desktop/recovery/host";
import {
  ABOUT_PANEL_SIZE,
  DesktopAboutPanel,
} from "../../../apps/desktop/about-panel";
import {
  DesktopUpdatesPanel,
  UPDATES_PANEL_SIZE,
} from "../../../apps/desktop/updates-panel";
import { updatesChannels } from "../../../apps/desktop/renderer/updates/contract";
import { connectorRuntimeUncertain } from "../../pkg/product-settings/connector-uncertainty";

import { connectorWorkspaceSelection } from "../../pkg/product-settings/connector-workspace-selection";
import { connectorVerificationProof } from "./connector-verification-proof";
import { ConnectorSetupReplies } from "../../../apps/desktop/connector-setup-host";
import {
  startDesktopGoCore,
  type DesktopGoCore,
} from "../../../apps/desktop/go-core-host";
import {
  maintenanceFailureCode,
  type MaintenanceObservation,
} from "../../../apps/desktop/recovery/diagnostics";
import { goCoreQuitClosers } from "../../../apps/desktop/go-core-quit-closers";
import type {
  ChatComputerAdmissionResponse,
  SettingsDeliveryResult,
} from "../../../apps/desktop/bridge/wire";
import {
  connectorAppBindingCurrent,
  createConnectorCheck,
  type ConnectorAppVerificationBinding,
} from "../../../apps/desktop/connector/check";
import {
  createConnectorStart,
  reportConnectorTransport,
} from "../../../apps/desktop/connector/start";
import {
  createProductAgentHost,
  type ProductAgentSession,
} from "../../../apps/desktop/task/agent";
import { createTaskCommands } from "../../../apps/desktop/task/command";
import { createChatGptSession } from "../../../apps/desktop/chat/session";
import { createTaskPersist } from "../../../apps/desktop/task/persist";
import { createTaskRoutes } from "../../../apps/desktop/task/route";
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
import {
  reportComputerCheckDiagnostic,
  refuseComputerSettingsList,
} from "./computer-check-diagnostic";
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
import { surfaceNavigation } from "../../../apps/desktop/shell/navigation";
import { desktopCoreArtifactRoot } from "../../../apps/desktop/dev-core-layout";
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
  type SaveDialogOptions,
} from "electron";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
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
import { spawn, type ChildProcess } from "node:child_process";
import {
  observeLocalRuntime,
  type LocalRuntimeLifetime,
} from "./local-runtime-lifetime";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { TUNNEL_CLIENT } from "../../../apps/desktop/tunnel-client-contract";
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
import { LiveTaskRegistry, type LiveTaskAdmission } from "./live-task-registry";
import { journalUnderPromotionLease } from "./chatgpt-journal-lease";
import {
  workspaceDescriptor,
  verifiedProductWorkspace as verifiedWorkspaceOf,
  type VerifiedProductWorkspaceResult,
} from "./workspace-descriptor";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
} from "./promotion-lease";
import {
  reconcileTaskContexts,
  toProductTaskContext,
} from "./context-task-state";
import {
  createCodexContextController,
  type CodexContextController,
} from "./codex-context-runtime";
import { channels } from "../../pkg/ipc/channels";
import {
  defaultNavigationShortcuts,
  parseNavigationShortcuts,
  type NavigationShortcuts,
} from "../../pkg/ipc/navigation-shortcuts";
import type { RuntimeStatus } from "../../pkg/ipc/runtime-status";
import {
  ProductConfigurationCommandSchema,
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
  acknowledgementFailureCode,
  createInstanceRequest,
  decideSecondInstance,
  secondInstanceRefusalMessage,
  foreignAcknowledgementCount,
  readBuildLaunchIdentity,
  sameLaunchIdentity,
  waitForInstanceAcknowledgement,
  writeInstanceAcknowledgement,
} from "./single-instance";
import {
  parseDevDisplay,
  parseAllowPrimaryDisplay,
  parseBuiltInDisplayOnly,
  parseSidecarDisplayOnly,
  parsePreviewWindowSize,
  parsePreviewWindowMode,
} from "./window-placement";
import {
  PrimaryStartup,
  devReopenPrimaryRefused,
  emitStartupStage,
  primaryStartupReady,
  previewStartupDelay,
  type StartupStage,
} from "./primary-startup";
import { readRuntimeBuildIdentity } from "./build-identity";
import {
  currentConnectorAttachment,
  waitForConnectorAppReceipt,
} from "./connector-app-receipt-wait";
import {
  ProductConfigurationService,
  ProductSettingsStore,
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
import { MAX_CHATGPT_CONTEXT_CHARACTERS } from "./chatgpt-readonly-task";
import {
  ChatGptRoute,
  ChatGptSignInBlockLedger,
  type ChatGptRouteOptions,
  type ChatGptSignInOutcomeDiagnostic,
  type ChatGptSignInStatus,
} from "./chatgpt-route";
import { SavedChatBrowser } from "./saved-chat-browser";
import { startSavedChatBridge } from "./saved-chat-bridge";
import { savedChatPreviewQualified } from "./saved-chat-preview-admission";
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
import {
  startCodexCallerRelay,
  type CodexCallerRelayRuntime,
} from "./codex-caller-relay";
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
import { createDevProof } from "../../../apps/desktop/dev/proof";
import {
  createConfigurationChatgpt,
  type DirectChatStart,
  type GoReadonlyConversation,
  type PendingChatGptAttachmentTask,
  type PendingChatGptReadonlyTask,
} from "../../../apps/desktop/configuration/chatgpt";
import type {
  ComputerConfigurationCommand,
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
import { drainComputerConnector } from "./computer-connector-drain";
import { isTrustedIpcSender } from "./ipc-sender";
import {
  currentBootTimeMs,
  removeRunMarker,
  readProcessStart,
  writeRunMarker,
} from "./run-marker";
import {
  computerConnectorAdmission,
  recoverSummaryExecutionFence,
  type SummaryFenceRecovery,
} from "./summary-fence-recovery";
import {
  deleteTaskContext,
  sweepOrphanTaskContexts,
} from "./task-context-cleanup";
import { createRouteBTaskLifecycle } from "./route-b-task-lifecycle";
import { TaskMutationGate, underTaskMutation } from "./task-mutation-gate";
import { runCodexChatGptHostRoute } from "./codex-chatgpt-host-route";
import { runRouteBHostCheck } from "./route-b-host-check";
import {
  ROUTE_B_MODEL,
  startRouteBRuntime,
  type RouteBRuntime,
  type RouteBSurfaceAdmission,
  type RouteBTaskSurfaces,
} from "./route-b-runtime";
import { type PendingWorkspaceEdit } from "./workspace-edit";
import { classifyWorkspaceRootDrift } from "../../../apps/desktop/configuration/drift";
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
import {
  UNTRUSTED_CANDIDATE_DIALOG,
  reverifyDiscoveredCandidate as reverifyDiscoveredCandidateImpl,
  untrustedCandidateDialogDecision,
  type ConfirmUntrustedCandidate,
} from "./reverify-discovered-candidate";
import { launchCodexAppServer } from "./codex-app-server-process";
import { runCodexHostSmoke } from "./codex-host-smoke";
import { runCodexNativeAgentCheck } from "./codex-native-agent-check";
import { CodexAgentWorkspaceProbe } from "./codex-agent-workspace-probe";
import { GoSettingsListWorkspace } from "./go-settings-workspace";
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
  desktopAppDataPath,
  desktopUserDataPath,
  desktopEnvironment,
  desktopIdentity,
  prepareOwnerPreviewProfile,
  desktopProfileEnvironment,
  isolatedDevMcpProofAllowed,
} from "./desktop-environment";
import {
  runDesktopStartupBoundary,
  startupNoticeAllowed,
  terminateDesktopStartup,
} from "./desktop-startup-failure";
import { resolvePhysicalDevDataDirectoryName } from "./dev-profile-directory";
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
const buildEnvironment = desktopEnvironment(process.env.FAROL_ENVIRONMENT);
const runtimeEnvironment = (() => {
  try {
    return desktopProfileEnvironment(
      buildEnvironment,
      process.env.FAROL_PROFILE_MODE,
      process.env.FAROL_ACCEPTANCE_PROFILE,
    );
  } catch (error) {
    terminateDesktopStartup(error, buildEnvironment, {
      write: (message) => process.stderr.write(message),
      exit: (code) => process.exit(code),
    });
    throw error;
  }
})();
const isolatedE2EHome =
  process.env.FAROL_E2E === "1" ? process.env.HOME : undefined;
const desktopAppData = (() => {
  try {
    return desktopAppDataPath(buildEnvironment, app.getPath("appData"), {
      enabled: process.env.FAROL_E2E === "1",
      override: process.env.FAROL_E2E_APP_DATA,
      acceptanceProfile: process.env.FAROL_ACCEPTANCE_PROFILE,
      testRoot: process.env.FAROL_E2E_TEST_ROOT,
      testHome: isolatedE2EHome,
      testProof: process.env.FAROL_E2E_TEST_PROOF,
    });
  } catch (error) {
    // An invalid E2E profile must fail before Electron selects any owner path
    // or shows an uncaught-exception dialog.
    terminateDesktopStartup(error, runtimeEnvironment, {
      write: (message) => process.stderr.write(message),
      exit: (code) => process.exit(code),
    });
    throw error;
  }
})();
// On macOS Electron's native home may ignore the child's HOME environment.
// The existing app-data proof has already validated this exact private HOME;
// select it before Go/native child composition can observe the owner's home.
if (isolatedE2EHome !== undefined) app.setPath("home", isolatedE2EHome);
const declaredDesktopIdentity = (() => {
  try {
    if (runtimeEnvironment === "owner-preview")
      prepareOwnerPreviewProfile(desktopAppData);
    return desktopIdentity(
      runtimeEnvironment,
      desktopAppData,
      runtimeEnvironment === "dev"
        ? resolvePhysicalDevDataDirectoryName(desktopAppData)
        : undefined,
    );
  } catch (error) {
    terminateDesktopStartup(error, runtimeEnvironment, {
      write: (message) => process.stderr.write(message),
      exit: (code) => process.exit(code),
    });
    throw error;
  }
})();
const selectedDesktopUserData = (() => {
  try {
    return desktopUserDataPath(declaredDesktopIdentity, {
      enabled: process.env.FAROL_E2E === "1",
      override: app.commandLine.getSwitchValue("user-data-dir"),
      devProfileArguments: process.argv,
    });
  } catch (error) {
    terminateDesktopStartup(error, runtimeEnvironment, {
      write: (message) => process.stderr.write(message),
      exit: (code) => process.exit(code),
    });
    throw error;
  }
})();
// Visible product names must not select storage. Pin both paths before any
// profile read, instance lock or browser session; E2E keeps its proven root.
app.setPath("userData", selectedDesktopUserData);
app.setPath("sessionData", selectedDesktopUserData);
// The profile's state layout, read at call time because the identity setup
// above redirects `userData` before any state path is used.
function statePaths() {
  return desktopStatePaths({
    userData: app.getPath("userData"),
    tmpdir: os.tmpdir(),
  });
}
const activeDesktopIdentity = {
  ...declaredDesktopIdentity,
  // Storage selection does not change development build admission or edition.
  displayEdition:
    buildEnvironment === "dev"
      ? "Development"
      : declaredDesktopIdentity.displayEdition,
  userData: app.getPath("userData"),
  sessionData: app.getPath("sessionData"),
  codexHome: path.join(app.getPath("userData"), "farol-private", "codex-home"),
} as const;
// `buildIdentity.product` ("Farol") is the release identity —
// it is validated against the packaged app name, the bundle ID, and the
// build digest, and stays exactly that everywhere those checks read it.
// Everywhere the app is only naming itself to the owner (the window title,
// the macOS app menu, the About panel), it reads "Farol" with a
// development edition only for Task Dev. Release identity remains unchanged.
const displayProductName = activeDesktopIdentity.displayName;
const displayEdition = activeDesktopIdentity.displayEdition;
const displayWindowTitle = [displayProductName, displayEdition]
  .filter(Boolean)
  .join(" · ");
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
const ownerBackgroundOnly = process.argv.includes("--owner-background-only");
if (ownerBackgroundOnly && parsePreviewWindowMode(process.argv) !== "hidden") {
  throw new Error("OWNER_BACKGROUND_PRESENTATION_INVALID");
}
const instanceRequest = createInstanceRequest(
  launchIdentity,
  ownerBackgroundOnly,
);
const secondInstanceResultPrefix = "FAROL_SECOND_INSTANCE_RESULT:";
const secondInstanceAcknowledgementPrefix = "FAROL_SECOND_INSTANCE_ACK_FAILED:";
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
const startupDelayMs = previewStartupDelay(
  process.argv,
  process.env.FAROL_E2E === "1",
);
const demoMode = process.argv.includes("--demo");
// Only the fixture lane can exercise the retained legacy journey explicitly.
// A normal packaged preview always selects the integrated Setup.
const legacySetupTestMode =
  process.env.FAROL_E2E === "1" && process.env.FAROL_E2E_LEGACY_SETUP === "1";
const contextOwnerId = "owner-desktop";
const contextProviderProfileId = "profile-isolated-farol";
const contextModel = ROUTE_B_MODEL;
const devSecondaryDisplay = parseDevDisplay(process.argv);
if (devSecondaryDisplay && buildEnvironment !== "dev")
  throw new Error("DEV_DISPLAY_ARGUMENT_INVALID");
const windowMode = devSecondaryDisplay
  ? "secondary-visible"
  : parsePreviewWindowMode(process.argv);
// Explicit-only: the owner-handed overnight run passes this itself. Its
// absence keeps every display-selection outcome exactly as before.
const allowPrimaryDisplay = parseAllowPrimaryDisplay(process.argv);
const builtInDisplayOnly = parseBuiltInDisplayOnly(process.argv);
const sidecarDisplayOnly = parseSidecarDisplayOnly(process.argv);
const initialWindowSize = parsePreviewWindowSize(process.argv, windowMode);
const explicitPreviewWindowSize = process.argv.some((argument) =>
  argument.startsWith("--preview-window-size="),
);
const demoTasks = [
  {
    ownerId: "demo-local-preview",
    taskId: "task-atlantic",
    sessionId: "session-atlantic",
    turnId: "turn-atlantic-1",
    generation: 1,
    label: "Demo · Atlantic workspace check",
    hasComputer: true,
  },
  {
    ownerId: "demo-local-preview",
    taskId: "task-harbor",
    sessionId: "session-harbor",
    turnId: "turn-harbor-1",
    generation: 1,
    label: "Demo · Harbor research stream",
    hasComputer: false,
  },
] as const;
const expectedTasks = demoMode ? demoTasks : [];

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
let runtimeChild: ChildProcess | null = null;
let localRuntimeGeneration = 0;
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
  summaryFenceRecovery: () => summaryFenceRecovery,
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
let codexContextController: CodexContextController | null = null;
// The connector's execution fence for summary-only phases, shared with the
// MCP process through the launch root; it exists once the controller does.
let summaryExecutionFence: PrivateExecutionFence | null = null;
// What the last start's fence recovery concluded; the Computer connector is
// not started while it holds nothing (or never ran).
let summaryFenceRecovery: SummaryFenceRecovery | null = null;
let routeBRuntime: RouteBRuntime | null = null;
// Live counters are cleared when the runtime exits; a support report made
// after that uses the counts taken just before the exit.
let taskCountsBeforeRuntimeExit: Readonly<{
  running: number;
  waiting: number;
  failed: number;
}> | null = null;
let callerRelayRuntime: CodexCallerRelayRuntime | null = null;
let callerRelayDirectoryWitness: ReturnType<
  CodexCallerRelayRuntime["directoryWitness"]
> | null = null;
if (process.env.FAROL_E2E === "1") {
  // Main-process metadata readback only: no token, socket client or control API.
  Object.defineProperty(app, "__farolE2ERelayDirectory", {
    get: () => callerRelayDirectoryWitness,
  });
}
let savedChatBridgeRuntime: Awaited<
  ReturnType<typeof startSavedChatBridge>
> | null = null;
// S35-03/2: takes the SAME cross-process lease a promotion holds from
// before its drain check through placement, for the whole durable admission
// — not merely a synchronous check of it (see `live-task-registry.ts`'s
// `PromotionLeaseGuard`). An unsafe or unreadable lease state refuses
// admission rather than surfacing the lease error as an unrelated crash;
// `verify` fences the durable write against a lease file replaced by hand.
const liveTaskRegistry = new LiveTaskRegistry(5, {
  acquireForAdmission: async () => {
    const handle = await acquirePromotionLease(
      app.getPath("userData"),
      buildIdentity.buildId,
      "admission",
    ).catch(() => null);
    if (!handle) return null;
    return {
      release: () => releasePromotionLease(handle),
      verify: () => verifyPromotionLease(handle),
    };
  },
});
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
  const account = readonlyAccountConfirmations.get(pending)?.projection();
  return {
    kind: "chatgpt.readonly-task-preview",
    sendAvailable: Boolean(pending.goAdmission && goChatStartupProfile),
    operationId: pending.operationId,
    workspaceId: pending.workspaceId,
    workspaceLabel: pending.workspaceLabel,
    relativePath: pending.relativePath,
    bytes: pending.bytes,
    contextCharacters: pending.contextCharacters,
    contextLimit: MAX_CHATGPT_CONTEXT_CHARACTERS,
    contextTruncated: pending.contextTruncated,
    excludedPaths: pending.excludedPaths,
    expiresAt: new Date(pending.expiresAt).toISOString(),
    ...(account ? { account } : {}),
  };
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
  return {
    kind: "chatgpt.attachment-task-preview",
    operationId: pending.operationId,
    attachments: pending.attachments.attachments.map(
      ({ stagedPath: _stagedPath, ...attachment }) => attachment,
    ),
    totalBytes: pending.attachments.attachments.reduce(
      (total, attachment) => total + attachment.bytes,
      0,
    ),
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
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

function runtimeBase(): string | null {
  return runtime ? `http://127.0.0.1:${runtime.port}` : null;
}

function bootstrap() {
  const taskState = productTasksState();
  return {
    schema: 3,
    chatHistoryContext: desktopGoCore?.historyContext ?? null,
    productName,
    bundleId,
    environment: activeDesktopIdentity.environment,
    displayName: activeDesktopIdentity.displayName,
    displayEdition: activeDesktopIdentity.displayEdition,
    applicationId: activeDesktopIdentity.applicationId,
    build: buildIdentity,
    demoMode,
    legacySetupTestMode,
    configuration: configuration?.snapshot() ?? {
      status: "error",
      error: "SETTINGS_READ_FAILED",
    },
    runtimeState,
    independentSession: desktopGoCore?.limitedSession === true,
    browserRouteState:
      selectedTaskId === ""
        ? { state: chatGptRoute?.loadState() ?? "loading" }
        : undefined,
    browserHistoryState: {
      taskId: selectedTaskId,
      back: false,
      forward: false,
      ...(selectedTaskId === ""
        ? chatGptRoute
        : liveTaskRoutes.get(selectedTaskId)
      )?.navigationHistory(),
    },
    connectionStatus: currentConnectionStatus(),
    runtimeError,
    runtimeIdentity: runtime?.identity ?? null,
    embeddedNode: runtime?.embeddedNode ?? null,
    embeddedElectron: runtime?.embeddedElectron ?? process.versions.electron,
    taskRevision: taskState.revision,
    tasks: taskState.tasks,
    selectedTaskId,
    partition: activeDesktopIdentity.runtimePartition,
    chatgptPartition: activeDesktopIdentity.chatGptPartition,
    chatgptRecoveryPending: recoverableChatGptTask !== null,
    chatgptConversationState: chatGptConversationState(),
    updateChannel: buildIdentity.updateChannel,
    nativeFilesystem: true,
    nativeAgent: productAgentCapabilityAvailable(),
    // The fixed Git verifiers exist only in the explicit legacy build.
    gitVerificationAvailable: compiledGoCore === null,
    liveProvider: false,
    windowState: currentWindowState(),
    chatgptSignInBlocked: chatGptSignInBlocked.current(),
    chatgptSignInOutcome: chatGptSignInOutcome,
    // The renderer cannot read this process's environment, and one E2E
    // scenario needs it to: the acknowledgement of a guarded edit is sent
    // from the renderer, so only the renderer can fail to send it. This is
    // the one number that seam needs, under the same double gate as the
    // reply fault, and it is null in every production build because the
    // lane variable is unset. It carries no authority and names nothing
    // else. See configuration-reply-fault.ts for the family.
    e2eWorkspaceEditAckHold: e2eBudget(
      process.env,
      WORKSPACE_EDIT_ACK_HOLD_ENV,
      WORKSPACE_EDIT_ACK_HOLD_INVALID,
    ),
  };
}

function publishTasksState(): void {
  if (demoMode) return;
  window?.webContents.send(channels.tasksState, liveTaskRegistry.snapshot());
}

function taskFailure(
  error: Extract<ProductTaskCommandResult, { ok: false }>["error"],
): ProductTaskCommandResult {
  return ProductTaskCommandResultSchema.parse({
    ok: false,
    error,
    state: liveTaskRegistry.snapshot(),
  });
}

function taskSuccess(taskId: string | null): ProductTaskCommandResult {
  return ProductTaskCommandResultSchema.parse({
    ok: true,
    state: liveTaskRegistry.snapshot(),
    selectedTaskId: taskId,
  });
}

function surfaceLiveTaskPersistenceFailure(taskId: string): void {
  if (!liveTaskRegistry.get(taskId)) return;
  liveTaskRegistry.setLifecycle(taskId, "outcome_unknown");
  publishTasksState();
}

function setLiveTaskLifecycle(
  taskId: string,
  lifecycle: ProductTask["lifecycle"],
): void {
  if (liveTaskRegistry.get(taskId)?.lifecycle === lifecycle) return;
  if (!liveTaskRegistry.setLifecycle(taskId, lifecycle)) return;
  publishTasksState();
  void persistLiveTaskState().catch(() =>
    surfaceLiveTaskPersistenceFailure(taskId),
  );
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
  return {
    ownerId: contextOwnerId,
    taskId,
    hostThreadId: taskId,
    sessionId: taskId,
    providerProfileId: contextProviderProfileId,
    modelId: contextModel,
    mode: "chatgpt",
  };
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
  // `surfaceFor` read the gate free before it removed this thread's private
  // residue; another task mutation may have claimed it in that gap.
  return underTaskMutation(
    taskMutations,
    () => ({ ok: false, code: "TASK_ROUTE_BUSY" }),
    async () => {
      const before = liveTaskRegistry.snapshot();
      const labels = new Set(before.tasks.map((candidate) => candidate.label));
      let ordinal = 1;
      while (labels.has(`Codex task ${ordinal}`)) ordinal += 1;
      const task: ProductTask = {
        taskId: threadId,
        sessionId: threadId,
        turnId: randomUUID(),
        label: `Codex task ${ordinal}`,
        provider: "chatgpt",
        requestedModel: "Account default",
        observedModel: null,
        requestedMode: "Account default",
        observedMode: null,
        hasComputer: false,
        pinned: false,
        lifecycle: "running",
      };
      // S35-03/2: admits and persists under the same cross-process lease a
      // promotion holds, so this cannot land in the gap after a promotion's
      // drain check validated nothing running and before its placement.
      let admitted: LiveTaskAdmission;
      try {
        admitted = await liveTaskRegistry.admitDurable(
          task,
          persistLiveTaskState,
        );
      } catch {
        return { ok: false, code: "TASK_STATE_UNAVAILABLE" };
      }
      if (admitted.status === "capacity") {
        return { ok: false, code: "TASK_CAPACITY_REACHED" };
      }
      if (admitted.status !== "admitted") {
        return { ok: false, code: "TASK_ROUTE_UNAVAILABLE" };
      }
      const route = createLiveChatGptRoute(task.taskId, task.label);
      liveTaskConversationUrls.set(task.taskId, null);
      liveTaskRoutes.set(task.taskId, route);
      publishTasksState();
      if (!(await openLiveTaskSurface(task.taskId))) {
        return { ok: false, code: "TASK_SURFACE_UNREACHABLE" };
      }
      return { ok: true, surface: route };
    },
  );
}

const routeBTaskLifecycle = createRouteBTaskLifecycle({
  owns: (taskId) => routeBRuntime?.owns(taskId) ?? false,
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
  deleteContext: (taskId) =>
    codexContextController
      ? deleteTaskContext(
          codexContextController.store,
          contextBinding(taskId),
          summaryExecutionFence ?? undefined,
        )
      : Promise.resolve("none"),
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

// Includes the bounded Go retirement/ACK, exact child exit and terminal recorder.
const QUIT_DRAIN_DEADLINE_MS = 60_000;
const QUIT_PREPARATION_MS = 10_000;
const QUIT_RECORD_RESERVE_MS = 2_000;
// Leave at least 40 seconds of the normal post-preparation drain for Go core
// and recording. This bounds the whole dependent close, not a renewed budget.
const CONNECTOR_START_QUIT_BUDGET_MS = 8_000;

// What the start did with the connector's execution fence, kept privately
// for diagnostics: whether the store was read and how many summaries it
// still holds as possibly running.
async function recordSummaryFenceRecovery(
  recovery: SummaryFenceRecovery,
): Promise<void> {
  const file = statePaths().summaryFenceRecovery;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(
    file,
    `${JSON.stringify({ schema: 1, at: new Date().toISOString(), ...recovery })}\n`,
    { mode: 0o600 },
  );
}

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

// The single-instance lock is held here, so a relay socket left in the
// profile's short temporary directory belongs to a previous run of this same
// profile.
async function initializeCallerRelay(): Promise<void> {
  if (callerRelayRuntime) return;
  const root = statePaths().callerRelay;
  try {
    const stale = await lstat(path.join(root, "caller-relay.sock"));
    if (stale.isSocket() && stale.uid === process.getuid?.()) {
      await unlink(path.join(root, "caller-relay.sock"));
    }
  } catch {
    // No previous socket.
  }
  try {
    callerRelayRuntime = await startCodexCallerRelay({
      root,
      ...(isolatedE2EHome !== undefined
        ? {
            onDirectoryPrepared: (witness) => {
              callerRelayDirectoryWitness = witness;
            },
          }
        : {}),
    });
  } catch {
    // Without the relay, Route B turns that offer host tools are refused.
    callerRelayRuntime = null;
  }
}

async function initializeSavedChatBridge(): Promise<void> {
  if (savedChatBridgeRuntime) return;
  // This opt-in is set by the owner when launching the disposable Dev preview.
  // Normal builds never advertise an account-writing MCP tool by default.
  const fence = summaryExecutionFence;
  if (!fence) return;
  const qualified = () => {
    const snapshot = configuration?.snapshot();
    if (snapshot?.status !== "ready") return false;
    return savedChatPreviewQualified({
      environment: runtimeEnvironment,
      ownerOptIn: process.env.FAROL_SAVED_CHAT_PREVIEW,
      outcomeUnknown: snapshot.settings.setup.chatgpt.outcomeUnknown,
      verification: snapshot.settings.setup.chatgpt.verified,
      partition: activeDesktopIdentity.chatGptPartition,
      buildId: buildIdentity.buildId,
    });
  };
  if (!qualified()) return;
  const root = statePaths().savedChatHandoff;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(root)) !== path.resolve(root)
    )
      return;
    const canonical = (url: string) =>
      canonicalChatGptConversationUrl(url, chatGptE2eOrigin);
    const browser = new SavedChatBrowser(
      chatGptHomeUrl,
      chatGptE2eOrigin,
      createManagedChatGptRoute,
      {
        partition: activeDesktopIdentity.chatGptPartition,
        ...(runtimeEnvironment === "dev"
          ? { requiredAppName: activeDesktopIdentity.displayName }
          : {}),
      },
      Date.now,
      undefined,
      qualified,
    );
    savedChatBridgeRuntime = await startSavedChatBridge(
      new PersistentChatGptHandoff(
        new PrivateSavedChatJournal(root, canonical),
        browser,
        new Sha256SavedChatDigester(),
        canonical,
        async (request, requestDigest) => {
          if (!qualified()) return false;
          const owner = window;
          if (!owner || owner.isDestroyed()) return false;
          const { response } = await dialog.showMessageBox(owner, {
            type: "warning",
            buttons: ["Do not send", "Account checked — send once"],
            defaultId: 0,
            cancelId: 0,
            message: "Send this first message through Farol Browser?",
            detail: `Check the signed-in account in Farol Browser before approving. Farol cannot identify that account from this receipt.\n\nTitle: ${request.title}\nKey: ${request.key}\nDigest: ${requestDigest}\n\n${request.firstMessage}`,
          });
          return response === 1 && qualified();
        },
      ),
      () => fence.acquireAdmission(),
    );
  } catch {
    // The connector remains usable for Computer without Browser handoff.
    savedChatBridgeRuntime = null;
  }
}

async function initializeRouteBRuntime(): Promise<void> {
  const controller = codexContextController;
  if (!controller || routeBRuntime) return;
  try {
    routeBRuntime = await startRouteBRuntime({
      stateRoot: statePaths().state,
      surfaces: routeBTaskSurfaces,
      compaction: controller.continuity,
      ...(callerRelayRuntime ? { relay: callerRelayRuntime } : {}),
    });
  } catch {
    // Route B stays unavailable; ordinary Browser tasks are unaffected.
    routeBRuntime = null;
  }
}

async function initializeCodexContextController(): Promise<void> {
  // While a summary-only phase runs, the connector's Computer tools are
  // fenced through the launch root its MCP process reads. A summary a crash
  // interrupted may still be running on its page, so the fence a previous
  // process raised is never cleared here: reconcileContextAfterRestart
  // brings it in line with the private context store before any work is
  // admitted.
  const fence = new PrivateExecutionFence({
    root: statePaths().secureMcpLaunch,
  });
  summaryExecutionFence = fence;
  codexContextController = createCodexContextController({
    ownerId: contextOwnerId,
    providerProfileId: contextProviderProfileId,
    stateRoot: statePaths().contextContinuity,
    liveTask: (taskId) => liveTaskRegistry.get(taskId) !== null,
    summaryFence: {
      raise: (input) =>
        fence.raise({
          operationId: input.operationId,
          taskId: input.binding.taskId,
        }),
      lower: (input) => fence.lower(input.operationId),
    },
    summaryRoutes: {
      retained: (binding) => liveTaskRoutes.get(binding.taskId) ?? null,
      createFallback: createContextSummaryFallbackRoute,
      recoverFallback: (binding, conversationUrl) =>
        createContextSummaryFallbackRoute(binding, conversationUrl),
    },
    onContextStateChanged: async (session) => {
      if (
        !liveTaskRegistry.setContext(
          session.binding.taskId,
          toProductTaskContext(session),
        )
      ) {
        return;
      }
      await persistLiveTaskState();
      publishTasksState();
    },
  });
}

// Before Route B or IPC can admit work, each restored task's visible context
// is replaced by what the private context store holds.
async function reconcileContextAfterRestart(): Promise<void> {
  const controller = codexContextController;
  if (!controller) return;
  const reconciled = await reconcileTaskContexts(
    liveTaskRegistry.snapshot().tasks.map((task) => task.taskId),
    controller.store,
    contextBinding,
  );
  let changed = false;
  for (const entry of reconciled) {
    const current = liveTaskRegistry.get(entry.taskId)?.context ?? null;
    if (isDeepStrictEqual(current, entry.context)) continue;
    changed =
      liveTaskRegistry.setContext(entry.taskId, entry.context) || changed;
  }
  if (changed) {
    await persistLiveTaskState().catch(() => undefined);
    publishTasksState();
  }
  // Context a closed task left behind is removed only when the registry was
  // really read; an unreadable registry sweeps nothing.
  await sweepOrphanTaskContexts(
    controller.store,
    liveTaskStore && liveTaskRegistryRestored
      ? {
          status: "loaded",
          taskIds: liveTaskRegistry.snapshot().tasks.map((task) => task.taskId),
        }
      : { status: "unavailable" },
    contextBinding,
    summaryExecutionFence ?? undefined,
  ).catch(() => undefined);
  // A summary a crash interrupted may still be running on its page: only an
  // operation the store proves over, or a task the owner ended, loses its
  // fence; a store that cannot be read keeps every record. This runs before
  // Route B, IPC or the connector can admit work.
  if (summaryExecutionFence) {
    summaryFenceRecovery = await recoverSummaryExecutionFence({
      fence: summaryExecutionFence,
      store: controller.store,
    });
    await recordSummaryFenceRecovery(summaryFenceRecovery).catch(
      () => undefined,
    );
  }
}

async function initializeLiveTaskState(): Promise<void> {
  return taskPersist().initialize();
}

async function openLiveTaskSurface(taskId: string): Promise<boolean> {
  if (desktopAdmission.closed()) return false;
  const route = liveTaskRoutes.get(taskId);
  const task = liveTaskRegistry.get(taskId);
  if (!route || !task) return false;
  const currentTask = () => {
    const current = liveTaskRegistry.get(taskId);
    return liveTaskRoutes.get(taskId) === route &&
      current?.sessionId === task.sessionId &&
      current.turnId === task.turnId
      ? current
      : null;
  };
  const recordSurfaceFailure = () => {
    if (!currentTask()) return;
    const error = "TASK_SURFACE_UNREACHABLE";
    taskSurfaceFailures.set(taskId, error);
    try {
      publishTaskSurfaceStatus({ taskId, state: "failed", error });
    } catch {
      // An unavailable observer cannot replace the classified load failure.
    }
    const current = currentTask();
    // Loading a surface does not resolve an existing Task obligation or
    // replace a completion already observed by the activity owner.
    if (
      !current ||
      current.lifecycle === "running" ||
      current.lifecycle === "outcome_unknown" ||
      current.lifecycle === "completed"
    )
      return;
    try {
      setLiveTaskLifecycle(taskId, "failed");
    } catch {
      // Keep the original route outcome and recorded surface failure when
      // the existing lifecycle owner's synchronous publication cannot finish.
    }
  };
  try {
    const opened = await route.open();
    if (!currentTask()) return false;
    if (opened.status !== "opened") {
      recordSurfaceFailure();
      return false;
    }
    // Live ChatGPT surfaces also publish their observed load result. Without
    // this, renderer controls requiring a ready selected page never appear.
    taskSurfaceFailures.delete(taskId);
    publishTaskSurfaceStatus({ taskId, state: "ready", error: null });
    const current = currentTask();
    if (!current) return false;
    if (current.lifecycle === "failed") {
      setLiveTaskLifecycle(taskId, "idle");
    }
    if (!currentTask()) return false;
    applyLayout();
    if (!currentTask()) return false;
    focusForLayoutAfterRendererCommit();
    return currentTask() !== null;
  } catch {
    recordSurfaceFailure();
    return false;
  }
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

async function selectedSupportExportTarget(): Promise<string | null> {
  if (process.env.FAROL_E2E === "1") {
    const target = process.env.FAROL_E2E_SUPPORT_EXPORT;
    if (!target || !path.isAbsolute(target) || target.includes("\0")) {
      throw new Error("SUPPORT_EXPORT_E2E_TARGET_INVALID");
    }
    return target;
  }
  const options: SaveDialogOptions = {
    title: "Export content-free Farol support report",
    defaultPath: path.join(
      app.getPath("documents"),
      `Farol-Support-${buildIdentity.version}.json`,
    ),
    buttonLabel: "Export Support Report",
    filters: [{ name: "JSON", extensions: ["json"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  };
  const selected = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  return selected.canceled || !selected.filePath ? null : selected.filePath;
}

// DEV manages only the config inside its app-owned Codex home. It never
// reads, writes or falls back to the owner's ~/.codex. Packaged Preview keeps
// its existing explicitly owner-operated configuration behavior.
function farolModelCodexConfigPath(): string {
  const override =
    process.env.FAROL_E2E === "1"
      ? process.env.FAROL_MODEL_E2E_CODEX_CONFIG_PATH
      : undefined;
  if (override && path.isAbsolute(override) && !override.includes("\0")) {
    return override;
  }
  return desktopCodexConfigPath(
    buildEnvironment,
    activeDesktopIdentity,
    os.homedir(),
  );
}

// E2E-only: a minimal, valid OpenAI Responses-shaped completed turn, used
// solely behind the FAROL_E2E + FAROL_MODEL_E2E_SYNTHETIC_REPLY double
// gate above. It never runs in a normal launch.
function syntheticModelTurnHandler(
  text: string,
): NonNullable<
  ConstructorParameters<typeof FarolModelLifecycle>[0]["handler"]
> {
  return async () => ({
    ok: true,
    events: [
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: {
            id: "resp_e2e",
            object: "response",
            status: "completed",
            output: [
              {
                id: "msg_e2e",
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text, annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      },
    ],
  });
}

// This control only ever targets a host the owner starts themselves (their
// own ordinary Codex reading its own config.toml), so the literal-token
// delivery from the N04 addendum is the only one it ever builds — the
// env-key delivery stays reserved for a host Farol launches itself.
async function farolModelProviderSpec(): Promise<FarolModelProviderSpec | null> {
  if (!FAROL_MODEL_ENABLED) return null;
  if (!modelLifecycle) return null;
  const status = modelLifecycle.status();
  // S35-TA-2: a sealed endpoint must never produce a provider spec — a
  // block written from one would point an ordinary Codex at a port that
  // refuses every request.
  if (
    status.state === "not_running" ||
    status.state === "port_conflict" ||
    status.state === "sealed"
  ) {
    return null;
  }
  const token = await modelLifecycle.runtimeState.currentToken();
  if (!token) return null;
  return {
    providerName: FAROL_PROVIDER_ID,
    displayName: "Farol",
    baseUrl: `http://127.0.0.1:${status.port}`,
    // The one model the endpoint serves is the Route B model: the same
    // constant the endpoint validates against and the provider accepts.
    model: ROUTE_B_MODEL,
    wireApi: "responses",
    delivery: { mode: "bearer-token", token },
  };
}

// Whether a Codex started from the verified executable is running right
// now: it decides which restart note the control shows after an apply. A
// read-only process-table scan; `unknown` when no host is verified yet or
// the table cannot be read. Never signals or starts anything.
async function farolModelCodexHostPresence(): Promise<
  "running" | "not_running" | "unknown"
> {
  // DEV never inspects or asks the owner to restart a personal Codex. Its
  // model route is consumed only by app-owned children with private HOME and
  // CODEX_HOME directories.
  if (buildEnvironment !== "preview") return "not_running";
  const snapshot = configuration ? configuration.snapshot() : null;
  const executablePath =
    snapshot && snapshot.status === "ready"
      ? snapshot.settings.nativeHosts.codex?.executablePath
      : undefined;
  if (!executablePath) return "unknown";
  return (await detectCodexHostPresence({ executablePath })).state;
}

let desktopComputerMcpLifecycle: PrivateMcpLifecycle | null = null;
function computerMcpLifecycle(): PrivateMcpLifecycle {
  // Boot owns one lifecycle so concurrent Start/Stop share stop admission.
  desktopComputerMcpLifecycle ??= new PrivateMcpLifecycle(
    statePaths().secureMcpLaunch,
  );
  return desktopComputerMcpLifecycle;
}

async function stopAndConfirmComputerMcp(
  connector = secureMcpConnectorRuntime,
  inFlightStart: Promise<void> | null = null,
  core = desktopGoCore,
  savedChat = savedChatBridgeRuntime,
  reason?: "owner_stop",
  originalStopParent?: string,
  quitStartDeadlineAt?: number,
): Promise<void> {
  if (!connector) throw new Error("CONNECTOR_STOP_UNCONFIRMED");
  // Ordinary Stop is forbidden while C7 owns an unresolved original. Only
  // the already-admitted original parent may execute its single native effect.
  if (core && originalStopParent === undefined) {
    const custody = await core.observeOriginalStop();
    if (custody.restricted) throw new Error("CONNECTOR_STOP_UNCONFIRMED");
  }
  if (
    core?.independentSession &&
    inFlightStart === null &&
    !connector.isRunning()
  ) {
    if (originalStopParent !== undefined)
      throw new Error("CONNECTOR_STOP_UNCONFIRMED");
    // This run never owned the retained legacy tunnel. Close only its current
    // native connector/account ports; old lifecycle markers remain history.
    await savedChat?.close();
    await core.closeComputerConnector(reason);
    return;
  }
  const lifecycle = computerMcpLifecycle();
  await observeOperation(
    operationsStore(),
    { source: "You", kind: "connection.stop", target: {} },
    () =>
      connector.observeStopAttempt(() =>
        drainComputerConnector({
          beginStop: () => lifecycle.beginStop(),
          startInFlight: inFlightStart,
          startDeadlineAt: quitStartDeadlineAt,
          waitForMcpStop: () => lifecycle.waitForStop(),
          stopConnector: () => connector.stop(),
          closeSavedChat: async () => {
            // Wait for admitted account work before closing its Browser endpoint.
            try {
              if (savedChat) {
                await savedChat.close();
                if (savedChatBridgeRuntime === savedChat)
                  savedChatBridgeRuntime = null;
              }
            } finally {
              // Withdraw the original Go owner even when the old adapter drain fails.
              // A failure remains unconfirmed; it cannot authorize a new launch.
              if (
                quitStartDeadlineAt !== undefined &&
                Date.now() >= quitStartDeadlineAt
              )
                throw new Error("CONNECTOR_STOP_UNCONFIRMED");
              await core?.closeComputerConnector(reason, originalStopParent);
            }
          },
          confirmStop: () => lifecycle.confirmStop(),
        }),
      ),
  );
}

async function codexHostRuntimeRoot(): Promise<string> {
  const root = statePaths().codexHostRuntime;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    throw new Error("CODEX_HOST_RUNTIME_UNSAFE");
  }
  if ((info.mode & 0o077) !== 0) await chmod(root, 0o700);
  return root;
}

async function codexHostHomePath(): Promise<string> {
  const root = activeDesktopIdentity.codexHome;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    throw new Error("CODEX_HOST_HOME_UNSAFE");
  }
  if ((info.mode & 0o077) !== 0) await chmod(root, 0o700);
  return root;
}

async function codexHostHomeOption(): Promise<
  Readonly<{ codexHomePath?: string }>
> {
  const { codexHomePath: selected } = desktopCodexChildHomes(
    buildEnvironment,
    activeDesktopIdentity,
    app.getPath("home"),
    process.env.CODEX_HOME,
  );
  if (selected === undefined) return {};
  if (buildEnvironment !== "preview") await codexHostHomePath();
  return { codexHomePath: selected };
}

async function codexHostProcessHomePath(): Promise<string> {
  const { processHomePath: root } = desktopCodexChildHomes(
    buildEnvironment,
    activeDesktopIdentity,
    app.getPath("home"),
    process.env.CODEX_HOME,
  );
  if (buildEnvironment === "preview") return root;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  const effectiveUser = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (effectiveUser !== undefined && info.uid !== effectiveUser)
  ) {
    throw new Error("CODEX_HOST_PROCESS_HOME_UNSAFE");
  }
  if ((info.mode & 0o077) !== 0) await chmod(root, 0o700);
  return root;
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

async function withdrawGoReadonlyAdmission(
  admission: ChatComputerAdmissionResponse | undefined,
): Promise<boolean> {
  if (!admission) return true;
  if (!desktopGoCore) return false;
  try {
    await desktopGoCore.withdrawReadIntent(admission);
    return true;
  } catch {
    return false;
  }
}

function discardPreparedReadonlyTask(
  pending: PendingChatGptReadonlyTask,
): Promise<boolean> {
  const previous = readonlyDiscardAttempts.get(pending);
  if (previous) return previous;
  // The selected Go owner confirms its own cancellation/ACK. Only a legacy
  // preview owns a legacy journal entry; never create or clear a Go mirror.
  // Retain either failure; UI repetition is not a retry.
  const result = Promise.resolve().then(async () => {
    if (!(await withdrawGoReadonlyAdmission(pending.goAdmission))) return false;
    if (
      pending.goAdmission === undefined &&
      !(await discardPreparedChatGptTask(pending.operationId))
    )
      return false;
    if (pendingChatGptReadonlyTask === pending)
      pendingChatGptReadonlyTask = null;
    return true;
  });
  readonlyDiscardAttempts.set(pending, result);
  return result;
}

function selectedChatGptAttachmentPaths(): Promise<
  readonly string[] | "cancelled" | "invalid"
> {
  return chatGptSession().selectedAttachmentPaths();
}

function attachmentStagingFailure(error: unknown): ProductConfigurationResult {
  return chatGptSession().attachmentStagingFailure(error);
}

// The device and inode a folder has now, so its approval can refuse another
// object that later takes the same path.
async function measuredRootIdentity(
  root: string,
): Promise<WorkspaceRootIdentity | null> {
  try {
    const measured = await lstat(root, { bigint: true });
    return measured.isDirectory()
      ? { device: String(measured.dev), inode: String(measured.ino) }
      : null;
  } catch {
    return null;
  }
}

// Read-only measurement of every identity-bound folder, then one
// authority-reducing write for folders that are no longer there. Path-bound
// approval (owner decision 2026-11-22): a changed device or inode at the same
// path is diagnostic only and keeps the check; only a vanished or unreachable
// folder withdraws it. Returns false when a vanished folder could not be
// withdrawn: the caller must then not resume.
async function withdrawDriftedWorkspaceChecksAtLaunch(): Promise<boolean> {
  if (!configuration) return true;
  let drifted = 0;
  let withdrawn = false;
  let code: string | null = null;
  // The window and Settings IPC are already open. Hold the authority
  // reservation across the WHOLE scan (measurement and write), so a manual
  // Connect or Agent admission cannot start with the stale grant meanwhile.
  const reserved = await authorityTransitions.withReservation(
    "authority-change",
    async () => {
      const snapshot = configuration!.snapshot();
      if (snapshot.status !== "ready") return;
      const found: {
        workspaceId: string;
        root: string;
        rootIdentity: WorkspaceRootIdentity;
        observed: string;
      }[] = [];
      for (const workspace of snapshot.settings.computer.workspaces) {
        if (!workspace.rootIdentity) continue;
        // Evidence before measuring: a newer check is never erased by it.
        const observed = workspaceCheckEvidence(
          snapshot.settings,
          workspace.workspaceId,
        );
        const measured = await measuredRootIdentity(workspace.root);
        const drift = classifyWorkspaceRootDrift(
          workspace.rootIdentity,
          measured,
        );
        // Numeric drift (a reboot renumbered the volume) and a recreated
        // folder at the same path keep their check: the folder at the path
        // is the workspace. A vanished folder, or one now reached through a
        // linked ancestor (native traversal refuses links), withdraws it.
        if (drift !== "same")
          console.warn(
            `FAROL_WORKSPACE_ROOT_OBSERVED:${JSON.stringify({ drift })}`,
          );
        const reachable =
          measured !== null &&
          (await realpath(workspace.root).catch(() => null)) === workspace.root;
        if (!reachable)
          found.push({
            workspaceId: workspace.workspaceId,
            root: workspace.root,
            rootIdentity: workspace.rootIdentity,
            observed,
          });
      }
      drifted = found.length;
      if (found.length === 0) {
        withdrawn = true;
        return;
      }
      // Quit may have closed admission while the folders were measured, and a
      // connector or an active Agent may still carry the grant; then leave
      // settings alone (Go's per-call root guard keeps refusing the root).
      if (desktopAdmission.closed()) {
        code = "AUTHORITY_CHANGE_IN_PROGRESS";
        return;
      }
      if (
        codexAgentOperationActive() ||
        desktopAdmission.occupied("connector-task") ||
        secureMcpConnectorRuntime?.isRunning() === true
      ) {
        code = "CONNECTOR_STOP_REQUIRED";
        return;
      }
      try {
        const result = await configuration!.withdrawDriftedWorkspaceChecks(
          found,
          () => !desktopAdmission.closed(),
        );
        withdrawn = result.ok;
        code = result.ok ? null : result.error;
      } catch {
        code = "SETTINGS_WRITE_FAILED";
      }
    },
  );
  // A competing authority change owns this moment; do not resume on top of
  // an unmeasured grant. The owner's own operation proceeds as before.
  if (!reserved.admitted) code = "AUTHORITY_CHANGE_IN_PROGRESS";
  if (drifted > 0 || !reserved.admitted)
    console.warn(
      "FAROL_WORKSPACE_ROOT_DRIFT:" +
        JSON.stringify({
          workspaces: drifted,
          withdrawn,
          ...(code ? { code } : {}),
        }),
    );
  return reserved.admitted && withdrawn;
}

async function selectedWorkspace(): Promise<
  | Readonly<{
      root: string;
      label: string;
      rootIdentity: WorkspaceRootIdentity;
    }>
  | "cancelled"
  | "invalid"
> {
  if (
    process.env.FAROL_E2E === "1" &&
    process.env.FAROL_E2E_CANCEL_WORKSPACE_PICKER === "1"
  )
    return "cancelled";
  let selected: string | undefined;
  const testRoot =
    process.env.FAROL_E2E === "1"
      ? process.env.FAROL_E2E_WORKSPACE_ROOT
      : undefined;
  if (testRoot) {
    selected = testRoot;
  } else {
    if (!window) return "invalid";
    const result = await dialog.showOpenDialog(window, {
      title: "Choose a workspace",
      buttonLabel: "Add Workspace",
      properties: ["openDirectory"],
      securityScopedBookmarks: false,
    });
    if (result.canceled || result.filePaths.length !== 1) return "cancelled";
    selected = result.filePaths[0];
  }
  if (!selected || !path.isAbsolute(selected)) return "invalid";
  try {
    const listed = await lstat(selected);
    if (!listed.isDirectory() || listed.isSymbolicLink()) return "invalid";
    const root = await realpath(selected);
    if (!path.isAbsolute(root)) return "invalid";
    const rootIdentity = await measuredRootIdentity(root);
    if (!rootIdentity) return "invalid";
    return { root, label: path.basename(root) || root, rootIdentity };
  } catch {
    return "invalid";
  }
}

// A native choice is held only in this process. The renderer receives an
// opaque short-lived reference, so cancellation never stops a live connector.
let pendingWorkspacePick: PendingWorkspacePickValue | null = null;

// A renderer-chosen discovery candidate is never trusted at face value: the
// main process re-runs discovery itself and only accepts a path that is
// still a current, non-refused candidate before handing it to the existing
// execution probes (`verifyCodexExecutable` / `verifyTunnelClientExecutable`,
// which remain the sole authority on whether a path may actually run). This
// closes the gap between "the owner clicked a card that was true a moment
// ago" and "this exact path is still what discovery would offer right now".
//
// The decision logic itself lives in `reverify-discovered-candidate.ts`,
// injectable and unit-tested there; this wrapper supplies the real
// discovery function and the real owner-facing confirmation dialog.
async function reverifyDiscoveredCandidate(
  kind: "codex" | "tunnel-client",
  requestedPath: string,
): Promise<DiscoveryCandidate | "stale" | "declined"> {
  return reverifyDiscoveredCandidateImpl(kind, requestedPath, {
    discover: (discoverKind) => discoverExecutables(discoverKind),
    // Resolved lazily: the helper reads this only after discovery has
    // finished, so it asks about the window that exists at that moment. A
    // window destroyed while discovery ran yields null here, and a missing
    // window can never confirm an untrusted candidate.
    get confirm(): ConfirmUntrustedCandidate | null {
      const owner = window;
      if (!owner || owner.isDestroyed()) return null;
      return async ({ kind: dialogKind, path }) => {
        const { response } = await dialog.showMessageBox(owner, {
          type: "warning",
          buttons: [...UNTRUSTED_CANDIDATE_DIALOG.buttons],
          defaultId: UNTRUSTED_CANDIDATE_DIALOG.defaultId,
          cancelId: UNTRUSTED_CANDIDATE_DIALOG.cancelId,
          message:
            dialogKind === "codex"
              ? "Use a Codex that is not confirmed as signed by OpenAI?"
              : "Use a tunnel-client that does not match the reviewed build?",
          detail: `${path}\n\nFarol could not confirm where this file came from. Continue only if you placed it there yourself.`,
        });
        return untrustedCandidateDialogDecision(response);
      };
    },
  });
}

function e2eCodexExecutable(): string | "invalid" | undefined {
  const testExecutable =
    process.env.FAROL_E2E === "1"
      ? process.env.FAROL_E2E_CODEX_EXECUTABLE
      : undefined;
  if (testExecutable === undefined) return undefined;
  return path.isAbsolute(testExecutable) && !testExecutable.includes("\0")
    ? testExecutable
    : "invalid";
}

async function selectedCodexExecutable(): Promise<
  string | "cancelled" | "invalid"
> {
  const testExecutable = e2eCodexExecutable();
  if (testExecutable !== undefined) return testExecutable;
  if (!window) return "invalid";
  const result = await dialog.showOpenDialog(window, {
    title: "Choose the Codex executable",
    buttonLabel: "Verify Codex",
    properties: ["openFile"],
    securityScopedBookmarks: false,
  });
  if (result.canceled || result.filePaths.length !== 1) return "cancelled";
  const selected = result.filePaths[0];
  return selected && path.isAbsolute(selected) && !selected.includes("\0")
    ? selected
    : "invalid";
}

async function verifyCodexExecutable(
  executablePath: string,
  expectedDiscovery?: Readonly<{ canonicalPath: string; sha256: string }>,
): Promise<ProductConfigurationResult> {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  try {
    const probe = await probeCodexHost({
      executablePath,
      scratchRoot: statePaths().codexHostProbe,
      ...(expectedDiscovery ? { expectedDiscovery } : {}),
    });
    const recorded = await configuration.recordCodexHost({
      executablePath: probe.executablePath,
      executableSha256: probe.executableSha256,
      version: probe.version,
      protocol: probe.protocol,
      schemaSha256: probe.schemaSha256,
      taskSource: probe.taskSource,
      buildId: buildIdentity.buildId,
    });
    if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
    return ProductConfigurationResultSchema.parse({
      ...recorded,
      evidence: {
        kind: "host.codex-probe",
        version: probe.version,
        protocol: probe.protocol,
        executableSha256: probe.executableSha256,
        schemaSha256: probe.schemaSha256,
        capabilities: probe.capabilities,
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "CODEX_HOST_DISCOVERY_CANDIDATE_STALE") {
      return configurationFailure("CODEX_HOST_DISCOVERY_CANDIDATE_STALE");
    }
    const unsupported = code === "CODEX_HOST_INCOMPATIBLE";
    const recorded = await configuration.recordCodexHostFailure(
      unsupported ? "unsupported" : "unreachable",
    );
    if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
    if (code === "CODEX_HOST_SELECTION_INVALID") {
      return configurationFailure("CODEX_HOST_SELECTION_INVALID");
    }
    if (code === "CODEX_HOST_EXECUTABLE_UNSAFE") {
      return configurationFailure("CODEX_HOST_EXECUTABLE_UNSAFE");
    }
    if (unsupported) return configurationFailure("CODEX_HOST_INCOMPATIBLE");
    return configurationFailure("CODEX_HOST_PROBE_FAILED");
  }
}

function e2eTunnelClientExecutable(): string | "invalid" | undefined {
  const testExecutable =
    process.env.FAROL_E2E === "1"
      ? process.env.FAROL_E2E_TUNNEL_CLIENT
      : undefined;
  if (testExecutable === undefined) return undefined;
  return path.isAbsolute(testExecutable) && !testExecutable.includes("\0")
    ? testExecutable
    : "invalid";
}

async function selectedTunnelClientExecutable(): Promise<
  string | "cancelled" | "invalid"
> {
  const testExecutable = e2eTunnelClientExecutable();
  if (testExecutable !== undefined) return testExecutable;
  return path.join(directory, TUNNEL_CLIENT.entry);
}

async function verifyTunnelClientExecutable(
  executablePath: string,
  expectedDiscovery?: Readonly<{ canonicalPath: string; sha256: string }>,
): Promise<ProductConfigurationResult> {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  try {
    const fixture = e2eTunnelClientExecutable();
    const bundledPath = path.join(directory, TUNNEL_CLIENT.entry);
    const fixtureSelected =
      fixture !== undefined &&
      fixture !== "invalid" &&
      fixture === executablePath;
    if (!fixtureSelected && executablePath !== bundledPath)
      return configurationFailure("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
    const expected = fixtureSelected
      ? expectedDiscovery
      : { canonicalPath: bundledPath, sha256: TUNNEL_CLIENT.sha256 };
    const probe = await probeTunnelClient({
      executablePath,
      ...(expected ? { expectedDiscovery: expected } : {}),
    });
    if (secureMcpConnectorRuntime?.isRunning()) {
      return configurationFailure("CONNECTOR_STOP_REQUIRED");
    }
    const recorded = await configuration.recordSecureMcpTunnelClient(probe);
    if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
    return ProductConfigurationResultSchema.parse({
      ...recorded,
      evidence: {
        kind: "connector.client-probe",
        version: probe.version,
        protocol: probe.protocol,
        executableSha256: probe.executableSha256,
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE") {
      return configurationFailure("TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE");
    }
    if (code === "TUNNEL_CLIENT_SELECTION_INVALID") {
      return configurationFailure("TUNNEL_CLIENT_SELECTION_INVALID");
    }
    if (code === "TUNNEL_CLIENT_EXECUTABLE_UNSAFE") {
      return configurationFailure("TUNNEL_CLIENT_EXECUTABLE_UNSAFE");
    }
    if (code === "TUNNEL_CLIENT_INCOMPATIBLE") {
      return configurationFailure("TUNNEL_CLIENT_INCOMPATIBLE");
    }
    return configurationFailure("TUNNEL_CLIENT_PROBE_FAILED");
  }
}

function reportMaintenanceObservation(
  observation: MaintenanceObservation,
): void {
  if (runtimeEnvironment !== "dev" && process.env.FAROL_E2E !== "1") return;
  try {
    process.stderr.write(
      "FAROL_STARTUP_MAINTENANCE:" +
        JSON.stringify({
          schema: 1,
          buildId: buildIdentity.buildId,
          pid: process.pid,
          ...observation,
        }) +
        "\n",
    );
  } catch {
    /* Diagnostics never grant recovery or retry. */
  }
}
// Built once, here, where the function declarations they replace stood. Every
// call site is inside main() or a later closure, and main() is first called
// near the end of this module, so each one reads the same built functions.
const { reportQualificationObservation, reportOwnedBackendLifecycle } =
  createCoreReporters({ runtimeEnvironment, buildIdentity, operationsStore });

// Bootstrap and separate-app recovery retain their existing challenge workflow.
// Already-attached Setup checks use the same Go owner as the explicit toolbar.
async function verifySecureMcpApp(
  separate?: SeparateAppVerificationScope,
): Promise<ProductConfigurationResult> {
  if (!embeddedBrowserEnabled()) {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_UNAVAILABLE");
  }
  if (!configuration || !chatGptRoute || !secureMcpConnectorRuntime) {
    return configurationFailure("SETTINGS_UNAVAILABLE");
  }
  if (
    desktopAdmission.occupied("chatgpt-task") ||
    desktopAdmission.occupied("connector-task")
  ) {
    return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
  }
  const verificationCore = desktopGoCore;
  if (!verificationCore)
    return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
  const initial = configuration.snapshot();
  if (!separate && initial.status === "ready") {
    const workspaceId = connectorWorkspaceSelection(initial.settings);
    if (
      workspaceId !== undefined &&
      currentConnectorAttachment(
        initial.settings,
        buildIdentity.buildId,
        workspaceId,
      )
    )
      return connectorCheck().testConnectionCommand(
        {
          kind: "connector.test-connection",
          operationId: randomUUID(),
          taskId: selectedTaskId ?? "",
        },
        "setup",
      );
  }
  // Reserve both routes before the first await so concurrent IPC calls cannot
  // both pass the check and race to claim or release the same verification.
  const chatAdmission = desktopAdmission.reserveAdmitted("chatgpt-task");
  const connectorAdmission = desktopAdmission.reserveAdmitted("connector-task");
  let requestedWorkspaceId: string | null | undefined;
  let receiptPending = false;
  let expectedBinding: ConnectorAppVerificationBinding | null = null;
  let verificationRoute: ChatGptRoute | null = null;
  try {
    const snapshot = configuration.snapshot();
    if (snapshot.status !== "ready")
      return configurationFailure("SETTINGS_UNAVAILABLE");
    const settings = snapshot.settings;
    const connector = settings.connectors.secureMcp;
    const runtime = connector.runtime;
    const challenge = connector.challenge;
    const appName = selectedConnectorApp(connector);
    if (appName === null)
      return configurationFailure("CONNECTOR_APP_TARGET_REQUIRED");
    const workspaceId = connectorWorkspaceSelection(settings);
    const proofScope = challenge;
    if (
      !chatGptTaskAdmissionReady() ||
      desktopAdmission.closed() ||
      !secureMcpConnectorRuntime.isRunning() ||
      connector.tunnelId === null ||
      runtime?.state !== "ready" ||
      runtime.buildId !== buildIdentity.buildId ||
      runtime.computerGeneration !== settings.computer.generation ||
      runtime.connectorGeneration !== connector.generation ||
      proofScope === null ||
      proofScope.buildId !== runtime.buildId ||
      proofScope.computerGeneration !== runtime.computerGeneration ||
      proofScope.runtimeGeneration !== runtime.runtimeGeneration ||
      workspaceId === undefined
    ) {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
    }
    if (connector.tunnelId === null) {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
    }
    requestedWorkspaceId = workspaceId;
    expectedBinding = {
      tunnelId: connector.tunnelId,
      connectorGeneration: connector.generation,
      computerGeneration: settings.computer.generation,
      runtimeGeneration: runtime.runtimeGeneration,
      challengeSha256: proofScope.challengeSha256,
      buildId: runtime.buildId,
      workspaceId,
      appName,
    };
    let separateAttempt: SeparateAppVerification | undefined;
    if (separate) {
      if (
        !separateAppVerificationScopeCurrent(
          settings,
          separate,
          buildIdentity.buildId,
        )
      )
        return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
      try {
        // Positive current-Go observation is distinct from absence of an old
        // disk claim. No receipt or unsettled Go verification may be replayed.
        const observed =
          await verificationCore.observeComputerConnectorVerification();
        if (
          observed.receipt !== undefined ||
          observed.catalogueReceipt !== undefined ||
          observed.receiptSha256 !== undefined
        )
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED",
          );
        const current = configuration.snapshot();
        if (
          desktopGoCore !== verificationCore ||
          current.status !== "ready" ||
          !separateAppVerificationScopeCurrent(
            current.settings,
            separate,
            buildIdentity.buildId,
          )
        )
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
          );
        const owner = window;
        if (!owner || owner.isDestroyed())
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED",
          );
        separateAttempt = await confirmSeparateAppVerificationAttempt(
          { expected: separate, binding: observed.binding },
          {
            current: (attempt) => {
              const latest = configuration!.snapshot();
              return (
                window === owner &&
                !owner.isDestroyed() &&
                desktopGoCore === verificationCore &&
                latest.status === "ready" &&
                separateAppVerificationScopeCurrent(
                  latest.settings,
                  attempt.expected,
                  buildIdentity.buildId,
                )
              );
            },
            confirm: async () => {
              const answer = await dialog.showMessageBox(owner, {
                type: "question",
                buttons: ["Cancel", "Test in ChatGPT"],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
                message: "Test this connection in ChatGPT?",
                detail: `Send one test message using ${appName}. Earlier unconfirmed tests stay in Activity and will not be repeated.`,
              });
              return answer.response === 1;
            },
          },
        );
        // A native prompt can remain open while the runtime changes. Owner
        // consent cannot carry a stale Go binding into a later dispatch.
        const afterConsent =
          await verificationCore.observeComputerConnectorVerification();
        if (
          desktopGoCore !== verificationCore ||
          Object.entries(separateAttempt.binding).some(
            ([key, value]) =>
              afterConsent.binding[key as keyof typeof afterConsent.binding] !==
              value,
          )
        )
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
          );
        if (
          afterConsent.receipt !== undefined ||
          afterConsent.catalogueReceipt !== undefined ||
          afterConsent.receiptSha256 !== undefined
        )
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED",
          );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message ===
            "CONNECTOR_APP_VERIFICATION_OWNER_CONSENT_REQUIRED" ||
            error.message === "CONNECTOR_APP_VERIFICATION_STATE_CHANGED")
        )
          return configurationFailure(error.message);
        return configurationFailure(
          "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
        );
      }
    } else if (settings.setup.connect.outcomeUnknown) {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN");
    }
    const stateRoot = statePaths().secureMcpLaunch;
    try {
      if (
        await connectorAppVerificationAttemptExists(
          stateRoot,
          proofScope.challengeSha256,
        )
      ) {
        return configurationFailure(
          "CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED",
        );
      }
    } catch {
      return configurationFailure(
        "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
      );
    }
    // Use the retained browser as a browser. A new temporary document keeps
    // Chromium history, without a second window or a parallel conversation.
    verificationRoute = chatGptRoute;
    const preparedDocument = await prepareConnectorCheckDocument(
      verificationRoute,
      () => {
        const latest = configuration!.snapshot();
        return (
          !desktopAdmission.closed() &&
          desktopGoCore === verificationCore &&
          latest.status === "ready" &&
          expectedBinding !== null &&
          connectorAppBindingCurrent(latest.settings, expectedBinding)
        );
      },
    );
    if (!preparedDocument.ready) {
      console.warn(
        `FAROL_CONNECTOR_CHECK_PREFLIGHT:${JSON.stringify({ schema: 1, stage: preparedDocument.stage })}`,
      );
      return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
    }
    const prompt =
      workspaceId === null
        ? `Use the selected ${appName} app to call farol_connector_verify_catalogue once with challenge "${challenge!.value}". No workspace is configured. Do not read files or run commands. Reply briefly with the result.`
        : `Use the selected ${appName} app to call farol_connector_verify once with challenge "${challenge!.value}" and workspaceId "${workspaceId}". Do not read file contents. Reply briefly with the result.`;
    let claimed = false;
    const timingId = runtimeEnvironment === "dev" ? randomUUID() : null;
    const result = await verificationRoute.runReadonlyTask(
      prompt,
      [],
      {
        ...(timingId === null
          ? {}
          : {
              onConnectorTiming: (event) => {
                console.warn(
                  `FAROL_CONNECTOR_CHECK_TIMING:${JSON.stringify({ schema: 1, id: timingId, ...event })}`,
                );
              },
            }),
        readConnectorReceipt: async () => {
          const current = configuration!.snapshot();
          if (
            !claimed ||
            current.status !== "ready" ||
            expectedBinding === null ||
            !connectorAppBindingCurrent(current.settings, expectedBinding)
          )
            return false;
          const observed =
            await verificationCore.observeComputerConnectorVerification();
          const proof = connectorVerificationProof(observed);
          if (!proof || desktopGoCore !== verificationCore) return false;
          const { receipt, workspaceId } = proof;
          const afterRead = configuration!.snapshot();
          if (
            afterRead.status !== "ready" ||
            !connectorAppBindingCurrent(afterRead.settings, expectedBinding)
          )
            return false;
          return (
            receipt.challengeSha256 === expectedBinding.challengeSha256 &&
            workspaceId === expectedBinding.workspaceId &&
            receipt.binding.buildId === expectedBinding.buildId &&
            receipt.binding.connectorGeneration ===
              String(expectedBinding.connectorGeneration)
          );
        },
        onDispatchIntent: async () => {
          if (claimed) return;
          const admitted = configuration!.snapshot();
          if (
            desktopAdmission.closed() ||
            desktopGoCore !== verificationCore ||
            admitted.status !== "ready" ||
            expectedBinding === null ||
            (separateAttempt &&
              !separateAppVerificationScopeCurrent(
                admitted.settings,
                separateAttempt.expected,
                buildIdentity.buildId,
              )) ||
            !connectorAppBindingCurrent(admitted.settings, expectedBinding)
          )
            throw new Error("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
          await prepareConnectorAppVerificationAttempt(
            stateRoot,
            proofScope.challengeSha256,
            async () =>
              (
                await configuration!.recordSecureMcpAppPending(
                  runtime.runtimeGeneration,
                )
              ).ok,
            separateAttempt,
          );
          claimed = true;
        },
      },
      "temporary-instant",
      { name: appName },
    );
    if (
      result.state === "failed_before_submit" ||
      result.state === "not_authenticated"
    ) {
      const beforeSubmit = configuration.snapshot();
      if (
        beforeSubmit.status !== "ready" ||
        !connectorAppBindingCurrent(beforeSubmit.settings, expectedBinding)
      )
        return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
      if (
        !separateAttempt &&
        beforeSubmit.settings.setup.connect.outcomeUnknown
      ) {
        const cleared =
          await configuration.clearSecureMcpAppPendingBeforeSubmit(
            expectedBinding,
          );
        if (!cleared.ok)
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN",
          );
      }
      const preSubmitCode = result.code;
      return configurationFailure(
        preSubmitCode === "CHATGPT_APP_SELECTION_MISSING" ||
          preSubmitCode === "CHATGPT_APP_SELECTION_AMBIGUOUS" ||
          preSubmitCode === "CHATGPT_APP_SELECTION_CONFLICT" ||
          preSubmitCode === "CHATGPT_APP_SELECTION_LOST" ||
          preSubmitCode === "CHATGPT_COMPOSER_DRAFT_PRESENT" ||
          preSubmitCode === "CHATGPT_TEMPORARY_CHAT_REQUIRED" ||
          preSubmitCode === "CHATGPT_INSTANT_MODEL_REQUIRED"
          ? preSubmitCode
          : "CONNECTOR_APP_VERIFICATION_BEFORE_SUBMIT_FAILED",
      );
    }
    if (!claimed) {
      return configurationFailure(
        result.state === "outcome_unknown"
          ? "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN"
          : "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
      );
    }
    receiptPending = true;
    const current = configuration.snapshot();
    if (
      current.status !== "ready" ||
      expectedBinding === null ||
      !connectorAppBindingCurrent(current.settings, expectedBinding)
    ) {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
    }
  } finally {
    chatAdmission.release();
    connectorAdmission.release();
    // Join any observation started before the fence ended, then take a fresh
    // passive sample. The observer owns identity, expiry and shutdown checks.
    void connectorConnection
      .sample()
      .then(() => connectorConnection.sample())
      .then(currentConnectionStatus)
      .catch(() => undefined);
    // The managed task can temporarily suppress pure page observations. Ask
    // the renderer to read the retained document again after that fence ends.
    try {
      if (
        verificationRoute &&
        window &&
        !window.isDestroyed() &&
        window.webContents &&
        !window.webContents.isDestroyed()
      )
        window.webContents.send(channels.browserRouteState, {
          state: verificationRoute.loadState(),
        });
    } catch {
      // A closing renderer cannot change the original check result.
    }
  }
  if (requestedWorkspaceId === undefined || expectedBinding === null) {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE");
  }
  if (!receiptPending) {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE");
  }
  type ReceiptProbe = Readonly<
    | { state: "changed" }
    | { state: "receipt"; challengeSha256: string; workspaceId: string | null }
  >;
  let observed: ReceiptProbe | null;
  try {
    observed = await waitForConnectorAppReceipt<ReceiptProbe>(
      async () => {
        const current = configuration?.snapshot();
        if (
          current?.status !== "ready" ||
          !connectorAppBindingCurrent(current.settings, expectedBinding)
        ) {
          return { state: "changed" };
        }
        if (desktopGoCore !== verificationCore) return { state: "changed" };
        const state =
          await verificationCore.observeComputerConnectorVerification();
        const proof = connectorVerificationProof(state);
        if (!proof) return null;
        return {
          state: "receipt",
          challengeSha256: proof.receipt.challengeSha256,
          workspaceId: proof.workspaceId,
        };
      },
      (probe) =>
        probe.state === "changed" ||
        (probe.challengeSha256 === expectedBinding.challengeSha256 &&
          probe.workspaceId === requestedWorkspaceId),
    );
  } catch {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN");
  }
  if (observed === null) {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN");
  }
  if (observed.state === "changed") {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
  }
  return connectorCheck().checkSecureMcpAttachment(
    requestedWorkspaceId,
    expectedBinding,
  );
}

function connectorStart() {
  return (connectorStartCache ??= createConnectorStart({
    configuration: () => configuration,
    connectorCredentialStore: () => connectorCredentialStore,
    secureMcpConnectorRuntime: () => secureMcpConnectorRuntime,
    desktopGoCore: () => desktopGoCore,
    summaryFenceRecovery: () => summaryFenceRecovery,
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

// S35-TA-4: the composition itself lives in `workspace-descriptor.ts`, so the
// denied list, the bound identity and the verification rule are exercised by
// tests rather than restated in them. What stays here is reading the current
// snapshot, which only `main.ts` can do.
function verifiedProductWorkspace(
  workspaceId: string,
): VerifiedProductWorkspaceResult {
  const snapshot = configuration?.snapshot();
  if (!snapshot || snapshot.status !== "ready") return { status: "not_found" };
  return verifiedWorkspaceOf(snapshot.settings, workspaceId);
}

async function selectedWorkspaceFile(
  workspace: ApprovedProductWorkspace,
  labels: Readonly<{ title: string; buttonLabel: string }>,
): Promise<string | "cancelled" | "invalid"> {
  let selected: string | undefined;
  const testFile =
    process.env.FAROL_E2E === "1"
      ? process.env.FAROL_E2E_WORKSPACE_FILE
      : undefined;
  if (testFile) {
    selected = testFile;
  } else {
    if (!window) return "invalid";
    const result = await dialog.showOpenDialog(window, {
      title: labels.title,
      buttonLabel: labels.buttonLabel,
      defaultPath: workspace.root,
      properties: ["openFile"],
      securityScopedBookmarks: false,
    });
    if (result.canceled || result.filePaths.length !== 1) return "cancelled";
    selected = result.filePaths[0];
  }
  if (!selected || !path.isAbsolute(selected)) return "invalid";
  const relative = path.relative(workspace.root, selected);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return "invalid";
  }
  return relative.split(path.sep).join("/");
}

function workspaceReadFailure(code: string): ProductConfigurationResult {
  switch (code) {
    case "WORKSPACE_PATH_REFUSED":
    case "WORKSPACE_ROOT_CHANGED":
    case "WORKSPACE_NOT_FOUND":
    case "WORKSPACE_NOT_A_FILE":
    case "WORKSPACE_FILE_TOO_LARGE":
    case "WORKSPACE_NOT_TEXT":
    case "WORKSPACE_SEARCH_TIMEOUT":
      return configurationFailure(code);
    default:
      return configurationFailure("WORKSPACE_READ_FAILED");
  }
}

// The workspace the Codex agent check lists through. A Go build asks the Go
// settings list and a Go failure is the check's failure: it never dispatches
// the Python helper. Only the explicit legacy build keeps the native one.
function codexAgentCheckWorkspace(
  settings: ProductSettings,
): ReadonlyWorkspace {
  if (compiledGoCore === null) return nativeWorkspace;
  return new GoSettingsListWorkspace((workspace, relativePath) =>
    listOwnerWorkspace(
      settings.computer.generation,
      workspace,
      workspace.approvedRoot,
      relativePath,
    ),
  );
}

// `identity` is a live measurement taken by the same verification attempt
// (path-bound approval: never the saved pair); null compares path only.
async function inspectOwnerWorkspace(
  generation: number,
  workspace: Pick<ApprovedProductWorkspace, "workspaceId" | "root">,
  identity: WorkspaceRootIdentity | null,
  diagnosticAction: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!desktopGoCore) return { ok: false, code: "WORKSPACE_READ_FAILED" };
  try {
    const result = await desktopGoCore.inspectSettingsWorkspace(
      generation,
      workspace.workspaceId,
      ".",
    );
    const current = configuration?.snapshot();
    if (
      result.root.path !== workspace.root ||
      (identity !== null &&
        (result.root.device !== identity.device ||
          result.root.inode !== identity.inode)) ||
      current?.status !== "ready" ||
      current.settings.computer.generation !== generation
    )
      return { ok: false, code: "WORKSPACE_ROOT_CHANGED" };
    return { ok: true };
  } catch (error) {
    return refuseComputerSettingsList(
      error,
      console.warn,
      diagnosticAction,
      "go-settings-inspect",
    );
  }
}

// Path-bound approval: a list is bound by path and generation; the Go root
// identity is a live measurement and is not compared with the saved pair.
async function listOwnerWorkspace(
  generation: number,
  workspace: Pick<ApprovedProductWorkspace, "workspaceId" | "root">,
  _savedIdentity: unknown,
  relativePath: string,
  diagnosticAction?: string,
): Promise<
  | { ok: true; entries: string[]; truncated: boolean }
  | { ok: false; code: string }
> {
  if (!desktopGoCore) {
    if (diagnosticAction)
      reportComputerCheckDiagnostic(
        console.warn,
        diagnosticAction,
        "go-unavailable",
        null,
      );
    return { ok: false, code: "WORKSPACE_READ_FAILED" };
  }
  try {
    const result = await desktopGoCore.listSettingsWorkspace(
      generation,
      workspace.workspaceId,
      relativePath,
    );
    const current = configuration?.snapshot();
    if (
      result.root.path !== workspace.root ||
      current?.status !== "ready" ||
      current.settings.computer.generation !== generation
    ) {
      if (diagnosticAction)
        reportComputerCheckDiagnostic(
          console.warn,
          diagnosticAction,
          "root-recheck",
          { code: "WORKSPACE_ROOT_CHANGED" },
        );
      return { ok: false, code: "WORKSPACE_ROOT_CHANGED" };
    }
    return { ok: true, entries: result.entries, truncated: result.truncated };
  } catch (error) {
    // A refused/unknown Go call never selects the legacy executor.
    return refuseComputerSettingsList(error, console.warn, diagnosticAction);
  }
}

function workspaceCommandFailure(code: string): ProductConfigurationResult {
  switch (code) {
    case "AUTHORITY_CAPABILITY_DENIED":
    case "AUTHORITY_COMMAND_DENIED":
    case "AUTHORITY_PATH_DENIED":
      return configurationFailure("WORKSPACE_COMMAND_APPROVAL_REQUIRED");
    case "WORKSPACE_COMMAND_UNSUPPORTED":
    case "WORKSPACE_COMMAND_SANDBOX_UNAVAILABLE":
    case "WORKSPACE_COMMAND_EXECUTABLE_UNTRUSTED":
      return configurationFailure("WORKSPACE_COMMAND_UNAVAILABLE");
    case "WORKSPACE_COMMAND_CANCELLED":
      return configurationFailure("WORKSPACE_COMMAND_CANCELLED");
    case "WORKSPACE_COMMAND_TIMEOUT":
      return configurationFailure("WORKSPACE_COMMAND_TIMEOUT");
    case "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE":
      return configurationFailure("WORKSPACE_COMMAND_OUTPUT_TOO_LARGE");
    case "WORKSPACE_NOT_GIT_REPOSITORY":
      return configurationFailure("WORKSPACE_NOT_GIT_REPOSITORY");
    case "WORKSPACE_GIT_HEAD_UNBORN":
      return configurationFailure("WORKSPACE_GIT_HEAD_UNBORN");
    case "WORKSPACE_ROOT_CHANGED":
      return configurationFailure("WORKSPACE_ROOT_CHANGED");
    case "WORKSPACE_GIT_METADATA_NOT_APPROVED":
      return configurationFailure("WORKSPACE_GIT_METADATA_NOT_APPROVED");
    // N02: the snapshot route's own closed refusals, surfaced one for one.
    case "WORKSPACE_GIT_ALTERNATES_UNSUPPORTED":
    case "WORKSPACE_INDEX_CHANGED_DURING_SNAPSHOT":
    case "WORKSPACE_CHANGED_DURING_SNAPSHOT":
    case "WORKSPACE_TRACKED_LIST_TOO_LARGE":
    case "WORKSPACE_TRACKED_PATH_UNSUPPORTED":
    case "WORKSPACE_SNAPSHOT_TOO_LARGE":
    case "WORKSPACE_SNAPSHOT_CROSS_VOLUME":
    case "WORKSPACE_SNAPSHOT_CLONE_UNSUPPORTED":
    case "WORKSPACE_PATH_REFUSED":
    case "WORKSPACE_NOT_FOUND":
      return configurationFailure(code);
    default:
      return configurationFailure("WORKSPACE_COMMAND_FAILED");
  }
}

function workspaceMutationFailure(code: string): ProductConfigurationResult {
  switch (code) {
    case "WORKSPACE_PATH_REFUSED":
    case "WORKSPACE_ROOT_CHANGED":
    case "WORKSPACE_NOT_FOUND":
    case "WORKSPACE_NOT_A_FILE":
    case "WORKSPACE_FILE_TOO_LARGE":
    case "WORKSPACE_NOT_TEXT":
    case "WORKSPACE_MUTATION_CONFLICT":
    case "WORKSPACE_EDIT_NO_MATCH":
    case "WORKSPACE_EDIT_NOT_UNIQUE":
    case "WORKSPACE_MUTATION_OUTCOME_UNKNOWN":
      return configurationFailure(code);
    case "COMPUTER_MUTATION_OPERATION_CONFLICT":
      return configurationFailure("WORKSPACE_MUTATION_CONFLICT");
    case "AUTHORITY_CAPABILITY_DENIED":
    case "AUTHORITY_MUTATION_OWNERSHIP_DENIED":
    case "AUTHORITY_PATH_DENIED":
      return configurationFailure("WORKSPACE_WRITE_APPROVAL_REQUIRED");
    default:
      return configurationFailure("WORKSPACE_MUTATION_FAILED");
  }
}

function goWorkspaceEditResult(
  delivery: SettingsDeliveryResult,
  redelivered: boolean,
): ProductConfigurationResult {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  if (delivery.state === "pending")
    return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
  const result = delivery.result!;
  // The Go offer has already performed any required uncertainty invalidation.
  // This adapter only projects the retained result for the React surface.
  if (result.phase !== "completed")
    return workspaceMutationFailure(result.failure!.code);
  const receipt = result.receipt!;
  return ProductConfigurationResultSchema.parse({
    ok: true,
    snapshot: configuration.snapshot(),
    evidence: {
      kind: "computer.workspace-mutation",
      operationId: result.operationId,
      workspaceId: result.workspaceId,
      relativePath: receipt.relativePath,
      operation: receipt.operation,
      bytes: Number(receipt.bytes),
      replacements: receipt.replacements,
      beforeSha256: receipt.beforeSHA256,
      afterSha256: receipt.afterSHA256,
      resultRetention: delivery.retention,
      redelivered,
    },
  });
}

const connectorSetupReplies = new ConnectorSetupReplies();

let operationsLog: OperationsStore | undefined;
let processAuditCollector: ProcessAuditCollector | undefined;
let processAuditObserver: ProcessAuditObserver | undefined;
function operationsStore(): OperationsStore {
  return (operationsLog ??= new OperationsStore(statePaths().operations));
}
function configureProduct(value: unknown): Promise<ProductConfigurationResult> {
  const parsed = ProductConfigurationCommandSchema.safeParse(value);
  if (!parsed.success) return configureProductObserved(value);
  // This bounded page query has no effect to reconcile. Inconclusive status
  // remains a diagnostic, never a durable unresolved operation.
  if (parsed.data.kind === "chatgpt.observe-sign-in")
    return configureProductObserved(parsed.data);
  const metadata = configurationOperation(parsed.data);
  return observeOperation(operationsStore(), metadata, () => {
    const original = configureProductObserved(value);
    void original.then(
      (result) => {
        try {
          if (result.snapshot.status === "ready") {
            const workspaces = result.snapshot.settings.computer.workspaces;
            operationsStore().setWorkspaceLabels(workspaces);
            Object.assign(metadata.target, configurationResultTarget(result));
          }
        } catch {
          // Optional labels cannot replace the configuration result or notification.
        }
      },
      () => undefined,
    );
    return original;
  });
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
    savedChatBridgeRuntime: () => savedChatBridgeRuntime,
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
    routeBRuntime: () => routeBRuntime,
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
    routeBRuntime: () => routeBRuntime,
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
    summaryFenceRecovery: () => summaryFenceRecovery,
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

async function configureProductObserved(
  value: unknown,
): Promise<ProductConfigurationResult> {
  return configurationObserved().configureProductObserved(value);
}

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

// The reply's last step before Electron carries it to the renderer. The
// command itself has fully completed here — its edit, receipt and durable
// pending record are already on disk — so a dropped reply is a reply lost in
// transit and nothing else. Outside the E2E lane the decision is always
// "deliver" and the production result is returned untouched.
const configurationReplyFault = createConfigurationReplyFault(process.env);

function deliverConfigurationReply(
  commandKind: string,
  result: ProductConfigurationResult,
): ProductConfigurationResult | Promise<ProductConfigurationResult> {
  if (configurationReplyFault(commandKind, result) === "deliver") return result;
  const operationId =
    result.ok && result.evidence?.kind === "computer.workspace-mutation"
      ? result.evidence.operationId
      : "unknown";
  process.stderr.write(
    `farol-e2e:reply-dropped ${commandKind} ${operationId}\n`,
  );
  // Never settles: the renderer's `ipcRenderer.invoke` receives nothing at
  // all, which is the state the durable pending-edit record exists for.
  return new Promise<ProductConfigurationResult>(() => {});
}

async function configureAdmittedProduct(
  command: ProductConfigurationCommand,
): Promise<ProductConfigurationResult> {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  // These legacy checks hard-code a model the owner no longer permits.
  // Refuse before starting a host or changing verification evidence; retain
  // the old reader and the separate cleanup route for existing assignments.
  if (
    new Set<string>(["host.run-codex-smoke", "host.run-codex-agent-check"]).has(
      command.kind,
    )
  )
    return configurationFailure("CODEX_HOST_MODEL_UNAVAILABLE");
  if (command.kind === "connector.test-connection")
    return connectorCheck().testConnectionCommand(command);
  if (command.kind === "chatgpt.run-deep-test")
    return configurationDeep().runManualDeepTest(
      command.operationId,
      command.taskId,
      command.test ?? "deep",
    );
  if (command.kind === "chatgpt.deep-test-status")
    return configurationDeep().deepTestStatus();
  if (command.kind === "chatgpt.ack-deep-test")
    return configurationDeep().acknowledgeDeepTest(command.operationId);
  if (command.kind.startsWith("computer.")) {
    return configurationComputer().configureAdmittedComputer(
      command as ComputerConfigurationCommand,
    );
  }
  switch (command.kind) {
    case "chatgpt.inspect-chat-account":
    case "chatgpt.start-conversation":
    case "chatgpt.observe-readonly-conversation":
    case "chatgpt.ack-readonly-conversation":
    case "chatgpt.follow-readonly-conversation":
    case "chatgpt.recover-task-result":
    case "chatgpt.reset-conversation":
    case "chatgpt.ack-task-result":
    case "chatgpt.open-sign-in":
    case "chatgpt.observe-sign-in":
    case "chatgpt.present-browser":
    case "chatgpt.open-browser":
    case "chatgpt.toggle-sidebar":
    case "chatgpt.verify":
    case "chatgpt.sign-in-return":
    case "chatgpt.verification-return":
    case "chatgpt.prepare-attachment-task":
    case "chatgpt.submit-attachment-task":
    case "chatgpt.cancel-attachment-task":
    case "chatgpt.prepare-readonly-task":
    case "chatgpt.inspect-readonly-account":
    case "chatgpt.approve-readonly-account":
    case "chatgpt.submit-readonly-task":
    case "chatgpt.cancel-readonly-task":
      return configurationChatgpt().configureAdmittedChatgpt(command);
    case "onboarding.open-help":
    case "support.export":
    case "general.update":
    case "setup.progress":
      return configurationSupport().configureAdmittedSupport(command);
    case "connector.select-client":
    case "connector.discover-client":
    case "connector.select-discovered-client":
    case "connector.save-and-connect":
    case "connector.configure":
    case "connector.select-chatgpt-app":
    case "connector.start":
    case "connector.repair":
    case "connector.check-health":
    case "connector.check-attachment":
    case "connector.verify-app":
    case "connector.verify-separate-app":
    case "connector.stop":
      return configurationConnector().configureAdmittedConnector(command);

    case "dev-proof.prepare":
      return devProof().prepare();
    case "dev-proof.run":
      return devProof().run();

    case "host.select-codex":
    case "host.discover-codex":
    case "host.select-discovered-codex":
    case "host.verify-codex":
    case "host.refresh-codex-task-models":
    case "host.configure-codex-tasks":
    case "host.clear-codex-tasks":
    case "host.run-route-b-check":
    case "host.run-codex-smoke":
    case "host.run-codex-agent-check":
    case "host.remove-codex":
      return configurationHost().configureAdmittedHost(command);
    case "model.status":
    case "model.preview":
    case "model.apply":
    case "model.rollback":
    case "model.rotate-token":
      return configurationModel().configureAdmittedModel(command);
  }
  return configurationFailure("SETTINGS_INPUT_INVALID");
}

function currentRuntimeStatus(): RuntimeStatus {
  return {
    state: runtimeState,
    error: runtimeError,
    identity: runtime?.identity ?? null,
    embeddedNode: runtime?.embeddedNode ?? null,
    embeddedElectron: runtime?.embeddedElectron ?? process.versions.electron,
  };
}

function publishRuntimeStatus(): void {
  window?.webContents.send(channels.runtimeState, currentRuntimeStatus());
}

function desktopBrandImage() {
  const icon = nativeImage.createFromPath(
    path.join(
      directory,
      activeDesktopIdentity.environment === "dev"
        ? "farol-dev-mark.png"
        : activeDesktopIdentity.environment === "owner-preview"
          ? "farol-preview-mark.png"
          : "farol-mark.png",
    ),
  );
  if (icon.isEmpty()) throw new Error("DESKTOP_BRAND_IMAGE_INVALID");
  return icon;
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

function handleRuntimeExit(code: number | null): void {
  if (runtimeStopping) {
    runtimeChild = null;
    runtime = null;
    return;
  }
  taskCountsBeforeRuntimeExit = {
    running: streamControllers.size,
    waiting: pendingComputer.size,
    failed: taskSurfaceFailures.size,
  };
  runtimeChild = null;
  runtime = null;
  runtimeState = "failed";
  runtimeError =
    code === 0 ? "RUNTIME_PROCESS_EXITED" : "RUNTIME_PROCESS_FAILED";
  stopStreams();
  taskSurfaceFailures.clear();
  pendingComputer.clear();
  disposeTaskViews("runtime");
  publishRuntimeStatus();
}

async function startRuntime(): Promise<void> {
  if (desktopAdmission.closed()) return;
  if (runtimeChild !== null || ownedLocalRuntimes.size !== 0) {
    throw new Error("LOCAL_RUNTIME_ALREADY_OWNED");
  }
  runtimeStopping = false;
  const resources = installedUpdates.resources();
  await resources.recheck();
  if (runtimeStopping || desktopAdmission.closed()) return;
  const child = spawn(
    resources.executable,
    [path.join(resources.directory, "runtime.cjs")],
    {
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        FAROL_RUNTIME_IDENTITY: activeDesktopIdentity.runtimeIdentity,
        FAROL_PREVIEW_SCENARIO: process.argv.includes(
          "--preview-stream-failure",
        )
          ? "stream-failure"
          : process.env.FAROL_E2E === "1" &&
              process.argv.includes("--preview-runtime-start-failure")
            ? "startup-failure"
            : process.argv.includes("--preview-failure")
              ? "failure"
              : "normal",
        FAROL_PREVIEW_MODE: demoMode ? "demo" : "empty",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      windowsHide: true,
    },
  );
  runtimeChild = child;
  // runtime.cjs is the build-qualified in-memory preview service. Real Go,
  // connector and command owners keep their independent shutdown obligations.
  const lifetime = observeLocalRuntime(child, "in-memory-preview");
  ownedLocalRuntimes.set(lifetime, `local-runtime-${++localRuntimeGeneration}`);
  void lifetime.closed.then(
    () => ownedLocalRuntimes.delete(lifetime),
    () => {
      /* A failed shutdown remains an unconfirmed Quit obligation. */
    },
  );
  try {
    runtime = await new Promise<RuntimeReady>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("RUNTIME_START_TIMEOUT"));
      }, 10_000);
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("RUNTIME_PROCESS_NOT_STARTED"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (settled) {
          handleRuntimeExit(code);
          return;
        }
        settled = true;
        reject(
          new Error(
            code === 0 ? "RUNTIME_EXITED" : `RUNTIME_START_FAILED_${code}`,
          ),
        );
      });
      child.on("message", (message) => {
        const parsed = readySchema.safeParse(message);
        if (!parsed.success || settled) return;
        if (parsed.data.identity !== activeDesktopIdentity.runtimeIdentity) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("RUNTIME_IDENTITY_MISMATCH"));
          return;
        }
        const exactTasks =
          parsed.data.tasks.length === expectedTasks.length &&
          parsed.data.tasks.every((task, index) => {
            const expected = expectedTasks[index];
            return (
              expected !== undefined &&
              task.ownerId === expected.ownerId &&
              task.sessionId === expected.sessionId &&
              task.taskId === expected.taskId &&
              task.turnId === expected.turnId &&
              task.generation === expected.generation &&
              task.label === expected.label &&
              task.hasComputer === expected.hasComputer
            );
          });
        if (!exactTasks) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("RUNTIME_TASK_MANIFEST_MISMATCH"));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(parsed.data);
      });
    });
    runtimeState = "ready";
    taskCountsBeforeRuntimeExit = null;
  } catch (error) {
    runtimeState = "failed";
    runtimeError =
      error instanceof Error ? error.message : "RUNTIME_START_FAILED";
    runtimeStopping = true;
    child.kill();
    runtimeChild = null;
  }
}

async function runtimeJson(
  pathname: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  if (!runtime) return { error: "RUNTIME_OFFLINE" };
  const options: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${runtime.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(
    `http://127.0.0.1:${runtime.port}${pathname}`,
    options,
  );
  if (response.status === 204) return { ok: true };
  const value = (await response.json()) as unknown;
  return response.ok ? value : { ok: false, status: response.status, value };
}

function contextFixtureHistory(epoch: number): readonly unknown[] {
  return [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Keep every change local until owner review.",
        },
      ],
    },
    {
      type: "function_call_output",
      call_id: `context-receipt-${epoch}`,
      output: `receipt-context-epoch-${epoch}`,
    },
    {
      type: "function_call_output",
      call_id: `context-unknown-${epoch}`,
      output: "outcome_unknown",
    },
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Use report-v2.md; report-v1.md is obsolete. Never publish, push, sign, or release.",
        },
      ],
    },
  ];
}

async function runContextFixtureControl(
  taskId: string,
  action: "compact-context-fixture" | "confirm-context-fixture",
): Promise<unknown> {
  if (process.env.FAROL_E2E !== "1" || demoMode) {
    return { error: "IPC_CONTROL_INVALID" };
  }
  const task = liveTaskRegistry.get(taskId);
  const controller = codexContextController;
  if (!task || task.provider !== "chatgpt" || !controller) {
    return { error: "CONTEXT_FIXTURE_UNAVAILABLE" };
  }
  const binding = contextBinding(taskId);
  if (action === "compact-context-fixture") {
    const epoch = task.context?.phase === "active" ? task.context.epoch : 1;
    const compacted = await controller.continuity.compact({
      endpoint: "responses_compact",
      body: {
        model: contextModel,
        input: contextFixtureHistory(epoch),
      },
      metadataHeader: JSON.stringify({
        thread_id: taskId,
        turn_id: `${task.turnId}-context-compact-${epoch}`,
      }),
    });
    return compacted.ok
      ? {
          ok: true,
          phase: liveTaskRegistry.get(taskId)?.context?.phase ?? null,
        }
      : { error: compacted.error.code };
  }

  const session = await controller.store.load(binding);
  const operation = session?.operation;
  if (
    !session ||
    session.phase !== "handoff_offered" ||
    !operation?.checkpointId
  ) {
    return { error: "CONTEXT_FIXTURE_CONFIRMATION_UNAVAILABLE" };
  }
  const [checkpoint, source] = await Promise.all([
    controller.store.get(binding, operation.checkpointId),
    controller.store.getSource(binding, operation.operationId),
  ]);
  if (!checkpoint || !source) {
    return { error: "CONTEXT_FIXTURE_CONFIRMATION_UNAVAILABLE" };
  }
  const handoff = buildHostCompactionHandoff(
    {
      variant: source.variant,
      identity: {
        threadId: taskId,
        turnId: `${task.turnId}-context-compact-${session.epoch}`,
        modelId: contextModel,
      },
      sourceBoundary: source.sourceBoundary,
      history: source.history,
    },
    checkpoint,
    {
      maximumCheckpointContentBytes: 256 * 1_024,
      retainedTailMaximumBytes: 64 * 1_024,
      maximumHandoffBytes: 128 * 1_024,
    },
  );
  if (!handoff.ok) return { error: handoff.error.code };
  const input =
    handoff.value.variant === "unary_replacement_history"
      ? handoff.value.response.output
      : [handoff.value.item];
  const confirmed = await controller.continuity.prepareTurn({
    body: {
      model: contextModel,
      input,
      client_metadata: {
        session_id: taskId,
        thread_id: taskId,
        turn_id: `${task.turnId}-context-confirm-${session.epoch}`,
      },
    },
  });
  return confirmed.ok
    ? {
        ok: true,
        phase: liveTaskRegistry.get(taskId)?.context?.phase ?? null,
      }
    : { error: confirmed.error.code };
}

function installIpc(): void {
  ipcMain.on(updatesChannels.projection, (event, value: unknown) => {
    if (
      !isTrustedIpcSender(event, window) ||
      !window ||
      event.senderFrame !== window.webContents.mainFrame
    )
      return;
    updatesPanel.bindOwner(window, installedUpdates.resources().directory);
    updatesPanel.publish(event, value);
  });
  ipcMain.on(updatesChannels.settled, (event, value: unknown) =>
    updatesPanel.settle(event, value),
  );
  ipcMain.on(updatesChannels.directSettled, (event, value: unknown) =>
    updatesPanel.settleDirect(event, value),
  );
  ipcMain.on(updatesChannels.intent, (event, value: unknown) =>
    updatesPanel.relay(event, value),
  );
  ipcMain.on(updatesChannels.close, (event) => updatesPanel.close(event));
  ipcMain.handle(updatesChannels.state, (event) =>
    updatesPanel.isPanel(event)
      ? updatesPanel.state()
      : { status: "unavailable" },
  );
  ipcMain.on(updatesChannels.open, (event) => {
    if (!updatesPanel.isOwner(event) || !window || desktopAdmission.closed())
      return;
    const owner = window;
    void updatesPanel
      .open({
        owner,
        directory: installedUpdates.resources().directory,
        mode: windowMode,
        place: () => selectedVisibleTestPlacement(UPDATES_PANEL_SIZE).bounds,
        admitted: () =>
          window === owner &&
          !owner.isDestroyed() &&
          !desktopAdmission.closed(),
      })
      .catch(() => console.error("DESKTOP_UPDATES_PRESENTATION_FAILED"));
  });
  const settings = configuration?.snapshot();
  if (settings?.status === "ready")
    operationsStore().setWorkspaceLabels(settings.settings.computer.workspaces);
  ipcMain.handle(channels.operations, async (event) => {
    if (!isTrustedIpcSender(event, window))
      return { entries: [], corruptLines: 0, writeFailures: 1 };
    const snapshot = await operationsStore().snapshot();
    return {
      ...snapshot,
      connectionChecking:
        startupConnectionChecking || connectionAdmissionInProgress(),
    };
  });
  ipcMain.handle(channels.selfTest, (event, value: unknown) =>
    isTrustedIpcSender(event, window) &&
    event.senderFrame === event.sender.mainFrame
      ? runSelfTestCommand(
          () => desktopGoCore,
          () => !desktopAdmission.closed(),
          value,
        )
      : { ok: false, code: "SELF_TEST_UNAVAILABLE" },
  );
  ipcMain.handle(
    channels.installedUpdate,
    async (event, value: unknown, operationId: unknown) => {
      if (!isTrustedIpcSender(event, window))
        return { error: "IPC_SENDER_DENIED" };
      const parsed = InstalledUpdateCommandSchema.safeParse(value);
      const tracked =
        installedUpdates.updater !== null &&
        parsed.success &&
        parsed.data.kind !== "status";
      if (tracked && !updatesPanel.beginDirect(event, operationId))
        return { phase: "unavailable", code: "UPDATE_ACTION_INVALID" };
      let returned = false;
      let hostResult: unknown;
      try {
        const result = await installedUpdates.command(value);
        hostResult = result;
        returned = true;
        return result;
      } finally {
        if (tracked)
          updatesPanel.endDirect(event, operationId, returned, hostResult);
      }
    },
  );
  ipcMain.handle(channels.bootstrap, (event) =>
    isTrustedIpcSender(event, window)
      ? bootstrap()
      : { error: "IPC_SENDER_DENIED" },
  );
  ipcMain.handle(channels.snapshot, (event) =>
    isTrustedIpcSender(event, window)
      ? runtimeJson("/snapshot")
      : { error: "IPC_SENDER_DENIED" },
  );
  ipcMain.handle(channels.configuration, (event, value: unknown) =>
    isTrustedIpcSender(event, window)
      ? configureProduct(value)
      : configurationFailure("SETTINGS_UNAVAILABLE"),
  );
  ipcMain.handle(channels.chatHistory, (event, value: unknown) =>
    isTrustedIpcSender(event, window)
      ? readChatHistoryView(() => desktopGoCore, value)
      : { error: "IPC_SENDER_DENIED" },
  );
  ipcMain.handle(channels.retiredReplies, (event, value: unknown) =>
    isTrustedIpcSender(event, window)
      ? readRetiredRepliesView(() => desktopGoCore, value)
      : { error: "IPC_SENDER_DENIED" },
  );
  ipcMain.handle(channels.task, (event, value: unknown) =>
    isTrustedIpcSender(event, window)
      ? runProductTaskCommand(value)
      : taskFailure("TASKS_UNAVAILABLE"),
  );
  ipcMain.handle(channels.navigationShortcuts, (event, value: unknown) => {
    if (!isTrustedIpcSender(event, window)) return { ok: false };
    if (desktopAdmission.closed()) return { ok: false };
    const parsed = parseNavigationShortcuts(value);
    if (!parsed) return { ok: false };
    navigationShortcuts = parsed;
    installApplicationMenu();
    return { ok: true };
  });
  ipcMain.handle(channels.control, async (event, value: unknown) => {
    if (desktopAdmission.closed()) return { error: "UPDATE_IN_PROGRESS" };
    if (!isTrustedIpcSender(event, window))
      return { error: "IPC_SENDER_DENIED" };
    const parsed = controlSchema.safeParse(value);
    if (
      parsed.success &&
      (parsed.data.action === "compact-context-fixture" ||
        parsed.data.action === "confirm-context-fixture")
    ) {
      return runContextFixtureControl(parsed.data.taskId, parsed.data.action);
    }
    if (
      !parsed.success ||
      !expectedTasks.some((task) => task.taskId === parsed.data.taskId)
    ) {
      return { error: "IPC_CONTROL_INVALID" };
    }
    const task = runtime?.tasks.find(
      (candidate) => candidate.taskId === parsed.data.taskId,
    );
    if (!task) return { error: "RUNTIME_OFFLINE" };
    if (taskSurfaceFailures.has(task.taskId)) {
      return { error: "TASK_STREAM_FAILED" };
    }
    const correlation =
      parsed.data.action === "release-tool"
        ? pendingComputer.get(task.taskId)
        : { ...task, callId: null };
    if (!correlation) return { error: "CONTROL_NOT_PENDING" };
    return runtimeJson(
      `/control/${encodeURIComponent(parsed.data.taskId)}/${parsed.data.action}`,
      "POST",
      {
        ownerId: correlation.ownerId,
        sessionId: correlation.sessionId,
        taskId: correlation.taskId,
        turnId: correlation.turnId,
        generation: correlation.generation,
        callId:
          "callId" in correlation && typeof correlation.callId === "string"
            ? correlation.callId
            : null,
      },
    );
  });
  ipcMain.handle(channels.browserHistory, (event, value: unknown) => {
    const request = z
      .object({
        taskId: z.string().max(200),
        direction: z.union([z.literal(-1), z.literal(1)]),
      })
      .strict()
      .safeParse(value);
    if (
      !request.success ||
      desktopAdmission.closed() ||
      !isTrustedIpcSender(event, window) ||
      section !== "browser" ||
      setupOpen ||
      shellOverlay !== "none" ||
      request.data.taskId !== selectedTaskId
    )
      return { handled: false, taskId: "", back: false, forward: false };
    const route =
      selectedTaskId === "" ? chatGptRoute : liveTaskRoutes.get(selectedTaskId);
    const handled = route?.travelHistory(request.data.direction) ?? false;
    return {
      handled,
      taskId: selectedTaskId,
      back: false,
      forward: false,
      ...route?.navigationHistory(),
    };
  });
  ipcMain.on(channels.layout, (event, value: unknown) => {
    if (desktopAdmission.closed() || !isTrustedIpcSender(event, window)) return;
    applyRendererLayout(value);
  });
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

// Set when a quit begins; a quit drain always ends in the real quit.
let startupRecovery: StartupRecoveryWindow | null = null;

function isPrimaryReady(): boolean {
  return primaryStartupReady({
    stopping:
      desktopAdmission.quitInProgress ||
      runtimeStopping ||
      desktopAdmission.installedUpdateAdmission,
    runtimeState,
    windowReady: window !== null && !window.isDestroyed(),
    taskViewCount: [...taskViewKinds.values()].filter(
      (kind) => kind === "runtime",
    ).length,
    expectedTaskViewCount: expectedTasks.length,
  });
}

async function handleSecondInstance(candidate: unknown): Promise<void> {
  const decision = decideSecondInstance(launchIdentity, candidate);
  if (!decision) return;
  let status = decision.status;
  if (
    status === "reopened" &&
    (desktopAdmission.quitInProgress ||
      runtimeStopping ||
      desktopAdmission.installedUpdateAdmission)
  ) {
    // Quit/update owns admission: acknowledge that it cannot take this launch
    // instead of reopening a window that is about to close.
    status = "reopen-failed";
  }
  if (status === "reopened" && startupRecovery !== null) {
    try {
      await startupRecovery.reopen();
    } catch {
      /* The primary owns failure cleanup. */
    }
    // A recovery window is available, but normal runtime readiness is not.
    status = "reopen-failed";
  }
  if (status === "reopened") {
    try {
      await primaryStartup.whenReady();
      // Quit/update may have begun while this launch waited for startup: check
      // again before opening a window that is about to close.
      if (
        desktopAdmission.quitInProgress ||
        runtimeStopping ||
        desktopAdmission.installedUpdateAdmission
      ) {
        status = "reopen-failed";
      } else {
        const outcome = await containWindowOpenFailure(
          ensureWindow,
          recoverWindowOpenFailure,
        );
        if (outcome === "failed" || !isPrimaryReady()) {
          status = "reopen-failed";
        }
      }
    } catch {
      status = "reopen-failed";
    }
  }
  try {
    await writeInstanceAcknowledgement(
      app.getPath("userData"),
      candidate,
      status,
      launchIdentity,
    );
  } catch (error) {
    // The secondary process fails closed if this bounded acknowledgement is
    // unavailable. Never reopen a mismatched build merely to make it exit 0.
    // Say that it happened, though: without this line the secondary waits its
    // whole deadline and reports "unverified" for a reason nothing on the
    // primary's side ever recorded. The token is content-free by contract.
    process.stderr.write(
      `${secondInstanceAcknowledgementPrefix}${acknowledgementFailureCode(error)}\n`,
    );
  }
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
  app.on(
    "second-instance",
    (_event, _commandLine, _workingDirectory, candidate) => {
      void handleSecondInstance(candidate);
    },
  );
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
  let freshStartup = false;
  const previousHostAdmissionReady = await withInstalledStartupFence(
    process.argv,
    app.getPath("userData"),
    buildIdentity.buildId,
    observeUpdateRelaunch,
    async (updateRelaunch, verify, lease) => {
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
      freshStartup = compiledGoCore !== null;
      if (freshStartup) {
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
              !primaryInstanceLock ||
              !app.hasSingleInstanceLock() ||
              desktopAdmission.quitInProgress ||
              runtimeStopping ||
              !(await verify())
            )
              throw Error("FRESH_START_CURRENT_OWNER_UNCONFIRMED");
          });
      }
      if (!freshStartup && compiledGoCore !== null && !clean) {
        const assertMaintenanceCurrent = async () => {
          await updateRelaunch?.recheck();
          if (
            !primaryInstanceLock ||
            !app.hasSingleInstanceLock() ||
            desktopAdmission.quitInProgress ||
            runtimeStopping ||
            desktopGoCore !== null ||
            configuration !== null ||
            startupRecovery !== null ||
            secureMcpConnectorRuntime !== null ||
            connectorStartInFlight !== null ||
            modelLifecycle !== null ||
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
          if (!(await verify()))
            throw new Error("STARTUP_PROMOTION_LEASE_LOST");
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
            quitTracePhase = "recovery";
            startupRecovery = openStartupRecoveryWindow({
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
                selectedVisibleTestPlacement({ width: 640, height: 520 })
                  .bounds,
              quitSignals,
              onQuitting: () => {
                desktopAdmission.beginQuit();
              },
            });
            await startupRecovery.ready;
            process.stderr.write(
              `${secondInstanceResultPrefix}primary-recovery\n`,
            );
            await startupRecovery.quitRequested;
          } finally {
            try {
              await session.close();
            } finally {
              startupRecovery?.dispose();
            }
          }
          return false;
        }
      }
      if (compiledGoCore !== null && !freshStartup) {
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
    },
  );
  if (startupRecovery !== null) {
    quitTracePhase = "recovery";
    // Only the UI's startup lease was released. The predecessor remains
    // unconfirmed, so normal Quit receipts and marker removal are forbidden.
    app.quit();
    return;
  }
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
  configuration = new ProductConfigurationService(
    new ProductSettingsStore({
      root: statePaths().state,
    }),
    {
      taskModelPolicy: async (revision, tasks, selection) => {
        const core = desktopGoCore;
        if (!core)
          throw new BridgeError(
            "unavailable",
            "host_task_model_policy_unavailable",
          );
        const result = await core.resolveTaskModel(revision, tasks, selection);
        if (desktopGoCore !== core)
          throw new BridgeError(
            "unavailable",
            "host_task_model_policy_changed",
          );
        return result;
      },
      taskSettingsCompare: async (before, candidate) => {
        const core = desktopGoCore;
        if (!core)
          throw new BridgeError(
            "unavailable",
            "host_task_settings_unavailable",
          );
        const changed = await core.compareTaskSettings(before, candidate);
        if (desktopGoCore !== core)
          throw new BridgeError("unavailable", "host_task_settings_changed");
        return changed;
      },
      // S35-N03d: the same cross-process lease `liveTaskRegistry` takes for
      // admission (same lease file, same "admission" role — see the guard
      // above), so a guarded edit's durable critical phase excludes a live
      // promotion exactly the way a Chat turn or a native Agent start
      // already does. An unsafe or unreadable lease state refuses the edit
      // with its own readable code rather than surfacing a crash.
      promotionLease: {
        acquireForAdmission: async () => {
          const handle = await acquirePromotionLease(
            app.getPath("userData"),
            buildIdentity.buildId,
            "admission",
          ).catch(() => null);
          if (!handle) return null;
          return {
            release: () => releasePromotionLease(handle),
            verify: () => verifyPromotionLease(handle),
          };
        },
      },
    },
  );
  await runDesktopStartupBoundary("configuration", () =>
    configuration!.initialize(),
  );
  const e2eChatGptUrl =
    process.env.FAROL_E2E === "1"
      ? process.env.FAROL_E2E_CHATGPT_URL
      : undefined;
  let chatGptUrl = CHATGPT_HOME;
  let e2eChatGptOrigin: string | null = null;
  if (e2eChatGptUrl) {
    const parsed = new URL(e2eChatGptUrl);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
      throw new Error("CHATGPT_E2E_URL_INVALID");
    }
    chatGptUrl = parsed.href;
    e2eChatGptOrigin = parsed.origin;
  }
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
  // via `initializeRouteBRuntime()` below, and can also close before it), so
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
          : routeBModelTurnHandler(() => routeBRuntime?.endpoint ?? null),
      ),
      compactionHandler: recordedCompaction(
        operationsStore(),
        routeBModelCompactionHandler(() => routeBRuntime?.endpoint ?? null),
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
    await initializeCodexContextController();
    await reconcileContextAfterRestart();
    await initializeCallerRelay();
    await initializeSavedChatBridge();
    await initializeRouteBRuntime();
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
      const savedChat = savedChatBridgeRuntime;
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
                if (savedChatBridgeRuntime === savedChat)
                  savedChatBridgeRuntime = null;
              }
            }
          },
        };
      } else if (savedChat) {
        savedChatBridgeRuntime = null;
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
      const routeB = routeBRuntime;
      routeBRuntime = null;
      if (routeB)
        closers.push({ name: "route-b", close: () => routeB.close() });
      const relay = callerRelayRuntime;
      callerRelayRuntime = null;
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
  app.releaseSingleInstanceLock();
  process.stderr.write(`${secondInstanceResultPrefix}reopen-failed\n`);
  app.exit(1);
} else if (!primaryInstanceLock) {
  void waitForInstanceAcknowledgement(app.getPath("userData"), instanceRequest)
    .then(async (acknowledgement) => {
      const accepted =
        acknowledgement?.status === "reopened" &&
        sameLaunchIdentity(launchIdentity, acknowledgement);
      if (!accepted) {
        const outcome =
          acknowledgement?.status === "identity-mismatch" ||
          acknowledgement?.status === "reopen-failed"
            ? acknowledgement.status
            : "unverified";
        process.stderr.write(
          `${secondInstanceRefusalMessage(instanceRequest, acknowledgement)}\n`,
        );
        process.stderr.write(`${secondInstanceResultPrefix}${outcome}\n`);
        if (acknowledgement === null) {
          // Nothing arrived within the deadline. Say whether the primary
          // published nothing at all, or published for a launch that is not
          // this one — the second is a disagreement no wait can resolve.
          const foreign = await foreignAcknowledgementCount(
            app.getPath("userData"),
            instanceRequest,
          ).catch(() => -1);
          process.stderr.write(
            `${secondInstanceAcknowledgementPrefix}${foreign === 0 ? "absent" : `foreign:${foreign}`}\n`,
          );
        }
        app.quit();
        return;
      }
      // Match Electron's graceful secondary-instance shutdown. A hard exit of
      // the second macOS application process can hide the primary window that
      // was just reopened.
      process.stderr.write(`${secondInstanceResultPrefix}reopened\n`);
      app.quit();
    })
    .catch(() => {
      process.stderr.write(`${secondInstanceResultPrefix}unverified\n`);
      app.quit();
    });
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
      if (startupRecovery !== null) return;
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
