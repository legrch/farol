import {
  startDesktopGoCore,
  type DesktopGoCore,
} from "../../../apps/desktop/go-core-host";
import type {
  ChatComputerAdmissionResponse,
  SettingsDeliveryResult,
  ComputerConnectorVerificationReceipt,
} from "../../../apps/desktop/bridge/wire";
import { createDesktopChatBrowser } from "../../../apps/desktop/go-chat-host";
import { GoChatBrowserDriver } from "../../../apps/desktop/go-chat-browser";
import {
  captureChatStartupProfile,
  chatWorkerInitialUrl,
} from "../../../apps/desktop/go-chat-startup-profile";
import {
  ReadConversationClient,
  type ReadConversationProjection,
} from "../../../apps/desktop/bridge/read-conversation";
import { readChatHistoryView } from "../../../apps/desktop/chat-history-view";
import { projectReadConversation } from "../../../apps/desktop/read-conversation-projection";
import { ReadConversationPromptSchema } from "../../pkg/product-settings/chat-conversation";
import { BridgeError } from "../../../apps/desktop/bridge/client";
import { ConnectorHostError } from "../../../apps/desktop/bridge/connector-host";
import {
  reportComputerCheckDiagnostic,
  refuseComputerSettingsList,
} from "./computer-check-diagnostic";
import { NativeViewVisibility } from "../../../apps/desktop/bridge/native-view-visibility";
import { withSettingsEditLease } from "../../../apps/desktop/with-settings-edit-lease";
import { readGoWorkspaceSnapshot } from "../../../apps/desktop/go-workspace-snapshot";
import { ReadAccountConfirmation } from "../../../apps/desktop/read-account-confirmation";
import { AccountObservationConfirmation } from "../../../apps/desktop/account-observation-confirmation";
import {
  ReadAccountCommands,
  readAccountFailure,
} from "../../../apps/desktop/read-account-commands";
declare const __FAROL_GO_CORE__: unknown;
import { createMenuBar } from "./menu-bar";
import { promises as rawFs } from "original-fs";
import {
  createInstalledUpdateRuntime,
  waitForInstalledUpdateRelaunch,
} from "./installed-update-runtime";
import { drainInstalledComputer } from "./installed-computer-drain";
import {
  InstalledUpdateCommandSchema,
  type InstalledUpdateView,
} from "../../modules/release/contract/installed-update";
import {
  UPDATE_RECHECK_MS,
  type InstalledUpdater,
} from "../../modules/release/app/installed-updater";
import { selectedConnectorApp } from "../../pkg/product-settings/connector-app-selection";
import { resolveOwnerTaskModel } from "./owner-config";
import { describeTaskModels } from "../../pkg/owner-config/contract";
import { ReadCodexModelCatalogue } from "../../modules/chat/app/service/read-codex-model-catalogue";
import type { CodexModelCatalogueResult } from "../../modules/chat/app/port/codex-model-catalogue";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  utilityProcess,
  WebContentsView,
  type Input,
  type MenuItemConstructorOptions,
  type SaveDialogOptions,
  type UtilityProcess,
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
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { exactProject } from "../../modules/chat/app/service/persistent-codex-handoff";
import { PhysicalCodexHandoffAuthority } from "../../modules/chat/infra/native/physical-codex-handoff-authority";
import { SharedCodexProxyHost } from "../../modules/chat/infra/native/shared-codex-proxy-host";
import {
  codexTaskRouteFailureCode,
  codexTaskRouteFailureRecord,
  codexTaskRouteRefusalRecord,
} from "./codex-task-route-error";
import { PersistentChatGptHandoff } from "../../modules/chat/app/service/persistent-chatgpt-handoff";
import { PrivateSavedChatJournal } from "../../modules/chat/infra/repo/private-saved-chat-journal";
import { Sha256SavedChatDigester } from "../../modules/chat/infra/native/sha256-saved-chat-digester";
import {
  CHATGPT_MODEL_ID,
  FAROL_PROVIDER_ID,
} from "../../pkg/model-route/contract";
import { ClientEventSchema } from "../../modules/chat/contract/client-event";
import type { ContextBinding } from "../../modules/chat/domain/context-continuity";
import { buildHostCompactionHandoff } from "../../modules/chat/infra/client/host-compaction-codec";
import {
  ProductTaskCommandResultSchema,
  ProductTaskCommandSchema,
  ProductTasksStateSchema,
  type ProductAgentScopeSelection,
  type ProductTask,
  type ProductTaskAgent,
  type ProductTaskCommandResult,
} from "../../modules/chat/contract/product-task";
import { LiveTaskRegistry, type LiveTaskAdmission } from "./live-task-registry";
import { onboardingHelpUrl } from "./onboarding-help";
import {
  journalUnderPromotionLease,
  PromotionPendingRefusal,
} from "./chatgpt-journal-lease";
import { admitProductAgentRejoin } from "./product-agent-rejoin";
import {
  workspaceDeniedPaths,
  workspaceDescriptor,
  verifiedProductWorkspace as verifiedWorkspaceOf,
  type VerifiedProductWorkspaceResult,
} from "./workspace-descriptor";
import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
} from "./promotion-lease";
import { withStartupPromotionLease } from "./startup-promotion-lease";
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
  sidebarShortcutMatches,
  sectionForShortcut,
  type NavigationShortcuts,
} from "../../pkg/ipc/navigation-shortcuts";
import type { ShellAction, ShellActionSource } from "../../pkg/ipc/shell-state";
import type { RuntimeStatus } from "../../pkg/ipc/runtime-status";
import type { TaskSurfaceStatus } from "../../pkg/ipc/task-surface-status";
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
  ShellLayoutSchema,
  type ShellOverlay,
  type SidebarMode,
  type SurfaceSection,
  type WindowState,
} from "../../pkg/ipc/shell-state";
import {
  containWindowOpenFailure,
  presentationAction,
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
  parseAllowPrimaryDisplay,
  parseBuiltInDisplayOnly,
  parsePreviewWindowMode,
  selectPreviewWindowPlacement,
} from "./window-placement";
import {
  PrimaryStartup,
  emitStartupStage,
  primaryStartupReady,
  previewStartupDelay,
  type StartupStage,
} from "./primary-startup";
import { readRuntimeBuildIdentity } from "./build-identity";
import { waitForConnectorAppReceipt } from "./connector-app-receipt-wait";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "./product-configuration";
import { deriveSurfaceLayout, shellGeometry } from "./surface-layout";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../modules/computer/infra/native/native-readonly-workspace";
import { discoverWorkspaceGitMetadata } from "../../modules/computer/infra/native/native-verification-command";
import {
  CHATGPT_HOME,
  canonicalChatGptConversationUrl,
} from "./chatgpt-page-policy";
import {
  MAX_CHATGPT_CONTEXT_CHARACTERS,
  buildChatGptAttachmentTaskPrompt,
  buildChatGptReadonlyTaskPrompt,
} from "./chatgpt-readonly-task";
import {
  ChatGptRoute,
  ChatGptSignInBlockLedger,
  type ChatGptRouteOptions,
  type ChatGptWindowPresentation,
  type ChatGptRouteSurface,
  type ChatGptRouteSurfaceFactory,
  type ChatGptSignInOutcomeDiagnostic,
  type ChatGptSignInStatus,
} from "./chatgpt-route";
import { NextSavedChatBrowser } from "./saved-chat-browser";
import { startSavedChatBridge } from "./saved-chat-bridge";
import { savedChatPreviewQualified } from "./saved-chat-preview-admission";
import {
  PrivateLiveTaskStore,
  type LiveTaskStoreRecord,
  type StoredLiveTask,
} from "./live-task-store";
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
import {
  changesComputerAuthority,
  configurationAdmission,
} from "./configuration-admission";
import {
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
import { productAgentOpenRefusal } from "./product-agent-open-refusal";
import { activateAgentCheckSession } from "./codex-agent-check-admission";
import { productAgentSessionKey } from "./product-agent-session-key";
import { runCodexChatGptHostRoute } from "./codex-chatgpt-host-route";
import { runRouteBHostCheck } from "./route-b-host-check";
import {
  ROUTE_B_MODEL,
  startRouteBRuntime,
  type RouteBRuntime,
  type RouteBSurfaceAdmission,
  type RouteBTaskSurfaces,
} from "./route-b-runtime";
import {
  observeWorkspaceEdit,
  workspaceEditPreview,
  type PendingWorkspaceEdit,
} from "./workspace-edit";
import {
  createSupportExport,
  writeSupportExport,
  type SupportRuntimeErrorCode,
} from "./support-export";
import {
  cleanupChatGptAttachmentStaging,
  discardChatGptAttachments,
  stageChatGptAttachments,
  verifyStagedChatGptAttachments,
  type StagedChatGptAttachments,
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
import { CodexNativeAgentHost } from "../../modules/agent/infra/native/codex-native-agent-host";
import { PrivateAssignmentStore } from "../../modules/agent/infra/repo/private-assignment-store";
import { AcknowledgeAgentResult } from "../../modules/agent/app/service/acknowledge-agent-result";
import { CancelAgentAssignment } from "../../modules/agent/app/service/cancel-agent-assignment";
import type { AgentHost } from "../../modules/agent/app/port/agent-host";
import type { AgentRunReceipt } from "../../modules/agent/app/service/run-agent-assignment";
import { runProductAgentAssignment } from "./product-agent-assignment";
import { ProductAgentSessionReservation } from "./product-agent-session-reservation";
import {
  PrivateProductAgentStore,
  type ProductAgentInput,
} from "./product-agent-store";
import { resolveProductAgentScope } from "./product-agent-scope";
import {
  productAgentContext,
  productAgentHostContext,
  productAgentInputMatchesContext,
  type ProductAgentContext,
  type ProductAgentHostContext,
} from "./product-agent-context";
import {
  productAgentSessionExpiryVerdict,
  persistedProductAgentExpiryVerdict,
  productAgentExpiryRecoveryVerdict,
} from "./product-agent-expiry";
import { PrivateConnectorKeyStore } from "./connector-key-store";
import {
  FarolModelLifecycle,
  type FarolModelLifecycleStatus,
} from "./farol-model-lifecycle";
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
import {
  createUpdateAbortConnectorRecovery,
  resumeComputerConnector,
} from "./connector-resume-policy";
import { identityBoundWorkspaces } from "./identity-bound-workspaces";
import { AuthorityTransitionReservation } from "./authority-transition";
import {
  ConnectorRuntimeEffectUnknown,
  SecureMcpConnectorRuntime,
} from "./secure-mcp-connector-runtime";
import { clearConnectorVerificationReceipt } from "../../modules/computer/infra/mcp/connector-verification-receipt";
import { PrivateExecutionFence } from "../../modules/computer/infra/mcp/execution-fence";
import { PrivateMcpLifecycle } from "../../modules/computer/infra/mcp/private-mcp-lifecycle";
import {
  DEV_MCP_PROOF_ALLOWED_PATH,
  DEV_MCP_PROOF_DENIED_PATH,
  type DevMcpProofPreparation,
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
  desktopProfileEnvironment,
  isolatedDevMcpProofAllowed,
} from "./desktop-environment";
import {
  runDesktopStartupBoundary,
  terminateDesktopStartup,
} from "./desktop-startup-failure";
import { resolvePhysicalDevDataDirectoryName } from "./dev-profile-directory";

const directory = __dirname;
// A legacy build has no Go declaration; a Go build never falls back after a
// failed launch, publication or operation. The builder supplies this constant.
const compiledGoCore =
  typeof __FAROL_GO_CORE__ === "undefined" ? null : __FAROL_GO_CORE__;
let desktopGoCore: DesktopGoCore | null = null;
const buildIdentity = readRuntimeBuildIdentity(directory);
const productName = buildIdentity.product;
const bundleId = buildIdentity.bundleId;
const buildEnvironment = desktopEnvironment(process.env.FAROL_NEXT_ENVIRONMENT);
const runtimeEnvironment = (() => {
  try {
    return desktopProfileEnvironment(
      buildEnvironment,
      process.env.FAROL_NEXT_PROFILE_MODE,
      process.env.FAROL_NEXT_ACCEPTANCE_PROFILE,
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
  process.env.FAROL_NEXT_E2E === "1" ? process.env.HOME : undefined;
const desktopAppData = (() => {
  try {
    return desktopAppDataPath(buildEnvironment, app.getPath("appData"), {
      enabled: process.env.FAROL_NEXT_E2E === "1",
      override: process.env.FAROL_NEXT_E2E_APP_DATA,
      acceptanceProfile: process.env.FAROL_NEXT_ACCEPTANCE_PROFILE,
      testRoot: process.env.FAROL_NEXT_E2E_TEST_ROOT,
      testHome: isolatedE2EHome,
      testProof: process.env.FAROL_NEXT_E2E_TEST_PROOF,
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
const declaredDesktopIdentity = desktopIdentity(
  runtimeEnvironment,
  desktopAppData,
  runtimeEnvironment === "dev"
    ? resolvePhysicalDevDataDirectoryName(desktopAppData)
    : undefined,
);
const selectedDesktopUserData = (() => {
  try {
    return desktopUserDataPath(declaredDesktopIdentity, {
      enabled: process.env.FAROL_NEXT_E2E === "1",
      override: app.commandLine.getSwitchValue("user-data-dir"),
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
const activeDesktopIdentity = {
  ...declaredDesktopIdentity,
  // Storage selection does not change development build admission or edition.
  displayEdition:
    buildEnvironment === "dev"
      ? "Development"
      : declaredDesktopIdentity.displayEdition,
  userData: app.getPath("userData"),
  sessionData: app.getPath("sessionData"),
  codexHome: path.join(
    app.getPath("userData"),
    "farol-next-private",
    "codex-home",
  ),
} as const;
// `buildIdentity.product` ("Farol Next Preview") is the release identity —
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
  helperPath: path.join(directory, "computer-safe-open.py"),
  helper: NEXT_SAFE_OPEN_HELPER,
});
const ownerBackgroundOnly = process.argv.includes("--owner-background-only");
if (ownerBackgroundOnly && parsePreviewWindowMode(process.argv) !== "hidden") {
  throw new Error("OWNER_BACKGROUND_PRESENTATION_INVALID");
}
const instanceRequest = createInstanceRequest(
  launchIdentity,
  ownerBackgroundOnly,
);
const secondInstanceResultPrefix = "FAROL_NEXT_SECOND_INSTANCE_RESULT:";
const secondInstanceAcknowledgementPrefix =
  "FAROL_NEXT_SECOND_INSTANCE_ACK_FAILED:";
const startupStage = (stage: StartupStage) => {
  const enabled = process.env.FAROL_NEXT_E2E === "1";
  emitStartupStage(stage, enabled, (line) => process.stderr.write(line));
  // Playwright can attach after early stderr tokens have passed. Persist only
  // fixed stage tokens in this run's private disposable E2E home.
  if (!enabled) return;
  try {
    const home = process.env.HOME;
    if (
      !home ||
      !/^farol-next-e2e-home-[A-Za-z0-9]{6,}$/u.test(path.basename(home))
    )
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
        ? ".farol-next-secondary-lock-stage"
        : stage === "delay-complete"
          ? ".farol-next-delay-complete-stage"
          : stage.startsWith("connector-resume") ||
              stage === "connector-resumed"
            ? ".farol-next-connector-resume-stage"
            : ".farol-next-startup-stage";
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
  process.env.FAROL_NEXT_E2E === "1",
);
const demoMode = process.argv.includes("--demo");
// Only the fixture lane can exercise the retained legacy journey explicitly.
// A normal packaged preview always selects the integrated Setup.
const legacySetupTestMode =
  process.env.FAROL_NEXT_E2E === "1" &&
  process.env.FAROL_NEXT_E2E_LEGACY_SETUP === "1";
const contextOwnerId = "owner-desktop";
const contextProviderProfileId = "profile-isolated-next";
const contextModel = ROUTE_B_MODEL;
const windowMode = parsePreviewWindowMode(process.argv);
// Explicit-only: the owner-handed overnight run passes this itself. Its
// absence keeps every display-selection outcome exactly as before.
const allowPrimaryDisplay = parseAllowPrimaryDisplay(process.argv);
const builtInDisplayOnly = parseBuiltInDisplayOnly(process.argv);
const initialWindowSize = { width: 1180, height: 760 } as const;
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
  identity: z.enum(["farol-next-preview-runtime", "farol-dev-runtime"]),
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
// The visible production name must not change the observed process identity.
process.title =
  buildEnvironment === "dev"
    ? activeDesktopIdentity.applicationName
    : productName;
if (process.platform === "win32")
  app.setAppUserModelId(activeDesktopIdentity.applicationId);
if (process.platform === "darwin") {
  // macOS's default About panel otherwise reads the raw release identity
  // (app.getName()); this is display-only and does not touch that
  // identity, the bundle ID, or app.setName's own OS-level registration.
  app.setAboutPanelOptions({
    applicationName: displayProductName,
    applicationVersion: displayEdition
      ? `${buildIdentity.version} (${displayEdition})`
      : buildIdentity.version,
    version: buildIdentity.sourceCommit.slice(0, 12),
  });
}

let window: BrowserWindow | null = null;
let runtimeChild: UtilityProcess | null = null;
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
let connectorTaskAdmission = false;
let connectorStartInFlight: Promise<void> | null = null;
// F3-1b: one authority transition at a time. A command that changes Computer
// authority holds it through its commit; a connector start and an Agent
// admission hold it from reading the settings until they run, so neither can
// start with authority that a concurrent change is about to replace.
const authorityTransitions = new AuthorityTransitionReservation();
let installedUpdater: InstalledUpdater | null = null;
let installedUpdaterInitialization: Promise<void> | null = null;
let installedUpdateTimer: NodeJS.Timeout | null = null;
let installedUpdateAdmission = false;
let configurationRequests = 0;
let installedUpdateView: InstalledUpdateView = {
  phase: "unavailable",
  code: "UPDATE_NOT_INSTALLED",
};

function publishInstalledUpdate(view: InstalledUpdateView): void {
  installedUpdateView = view;
  window?.webContents.send(channels.installedUpdateState, view);
}
async function installedUpdateCommand(
  value: unknown,
): Promise<InstalledUpdateView> {
  const command = InstalledUpdateCommandSchema.safeParse(value);
  if (!command.success || !installedUpdater) return installedUpdateView;
  if (command.data.kind === "check") await installedUpdater.check(true);
  else if (command.data.kind === "download") await installedUpdater.download();
  else if (command.data.kind === "skip") await installedUpdater.skip();
  else if (command.data.kind === "later") await installedUpdater.later();
  else if (command.data.kind === "notice-seen")
    await installedUpdater.acknowledgeNotice(command.data.noticeKey);
  else if (command.data.kind === "set-automatic-update-preference") {
    await installedUpdater.setAutomaticUpdatePreference(command.data.enabled);
    return installedUpdater.snapshot();
  } else if (command.data.kind === "restart") await installedUpdater.restart();
  else if (command.data.kind === "recover" || command.data.kind === "rollback")
    await installedUpdater.restore(command.data.kind);
  return installedUpdateView;
}
async function initializeInstalledUpdater(): Promise<void> {
  try {
    installedUpdater = await createInstalledUpdateRuntime({
      directory,
      userData: app.getPath("userData"),
      build: buildIdentity,
      copyApp: (source, destination) =>
        rawFs.cp(source, destination, {
          recursive: true,
          force: false,
          errorOnExist: true,
          verbatimSymlinks: true,
          preserveTimestamps: true,
        }),
      removeDirectory: (directory, force) =>
        rawFs.rm(directory, { recursive: true, force }),
      publish: publishInstalledUpdate,
      quit: () => app.quit(),
      acquireAdmission: async (desktopWorkSettled) => {
        if (
          installedUpdateAdmission ||
          quitInProgress ||
          configurationRequests > 0 ||
          chatGptTaskAdmission ||
          pendingChatGptReadonlyTask ||
          directChatStart ||
          pendingChatGptAttachmentTask ||
          pendingWorkspaceEdit ||
          workspaceMutationAdmission ||
          pendingComputer.size > 0 ||
          codexHostTaskAdmission ||
          codexAgentOperationActive() ||
          hostCheckClients.size > 0
        )
          return { ok: false, code: "UPDATE_WORK_PENDING" };
        if (connectorTaskAdmission || connectorStartInFlight)
          return { ok: false, code: "UPDATE_CONNECTOR_ACTIVE" };
        const snapshot = configuration?.snapshot();
        if (!snapshot || snapshot.status !== "ready")
          return { ok: false, code: "UPDATE_STATE_UNREADABLE" };
        const transition = authorityTransitions.tryReserve("authority-change");
        if (!transition) return { ok: false, code: "UPDATE_WORK_PENDING" };
        const taskClaim = taskMutations.tryEnter();
        if (!taskClaim) {
          transition.release();
          return { ok: false, code: "UPDATE_WORK_PENDING" };
        }
        installedUpdateAdmission = true;
        // Hide embedded input before any asynchronous probe; IPC and configuration
        // admission above stay reserved through the final helper handoff.
        applyLayout();
        const browserAdmissions: Array<
          Extract<
            Awaited<ReturnType<ChatGptRoute["acquireUpdateIdle"]>>,
            { ok: true }
          >
        > = [];
        const recheck = async () => {
          for (const browser of browserAdmissions) {
            const result = await browser.recheck();
            if (!result.ok) return result;
          }
          return { ok: true as const };
        };
        let lease: Awaited<ReturnType<typeof acquirePromotionLease>> = null;
        let browserReleaseUnconfirmed = false;
        const recovery = createUpdateAbortConnectorRecovery({
          before: snapshot,
          wasRunning: secureMcpConnectorRuntime?.isRunning() ?? false,
          current: () => configuration?.snapshot() ?? null,
          releaseAdmission: async () => {
            for (const browser of browserAdmissions) await browser.release();
            if (browserReleaseUnconfirmed)
              throw new Error("UPDATE_BROWSER_RELEASE_UNCONFIRMED");
            if (lease) await releasePromotionLease(lease);
            taskClaim.release();
            transition.release();
            installedUpdateAdmission = false;
            applyLayout();
          },
          resumeConnector: async () => {
            if (quitInProgress) return;
            try {
              const result = await startSecureMcpConnector(false, true);
              startupStage(
                result.ok
                  ? "update-abort-connector-resumed"
                  : "update-abort-connector-resume-refused",
              );
            } catch {
              startupStage("update-abort-connector-resume-failed");
            }
            if (!quitInProgress && window && !window.isDestroyed())
              window.webContents.send(channels.configurationChanged);
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
          const routes = new Set([
            ...managedChatGptRoutes,
            ...(chatGptRoute ? [chatGptRoute] : []),
          ]);
          for (const route of routes) {
            const browser = await route.acquireUpdateIdle();
            if (!browser.ok) {
              browserReleaseUnconfirmed =
                browser.code === "UPDATE_BROWSER_RELEASE_UNCONFIRMED";
              return abort(browser.code);
            }
            browserAdmissions.push(browser);
          }
          lease = await acquirePromotionLease(
            app.getPath("userData"),
            buildIdentity.buildId,
            "promotion",
          );
          if (!lease || !(await verifyPromotionLease(lease))) {
            return abort("UPDATE_WORK_PENDING");
          }
          await liveTaskPersistence;
          const drained = await drainInstalledComputer({
            root: secureMcpLaunchRoot(),
            settings: snapshot.settings,
            desktopWorkSettled,
            stillCurrent: () => {
              const current = configuration?.snapshot();
              return (
                !quitInProgress &&
                current?.status === "ready" &&
                current.settings.revision === snapshot.settings.revision
              );
            },
            stopOwnedClients: async () => {
              await stopAndConfirmComputerMcp();
              // Preserve route, grants, selected app and credentials. Only the
              // runtime attachment becomes stopped after a verified drain.
              const recorded =
                await configuration?.recordSecureMcpDrainedForUpdate();
              if (!recorded?.ok)
                throw new Error("UPDATE_CONNECTOR_DRAIN_UNCONFIRMED");
              recovery.recordDrained(recorded.snapshot);
            },
          });
          if (!drained.ok) {
            return abort(drained.code);
          }
          return { ok: true, release, recheck };
        } catch {
          return abort("UPDATE_STATE_UNREADABLE");
        }
      },
    });
    if (!installedUpdater) return;
    if (quitInProgress) {
      await installedUpdater.close();
      return;
    }
    publishInstalledUpdate(installedUpdater.snapshot());
    await installedUpdater.initialize();
    if (quitInProgress) {
      await installedUpdater.close();
      return;
    }
    void installedUpdater.scheduledCheck();
    installedUpdateTimer = setInterval(() => {
      void installedUpdater?.scheduledCheck();
    }, UPDATE_RECHECK_MS);
    installedUpdateTimer.unref();
  } catch {
    publishInstalledUpdate({
      phase: "failed",
      code: "UPDATE_INITIALIZATION_FAILED",
      recoveryRequired: true,
    });
  }
}
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
let signInSurfaceOpen = false;
let browserHomeSurfaceOpen = false;
let checkFeedbackVisible = false;
let signInReturnLayout: {
  section: SurfaceSection;
  setupOpen: boolean;
  taskId: string;
} | null = null;

function restoreEmbeddedSignInLayout(): void {
  signInSurfaceOpen = false;
  const previous = signInReturnLayout;
  signInReturnLayout = null;
  if (
    previous &&
    section === "browser" &&
    !setupOpen &&
    selectedTaskId === previous.taskId &&
    shellOverlay === "none"
  ) {
    section = previous.section;
    setupOpen = previous.setupOpen;
  }
  applyLayout();
  publishLayout();
}
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
let chatGptTaskAdmission = false;
type ChatGptVerification = NonNullable<
  ProductSettings["setup"]["chatgpt"]["verified"]
>;
type PendingChatGptReadonlyTask = Readonly<{
  goAdmission?: ChatComputerAdmissionResponse;
  operationId: string;
  workspaceId: string;
  workspaceLabel: string;
  computerGeneration: number;
  relativePath: string;
  bytes: number;
  contextCharacters: number;
  contextTruncated: boolean;
  excludedPaths: readonly string[];
  prompt: string;
  chatGptVerification: ChatGptVerification;
  expiresAt: number;
}>;
let pendingChatGptReadonlyTask: PendingChatGptReadonlyTask | null = null;
let goChatStartupProfile: ReturnType<typeof captureChatStartupProfile> = null;
// One window's original transport client, not a second model/task registry.
let goReadonlyConversation: {
  pending: PendingChatGptReadonlyTask | null;
  operationId: string;
  core: DesktopGoCore;
  client: ReadConversationClient;
  start: Promise<ProductConfigurationResult>;
} | null = null;
// One window's retained inspection and first transport attempt. The Go owner
// mints the account grant, task and turn; no provider state is restored here.
let directChatStart: {
  operationId: string;
  sessionId: string;
  core: DesktopGoCore;
  client: ReadConversationClient;
  confirmation: AccountObservationConfirmation<ReadConversationProjection>;
  inspection: Promise<ProductConfigurationResult>;
  start?: {
    command: Extract<
      ProductConfigurationCommand,
      { kind: "chatgpt.start-conversation" }
    >;
    promise: Promise<ProductConfigurationResult>;
  };
} | null = null;
const readonlyAccountCommands = new ReadAccountCommands();
const readonlyAccountConfirmations = new WeakMap<
  PendingChatGptReadonlyTask,
  ReadAccountConfirmation
>();
const readonlyDiscardAttempts = new WeakMap<
  PendingChatGptReadonlyTask,
  Promise<boolean>
>();
type PendingChatGptAttachmentTask = Readonly<{
  operationId: string;
  attachments: StagedChatGptAttachments;
  prompt: string;
  chatGptVerification: ChatGptVerification;
  expiresAt: number;
}>;
let pendingChatGptAttachmentTask: PendingChatGptAttachmentTask | null = null;
let attachmentStagingReady = true;
let chatGptTaskJournal: PrivateChatGptTaskJournal | null = null;
let recoverableChatGptTask: ChatGptTaskJournalRecord | null = null;
let recoverableChatGptObservationPersisted = false;
let chatGptConversationStore: PrivateChatGptConversationStore | null = null;
let chatGptConversation: ChatGptConversationRecord | null = null;
let pendingWorkspaceEdit: PendingWorkspaceEdit | null = null;
let workspaceMutationAdmission = false;
let windowPresentationReady = false;
let codexHostTaskAdmission = false;
type ActiveCodexAgentCheck = Readonly<{
  key: string;
  client: Awaited<ReturnType<typeof launchCodexAppServer>>;
  host: CodexNativeAgentHost;
  boundedRunningObserved: boolean;
}>;
let activeCodexAgentCheck: ActiveCodexAgentCheck | null = null;
// App Servers a one-off host check started. The check keeps its client in a
// local variable, so quit can wait for it only through this set.
const hostCheckClients = new Set<
  Awaited<ReturnType<typeof launchCodexAppServer>>
>();
type ActiveProductAgentSession = {
  taskId: string;
  key: string;
  input: ProductAgentInput;
  assignments: PrivateAssignmentStore;
  client: Awaited<ReturnType<typeof launchCodexAppServer>>;
  host: CodexNativeAgentHost;
  expiryTimer: NodeJS.Timeout | null;
  cancellation: Promise<ProductTaskCommandResult> | null;
};
type ProductAgentRoute =
  | Readonly<{ model: "gpt-6-astra"; effort?: "low" }>
  | Readonly<{ model: typeof CHATGPT_MODEL_ID; effort: "low" }>;
const legacyProductAgentCleanupRoute: ProductAgentRoute = {
  model: "gpt-6-astra",
};
let activeProductAgentSession: ActiveProductAgentSession | null = null;
const productAgentSessionReservation =
  new ProductAgentSessionReservation<ActiveProductAgentSession>();
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
): RunReadonlyComputerAction | null {
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
  return liveTaskRegistry.markRunningDurable(
    taskId,
    () => persistLiveTaskState(),
    {
      onPublish: () => publishTasksState(),
      onPersistFailure: () => surfaceLiveTaskPersistenceFailure(taskId),
    },
  );
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

function storedLiveTaskState(): Readonly<{
  revision: number;
  tasks: StoredLiveTask[];
}> {
  const snapshot = liveTaskRegistry.snapshot();
  return {
    revision: snapshot.revision,
    tasks: snapshot.tasks.map((task) => ({
      ...task,
      provider: "chatgpt" as const,
      conversationUrl: liveTaskConversationUrls.get(task.taskId) ?? null,
    })),
  };
}

function persistLiveTaskState(): Promise<void> {
  const store = liveTaskStore;
  if (!store) return Promise.reject(new Error("LIVE_TASK_STATE_UNAVAILABLE"));
  const state = storedLiveTaskState();
  const write = liveTaskPersistence.then(() => store.save(state));
  liveTaskPersistence = write.catch(() => undefined);
  return write;
}

function createManagedChatGptRoute(options: ChatGptRouteOptions): ChatGptRoute {
  let route: ChatGptRoute;
  route = new ChatGptRoute({
    ...options,
    partition: activeDesktopIdentity.chatGptPartition,
    ...(runtimeEnvironment === "dev"
      ? {
          requiredAppName: activeDesktopIdentity.displayName,
          title:
            options.title ?? `ChatGPT · ${activeDesktopIdentity.displayName}`,
        }
      : {}),
    onUpdateAdmissionDiagnostic: (diagnostic) => {
      // Fixed classifications only. The browser route contains observer errors,
      // so diagnostics cannot alter an update admission or release outcome.
      process.stderr.write(
        `FAROL_UPDATE_ADMISSION_DIAGNOSTIC ${diagnostic.stage}:${diagnostic.reason}\n`,
      );
      options.onUpdateAdmissionDiagnostic?.(diagnostic);
    },
    onDisposed: () => managedChatGptRoutes.delete(route),
  });
  managedChatGptRoutes.add(route);
  return route;
}

function createLiveChatGptRoute(
  taskId: string,
  label: string,
  initialUrl = chatGptHomeUrl,
): ChatGptRoute {
  let routeHomeUrl = chatGptHomeUrl;
  let routeInitialUrl = initialUrl;
  if (chatGptE2eOrigin !== null) {
    const fixtureUrl = new URL(chatGptHomeUrl);
    fixtureUrl.searchParams.set("farol-e2e-task", taskId);
    routeHomeUrl = fixtureUrl.href;
    if (initialUrl === chatGptHomeUrl) routeInitialUrl = routeHomeUrl;
  }
  const recordConversationUrl = (conversationUrl: string | null) => {
    if (!liveTaskRegistry.get(taskId)) return;
    if (liveTaskConversationUrls.get(taskId) === conversationUrl) return;
    liveTaskConversationUrls.set(taskId, conversationUrl);
    void persistLiveTaskState().catch(() =>
      surfaceLiveTaskPersistenceFailure(taskId),
    );
  };
  const recordTaskActivity = (
    state: "idle" | "running" | "outcome_unknown",
  ) => {
    const task = liveTaskRegistry.get(taskId);
    if (!task) return;
    const lifecycle =
      state === "running"
        ? "running"
        : state === "outcome_unknown"
          ? "outcome_unknown"
          : task.lifecycle === "running"
            ? "completed"
            : task.lifecycle;
    setLiveTaskLifecycle(taskId, lifecycle);
  };
  return createManagedChatGptRoute({
    homeUrl: routeHomeUrl,
    initialUrl: routeInitialUrl,
    e2eOrigin: chatGptE2eOrigin,
    parent: () => window,
    ...chatGptWindowPresentationOption(),
    surfaceFactory: liveChatGptSurfaceFactory(taskId),
    collapseSidebarByDefault: embeddedBrowserEnabled(),
    title: `${label} · ${displayProductName}`,
    onClosed: (conversationUrl, taskRunning) => {
      recordConversationUrl(conversationUrl);
      recordTaskActivity(taskRunning ? "outcome_unknown" : "idle");
    },
    onConversationChanged: recordConversationUrl,
    onTaskActivityChanged: recordTaskActivity,
    ...(process.env.FAROL_NEXT_E2E === "1"
      ? { taskTimeoutMs: 5_000, taskPollMs: 50 }
      : {}),
  });
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
  let initialUrl = recoveredConversationUrl ?? chatGptHomeUrl;
  if (recoveredConversationUrl === undefined && chatGptE2eOrigin !== null) {
    const fixtureUrl = new URL(initialUrl);
    fixtureUrl.searchParams.set("farol-e2e-task", `context-${binding.taskId}`);
    initialUrl = fixtureUrl.href;
  }
  return createManagedChatGptRoute({
    homeUrl: chatGptHomeUrl,
    initialUrl,
    e2eOrigin: chatGptE2eOrigin,
    parent: () => window,
    ...chatGptWindowPresentationOption(),
    title: `Context recovery · ${displayProductName}`,
    ...(process.env.FAROL_NEXT_E2E === "1"
      ? { taskTimeoutMs: 5_000, taskPollMs: 50 }
      : {}),
  });
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
              profile: "chatgpt.next-partition/1",
              runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
              buildId: buildIdentity.buildId,
              protocol: "chatgpt-page-readiness/1",
            }
          : { state: "signed_out" },
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
const QUIT_DRAIN_DEADLINE_MS = 10_000;

// What the start did with the connector's execution fence, kept privately
// for diagnostics: whether the store was read and how many summaries it
// still holds as possibly running.
async function recordSummaryFenceRecovery(
  recovery: SummaryFenceRecovery,
): Promise<void> {
  const file = path.join(
    app.getPath("userData"),
    "farol-next-state",
    "summary-fence-recovery.json",
  );
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
async function recordQuitReceipt(receipt: QuitDrainReceipt): Promise<void> {
  await writeQuitReceipt(
    path.join(app.getPath("userData"), "farol-next-state"),
    receipt,
    new Date().toISOString(),
  );
}

// The relay socket path must stay under the 104-byte Unix socket limit, so it
// lives in a short private temporary directory keyed by this profile. The
// single-instance lock is held here, so a socket left there belongs to a
// previous run of this same profile.
function callerRelayRoot(): string {
  const profile = createHash("sha256")
    .update(app.getPath("userData"))
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), `farol-next-relay-${profile}`);
}

async function initializeCallerRelay(): Promise<void> {
  if (callerRelayRuntime) return;
  const root = callerRelayRoot();
  try {
    const stale = await lstat(path.join(root, "caller-relay.sock"));
    if (stale.isSocket() && stale.uid === process.getuid?.()) {
      await unlink(path.join(root, "caller-relay.sock"));
    }
  } catch {
    // No previous socket.
  }
  try {
    callerRelayRuntime = await startCodexCallerRelay({ root });
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
      ownerOptIn: process.env.FAROL_NEXT_SAVED_CHAT_PREVIEW,
      outcomeUnknown: snapshot.settings.setup.chatgpt.outcomeUnknown,
      verification: snapshot.settings.setup.chatgpt.verified,
      partition: activeDesktopIdentity.chatGptPartition,
      buildId: buildIdentity.buildId,
    });
  };
  if (!qualified()) return;
  const root = path.join(
    app.getPath("userData"),
    "farol-next-state",
    "saved-chat-handoff",
  );
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
    const browser = new NextSavedChatBrowser(
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
            message: "Send this first message through Farol Next Browser?",
            detail: `Check the signed-in account in Farol Next Browser before approving. Farol cannot identify that account from this receipt.\n\nTitle: ${request.title}\nKey: ${request.key}\nDigest: ${requestDigest}\n\n${request.firstMessage}`,
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
      stateRoot: path.join(app.getPath("userData"), "farol-next-state"),
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
  const fence = new PrivateExecutionFence({ root: secureMcpLaunchRoot() });
  summaryExecutionFence = fence;
  codexContextController = createCodexContextController({
    ownerId: contextOwnerId,
    providerProfileId: contextProviderProfileId,
    stateRoot: contextContinuityRoot(),
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
  let e2eSaveAttempts = 0;
  const e2eSuccessfulSaves =
    process.env.FAROL_NEXT_E2E === "1"
      ? process.env.FAROL_NEXT_E2E_LIVE_TASK_SAVE_SUCCESSES
      : undefined;
  const store = new PrivateLiveTaskStore(
    { root: liveTaskStoreRoot() },
    e2eSuccessfulSaves === undefined
      ? {}
      : {
          beforeCommit: async () => {
            const successfulSaves = Number(e2eSuccessfulSaves);
            if (!Number.isSafeInteger(successfulSaves) || successfulSaves < 0) {
              throw new Error("LIVE_TASK_E2E_SAVE_FAULT_INVALID");
            }
            e2eSaveAttempts += 1;
            if (e2eSaveAttempts > successfulSaves) {
              throw new Error("LIVE_TASK_E2E_SAVE_FAULT");
            }
          },
        },
  );
  const stagedRoutes = new Map<string, ChatGptRoute>();
  const stagedConversationUrls = new Map<string, string | null>();
  let record: LiveTaskStoreRecord | null;
  try {
    record = await store.load();
  } catch {
    liveTaskStore = null;
    return;
  }
  liveTaskStore = store;
  if (!record) return;

  let reconciled = false;
  try {
    const tasks = record.tasks.map(({ conversationUrl, ...task }) => {
      stagedConversationUrls.set(task.taskId, conversationUrl);
      const lifecycle =
        task.lifecycle === "running" ? "outcome_unknown" : task.lifecycle;
      reconciled ||= lifecycle !== task.lifecycle;
      stagedRoutes.set(
        task.taskId,
        createLiveChatGptRoute(
          task.taskId,
          task.label,
          conversationUrl ?? chatGptHomeUrl,
        ),
      );
      return { ...task, lifecycle };
    });
    liveTaskRegistry.restore({
      revision: record.revision + (reconciled ? 1 : 0),
      tasks,
    });
    liveTaskRegistryRestored = true;
    for (const [taskId, route] of stagedRoutes) {
      liveTaskRoutes.set(taskId, route);
    }
    for (const [taskId, conversationUrl] of stagedConversationUrls) {
      liveTaskConversationUrls.set(taskId, conversationUrl);
    }
    selectedTaskId = tasks[0]?.taskId ?? "";
  } catch {
    for (const route of stagedRoutes.values()) route.dispose();
    liveTaskStore = null;
    liveTaskConversationUrls.clear();
    return;
  }

  if (reconciled) {
    try {
      await persistLiveTaskState();
    } catch {
      liveTaskStore = null;
    }
  }
}

async function openLiveTaskSurface(taskId: string): Promise<boolean> {
  if (installedUpdateAdmission) return false;
  const route = liveTaskRoutes.get(taskId);
  if (!route) return false;
  try {
    const opened = await route.open();
    if (opened.status !== "opened") {
      setLiveTaskLifecycle(taskId, "failed");
      return false;
    }
    // Live ChatGPT surfaces also publish their observed load result. Without
    // this, renderer controls requiring a ready selected page never appear.
    taskSurfaceFailures.delete(taskId);
    publishTaskSurfaceStatus({ taskId, state: "ready", error: null });
    const current = liveTaskRegistry.get(taskId);
    if (current?.lifecycle === "failed") {
      setLiveTaskLifecycle(taskId, "idle");
    }
    applyLayout();
    focusForLayoutAfterRendererCommit();
    return true;
  } catch {
    setLiveTaskLifecycle(taskId, "failed");
    return false;
  }
}

function productAgentCapabilityAvailable(): boolean {
  if (!FAROL_BACKED_PRODUCT_AGENT_ENABLED) return false;
  const snapshot = configuration?.snapshot();
  if (snapshot?.status !== "ready") return false;
  const workspaceId = snapshot.settings.setup.computer.verified?.workspaceId;
  return workspaceId
    ? productAgentContext(
        workspaceId,
        snapshot.settings,
        productAgentStore,
        buildIdentity.buildId,
      ) !== null
    : false;
}

function productAgentInput(
  task: ProductTask,
  context: ProductAgentContext,
  objective: string,
  scope: ProductAgentScopeSelection,
): ProductAgentInput | null {
  const now = Date.now();
  const resolved = resolveProductAgentScope(
    context.workspace.root,
    context.workspace.excludedPaths,
    scope,
  );
  if (!resolved) return null;
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    assignmentId: randomUUID(),
    authorityId: randomUUID(),
    parentParticipantId: randomUUID(),
    agentParticipantId: randomUUID(),
    taskEpoch: context.settings.computer.generation,
    generation: 1,
    workspaceId: context.workspace.workspaceId,
    ...resolved,
    objective,
    computerGeneration: context.settings.computer.generation,
    executableSha256: context.host.executableSha256,
    schemaSha256: context.host.schemaSha256,
    buildId: buildIdentity.buildId,
    expiresAt: now + 30 * 60_000,
    createdAt: new Date(now).toISOString(),
  };
}

async function openProductAgentSession(
  input: ProductAgentInput,
  context: ProductAgentHostContext,
  route: ProductAgentRoute,
  scheduleExpiry = true,
): Promise<ActiveProductAgentSession> {
  const key = productAgentSessionKey(input, scheduleExpiry);
  if (activeProductAgentSession) {
    if (
      activeProductAgentSession.taskId === input.taskId &&
      activeProductAgentSession.key === key
    ) {
      return activeProductAgentSession;
    }
    throw new Error("PRODUCT_AGENT_SESSION_BUSY");
  }
  return productAgentSessionReservation.open(key, async () => {
    // Same reservation as the native check: from the settings this session
    // was admitted with until it is active; stale settings are refused.
    const agentAdmission = authorityTransitions.tryReserve("agent-admission");
    if (!agentAdmission) throw new Error("AUTHORITY_CHANGE_IN_PROGRESS");
    try {
      return await openAdmittedProductAgentSession(
        input,
        context,
        route,
        key,
        scheduleExpiry,
      );
    } finally {
      agentAdmission.release();
    }
  });
}

async function openAdmittedProductAgentSession(
  input: ProductAgentInput,
  context: ProductAgentHostContext,
  route: ProductAgentRoute,
  key: string,
  scheduleExpiry: boolean,
): Promise<ActiveProductAgentSession> {
  {
    const current = configuration?.snapshot();
    if (
      current?.status !== "ready" ||
      current.settings.revision !== context.settings.revision
    ) {
      throw new Error("AUTHORITY_CHANGE_IN_PROGRESS");
    }
    if (activeProductAgentSession) {
      if (
        activeProductAgentSession.taskId === input.taskId &&
        activeProductAgentSession.key === key
      ) {
        return activeProductAgentSession;
      }
      throw new Error("PRODUCT_AGENT_SESSION_BUSY");
    }
    const probe = await probeCodexHost({
      executablePath: context.host.executablePath,
      scratchRoot: codexHostProbeRoot(),
    });
    if (
      probe.executableSha256 !== input.executableSha256 ||
      probe.schemaSha256 !== input.schemaSha256 ||
      probe.version !== context.host.version ||
      probe.protocol !== context.host.protocol
    ) {
      throw new Error("PRODUCT_AGENT_HOST_CHANGED");
    }
    const runtimeRoot = await codexHostRuntimeRoot();
    const client = await launchCodexAppServer({
      executablePath: context.host.executablePath,
      cwd: runtimeRoot,
      homePath: await codexHostProcessHomePath(),
      tempPath: app.getPath("temp"),
      clientVersion: buildIdentity.version,
      toolProfile: "native-agent",
      ...(await codexHostHomeOption()),
    });
    try {
      const computer = new CodexAgentWorkspaceProbe(
        context.settings,
        nativeWorkspace,
        () => Date.now(),
      );
      const host = new CodexNativeAgentHost(
        client,
        {
          ...route,
          runtimeRoot,
          spawnTimeoutMs: 120_000,
          waitTimeoutMs: 250,
          pollIntervalMs: 25,
          nonce: randomUUID,
          now: () => Date.now(),
        },
        computer,
        computer,
      );
      const session: ActiveProductAgentSession = {
        taskId: input.taskId,
        key,
        input,
        assignments: new PrivateAssignmentStore({
          root: codexAgentAssignmentRoot(),
        }),
        client,
        host,
        expiryTimer: null,
        cancellation: null,
      };
      activeProductAgentSession = session;
      if (scheduleExpiry) armProductAgentExpiry(session);
      return session;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}

async function closeProductAgentSession(
  session: ActiveProductAgentSession,
): Promise<boolean> {
  if (session.expiryTimer) {
    clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
  }
  session.host.dispose();
  let closed = true;
  try {
    await session.client.close();
  } catch {
    closed = false;
  } finally {
    if (activeProductAgentSession === session) {
      activeProductAgentSession = null;
    }
  }
  return closed;
}

function productAgentSummary(
  input: ProductAgentInput,
  receipt: Pick<
    AgentRunReceipt,
    "assignment" | "parentDelivery" | "resultRef" | "workspaceEnforcement"
  > &
    Partial<Pick<AgentRunReceipt, "observation">>,
): ProductTaskAgent {
  const phase = receipt.assignment.phase;
  if (phase === "prepared") {
    throw new Error("PRODUCT_AGENT_STATE_INVALID");
  }
  return {
    assignmentBindingSha256: productAgentAssignmentBinding(input),
    phase,
    workspaceId: input.workspaceId,
    parentDelivery: receipt.parentDelivery,
    workspaceEnforcement: receipt.workspaceEnforcement ?? "not_applicable",
    resultAvailable: receipt.resultRef !== null,
    ...(phase === "running" && receipt.observation === "unavailable"
      ? { observation: "unavailable" as const }
      : {}),
  };
}

async function persistProductAgentSummary(
  taskId: string,
  summary: ProductTaskAgent,
): Promise<boolean> {
  if (!liveTaskRegistry.setAgent(taskId, summary)) return false;
  await persistLiveTaskState();
  publishTasksState();
  return true;
}

function productAgentIdentity(input: ProductAgentInput) {
  return {
    assignmentId: input.assignmentId,
    ownerId: "owner-desktop",
    sessionId: input.sessionId,
    taskId: input.taskId,
    taskEpoch: input.taskEpoch,
    generation: input.generation,
  };
}

function productAgentUnknownSummary(
  input: ProductAgentInput,
): ProductTaskAgent {
  return {
    assignmentBindingSha256: productAgentAssignmentBinding(input),
    phase: "outcome_unknown",
    workspaceId: input.workspaceId,
    parentDelivery: "not_applicable",
    workspaceEnforcement: "not_applicable",
    resultAvailable: false,
  };
}

function productAgentUnknownSummaryFromTask(
  agent: ProductTaskAgent,
): ProductTaskAgent {
  return {
    ...(agent.assignmentBindingSha256
      ? { assignmentBindingSha256: agent.assignmentBindingSha256 }
      : {}),
    phase: "outcome_unknown",
    workspaceId: agent.workspaceId,
    parentDelivery: "not_applicable",
    workspaceEnforcement: "not_applicable",
    resultAvailable: false,
  };
}

function productAgentAssignmentBinding(input: ProductAgentInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "farol-product-agent-binding-v1",
        input.taskId,
        input.sessionId,
        input.assignmentId,
      ]),
    )
    .digest("hex");
}

function productAgentAssignmentMatches(
  agent: ProductTaskAgent,
  input: ProductAgentInput,
): boolean {
  return (
    agent.assignmentBindingSha256 !== undefined &&
    agent.assignmentBindingSha256 === productAgentAssignmentBinding(input)
  );
}

function armProductAgentExpiry(
  session: ActiveProductAgentSession,
  delayOverride?: number,
): void {
  if (persistedProductAgentExpiry?.taskId === session.taskId) {
    clearTimeout(persistedProductAgentExpiry.timer);
    persistedProductAgentExpiry = null;
  }
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  session.expiryTimer = setTimeout(
    () => {
      session.expiryTimer = null;
      const now = Date.now();
      const verdict = productAgentSessionExpiryVerdict({
        sessionIsActive: activeProductAgentSession === session,
        taskPhase: liveTaskRegistry.get(session.taskId)?.agent?.phase,
        mutationInFlight: taskMutations.inFlight(),
        now,
      });
      if (verdict.action === "noop") return;
      if (verdict.action === "reschedule") {
        armProductAgentExpiry(session, verdict.atMs - now);
        return;
      }
      const mutation = taskMutations.tryEnter();
      if (!mutation) {
        armProductAgentExpiry(session, 0);
        return;
      }
      void cancelProductAgentSession(session).finally(() => {
        mutation.release();
      });
    },
    delayOverride ?? Math.max(0, session.input.expiresAt - Date.now()),
  );
  session.expiryTimer.unref?.();
}

function schedulePersistedProductAgentExpiry(
  taskId: string,
  input: ProductAgentInput,
  delayOverride?: number,
): void {
  if (persistedProductAgentExpiry) {
    clearTimeout(persistedProductAgentExpiry.timer);
    persistedProductAgentExpiry = null;
  }
  const timer = setTimeout(
    () => {
      persistedProductAgentExpiry = null;
      const task = liveTaskRegistry.get(taskId);
      const now = Date.now();
      const verdict = persistedProductAgentExpiryVerdict({
        taskPhase: task?.agent?.phase,
        mutationInFlight: taskMutations.inFlight(),
        now,
      });
      if (verdict.action === "noop") return;
      if (verdict.action === "reschedule") {
        schedulePersistedProductAgentExpiry(taskId, input, verdict.atMs - now);
        return;
      }
      // Unreachable in practice: `verdict.action === "expire"` only when
      // `taskPhase === "running"`, which requires `task` to exist. The
      // check narrows `task` for TypeScript rather than adding a new branch.
      if (!task) return;
      const mutation = taskMutations.tryEnter();
      if (!mutation) {
        schedulePersistedProductAgentExpiry(taskId, input, 0);
        return;
      }
      void cancelProductAgentTask(task).finally(() => {
        mutation.release();
      });
    },
    delayOverride ?? Math.max(0, input.expiresAt - Date.now()),
  );
  timer.unref?.();
  persistedProductAgentExpiry = { taskId, timer };
}

async function recoverProductAgentExpiry(): Promise<void> {
  const task = liveTaskRegistry
    .snapshot()
    .tasks.find((candidate) => candidate.agent?.phase === "running");
  let input: ProductAgentInput | null = null;
  if (task && productAgentStore) {
    try {
      input = await productAgentStore.load(task.taskId);
    } catch {
      input = null;
    }
  }
  const now = Date.now();
  const verdict = productAgentExpiryRecoveryVerdict({
    hasRunningTask: task !== undefined,
    storeAvailable: productAgentStore !== null,
    input,
    assignmentMatches:
      task !== undefined && input !== null
        ? productAgentAssignmentMatches(task.agent!, input)
        : false,
    now,
  });
  if (verdict.action === "noop") return;
  // Both remaining branches (`unknown` and `reschedule`) are only ever
  // produced when `hasRunningTask` was true, which requires `task` to
  // exist. The check narrows `task` for TypeScript rather than adding a new
  // branch.
  if (!task) return;
  if (verdict.action === "unknown") {
    await persistProductAgentSummary(
      task.taskId,
      productAgentUnknownSummaryFromTask(task.agent!),
    ).catch(() => undefined);
    return;
  }
  schedulePersistedProductAgentExpiry(task.taskId, input!, verdict.atMs - now);
}

async function performProductAgentCancellation(
  session: ActiveProductAgentSession,
): Promise<ProductTaskCommandResult> {
  const cancelled = await new CancelAgentAssignment(
    session.host,
    session.assignments,
  ).execute(productAgentIdentity(session.input));
  const closed = await closeProductAgentSession(session);
  if (!cancelled.ok || !closed) {
    await persistProductAgentSummary(
      session.taskId,
      productAgentUnknownSummary(session.input),
    ).catch(() => undefined);
    return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
  }
  const receipt = cancelled.value;
  const summary =
    receipt.assignmentRetention === "durable"
      ? productAgentSummary(session.input, receipt)
      : productAgentUnknownSummary(session.input);
  try {
    if (!(await persistProductAgentSummary(session.taskId, summary))) {
      return taskFailure("TASK_NOT_FOUND");
    }
  } catch {
    return taskFailure("TASK_STATE_UNAVAILABLE");
  }
  if (receipt.assignmentRetention !== "durable") {
    return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
  }
  if (receipt.assignment.phase === "cancelled") {
    return taskSuccess(session.taskId);
  }
  if (receipt.assignment.phase === "completed") {
    return taskFailure("AGENT_CANCEL_RACED_COMPLETION");
  }
  if (receipt.assignment.phase === "failed") {
    return taskFailure("AGENT_ASSIGNMENT_FAILED");
  }
  return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
}

function cancelProductAgentSession(
  session: ActiveProductAgentSession,
): Promise<ProductTaskCommandResult> {
  if (session.cancellation) return session.cancellation;
  const cancellation = performProductAgentCancellation(session).finally(() => {
    if (session.cancellation === cancellation) session.cancellation = null;
  });
  session.cancellation = cancellation;
  return cancellation;
}

const unavailableProductAgentHost: AgentHost = {
  async spawn() {
    throw new Error("PRODUCT_AGENT_HOST_UNAVAILABLE");
  },
  async wait() {
    throw new Error("PRODUCT_AGENT_HOST_UNAVAILABLE");
  },
  async cancel() {
    throw new Error("PRODUCT_AGENT_HOST_UNAVAILABLE");
  },
};

async function tombstoneUnavailableProductAgent(
  input: ProductAgentInput,
  assignments: PrivateAssignmentStore,
): Promise<ProductTaskCommandResult> {
  await new CancelAgentAssignment(
    unavailableProductAgentHost,
    assignments,
  ).execute(productAgentIdentity(input));
  await persistProductAgentSummary(
    input.taskId,
    productAgentUnknownSummary(input),
  ).catch(() => undefined);
  return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
}

async function cancelProductAgentTask(
  task: ProductTask,
): Promise<ProductTaskCommandResult> {
  const runningAgent = task.agent?.phase === "running" ? task.agent : null;
  if (!runningAgent) return taskFailure("TASK_NOT_RUNNING");
  if (persistedProductAgentExpiry?.taskId === task.taskId) {
    clearTimeout(persistedProductAgentExpiry.timer);
    persistedProductAgentExpiry = null;
  }
  if (activeProductAgentSession) {
    if (activeProductAgentSession.taskId !== task.taskId) {
      return taskFailure("AGENT_ALREADY_RUNNING");
    }
    if (
      !productAgentAssignmentMatches(
        runningAgent,
        activeProductAgentSession.input,
      )
    ) {
      await persistProductAgentSummary(
        task.taskId,
        productAgentUnknownSummaryFromTask(runningAgent),
      ).catch(() => undefined);
      await closeProductAgentSession(activeProductAgentSession);
      return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
    }
    return cancelProductAgentSession(activeProductAgentSession);
  }

  let input: ProductAgentInput | null;
  try {
    input = (await productAgentStore?.load(task.taskId)) ?? null;
  } catch {
    await persistProductAgentSummary(
      task.taskId,
      productAgentUnknownSummaryFromTask(runningAgent),
    ).catch(() => undefined);
    return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
  }
  if (!input || !productAgentAssignmentMatches(runningAgent, input)) {
    await persistProductAgentSummary(
      task.taskId,
      productAgentUnknownSummaryFromTask(runningAgent),
    ).catch(() => undefined);
    return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
  }

  const assignments = new PrivateAssignmentStore({
    root: codexAgentAssignmentRoot(),
  });
  const hostContextSnapshot = configuration?.snapshot();
  const context = productAgentHostContext(
    input,
    hostContextSnapshot?.status === "ready"
      ? hostContextSnapshot.settings
      : null,
    buildIdentity.buildId,
  );
  if (!context) return tombstoneUnavailableProductAgent(input, assignments);
  let session: ActiveProductAgentSession;
  try {
    // Existing Astra-backed assignments may only use this route for bounded
    // cancellation and cleanup; new work can use only the qualified route
    // selected by `farolBackedProductAgentRoute` above.
    session = await openProductAgentSession(
      input,
      context,
      legacyProductAgentCleanupRoute,
      false,
    );
  } catch {
    return tombstoneUnavailableProductAgent(input, assignments);
  }
  return cancelProductAgentSession(session);
}

async function executeProductAgent(
  task: ProductTask,
  input: ProductAgentInput,
  context: ProductAgentContext,
  admission: "new" | "rejoin",
): Promise<ProductTaskCommandResult> {
  const route = farolBackedProductAgentRoute();
  if (!route) return taskFailure("AGENT_NOT_READY");
  if (!productAgentInputMatchesContext(input, context, buildIdentity.buildId)) {
    return taskFailure("AGENT_NOT_READY");
  }
  let session: ActiveProductAgentSession;
  try {
    session = await openProductAgentSession(input, context, route);
  } catch (error) {
    const refusal = productAgentOpenRefusal(admission, error);
    if (refusal.record !== "none") {
      await persistProductAgentSummary(task.taskId, {
        assignmentBindingSha256: productAgentAssignmentBinding(input),
        phase: refusal.record,
        workspaceId: input.workspaceId,
        parentDelivery: "not_applicable",
        workspaceEnforcement: "not_applicable",
        resultAvailable: false,
      }).catch(() => undefined);
    }
    return taskFailure(refusal.failure);
  }
  const assignments = session.assignments;
  let result;
  try {
    result = await runProductAgentAssignment(
      context.settings,
      task,
      input,
      {
        host: session.host,
        assignments,
        now: () => Date.now(),
      },
      admission,
    );
  } catch {
    await persistProductAgentSummary(task.taskId, {
      assignmentBindingSha256: productAgentAssignmentBinding(input),
      phase: "outcome_unknown",
      workspaceId: input.workspaceId,
      parentDelivery: "not_applicable",
      workspaceEnforcement: "not_applicable",
      resultAvailable: false,
    }).catch(() => undefined);
    await closeProductAgentSession(session);
    return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
  }
  if (!result.ok) {
    const rejoinUnavailable = admission === "rejoin";
    await persistProductAgentSummary(task.taskId, {
      assignmentBindingSha256: productAgentAssignmentBinding(input),
      phase: rejoinUnavailable ? "outcome_unknown" : "failed",
      workspaceId: input.workspaceId,
      parentDelivery: "not_applicable",
      workspaceEnforcement: "not_applicable",
      resultAvailable: false,
    }).catch(() => undefined);
    await closeProductAgentSession(session);
    return taskFailure(
      rejoinUnavailable
        ? "AGENT_REJOIN_UNAVAILABLE"
        : "AGENT_ASSIGNMENT_FAILED",
    );
  }
  const receipt = result.value;
  const summary = productAgentSummary(input, receipt);
  try {
    if (!(await persistProductAgentSummary(task.taskId, summary))) {
      await closeProductAgentSession(session);
      return taskFailure("TASK_NOT_FOUND");
    }
  } catch {
    return taskFailure("TASK_STATE_UNAVAILABLE");
  }
  if (receipt.assignment.phase === "running") {
    return taskSuccess(task.taskId);
  }
  await closeProductAgentSession(session);
  if (receipt.assignment.phase === "outcome_unknown") {
    return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
  }
  if (receipt.assignment.phase === "failed" || !receipt.resultRef) {
    return taskFailure("AGENT_ASSIGNMENT_FAILED");
  }
  const assignment = receipt.assignment;
  const acknowledged = await new AcknowledgeAgentResult(assignments).execute({
    correlation: {
      ...assignment.identity,
      authorityId: assignment.authority.authorityId,
      participantId: assignment.authority.participantId,
      role: assignment.authority.role,
      parentThreadId: assignment.parentThreadId!,
      childId: assignment.childId!,
      parentTurnId: assignment.parentTurnId!,
      childTurnId: assignment.childTurnId!,
      hostRole: assignment.hostRole,
      delegationDigest: assignment.delegationDigest!,
    },
    parentParticipantId: assignment.authority.parentParticipantId,
    resultRef: receipt.resultRef,
  });
  if (!acknowledged.ok) return taskFailure("AGENT_DELIVERY_FAILED");
  try {
    await persistProductAgentSummary(
      task.taskId,
      productAgentSummary(input, {
        ...receipt,
        parentDelivery: acknowledged.value.parentDelivery,
      }),
    );
  } catch {
    return taskFailure("AGENT_DELIVERY_FAILED");
  }
  return taskSuccess(task.taskId);
}

async function runProductTaskCommand(
  value: unknown,
): Promise<ProductTaskCommandResult> {
  const command = ProductTaskCommandSchema.safeParse(value);
  if (!command.success) return taskFailure("TASK_COMMAND_INVALID");
  if (demoMode) {
    return taskFailure("TASKS_UNAVAILABLE");
  }
  if (taskMutations.inFlight()) {
    return taskFailure("TASK_OPERATION_IN_PROGRESS");
  }
  if (command.data.kind === "task.activate") {
    const mutation = taskMutations.tryEnter();
    if (!mutation) return taskFailure("TASK_OPERATION_IN_PROGRESS");
    try {
      if (!liveTaskRegistry.get(command.data.taskId)) {
        return taskFailure("TASK_NOT_FOUND");
      }
      selectedTaskId = command.data.taskId;
      section = "browser";
      shellOverlay = "none";
      applyLayout();
      publishLayout();
      return (await openLiveTaskSurface(command.data.taskId))
        ? taskSuccess(command.data.taskId)
        : taskFailure("TASK_SURFACE_UNREACHABLE");
    } finally {
      mutation.release();
    }
  }
  if (!liveTaskStore) return taskFailure("TASK_STATE_UNAVAILABLE");
  const mutation = taskMutations.tryEnter();
  if (!mutation) return taskFailure("TASK_OPERATION_IN_PROGRESS");
  const before = liveTaskRegistry.snapshot();
  try {
    if (
      command.data.kind === "task.start-agent" ||
      command.data.kind === "task.rejoin-agent"
    ) {
      if (!FAROL_BACKED_PRODUCT_AGENT_ENABLED) {
        return taskFailure("AGENT_NOT_READY");
      }
      const task = liveTaskRegistry.get(command.data.taskId);
      if (!task || task.provider !== "chatgpt") {
        return taskFailure("TASK_NOT_FOUND");
      }
      if (
        activeProductAgentSession &&
        activeProductAgentSession.taskId !== task.taskId
      ) {
        return taskFailure("AGENT_ALREADY_RUNNING");
      }
      const pendingTaskId = pendingProductAgentTaskId();
      if (pendingTaskId && pendingTaskId !== task.taskId) {
        return taskFailure("AGENT_ALREADY_RUNNING");
      }

      let input: ProductAgentInput;
      let context: ProductAgentContext | null;
      if (command.data.kind === "task.start-agent") {
        if (task.agent?.phase === "outcome_unknown") {
          return taskFailure("AGENT_ASSIGNMENT_OUTCOME_UNKNOWN");
        }
        if (
          task.agent?.phase === "running" ||
          (task.agent?.phase === "completed" &&
            task.agent.parentDelivery !== "acknowledged")
        ) {
          return taskFailure("AGENT_ALREADY_RUNNING");
        }
        const startAgentSnapshot = configuration?.snapshot();
        context = productAgentContext(
          command.data.workspaceId,
          startAgentSnapshot?.status === "ready"
            ? startAgentSnapshot.settings
            : null,
          productAgentStore,
          buildIdentity.buildId,
        );
        if (!context) return taskFailure("AGENT_NOT_READY");
        const candidate = productAgentInput(
          task,
          context,
          command.data.objective,
          command.data.scope,
        );
        if (!candidate) return taskFailure("AGENT_SCOPE_INVALID");
        input = candidate;
        try {
          await productAgentStore!.save(input);
        } catch {
          return taskFailure("AGENT_INPUT_STATE_UNAVAILABLE");
        }
        // S35-03/4: starting a native Agent turns this task into the SAME
        // `AGENT_RUNNING` obligation a promotion's drain check refuses on,
        // so it takes the same cross-process lease `admitDurable` does for
        // a brand new task — not only new admission is guarded.
        //
        // S35-TA-1: the leased body is `startAgentDurable`, so a
        // stolen-lease test drives the function this call site calls
        // rather than a copy of it.
        const agentStart = await liveTaskRegistry.startAgentDurable(
          task.taskId,
          {
            assignmentBindingSha256: productAgentAssignmentBinding(input),
            phase: "running",
            workspaceId: input.workspaceId,
            parentDelivery: "not_applicable",
            workspaceEnforcement: "not_applicable",
            resultAvailable: false,
          },
          () => persistLiveTaskState(),
          before,
          () => productAgentStore!.remove(task.taskId).catch(() => undefined),
        );
        if (!agentStart.ok) {
          // A lease a live promotion holds is the one refusal that leaves
          // the Agent input saved: the other two have already compensated.
          if (agentStart.code === "TASK_ROUTE_UNAVAILABLE") {
            await productAgentStore!.remove(task.taskId).catch(() => undefined);
          }
          return taskFailure(agentStart.code);
        }
        publishTasksState();
      } else {
        // S35-TA-11: the admission itself is `admitProductAgentRejoin`, so
        // the one thing that matters here — that the settings are read AFTER
        // the awaited load, not before — is exercised by tests rather than
        // asserted in a comment. `readSettings` is passed as a thunk for
        // exactly that reason: the module, not this call site, decides when
        // it runs.
        const admitted = await admitProductAgentRejoin({
          agent: task.agent,
          loadInput: () => productAgentStore!.load(task.taskId),
          readSettings: () => {
            const snapshot = configuration?.snapshot();
            return snapshot?.status === "ready" ? snapshot.settings : null;
          },
          store: productAgentStore,
          buildId: buildIdentity.buildId,
          assignmentMatches: productAgentAssignmentMatches,
        });
        if (!admitted.ok) {
          if (admitted.recordUnknownSummary) {
            await persistProductAgentSummary(
              task.taskId,
              productAgentUnknownSummaryFromTask(task.agent!),
            ).catch(() => undefined);
          }
          return taskFailure(admitted.refusal);
        }
        input = admitted.input;
        context = admitted.context;
      }
      return executeProductAgent(
        task,
        input,
        context,
        command.data.kind === "task.rejoin-agent" ? "rejoin" : "new",
      );
    }
    if (command.data.kind === "task.rename") {
      if (!liveTaskRegistry.rename(command.data.taskId, command.data.label)) {
        return taskFailure("TASK_NOT_FOUND");
      }
      try {
        await persistLiveTaskState();
      } catch {
        liveTaskRegistry.rollback(before);
        return taskFailure("TASK_STATE_UNAVAILABLE");
      }
      liveTaskRoutes
        .get(command.data.taskId)
        ?.setTitle(`${command.data.label.trim()} · Farol`);
      publishTasksState();
      return taskSuccess(command.data.taskId);
    }
    if (command.data.kind === "task.pin") {
      if (
        !liveTaskRegistry.setPinned(command.data.taskId, command.data.pinned)
      ) {
        return taskFailure("TASK_NOT_FOUND");
      }
      try {
        await persistLiveTaskState();
      } catch {
        liveTaskRegistry.rollback(before);
        return taskFailure("TASK_STATE_UNAVAILABLE");
      }
      publishTasksState();
      return taskSuccess(command.data.taskId);
    }
    if (command.data.kind === "task.close") {
      const task = liveTaskRegistry.get(command.data.taskId);
      if (
        task?.agent?.phase === "running" ||
        (task?.agent?.phase === "completed" &&
          task.agent.parentDelivery !== "acknowledged")
      ) {
        return taskFailure("AGENT_ALREADY_RUNNING");
      }
      if (persistedProductAgentExpiry?.taskId === command.data.taskId) {
        clearTimeout(persistedProductAgentExpiry.timer);
        persistedProductAgentExpiry = null;
      }
      const closed = await routeBTaskLifecycle.close(command.data.taskId);
      if (!closed.ok) return taskFailure(closed.code);
      const tasks = liveTaskRegistry.snapshot().tasks;
      selectedTaskId =
        selectedTaskId === command.data.taskId
          ? (tasks[0]?.taskId ?? "")
          : selectedTaskId;
      shellOverlay = "none";
      publishTasksState();
      applyLayout();
      publishLayout();
      return taskSuccess(selectedTaskId || null);
    }
    if (command.data.kind === "task.cancel") {
      const task = liveTaskRegistry.get(command.data.taskId);
      if (!task) return taskFailure("TASK_NOT_FOUND");
      if (task.agent?.phase === "running") {
        return cancelProductAgentTask(task);
      }
      if (
        task.agent?.phase === "completed" &&
        task.agent.parentDelivery !== "acknowledged"
      ) {
        return taskFailure("AGENT_ALREADY_RUNNING");
      }
      const route = liveTaskRoutes.get(command.data.taskId);
      if (!route) return taskFailure("TASK_NOT_FOUND");
      const result = await route.cancelActiveTask();
      if (result === "not_running") return taskFailure("TASK_NOT_RUNNING");
      const lifecycle =
        result === "cancelled" ? "cancelled" : "outcome_unknown";
      liveTaskRegistry.setLifecycle(command.data.taskId, lifecycle);
      publishTasksState();
      try {
        await persistLiveTaskState();
      } catch {
        liveTaskStore = null;
        surfaceLiveTaskPersistenceFailure(command.data.taskId);
        return taskFailure("TASK_STATE_UNAVAILABLE");
      }
      return result === "cancelled"
        ? taskSuccess(command.data.taskId)
        : taskFailure("TASK_CANCEL_FAILED");
    }
    if (!chatGptTaskAdmissionReady()) {
      return taskFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
    }
    if (!chatGptRoute) return taskFailure("TASK_ROUTE_UNAVAILABLE");

    const labels = new Set(
      liveTaskRegistry.snapshot().tasks.map((candidate) => candidate.label),
    );
    let ordinal = 1;
    while (labels.has(`ChatGPT task ${ordinal}`)) ordinal += 1;
    const task: ProductTask = {
      taskId: randomUUID(),
      sessionId: randomUUID(),
      turnId: randomUUID(),
      label: `ChatGPT task ${ordinal}`,
      provider: "chatgpt",
      requestedModel: "Account default",
      observedModel: null,
      requestedMode: "Account default",
      observedMode: null,
      hasComputer: false,
      pinned: false,
      lifecycle: "idle",
    };
    // S35-03/2: see `admitRouteBTask` above — admits and persists under the
    // same cross-process lease a promotion holds through placement.
    let admitted: LiveTaskAdmission;
    try {
      admitted = await liveTaskRegistry.admitDurable(
        task,
        persistLiveTaskState,
      );
    } catch {
      return taskFailure("TASK_STATE_UNAVAILABLE");
    }
    if (admitted.status === "capacity") {
      return taskFailure("TASK_CAPACITY_REACHED");
    }
    if (admitted.status !== "admitted") {
      return taskFailure("TASK_ROUTE_UNAVAILABLE");
    }
    const route = createLiveChatGptRoute(task.taskId, task.label);
    liveTaskConversationUrls.set(task.taskId, null);
    liveTaskRoutes.set(task.taskId, route);
    selectedTaskId = task.taskId;
    section = "browser";
    setupOpen = false;
    shellOverlay = "none";
    publishTasksState();
    publishLayout();
    if (!(await openLiveTaskSurface(task.taskId))) {
      return taskFailure("TASK_SURFACE_UNREACHABLE");
    }
    return taskSuccess(task.taskId);
  } finally {
    mutation.release();
  }
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

function supportRuntimeErrorCode(
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

async function selectedSupportExportTarget(): Promise<string | null> {
  if (process.env.FAROL_NEXT_E2E === "1") {
    const target = process.env.FAROL_NEXT_E2E_SUPPORT_EXPORT;
    if (!target || !path.isAbsolute(target) || target.includes("\0")) {
      throw new Error("SUPPORT_EXPORT_E2E_TARGET_INVALID");
    }
    return target;
  }
  const options: SaveDialogOptions = {
    title: "Export content-free Farol support report",
    defaultPath: path.join(
      app.getPath("documents"),
      `Farol-Next-Support-${buildIdentity.version}.json`,
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

function chatGptAttachmentStagingRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-state",
    "attachment-staging",
  );
}

function chatGptTaskJournalRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-state",
    "chatgpt-task-journal",
  );
}

function chatGptConversationStoreRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-state",
    "chatgpt-conversation",
  );
}

function liveTaskStoreRoot(): string {
  return path.join(app.getPath("userData"), "farol-next-state", "live-tasks");
}

function contextContinuityRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-state",
    "context-continuity",
  );
}

function secureMcpConnectorRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-state",
    "secure-mcp-connector",
  );
}

function modelEndpointStateRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-private",
    "model-endpoint",
  );
}

// DEV manages only the config inside its app-owned Codex home. It never
// reads, writes or falls back to the owner's ~/.codex. Packaged Preview keeps
// its existing explicitly owner-operated configuration behavior.
function farolModelCodexConfigPath(): string {
  const override =
    process.env.FAROL_NEXT_E2E === "1"
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

function modelStatusEvidencePayload(
  status: FarolModelLifecycleStatus,
): Readonly<{
  kind: "model.status";
  state: "port_conflict" | "listening" | "connected";
  port: number | null;
  requestsServed: number;
  occupant?: "unprobed" | "farol" | "foreign" | "vacated";
}> | null {
  // S35-TA-2: a sealed endpoint accepts nothing, so it reports exactly
  // what the caller of a dead endpoint gets — `MODEL_ENDPOINT_UNAVAILABLE`
  // from the `null` below. It is deliberately not a new evidence value:
  // `model.status` is a cross-process contract, and "unavailable" is the
  // true statement about an endpoint that will never serve again.
  if (status.state === "not_running" || status.state === "sealed") return null;
  if (status.state === "port_conflict") {
    return {
      kind: "model.status",
      state: "port_conflict",
      port: status.port,
      requestsServed: 0,
      occupant: status.occupant,
    };
  }
  return {
    kind: "model.status",
    state: status.state,
    port: status.port,
    requestsServed: status.requestsServed,
  };
}

// E2E-only: a minimal, valid OpenAI Responses-shaped completed turn, used
// solely behind the FAROL_NEXT_E2E + FAROL_MODEL_E2E_SYNTHETIC_REPLY double
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
  if (buildEnvironment === "dev") return "not_running";
  const snapshot = configuration ? configuration.snapshot() : null;
  const executablePath =
    snapshot && snapshot.status === "ready"
      ? snapshot.settings.nativeHosts.codex?.executablePath
      : undefined;
  if (!executablePath) return "unknown";
  return (await detectCodexHostPresence({ executablePath })).state;
}

function secureMcpCredentialRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-private",
    "secure-mcp-connector",
  );
}

function secureMcpLaunchRoot(): string {
  return path.join(secureMcpConnectorRoot(), "computer-authority");
}

let desktopComputerMcpLifecycle: PrivateMcpLifecycle | null = null;
function computerMcpLifecycle(): PrivateMcpLifecycle {
  // Boot owns one lifecycle so concurrent Start/Stop share stop admission.
  desktopComputerMcpLifecycle ??= new PrivateMcpLifecycle(
    secureMcpLaunchRoot(),
  );
  return desktopComputerMcpLifecycle;
}

async function stopAndConfirmComputerMcp(
  connector = secureMcpConnectorRuntime,
  inFlightStart: Promise<void> | null = null,
): Promise<void> {
  if (!connector) throw new Error("CONNECTOR_STOP_UNCONFIRMED");
  const lifecycle = computerMcpLifecycle();
  await drainComputerConnector({
    beginStop: () => lifecycle.beginStop(),
    startInFlight: inFlightStart,
    waitForMcpStop: () => lifecycle.waitForStop(),
    stopConnector: () => connector.stop(),
    closeSavedChat: async () => {
      // Wait for admitted account work before closing its Browser endpoint.
      const savedChat = savedChatBridgeRuntime;
      try {
        if (savedChat) {
          await savedChat.close();
          if (savedChatBridgeRuntime === savedChat)
            savedChatBridgeRuntime = null;
        }
      } finally {
        // Withdraw the original Go owner even when the old adapter drain fails.
        // A failure remains unconfirmed; it cannot authorize a new launch.
        await desktopGoCore?.closeComputerConnector();
      }
    },
    confirmStop: () => lifecycle.confirmStop(),
  });
}

function devMcpProofRoot(): string {
  return path.join(
    activeDesktopIdentity.userData,
    "farol-next-private",
    "dev-mcp-proof",
  );
}

function codexHostProbeRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-state",
    "codex-host-probe",
  );
}

function codexAgentAssignmentRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-state",
    "native-agent-assignments",
  );
}

function productAgentInputRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-state",
    "product-agent-inputs",
  );
}

async function codexHostRuntimeRoot(): Promise<string> {
  const root = path.join(
    app.getPath("userData"),
    "farol-next-state",
    "codex-host-runtime",
  );
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
  if (buildEnvironment === "dev") await codexHostHomePath();
  return { codexHomePath: selected };
}

async function codexHostProcessHomePath(): Promise<string> {
  const { processHomePath: root } = desktopCodexChildHomes(
    buildEnvironment,
    activeDesktopIdentity,
    app.getPath("home"),
    process.env.CODEX_HOME,
  );
  if (buildEnvironment !== "dev") return root;
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
  if (!chatGptConversationStore) return "unavailable";
  if (chatGptConversation?.state === "retained") return "retained";
  if (chatGptConversation?.state === "unresolved") return "review_required";
  return "new";
}

function chatGptConversationAdmissionFailure(): ProductConfigurationResult | null {
  if (goReadonlyConversation || directChatStart)
    return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
  if (!chatGptConversationStore) {
    return configurationFailure("CHATGPT_CONVERSATION_STATE_FAILED");
  }
  if (chatGptConversation?.state === "unresolved") {
    return configurationFailure("CHATGPT_CONVERSATION_REVIEW_REQUIRED");
  }
  return null;
}

function chatGptConversationContinuity():
  "retained" | "not_observed" | "review_required" | "unavailable" {
  const state = chatGptConversationState();
  return state === "new" ? "not_observed" : state;
}

const chatGptAppPreSubmitCodes = new Set([
  "CHATGPT_APP_SELECTION_MISSING",
  "CHATGPT_APP_SELECTION_AMBIGUOUS",
  "CHATGPT_APP_SELECTION_CONFLICT",
  "CHATGPT_APP_SELECTION_LOST",
  "CHATGPT_COMPOSER_DRAFT_PRESENT",
]);

function chatGptAppPreSubmitObservation(code: string | null) {
  if (code === null || !chatGptAppPreSubmitCodes.has(code)) return null;
  return {
    state: "authenticated" as const,
    profile: "chatgpt.next-partition/1",
    runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
    buildId: buildIdentity.buildId,
    protocol: "chatgpt-page-app-binding-block/1",
  };
}

async function retainChatGptConversation(
  operationId: string,
  taskState:
    | "completed"
    | "not_authenticated"
    | "failed_before_submit"
    | "outcome_unknown",
): Promise<"retained" | "not_observed" | "review_required" | "unavailable"> {
  if (
    taskState === "not_authenticated" ||
    taskState === "failed_before_submit"
  ) {
    return chatGptConversationContinuity();
  }
  if (!chatGptConversationStore || !chatGptRoute) return "unavailable";
  const conversationUrl = chatGptRoute.currentConversationUrl();
  try {
    if (conversationUrl === null) {
      await chatGptConversationStore.markUnresolved(operationId);
      chatGptConversation = await chatGptConversationStore.load();
      return "review_required";
    }
    await chatGptConversationStore.retain({ operationId, conversationUrl });
    chatGptConversation = await chatGptConversationStore.load();
    return "retained";
  } catch {
    chatGptConversationStore = null;
    chatGptConversation = null;
    return "unavailable";
  }
}

function chatGptJournalObservation(result: ChatGptTaskJournalResult) {
  if (result.state === "completed") {
    return {
      state: "authenticated" as const,
      profile: "chatgpt.next-partition/1",
      runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
      buildId: buildIdentity.buildId,
      protocol: "chatgpt-page-task-recovery/1",
    };
  }
  if (result.state === "not_authenticated") {
    return { state: "signed_out" as const };
  }
  if (result.state === "outcome_unknown") {
    return { state: "outcome_unknown" as const };
  }
  const bindingBlock = chatGptAppPreSubmitObservation(result.code);
  if (bindingBlock !== null) return bindingBlock;
  return result.code === "CHATGPT_PAGE_UNREACHABLE"
    ? { state: "unreachable" as const }
    : { state: "unsupported" as const };
}

async function discardPreparedChatGptTask(
  operationId: string,
): Promise<boolean> {
  if (!chatGptTaskJournal) return false;
  try {
    await chatGptTaskJournal.discardPrepared(operationId);
    return true;
  } catch {
    return false;
  }
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
  // The Go owner must confirm cancellation/ACK before the legacy preview
  // journal is cleared. Retain either failure; UI repetition is not a retry.
  const result = Promise.resolve().then(async () => {
    if (!(await withdrawGoReadonlyAdmission(pending.goAdmission))) return false;
    if (!(await discardPreparedChatGptTask(pending.operationId))) return false;
    if (pendingChatGptReadonlyTask === pending)
      pendingChatGptReadonlyTask = null;
    return true;
  });
  readonlyDiscardAttempts.set(pending, result);
  return result;
}

async function selectedChatGptAttachmentPaths(): Promise<
  readonly string[] | "cancelled" | "invalid"
> {
  if (process.env.FAROL_NEXT_E2E === "1") {
    try {
      const parsed = z
        .array(z.string().refine((value) => path.isAbsolute(value)))
        .min(1)
        .max(4)
        .safeParse(
          JSON.parse(
            process.env.FAROL_NEXT_E2E_ATTACHMENTS ?? "null",
          ) as unknown,
        );
      return parsed.success ? parsed.data : "invalid";
    } catch {
      return "invalid";
    }
  }
  if (!window) return "invalid";
  const selected = await dialog.showOpenDialog(window, {
    title: "Choose up to four attachments",
    buttonLabel: "Review Attachments",
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Supported images and documents",
        extensions: ["png", "jpg", "jpeg", "webp", "pdf", "txt", "md"],
      },
    ],
    securityScopedBookmarks: false,
  });
  if (selected.canceled) return "cancelled";
  if (selected.filePaths.length < 1 || selected.filePaths.length > 4) {
    return "invalid";
  }
  return selected.filePaths;
}

function attachmentStagingFailure(error: unknown): ProductConfigurationResult {
  const code = error instanceof Error ? error.message : "";
  if (code === "ATTACHMENT_TYPE_UNSUPPORTED") {
    return configurationFailure("CHATGPT_ATTACHMENT_TYPE_UNSUPPORTED");
  }
  if (
    code === "ATTACHMENT_TOO_LARGE" ||
    code === "ATTACHMENT_TOTAL_TOO_LARGE"
  ) {
    return configurationFailure("CHATGPT_ATTACHMENT_TOO_LARGE");
  }
  if (
    code === "ATTACHMENT_SOURCE_MISSING" ||
    code === "ATTACHMENT_REFERENCE_MISSING" ||
    code === "ATTACHMENT_REFERENCE_CHANGED"
  ) {
    return configurationFailure("CHATGPT_ATTACHMENT_REFERENCE_MISSING");
  }
  if (
    code === "ATTACHMENT_SELECTION_INVALID" ||
    code === "ATTACHMENT_DUPLICATE_NAME" ||
    code === "ATTACHMENT_EMPTY" ||
    code === "ATTACHMENT_SOURCE_UNSAFE"
  ) {
    return configurationFailure("CHATGPT_ATTACHMENT_SELECTION_INVALID");
  }
  return configurationFailure("CHATGPT_ATTACHMENT_STAGING_FAILED");
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
    process.env.FAROL_NEXT_E2E === "1" &&
    process.env.FAROL_NEXT_E2E_CANCEL_WORKSPACE_PICKER === "1"
  )
    return "cancelled";
  let selected: string | undefined;
  const testRoot =
    process.env.FAROL_NEXT_E2E === "1"
      ? process.env.FAROL_NEXT_E2E_WORKSPACE_ROOT
      : undefined;
  if (testRoot) {
    selected = testRoot;
  } else {
    if (!window) return "invalid";
    const result = await dialog.showOpenDialog(window, {
      title: "Add a read-only workspace",
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
let pendingWorkspacePick: Readonly<{
  id: string;
  selected: Exclude<
    Awaited<ReturnType<typeof selectedWorkspace>>,
    "cancelled" | "invalid"
  >;
  expiresAt: number;
}> | null = null;

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
    process.env.FAROL_NEXT_E2E === "1"
      ? process.env.FAROL_NEXT_E2E_CODEX_EXECUTABLE
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
      scratchRoot: codexHostProbeRoot(),
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
    process.env.FAROL_NEXT_E2E === "1"
      ? process.env.FAROL_NEXT_E2E_TUNNEL_CLIENT
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
  if (!window) return "invalid";
  const result = await dialog.showOpenDialog(window, {
    title: "Choose the tunnel-client executable",
    buttonLabel: "Verify tunnel-client",
    properties: ["openFile"],
    securityScopedBookmarks: false,
  });
  if (result.canceled || result.filePaths.length !== 1) return "cancelled";
  const selected = result.filePaths[0];
  return selected && path.isAbsolute(selected) && !selected.includes("\0")
    ? selected
    : "invalid";
}

async function verifyTunnelClientExecutable(
  executablePath: string,
  expectedDiscovery?: Readonly<{ canonicalPath: string; sha256: string }>,
): Promise<ProductConfigurationResult> {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  try {
    const probe = await probeTunnelClient({
      executablePath,
      ...(expectedDiscovery ? { expectedDiscovery } : {}),
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

function connectorAttemptGeneration(
  input: Readonly<{
    connectorGeneration: number;
    computerGeneration: number;
    launchContractSha256: string;
    phase: string;
  }>,
): string {
  return createHash("sha256")
    .update(
      [
        String(input.connectorGeneration),
        String(input.computerGeneration),
        buildIdentity.buildId,
        input.launchContractSha256,
        input.phase,
      ].join("\0"),
    )
    .digest("hex");
}

async function recordConnectorRuntime(
  state: "ready" | "unreachable" | "outcome_unknown",
  runtimeGeneration: string,
  computerGeneration: number,
): Promise<ProductConfigurationResult | null> {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  const recorded = await configuration.recordSecureMcpRuntime({
    state,
    runtimeGeneration,
    computerGeneration,
    buildId: buildIdentity.buildId,
  });
  return recorded.ok ? null : ProductConfigurationResultSchema.parse(recorded);
}

async function startSecureMcpConnector(
  repair: boolean,
  resumeAfterQuit = false,
): Promise<ProductConfigurationResult> {
  if (quitInProgress || installedUpdateAdmission)
    return configurationFailure("CONNECTOR_START_FAILED");
  if (
    !configuration ||
    !connectorCredentialStore ||
    !secureMcpConnectorRuntime
  ) {
    return configurationFailure("SETTINGS_UNAVAILABLE");
  }
  if (secureMcpConnectorRuntime.hasUnresolvedEffect())
    return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
  const retained = configuration.snapshot();
  if (
    retained.status === "ready" &&
    (retained.settings.connectors.secureMcp.runtime?.state ===
      "outcome_unknown" ||
      retained.settings.setup.connect.outcomeUnknown)
  )
    return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
  if (connectorTaskAdmission) {
    return configurationFailure("CONNECTOR_ALREADY_RUNNING");
  }
  // A start whose fence recovery could hold no record leaves the broker
  // nothing to refuse with: the connector is not exposed at all until a
  // later start recovers.
  const fenceAdmission = computerConnectorAdmission(summaryFenceRecovery);
  if (!fenceAdmission.admissible) {
    return configurationFailure(fenceAdmission.code);
  }
  if (secureMcpConnectorRuntime.isRunning() && !repair) {
    return configurationFailure("CONNECTOR_ALREADY_RUNNING");
  }
  const transition = authorityTransitions.tryReserve("connector-start");
  if (!transition) return transitionRefusal();
  connectorTaskAdmission = true;
  let finishStart!: () => void;
  connectorStartInFlight = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  try {
    if (repair) {
      try {
        await stopAndConfirmComputerMcp();
      } catch {
        return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
      }
    }
    if (repair || resumeAfterQuit) {
      // The previous process has exited. Withdraw its live proof under this
      // start reservation before any new launch can succeed or be refused.
      // Historical completion remains available, but is never live readiness.
      const stopped = await configuration.recordSecureMcpStopped();
      if (!stopped.ok) return ProductConfigurationResultSchema.parse(stopped);
    }
    // The ordinary Computer route is the selected Go backend. Its absence
    // cannot fall back to a separate TS authority or native helper.
    const core = desktopGoCore;
    if (!core) return configurationFailure("CONNECTOR_START_FAILED");
    const snapshot = configuration.snapshot();
    if (snapshot.status !== "ready") {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    const connector = snapshot.settings.connectors.secureMcp;
    if (
      connector.runtime?.state === "outcome_unknown" ||
      snapshot.settings.setup.connect.outcomeUnknown
    )
      return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
    if (!connector.tunnelClient || !connector.tunnelId) {
      return configurationFailure("CONNECTOR_CONFIGURE_FAILED");
    }
    // Settings pin canonical bytes, not just a command pathname. Recheck
    // before configure/doctor/start can execute the saved selection.
    try {
      await verifySelectedTunnelClient(connector.tunnelClient);
    } catch (error) {
      const refusal =
        error instanceof Error &&
        error.message === "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE"
          ? "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE"
          : "TUNNEL_CLIENT_EXECUTABLE_UNSAFE";
      if (resumeAfterQuit) {
        const stopped = await configuration.recordSecureMcpStopped(refusal);
        if (!stopped.ok) return ProductConfigurationResultSchema.parse(stopped);
      }
      return configurationFailure(refusal);
    }
    let credentialReference: string;
    try {
      credentialReference = await connectorCredentialStore.reference();
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "CONNECTOR_CREDENTIAL_MISSING") {
        await configuration.recordSecureMcpCredential("missing");
        return configurationFailure("CONNECTOR_CREDENTIAL_REQUIRED");
      }
      return configurationFailure("CONNECTOR_CREDENTIAL_STORE_FAILED");
    }

    const runtimeId = randomUUID();
    const verificationChallenge = randomUUID();
    const verificationChallengeSha256 = createHash("sha256")
      .update(verificationChallenge)
      .digest("hex");
    let launchFile: string;
    let launchContractSha256: string;
    try {
      await clearConnectorVerificationReceipt(secureMcpLaunchRoot());
      const intentDigest = createHash("sha256")
        .update(
          JSON.stringify({
            buildId: buildIdentity.buildId,
            runtimeId,
            computerGeneration: snapshot.settings.computer.generation,
            connectorGeneration: connector.generation,
            challengeSha256: verificationChallengeSha256,
          }),
        )
        .digest("hex");
      const opened = await core.openComputerConnector(
        runtimeId,
        intentDigest,
        verificationChallengeSha256,
        secureMcpLaunchRoot(),
      );
      if (!opened.launchFile || !opened.launchSha256)
        throw new Error("COMPUTER_MCP_GO_LAUNCH_UNAVAILABLE");
      launchFile = opened.launchFile;
      launchContractSha256 = opened.launchSha256;
      // An earlier Quit/update may have stopped admission while the contract
      // was being written. Do not clear its stop marker with a later prepare.
      if (quitInProgress || installedUpdateAdmission)
        return configurationFailure("CONNECTOR_START_FAILED");
      await computerMcpLifecycle().prepare(launchContractSha256);
    } catch (error) {
      if (error instanceof ConnectorHostError) {
        const connectorAttempt = {
          method: "computer.connector.open" as const,
          requestId: error.requestId,
          operationId: error.operationId,
          outcome: error.outcome,
        };
        if (error.outcome === "unknown") {
          // The Go operation may have published before its reply was lost.
          // Retain the original IDs in the caller result and a sticky runtime
          // generation in the existing settings owner, never another open.
          const generation = createHash("sha256")
            .update([error.requestId, error.operationId].join("\0"))
            .digest("hex");
          try {
            const recorded = await recordConnectorRuntime(
              "outcome_unknown",
              generation,
              snapshot.settings.computer.generation,
            );
            if (recorded && !recorded.ok)
              return ProductConfigurationResultSchema.parse({
                ...recorded,
                connectorAttempt,
              });
          } catch {
            return configurationFailure(
              "SETTINGS_WRITE_FAILED",
              connectorAttempt,
            );
          }
          return configurationFailure(
            "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN",
            connectorAttempt,
          );
        }
        return configurationFailure("CONNECTOR_START_FAILED", connectorAttempt);
      }
      const code = error instanceof Error ? error.message : "";
      if (code.startsWith("COMPUTER_MCP_")) {
        return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
      }
      if (code === "SECURE_MCP_WORKSPACE_REQUIRED") {
        return configurationFailure("CONNECTOR_WORKSPACE_REQUIRED");
      }
      if (code === "SECURE_MCP_WORKSPACE_LIMIT") {
        return configurationFailure("CONNECTOR_WORKSPACE_LIMIT");
      }
      return configurationFailure("CONNECTOR_START_FAILED");
    }

    const attempt = (phase: string) =>
      connectorAttemptGeneration({
        connectorGeneration: connector.generation,
        computerGeneration: snapshot.settings.computer.generation,
        launchContractSha256,
        phase,
      });
    try {
      await secureMcpConnectorRuntime.configure({
        executablePath: connector.tunnelClient.executablePath,
        tunnelId: connector.tunnelId,
        credentialReference,
        mcp: {
          electronPath: process.execPath,
          entryPath: path.join(directory, "computer-mcp.cjs"),
          launchContractPath: launchFile,
        },
      });
    } catch (error) {
      const unknown = error instanceof ConnectorRuntimeEffectUnknown;
      const failed = await recordConnectorRuntime(
        unknown ? "outcome_unknown" : "unreachable",
        attempt("configure"),
        snapshot.settings.computer.generation,
      );
      if (failed) return failed;
      return configurationFailure(
        unknown
          ? "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"
          : "CONNECTOR_CONFIGURE_FAILED",
      );
    }
    try {
      await secureMcpConnectorRuntime.doctor({
        executablePath: connector.tunnelClient.executablePath,
      });
    } catch {
      const failed = await recordConnectorRuntime(
        "unreachable",
        attempt("doctor"),
        snapshot.settings.computer.generation,
      );
      if (failed) return failed;
      return configurationFailure("CONNECTOR_DOCTOR_FAILED");
    }

    let started;
    // Quit closes new admission first. If it arrived while configure or
    // doctor was pending, do not launch a tunnel after its drain began.
    if (quitInProgress || installedUpdateAdmission)
      return configurationFailure("CONNECTOR_START_FAILED");
    try {
      started = await secureMcpConnectorRuntime.start({
        executablePath: connector.tunnelClient.executablePath,
        executableSha256: connector.tunnelClient.executableSha256,
        connectorGeneration: connector.generation,
        computerGeneration: snapshot.settings.computer.generation,
        buildId: buildIdentity.buildId,
        launchContractSha256,
      });
    } catch {
      const failed = await recordConnectorRuntime(
        "unreachable",
        attempt("start"),
        snapshot.settings.computer.generation,
      );
      if (failed) return failed;
      return configurationFailure("CONNECTOR_START_FAILED");
    }
    const failed = await recordConnectorRuntime(
      started.state,
      started.runtimeGeneration,
      snapshot.settings.computer.generation,
    );
    if (failed) return failed;
    if (started.state === "unreachable") {
      return configurationFailure("CONNECTOR_RUNTIME_UNREACHABLE");
    }
    if (started.state === "outcome_unknown") {
      return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
    }
    const challenged = await configuration.recordSecureMcpChallenge({
      challenge: verificationChallenge,
      runtimeGeneration: started.runtimeGeneration,
      computerGeneration: snapshot.settings.computer.generation,
      buildId: buildIdentity.buildId,
    });
    if (!challenged.ok) {
      try {
        await stopAndConfirmComputerMcp();
      } catch {
        return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
      }
      await configuration.recordSecureMcpStopped().catch(() => undefined);
      return ProductConfigurationResultSchema.parse(challenged);
    }
    return ProductConfigurationResultSchema.parse({
      ok: true,
      snapshot: challenged.snapshot,
      evidence: {
        kind: "connector.runtime",
        state: "ready",
        runtimeGeneration: started.runtimeGeneration,
        computerGeneration: snapshot.settings.computer.generation,
        buildId: buildIdentity.buildId,
      },
    });
  } finally {
    connectorTaskAdmission = false;
    transition.release();
    finishStart();
    connectorStartInFlight = null;
  }
}

type ConnectorAppVerificationBinding = Readonly<{
  tunnelId: string;
  connectorGeneration: number;
  computerGeneration: number;
  runtimeGeneration: string;
  challengeSha256: string;
  buildId: string;
  workspaceId: string;
  appName?: string;
}>;

function connectorAppBindingCurrent(
  settings: ProductSettings,
  expected: ConnectorAppVerificationBinding,
): boolean {
  const connector = settings.connectors.secureMcp;
  return (
    settings.computer.generation === expected.computerGeneration &&
    settings.setup.computer.verified?.workspaceId === expected.workspaceId &&
    connector.tunnelId === expected.tunnelId &&
    connector.generation === expected.connectorGeneration &&
    connector.runtime?.runtimeGeneration === expected.runtimeGeneration &&
    connector.runtime?.buildId === expected.buildId &&
    connector.challenge?.challengeSha256 === expected.challengeSha256 &&
    (expected.appName === undefined ||
      selectedConnectorApp(connector) === expected.appName)
  );
}

async function checkSecureMcpAttachment(
  expectedWorkspaceId?: string,
  expectedBinding?: ConnectorAppVerificationBinding,
): Promise<ProductConfigurationResult> {
  if (!configuration || !secureMcpConnectorRuntime) {
    return configurationFailure("SETTINGS_UNAVAILABLE");
  }
  if (connectorTaskAdmission) {
    return configurationFailure("CONNECTOR_ALREADY_RUNNING");
  }
  connectorTaskAdmission = true;
  try {
    const snapshot = configuration.snapshot();
    if (snapshot.status !== "ready") {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    if (
      expectedBinding &&
      !connectorAppBindingCurrent(snapshot.settings, expectedBinding)
    ) {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
    }
    const connector = snapshot.settings.connectors.secureMcp;
    const runtime = connector.runtime;
    const challenge = connector.challenge;
    if (
      expectedWorkspaceId !== undefined &&
      snapshot.settings.setup.computer.verified?.workspaceId !==
        expectedWorkspaceId
    ) {
      return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
    }
    if (
      runtime?.state !== "ready" ||
      challenge === null ||
      !secureMcpConnectorRuntime.isRunning()
    ) {
      return configurationFailure("CONNECTOR_CHALLENGE_UNAVAILABLE");
    }
    const core = desktopGoCore;
    if (!core) return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
    let observed;
    try {
      observed = await core.observeComputerConnectorVerification();
    } catch {
      return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
    }
    const receipt = observed.receipt;
    if (!receipt) return configurationFailure("CONNECTOR_ATTACHMENT_NOT_FOUND");
    if (
      !observed.receiptSha256 ||
      receipt.challengeSha256 !== challenge.challengeSha256 ||
      receipt.binding.buildId !== buildIdentity.buildId ||
      receipt.binding.connectorGeneration !== String(connector.generation) ||
      (expectedWorkspaceId !== undefined &&
        receipt.workspaceId !== expectedWorkspaceId) ||
      !snapshot.settings.computer.workspaces.some(
        (workspace) => workspace.workspaceId === receipt.workspaceId,
      )
    )
      return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
    const latest = configuration.snapshot();
    if (
      latest.status !== "ready" ||
      desktopGoCore !== core ||
      latest.settings.computer.generation !==
        snapshot.settings.computer.generation ||
      latest.settings.connectors.secureMcp.generation !==
        connector.generation ||
      latest.settings.connectors.secureMcp.runtime?.runtimeGeneration !==
        runtime.runtimeGeneration ||
      latest.settings.connectors.secureMcp.challenge?.challengeSha256 !==
        challenge.challengeSha256 ||
      (expectedBinding &&
        !connectorAppBindingCurrent(latest.settings, expectedBinding))
    )
      return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
    const receiptSha256 = observed.receiptSha256;
    const attached = await configuration.recordSecureMcpAttachment({
      workspaceId: receipt.workspaceId,
      runtimeGeneration: runtime.runtimeGeneration,
      computerGeneration: runtime.computerGeneration,
      buildId: runtime.buildId,
      challengeSha256: receipt.challengeSha256,
      receiptSha256,
    });
    if (!attached.ok) return ProductConfigurationResultSchema.parse(attached);
    return ProductConfigurationResultSchema.parse({
      ...attached,
      evidence: {
        kind: "connector.attachment",
        runtimeGeneration: runtime.runtimeGeneration,
        computerGeneration: runtime.computerGeneration,
        workspaceId: receipt.workspaceId,
        challengeSha256: receipt.challengeSha256,
        receiptSha256,
      },
    });
  } finally {
    connectorTaskAdmission = false;
  }
}

// One explicit owner click sends one small app-bound ChatGPT message. The
// existing route proves the exact selected app before submit; only the local
// Computer MCP receipt can complete the attachment, never the model's prose.
async function verifySecureMcpApp(): Promise<ProductConfigurationResult> {
  if (!embeddedBrowserEnabled()) {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_UNAVAILABLE");
  }
  if (!configuration || !chatGptRoute || !secureMcpConnectorRuntime) {
    return configurationFailure("SETTINGS_UNAVAILABLE");
  }
  if (chatGptTaskAdmission || connectorTaskAdmission) {
    return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
  }
  const verificationCore = desktopGoCore;
  if (!verificationCore)
    return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
  // Reserve both routes before the first await so concurrent IPC calls cannot
  // both pass the check and race to claim or release the same verification.
  chatGptTaskAdmission = true;
  connectorTaskAdmission = true;
  let requestedWorkspaceId: string | null = null;
  let receiptPending = false;
  let expectedBinding: ConnectorAppVerificationBinding | null = null;
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
    const workspaceId = settings.setup.computer.verified?.workspaceId;
    if (
      !chatGptTaskAdmissionReady() ||
      !secureMcpConnectorRuntime.isRunning() ||
      connector.tunnelId === null ||
      runtime?.state !== "ready" ||
      runtime.buildId !== buildIdentity.buildId ||
      runtime.computerGeneration !== settings.computer.generation ||
      runtime.connectorGeneration !== connector.generation ||
      challenge === null ||
      challenge.buildId !== runtime.buildId ||
      challenge.computerGeneration !== runtime.computerGeneration ||
      challenge.runtimeGeneration !== runtime.runtimeGeneration ||
      workspaceId === undefined ||
      workspaceId === null ||
      !settings.computer.workspaces.some(
        (workspace) => workspace.workspaceId === workspaceId,
      )
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
      challengeSha256: challenge.challengeSha256,
      buildId: runtime.buildId,
      workspaceId,
      appName,
    };
    if (settings.setup.connect.outcomeUnknown) {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN");
    }
    const stateRoot = secureMcpLaunchRoot();
    try {
      if (
        await connectorAppVerificationAttemptExists(
          stateRoot,
          challenge.challengeSha256,
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
    const prompt = `Use the selected ${appName} app to call farol_next_connector_verify once with challenge "${challenge.value}" and workspaceId "${workspaceId}". Do not read file contents. Reply briefly with the result.`;
    let claimed = false;
    const result = await chatGptRoute.runReadonlyTask(
      prompt,
      [],
      {
        readConnectorReceipt: async () => {
          const current = configuration!.snapshot();
          if (
            !claimed ||
            current.status !== "ready" ||
            expectedBinding === null ||
            !connectorAppBindingCurrent(current.settings, expectedBinding)
          )
            return false;
          const receipt = (
            await verificationCore.observeComputerConnectorVerification()
          ).receipt;
          if (!receipt || desktopGoCore !== verificationCore) return false;
          const afterRead = configuration!.snapshot();
          if (
            afterRead.status !== "ready" ||
            !connectorAppBindingCurrent(afterRead.settings, expectedBinding)
          )
            return false;
          return (
            receipt.challengeSha256 === expectedBinding.challengeSha256 &&
            receipt.workspaceId === expectedBinding.workspaceId &&
            receipt.binding.buildId === expectedBinding.buildId &&
            receipt.binding.connectorGeneration ===
              String(expectedBinding.connectorGeneration)
          );
        },
        onDispatchIntent: async () => {
          if (claimed) return;
          const admitted = configuration!.snapshot();
          if (
            admitted.status !== "ready" ||
            expectedBinding === null ||
            !connectorAppBindingCurrent(admitted.settings, expectedBinding)
          )
            throw new Error("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
          await prepareConnectorAppVerificationAttempt(
            stateRoot,
            challenge.challengeSha256,
            async () =>
              (
                await configuration!.recordSecureMcpAppPending(
                  runtime.runtimeGeneration,
                )
              ).ok,
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
      if (beforeSubmit.settings.setup.connect.outcomeUnknown) {
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
    chatGptTaskAdmission = false;
    connectorTaskAdmission = false;
  }
  if (requestedWorkspaceId === null || expectedBinding === null) {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE");
  }
  if (!receiptPending) {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE");
  }
  type ReceiptProbe = Readonly<
    | { state: "changed" }
    | { state: "receipt"; receipt: ComputerConnectorVerificationReceipt }
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
        const receipt = (
          await verificationCore.observeComputerConnectorVerification()
        ).receipt;
        return receipt === undefined ? null : { state: "receipt", receipt };
      },
      (probe) =>
        probe.state === "changed" ||
        (probe.receipt.challengeSha256 === expectedBinding.challengeSha256 &&
          probe.receipt.workspaceId === requestedWorkspaceId),
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
  return checkSecureMcpAttachment(requestedWorkspaceId, expectedBinding);
}

async function prepareDevMcpProof(): Promise<ProductConfigurationResult> {
  if (!isolatedDevMcpProofAllowed(buildEnvironment, runtimeEnvironment)) {
    return configurationFailure("DEV_MCP_PROOF_DEV_ONLY");
  }
  if (!configuration) {
    return configurationFailure("SETTINGS_UNAVAILABLE");
  }
  // `configureProduct` takes the authority-transition reservation for this
  // command, but its first admission read happens before that await. Re-read
  // the live holders after the reservation is ours so an Agent or connector
  // that won the race cannot have its carried grant replaced underneath it.
  const readmitted = configurationAdmission("dev-proof.prepare", {
    agentActive: codexAgentOperationActive(),
    connectorRunning:
      connectorTaskAdmission || secureMcpConnectorRuntime?.isRunning() === true,
  });
  if (readmitted !== "admitted") {
    return configurationFailure(
      readmitted === "CONNECTOR_STOP_REQUIRED"
        ? "DEV_MCP_PROOF_CONNECTOR_MUST_STOP"
        : readmitted,
    );
  }
  try {
    const previous = await readDevMcpProofPreparation(devMcpProofRoot()).catch(
      () => null,
    );
    let snapshot = configuration.snapshot();
    if (snapshot.status !== "ready") {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    if (
      previous !== null &&
      snapshot.settings.computer.workspaces.some(
        (workspace) => workspace.workspaceId === previous.workspaceId,
      )
    ) {
      const removed = await configuration.removeWorkspace(previous.workspaceId);
      if (!removed.ok) return ProductConfigurationResultSchema.parse(removed);
      snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
    }

    const fixture = await createDevMcpProofFixture(devMcpProofRoot());
    const rootIdentity = await measuredRootIdentity(fixture.workspaceRoot);
    if (rootIdentity === null) {
      return configurationFailure("DEV_MCP_PROOF_PREPARE_FAILED");
    }
    const added = await configuration.addReadonlyWorkspace({
      root: fixture.workspaceRoot,
      label: "Farol Dev verification fixture",
      rootIdentity,
    });
    if (!added.ok) return ProductConfigurationResultSchema.parse(added);
    const addedSnapshot = configuration.snapshot();
    if (addedSnapshot.status !== "ready") {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    const workspace = addedSnapshot.settings.computer.workspaces.find(
      (candidate) => candidate.root === fixture.workspaceRoot,
    );
    if (!workspace) {
      return configurationFailure("DEV_MCP_PROOF_PREPARE_FAILED");
    }
    const listed = await nativeWorkspace.execute({
      workspace: workspaceDescriptor(workspace, rootIdentity),
      operation: { kind: "workspace.list", relativePath: "." },
    });
    if (!listed.ok || listed.value.kind !== "workspace.entries") {
      return configurationFailure("DEV_MCP_PROOF_PREPARE_FAILED");
    }
    const recorded = await configuration.recordComputerVerification(
      workspace.workspaceId,
      {
        profile: "computer.local.read/1",
        runtimeGeneration: `${runtime?.identity ?? "runtime-offline"}:${buildIdentity.buildId}`,
        buildId: buildIdentity.buildId,
        protocol: "readonly-workspace/1",
      },
      { rootIdentity, gitMetadata: null },
    );
    if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
    const verifiedSnapshot = configuration.snapshot();
    if (verifiedSnapshot.status !== "ready") {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    const preparation = {
      schema: 1 as const,
      proofId: fixture.proofId,
      environment: "dev" as const,
      buildId: buildIdentity.buildId,
      workspaceId: workspace.workspaceId,
      workspaceRoot: fixture.workspaceRoot,
      computerGeneration: verifiedSnapshot.settings.computer.generation,
      sentinelSha256: fixture.sentinelSha256,
      allowedPath: DEV_MCP_PROOF_ALLOWED_PATH,
      deniedPath: DEV_MCP_PROOF_DENIED_PATH,
      preparedAt: new Date().toISOString(),
    } satisfies DevMcpProofPreparation;
    await writeDevMcpProofPreparation(devMcpProofRoot(), preparation);
    return ProductConfigurationResultSchema.parse({
      ok: true,
      snapshot: verifiedSnapshot,
      evidence: {
        kind: "dev-proof.prepared",
        proofId: preparation.proofId,
        workspaceId: preparation.workspaceId,
        computerGeneration: preparation.computerGeneration,
        buildId: preparation.buildId,
        allowedPath: preparation.allowedPath,
        deniedPath: preparation.deniedPath,
      },
    });
  } catch {
    return configurationFailure("DEV_MCP_PROOF_PREPARE_FAILED");
  }
}

async function runDevMcpProof(): Promise<ProductConfigurationResult> {
  if (!isolatedDevMcpProofAllowed(buildEnvironment, runtimeEnvironment)) {
    return configurationFailure("DEV_MCP_PROOF_DEV_ONLY");
  }
  if (!configuration || !chatGptRoute || !secureMcpConnectorRuntime) {
    return configurationFailure("SETTINGS_UNAVAILABLE");
  }
  if (chatGptTaskAdmission) {
    return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
  }
  const snapshot = configuration.snapshot();
  if (snapshot.status !== "ready") {
    return configurationFailure("SETTINGS_UNAVAILABLE");
  }
  const connector = snapshot.settings.connectors.secureMcp;
  const runtimeProof = connector.runtime;
  if (
    runtimeProof?.state !== "ready" ||
    connector.attachment === null ||
    !secureMcpConnectorRuntime.isRunning() ||
    !chatGptTaskAdmissionReady()
  ) {
    return configurationFailure("DEV_MCP_PROOF_CONNECTOR_NOT_READY");
  }
  const preparation = await readDevMcpProofPreparation(devMcpProofRoot()).catch(
    () => null,
  );
  if (preparation === null) {
    return configurationFailure("DEV_MCP_PROOF_NOT_PREPARED");
  }
  if (
    preparation.environment !== "dev" ||
    preparation.buildId !== buildIdentity.buildId ||
    preparation.computerGeneration !== snapshot.settings.computer.generation ||
    runtimeProof.computerGeneration !== preparation.computerGeneration ||
    runtimeProof.buildId !== preparation.buildId ||
    !snapshot.settings.computer.workspaces.some(
      (workspace) =>
        workspace.workspaceId === preparation.workspaceId &&
        workspace.root === preparation.workspaceRoot &&
        workspace.rootIdentity !== undefined,
    )
  ) {
    return configurationFailure("DEV_MCP_PROOF_STALE");
  }
  if (
    (await readDevMcpProofReceipt(devMcpProofRoot()).catch(() => null)) !== null
  ) {
    // A prior live attempt exists. Its outcome must never be overwritten or
    // retried as though nothing happened; prepare a fresh fixture instead.
    return configurationFailure("DEV_MCP_PROOF_STALE");
  }
  let attemptedAt: string;
  try {
    attemptedAt = await claimDevMcpProofAttempt(
      devMcpProofRoot(),
      preparation.proofId,
    );
  } catch {
    // The claim is exclusive and durable. Any previous attempt, including one
    // whose provider outcome is unknown, requires a newly prepared fixture.
    return configurationFailure("DEV_MCP_PROOF_STALE");
  }
  const prompt = [
    "Use the selected app's Computer tool computer_workspace_read.",
    `First read workspaceId ${preparation.workspaceId} at relativePath ${preparation.allowedPath}.`,
    `Then attempt the same tool and workspaceId at relativePath ${preparation.deniedPath}; it must be refused because it leaves the grant through a link.`,
    "If and only if the first read succeeds and the second is refused, reply with exactly the first file's text and nothing else.",
  ].join(" ");
  chatGptTaskAdmission = true;
  try {
    const result = await chatGptRoute.runReadonlyTask(prompt);
    if (result.state !== "completed" || typeof result.outputText !== "string") {
      return configurationFailure("DEV_MCP_PROOF_CHATGPT_FAILED");
    }
    const answerSha256 = createHash("sha256")
      .update(result.outputText.trim())
      .digest("hex");
    if (answerSha256 !== preparation.sentinelSha256) {
      return configurationFailure("DEV_MCP_PROOF_ANSWER_MISMATCH");
    }
    const receipt = await readDevMcpProofReceipt(devMcpProofRoot()).catch(
      () => null,
    );
    if (
      receipt === null ||
      receipt.allowed === null ||
      receipt.denied === null
    ) {
      return configurationFailure("DEV_MCP_PROOF_RECEIPT_MISSING");
    }
    const sameProofBinding =
      receipt.allowed.ownerId === receipt.denied.ownerId &&
      receipt.allowed.sessionId === receipt.denied.sessionId &&
      receipt.allowed.taskId === receipt.denied.taskId &&
      receipt.allowed.taskEpoch === receipt.denied.taskEpoch &&
      receipt.allowed.participantId === receipt.denied.participantId &&
      receipt.allowed.turnId === receipt.denied.turnId &&
      receipt.allowed.generation === receipt.denied.generation;
    if (
      receipt.proofId !== preparation.proofId ||
      receipt.environment !== "dev" ||
      receipt.buildId !== preparation.buildId ||
      receipt.computerGeneration !== preparation.computerGeneration ||
      receipt.workspaceId !== preparation.workspaceId ||
      receipt.sentinelSha256 !== preparation.sentinelSha256 ||
      receipt.allowed.outputSha256 !== preparation.sentinelSha256 ||
      receipt.allowed.generation !== preparation.computerGeneration ||
      receipt.allowed.taskEpoch !== preparation.computerGeneration ||
      receipt.denied.generation !== preparation.computerGeneration ||
      receipt.denied.taskEpoch !== preparation.computerGeneration ||
      receipt.denied.errorCode !== "WORKSPACE_PATH_REFUSED" ||
      receipt.allowed.ownerId !== "owner-desktop" ||
      receipt.allowed.callIdSha256 === receipt.denied.callIdSha256 ||
      receipt.allowed.recordedAt < attemptedAt ||
      receipt.denied.recordedAt < receipt.allowed.recordedAt ||
      !sameProofBinding
    ) {
      return configurationFailure("DEV_MCP_PROOF_RECEIPT_INVALID");
    }
    const receiptSha256 = createHash("sha256")
      .update(`${JSON.stringify(receipt, null, 2)}\n`)
      .digest("hex");
    return ProductConfigurationResultSchema.parse({
      ok: true,
      snapshot: configuration.snapshot(),
      evidence: {
        kind: "dev-proof.verified",
        proofId: preparation.proofId,
        workspaceId: preparation.workspaceId,
        environment: "dev",
        runtimeGeneration: runtimeProof.runtimeGeneration,
        computerGeneration: preparation.computerGeneration,
        buildId: preparation.buildId,
        sentinelSha256: preparation.sentinelSha256,
        answerSha256,
        receiptSha256,
        outsideGrantError: receipt.denied.errorCode,
      },
    });
  } finally {
    chatGptTaskAdmission = false;
  }
}

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
    process.env.FAROL_NEXT_E2E === "1"
      ? process.env.FAROL_NEXT_E2E_WORKSPACE_FILE
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

async function listOwnerWorkspace(
  generation: number,
  workspace: ApprovedProductWorkspace,
  identity: WorkspaceRootIdentity,
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
      result.root.device !== identity.device ||
      result.root.inode !== identity.inode ||
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

function workspaceMutationStateRoot(): string {
  return path.join(
    app.getPath("userData"),
    "farol-next-state",
    "workspace-mutations",
  );
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

async function configureProduct(
  value: unknown,
): Promise<ProductConfigurationResult> {
  const parsed = ProductConfigurationCommandSchema.safeParse(value);
  if (parsed.success && directChatStart) {
    const command = parsed.data;
    if (command.kind === "chatgpt.inspect-chat-account")
      return command.operationId === directChatStart.operationId
        ? directChatStart.inspection
        : configurationFailure("CHATGPT_CONVERSATION_REFUSED");
    if (command.kind === "chatgpt.start-conversation" && directChatStart.start)
      return isDeepStrictEqual(command, directChatStart.start.command)
        ? directChatStart.start.promise
        : configurationFailure("CHATGPT_CONVERSATION_REFUSED");
  }
  if (
    parsed.success &&
    parsed.data.kind === "chatgpt.submit-readonly-task" &&
    goReadonlyConversation?.pending?.operationId === parsed.data.operationId
  )
    return goReadonlyConversation.start;
  if (
    parsed.success &&
    (parsed.data.kind === "chatgpt.inspect-readonly-account" ||
      parsed.data.kind === "chatgpt.approve-readonly-account")
  ) {
    return readonlyAccountCommands.run(
      parsed.data,
      () => configureNewProductRequest(parsed.data),
      configurationFailure,
    );
  }
  return configureNewProductRequest(value);
}

async function configureNewProductRequest(
  value: unknown,
): Promise<ProductConfigurationResult> {
  if (installedUpdateAdmission)
    return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
  configurationRequests += 1;
  try {
    return await configureUnfencedProduct(value);
  } finally {
    configurationRequests -= 1;
  }
}

async function configureUnfencedProduct(
  value: unknown,
): Promise<ProductConfigurationResult> {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  const parsed = ProductConfigurationCommandSchema.safeParse(value);
  if (!parsed.success) return configurationFailure("SETTINGS_INPUT_INVALID");
  const command = parsed.data;
  const admission = configurationAdmission(command.kind, {
    agentActive: codexAgentOperationActive(),
    connectorRunning:
      connectorTaskAdmission || secureMcpConnectorRuntime?.isRunning() === true,
  });
  if (admission !== "admitted") return configurationFailure(admission);
  if (!changesComputerAuthority(command.kind)) {
    return deliverConfigurationReply(
      command.kind,
      await configureAdmittedProduct(command),
    );
  }
  const reservation = authorityTransitions.withReservation(
    "authority-change",
    async () => {
      activeAuthorityChangeKind = command.kind;
      try {
        let stopStage: "begin-stop" | "confirm-stop" = "begin-stop";
        try {
          const lifecycle = computerMcpLifecycle();
          await lifecycle.beginStop();
          stopStage = "confirm-stop";
          await lifecycle.confirmStop();
        } catch (error) {
          reportComputerCheckDiagnostic(
            console.warn,
            `settings:${command.kind}${"workspaceId" in command ? `:${command.workspaceId}` : ""}`,
            stopStage,
            error,
          );
          return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
        }
        return await configureAdmittedProduct(command);
      } finally {
        activeAuthorityChangeKind = null;
      }
    },
  );
  // withReservation tries to acquire synchronously before its first await.
  // Capture the holder now: reading it after awaiting a refusal could name
  // a later transition, or none at all.
  const activeCommandAtAdmission = activeAuthorityChangeKind;
  const reserved = await reservation;
  if (!reserved.admitted) {
    console.warn(
      "farol.authority-transition-refused",
      JSON.stringify({
        requested: command.kind,
        heldBy: reserved.heldBy,
        activeCommand: activeCommandAtAdmission,
      }),
    );
  }
  return deliverConfigurationReply(
    command.kind,
    reserved.admitted ? reserved.value : transitionRefusal(),
  );
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
    `farol-next-e2e:reply-dropped ${commandKind} ${operationId}\n`,
  );
  // Never settles: the renderer's `ipcRenderer.invoke` receives nothing at
  // all, which is the state the durable pending-edit record exists for.
  return new Promise<ProductConfigurationResult>(() => {});
}

async function configureAdmittedProduct(
  command: ProductConfigurationCommand,
): Promise<ProductConfigurationResult> {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  switch (command.kind) {
    case "chatgpt.inspect-chat-account": {
      const route = chatGptRoute;
      const core = desktopGoCore;
      const profile = goChatStartupProfile;
      const snapshot = configuration.snapshot();
      if (!route || !core || !profile || snapshot.status !== "ready")
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      if (
        directChatStart ||
        goReadonlyConversation ||
        chatGptTaskAdmission ||
        pendingChatGptReadonlyTask ||
        pendingChatGptAttachmentTask ||
        recoverableChatGptTask ||
        snapshot.settings.setup.chatgpt.outcomeUnknown ||
        installedUpdateAdmission ||
        quitInProgress
      )
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      const revision = snapshot.settings.revision;
      let selected: ReturnType<typeof captureChatStartupProfile>;
      try {
        selected = captureChatStartupProfile({
          environment: runtimeEnvironment,
          e2e: process.env.FAROL_NEXT_E2E === "1",
          origin: chatGptE2eOrigin,
          tasks: snapshot.settings.tasks,
        });
      } catch {
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      }
      if (
        !selected ||
        selected.snapshot.configSHA256 !== profile.snapshot.configSHA256
      )
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      const model = selected.snapshot;
      const operationId = command.operationId;
      const sessionId = randomUUID();
      const client = new ReadConversationClient(null, core.chat);
      const current = () => {
        const now = configuration?.snapshot();
        return (
          directChatStart?.operationId === operationId &&
          desktopGoCore === core &&
          chatGptRoute === route &&
          goChatStartupProfile === profile &&
          !installedUpdateAdmission &&
          !quitInProgress &&
          now?.status === "ready" &&
          now.settings.revision === revision &&
          !now.settings.setup.chatgpt.outcomeUnknown
        );
      };
      const confirmation =
        new AccountObservationConfirmation<ReadConversationProjection>({
          current,
          read: () => route.observeAccount(),
          commit: (account) => {
            const start = directChatStart?.start;
            if (!start || !current())
              throw new BridgeError(
                "refused",
                "CHATGPT_ACCOUNT_CONFIRMATION_INVALID",
              );
            return client.startAuthorized({
              sessionId,
              prompt: start.command.prompt,
              policy: model.policy,
              profiles: model.profiles,
              requested: {},
              ...account,
            });
          },
        });
      const inspection = Promise.resolve().then(async () => {
        chatGptTaskAdmission = true;
        try {
          const inspected = await confirmation.inspect();
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration!.snapshot(),
            evidence: {
              kind: "chatgpt.chat-account-preview",
              operationId,
              sessionId,
              ...inspected,
            },
          });
        } catch (error) {
          return configurationFailure(
            error instanceof BridgeError && error.state === "refused"
              ? "CHATGPT_ACCOUNT_CONFIRMATION_INVALID"
              : "CHATGPT_CONVERSATION_UNCONFIRMED",
          );
        } finally {
          chatGptTaskAdmission = false;
        }
      });
      directChatStart = {
        operationId,
        sessionId,
        core,
        client,
        confirmation,
        inspection,
      };
      return inspection;
    }
    case "chatgpt.start-conversation": {
      const pending = directChatStart;
      if (
        !pending ||
        command.operationId !== pending.operationId ||
        pending.start ||
        goReadonlyConversation ||
        chatGptTaskAdmission ||
        desktopGoCore !== pending.core
      )
        return configurationFailure("CHATGPT_CONVERSATION_REFUSED");
      const captured = structuredClone(command);
      const start = Promise.resolve().then(async () => {
        chatGptTaskAdmission = true;
        try {
          const projection = await pending.confirmation.confirm(
            captured.confirmationId,
          );
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration!.snapshot(),
            evidence: projectReadConversation(captured.operationId, projection),
          });
        } catch (error) {
          return configurationFailure(
            error instanceof BridgeError && error.state === "refused"
              ? "CHATGPT_CONVERSATION_REFUSED"
              : "CHATGPT_CONVERSATION_UNCONFIRMED",
          );
        } finally {
          chatGptTaskAdmission = false;
        }
      });
      pending.start = { command: captured, promise: start };
      // Pin before fresh account observation or admission. This same client is
      // the only host PrepareNext consumer, including after a lost reply.
      goReadonlyConversation = {
        pending: null,
        operationId: pending.operationId,
        core: pending.core,
        client: pending.client,
        start,
      };
      return start;
    }
    case "chatgpt.observe-readonly-conversation":
    case "chatgpt.ack-readonly-conversation":
    case "chatgpt.follow-readonly-conversation": {
      const active = goReadonlyConversation;
      if (
        !active ||
        active.operationId !== command.operationId ||
        desktopGoCore !== active.core
      )
        return configurationFailure("CHATGPT_CONVERSATION_REFUSED");
      try {
        const projection =
          command.kind === "chatgpt.follow-readonly-conversation"
            ? await active.client.follow(command.handleId, command.prompt)
            : command.kind === "chatgpt.observe-readonly-conversation"
              ? await active.client.progress(command.handleId, command.cursor)
              : await (async () => {
                  await active.client.acknowledge(
                    command.handleId,
                    command.resultId,
                  );
                  return active.client.snapshot(
                    command.handleId,
                    command.cursor,
                  );
                })();
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration.snapshot(),
          evidence: projectReadConversation(command.operationId, projection),
        });
      } catch (error) {
        return configurationFailure(
          error instanceof BridgeError && error.state === "refused"
            ? "CHATGPT_CONVERSATION_REFUSED"
            : "CHATGPT_CONVERSATION_UNCONFIRMED",
        );
      }
    }
    case "onboarding.open-help": {
      try {
        await shell.openExternal(onboardingHelpUrl(command.destination));
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration.snapshot(),
        });
      } catch {
        return configurationFailure("ONBOARDING_HELP_OPEN_FAILED");
      }
    }
    case "connector.select-client": {
      const current = configuration.snapshot();
      if (
        current.status === "ready" &&
        (current.settings.connectors.secureMcp.runtime?.state ===
          "outcome_unknown" ||
          current.settings.setup.connect.outcomeUnknown)
      )
        return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
      const selected = await selectedTunnelClientExecutable();
      if (selected === "cancelled") {
        return configurationFailure("TUNNEL_CLIENT_PICKER_CANCELLED");
      }
      if (selected === "invalid") {
        return configurationFailure("TUNNEL_CLIENT_SELECTION_INVALID");
      }
      return verifyTunnelClientExecutable(selected);
    }
    case "connector.discover-client": {
      const current = configuration.snapshot();
      if (
        current.status === "ready" &&
        (current.settings.connectors.secureMcp.runtime?.state ===
          "outcome_unknown" ||
          current.settings.setup.connect.outcomeUnknown)
      )
        return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
      try {
        // The real UI still drives discovery. This exact E2E-only seam lets
        // that button verify the synthetic CLI fixture instead of
        // probing or starting any tunnel-client installed on the owner host.
        const testExecutable = e2eTunnelClientExecutable();
        if (testExecutable === "invalid") {
          return configurationFailure("TUNNEL_CLIENT_SELECTION_INVALID");
        }
        if (testExecutable !== undefined) {
          return verifyTunnelClientExecutable(testExecutable);
        }
        const discovered = await discoverExecutables("tunnel-client");
        for (const candidate of discovered.candidates) {
          if (candidate.verdict !== "offer") continue;
          if (!candidate.sha256) continue;
          const verified = await verifyTunnelClientExecutable(candidate.path, {
            canonicalPath: candidate.path,
            sha256: candidate.sha256,
          });
          if (verified.ok) return verified;
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration.snapshot(),
          evidence: {
            kind: "connector.client-discovery",
            candidates: discovered.candidates,
            searched: discovered.searched,
          },
        });
      } catch {
        return configurationFailure("TUNNEL_CLIENT_DISCOVERY_FAILED");
      }
    }
    case "connector.select-discovered-client": {
      if (secureMcpConnectorRuntime?.isRunning()) {
        return configurationFailure("CONNECTOR_STOP_REQUIRED");
      }
      const candidate = await reverifyDiscoveredCandidate(
        "tunnel-client",
        command.path,
      );
      if (candidate === "stale") {
        return configurationFailure("TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE");
      }
      if (candidate === "declined") {
        return configurationFailure("TUNNEL_CLIENT_PICKER_CANCELLED");
      }
      if (!candidate.sha256) {
        return configurationFailure("TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE");
      }
      return verifyTunnelClientExecutable(candidate.path, {
        canonicalPath: candidate.path,
        sha256: candidate.sha256,
      });
    }
    case "connector.configure": {
      const current = configuration.snapshot();
      if (
        current.status === "ready" &&
        (current.settings.connectors.secureMcp.runtime?.state ===
          "outcome_unknown" ||
          current.settings.setup.connect.outcomeUnknown)
      )
        return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
      if (secureMcpConnectorRuntime?.hasUnresolvedEffect())
        return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
      if (!connectorCredentialStore || secureMcpConnectorRuntime?.isRunning()) {
        return configurationFailure(
          secureMcpConnectorRuntime?.isRunning()
            ? "CONNECTOR_STOP_REQUIRED"
            : "SETTINGS_UNAVAILABLE",
        );
      }
      try {
        if (command.runtimeKey !== null) {
          await connectorCredentialStore.store(command.runtimeKey);
        }
        const credentialStatus = await connectorCredentialStore.status();
        if (credentialStatus === "missing") {
          await configuration.recordSecureMcpCredential("missing");
          return configurationFailure("CONNECTOR_CREDENTIAL_REQUIRED");
        }
        const tunnel = await configuration.configureSecureMcpTunnel({
          tunnelId: command.tunnelId,
        });
        if (!tunnel.ok) return ProductConfigurationResultSchema.parse(tunnel);
        return ProductConfigurationResultSchema.parse(
          await configuration.recordSecureMcpCredential("stored"),
        );
      } catch {
        return configurationFailure("CONNECTOR_CREDENTIAL_STORE_FAILED");
      }
    }
    case "connector.select-chatgpt-app": {
      if (chatGptTaskAdmission || connectorTaskAdmission)
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      connectorTaskAdmission = true;
      try {
        return ProductConfigurationResultSchema.parse(
          await configuration.selectSecureMcpChatGptApp({
            name: command.name,
            tunnelId: command.tunnelId,
            connectorGeneration: command.connectorGeneration,
          }),
        );
      } finally {
        connectorTaskAdmission = false;
      }
    }
    case "connector.start":
      return startSecureMcpConnector(false);
    case "connector.repair":
      return startSecureMcpConnector(true);
    case "connector.check-health": {
      if (!secureMcpConnectorRuntime)
        return configurationFailure("SETTINGS_UNAVAILABLE");
      if (connectorTaskAdmission)
        return configurationFailure("CONNECTOR_ALREADY_RUNNING");
      connectorTaskAdmission = true;
      try {
        const before = configuration.snapshot();
        if (before.status !== "ready")
          return configurationFailure("SETTINGS_UNAVAILABLE");
        const connector = before.settings.connectors.secureMcp;
        const current = connector.runtime;
        if (
          !current ||
          current.state !== "ready" ||
          current.buildId !== buildIdentity.buildId ||
          current.computerGeneration !== before.settings.computer.generation ||
          current.connectorGeneration !== connector.generation
        )
          return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
        const healthy = await secureMcpConnectorRuntime.checkHealth();
        const after = configuration.snapshot();
        if (
          after.status !== "ready" ||
          after.settings.computer.generation !==
            before.settings.computer.generation ||
          after.settings.connectors.secureMcp.generation !==
            connector.generation ||
          after.settings.connectors.secureMcp.runtime?.runtimeGeneration !==
            current.runtimeGeneration
        )
          return configurationFailure(
            "CONNECTOR_APP_VERIFICATION_STATE_CHANGED",
          );
        if (!healthy) {
          const failure = await recordConnectorRuntime(
            "unreachable",
            current.runtimeGeneration,
            current.computerGeneration,
          );
          if (failure) return failure;
          return configurationFailure("CONNECTOR_DOCTOR_FAILED");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: after,
        });
      } finally {
        connectorTaskAdmission = false;
      }
    }
    case "connector.check-attachment":
      return checkSecureMcpAttachment();
    case "connector.verify-app":
      return verifySecureMcpApp();
    case "dev-proof.prepare":
      return prepareDevMcpProof();
    case "dev-proof.run":
      return runDevMcpProof();
    case "connector.stop": {
      const current = configuration.snapshot();
      if (
        current.status === "ready" &&
        (current.settings.connectors.secureMcp.runtime?.state ===
          "outcome_unknown" ||
          current.settings.setup.connect.outcomeUnknown)
      )
        return configurationFailure("CONNECTOR_RUNTIME_OUTCOME_UNKNOWN");
      if (!secureMcpConnectorRuntime) {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      if (connectorTaskAdmission) {
        return configurationFailure("CONNECTOR_ALREADY_RUNNING");
      }
      connectorTaskAdmission = true;
      try {
        try {
          await stopAndConfirmComputerMcp();
        } catch {
          return configurationFailure("CONNECTOR_STOP_UNCONFIRMED");
        }
        const stopped = await configuration.recordSecureMcpStopped();
        if (!stopped.ok) return ProductConfigurationResultSchema.parse(stopped);
        try {
          await clearConnectorVerificationReceipt(secureMcpLaunchRoot());
        } catch {
          return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
        }
        return ProductConfigurationResultSchema.parse(stopped);
      } finally {
        connectorTaskAdmission = false;
      }
    }
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
          snapshot: configuration.snapshot(),
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
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready" || !snapshot.settings.nativeHosts.codex) {
        return configurationFailure("CODEX_HOST_NOT_CONFIGURED");
      }
      return verifyCodexExecutable(
        snapshot.settings.nativeHosts.codex.executablePath,
      );
    }
    case "host.refresh-codex-task-models": {
      if (codexHostTaskAdmission || codexAgentOperationActive())
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      const snapshot = configuration.snapshot();
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
      codexHostTaskAdmission = true;
      let proxy: SharedCodexProxyHost | null = null;
      let scratch: string | null = null;
      let result: CodexModelCatalogueResult = {
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
        codexHostTaskAdmission = false;
      }
      const current = configuration.snapshot();
      if (
        !cleaned ||
        current.status !== "ready" ||
        current.settings.revision !== settings.revision ||
        route.expiresAt <= Date.now()
      )
        result = { status: "unavailable", code: "TASK_MODEL_CATALOG_CHANGED" };
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: current,
        evidence: {
          kind: "host.task-models",
          view: describeTaskModels(
            current.status === "ready" ? current.settings.tasks : undefined,
            "codex",
            result,
          ),
        },
      });
    }
    case "host.configure-codex-tasks": {
      const refuseRoute = (
        phase: Parameters<typeof codexTaskRouteRefusalRecord>[0],
      ) => {
        process.stderr.write(
          `farol-codex-task-route ${codexTaskRouteRefusalRecord(phase)}\n`,
        );
        return configurationFailure("CODEX_TASK_ROUTE_REFUSED");
      };
      if (codexHostTaskAdmission || codexAgentOperationActive()) {
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      }
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      const settings = snapshot.settings;
      const resolvedModel = resolveOwnerTaskModel(settings, {
        harness: "codex",
      });
      if (resolvedModel.status !== "ready") {
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
        settings.setup.computer.verified?.workspaceId !== command.workspaceId ||
        settings.setup.computer.verified.configRevision !==
          settings.computer.generation ||
        (command.sandbox === "workspace-write" && workspace.access !== "write")
      ) {
        return refuseRoute("workspace_identity");
      }
      codexHostTaskAdmission = true;
      let proxy: SharedCodexProxyHost | null = null;
      let scratch: string | null = null;
      try {
        const projectStat = await lstat(command.projectRoot, { bigint: true });
        if (
          !projectStat.isDirectory() ||
          projectStat.isSymbolicLink() ||
          (await realpath(command.projectRoot)) !== command.projectRoot
        ) {
          return refuseRoute("project_root");
        }
        const authority = new PhysicalCodexHandoffAuthority({
          workspaceId: command.workspaceId,
          writerRoot: workspace.root,
          writerIdentity: workspace.rootIdentity,
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
          await mkdtemp(path.join(os.tmpdir(), "farol-codex-task-selection-")),
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
            response && typeof response === "object" && !Array.isArray(response)
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
        const approvedAt = new Date().toISOString();
        return ProductConfigurationResultSchema.parse(
          await configuration.recordCodexTaskRoute({
            transport: "codex-shared-proxy/v1",
            socketPath: command.socketPath,
            expectedCodexHome: command.expectedCodexHome,
            workspaceId: command.workspaceId,
            projectId: command.projectId,
            ...(command.observeThreadId === undefined
              ? {}
              : { observeThreadId: command.observeThreadId }),
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
            harness: "codex",
            computerGeneration: settings.computer.generation,
            hostGeneration: settings.nativeHosts.generation,
            approvedAt,
            expiresAt: Date.parse(approvedAt) + 12 * 60 * 60 * 1_000,
          }),
        );
      } catch (error) {
        process.stderr.write(
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
        codexHostTaskAdmission = false;
      }
    }
    case "host.clear-codex-tasks":
      if (codexHostTaskAdmission) {
        return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
      }
      return ProductConfigurationResultSchema.parse(
        await configuration.clearCodexTaskRoute(),
      );
    case "host.run-route-b-check": {
      if (codexHostTaskAdmission || codexAgentOperationActive()) {
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      }
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      const selected = snapshot.settings.nativeHosts.codex;
      if (!selected) return configurationFailure("CODEX_HOST_NOT_CONFIGURED");
      codexHostTaskAdmission = true;
      // The check closes its host itself; quit reaches it meanwhile.
      const routeBCheckClients: Awaited<
        ReturnType<typeof launchCodexAppServer>
      >[] = [];
      try {
        const probe = await probeCodexHost({
          executablePath: selected.executablePath,
          scratchRoot: codexHostProbeRoot(),
        }).catch(() => null);
        if (
          probe === null ||
          probe.executableSha256 !== selected.executableSha256 ||
          probe.schemaSha256 !== selected.schemaSha256 ||
          probe.version !== selected.version ||
          probe.protocol !== selected.protocol
        ) {
          const invalidated =
            await configuration.recordCodexHostFailure("unreachable");
          if (!invalidated.ok) {
            return ProductConfigurationResultSchema.parse(invalidated);
          }
          return configurationFailure("CODEX_HOST_RECHECK_REQUIRED");
        }
        if (!chatGptTaskAdmissionReady()) {
          return configurationFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
        }
        const checkRouteB = routeBRuntime;
        if (!checkRouteB) return configurationFailure("ROUTE_B_UNAVAILABLE");
        const endpoint = checkRouteB.endpoint;
        const toolCallsBefore = checkRouteB.provider.diagnostics().toolCalls;
        const checked = await runRouteBHostCheck(
          {
            executablePath: selected.executablePath,
            runtimeRoot: await codexHostRuntimeRoot(),
            homePath: await codexHostProcessHomePath(),
            tempPath: app.getPath("temp"),
            clientVersion: buildIdentity.version,
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
        if (checkRouteB.provider.diagnostics().toolCalls !== toolCallsBefore) {
          return configurationFailure("ROUTE_B_CHECK_TOOL_USED");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration.snapshot(),
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
        codexHostTaskAdmission = false;
      }
    }
    case "host.run-codex-smoke": {
      if (codexHostTaskAdmission || codexAgentOperationActive()) {
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      }
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      const selected = snapshot.settings.nativeHosts.codex;
      if (!selected) {
        return configurationFailure("CODEX_HOST_NOT_CONFIGURED");
      }
      codexHostTaskAdmission = true;
      let client: Awaited<ReturnType<typeof launchCodexAppServer>> | null =
        null;
      try {
        const probe = await probeCodexHost({
          executablePath: selected.executablePath,
          scratchRoot: codexHostProbeRoot(),
        });
        const sameContract =
          probe.executableSha256 === selected.executableSha256 &&
          probe.schemaSha256 === selected.schemaSha256 &&
          probe.version === selected.version &&
          probe.protocol === selected.protocol;
        const recordedContract = await configuration.recordCodexHost({
          executablePath: probe.executablePath,
          executableSha256: probe.executableSha256,
          version: probe.version,
          protocol: probe.protocol,
          schemaSha256: probe.schemaSha256,
          taskSource: probe.taskSource,
          buildId: buildIdentity.buildId,
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
          tempPath: app.getPath("temp"),
          clientVersion: buildIdentity.version,
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
        const recorded = await configuration.recordCodexHostLiveVerification({
          model: live.model,
          executableSha256: probe.executableSha256,
          schemaSha256: probe.schemaSha256,
          buildId: buildIdentity.buildId,
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
          await configuration.recordCodexHostLiveFailure(failureState);
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
        codexHostTaskAdmission = false;
      }
    }
    case "host.run-codex-agent-check": {
      if (
        codexHostTaskAdmission ||
        activeProductAgentSession ||
        pendingProductAgentTaskId()
      ) {
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      }
      const snapshot = configuration.snapshot();
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
        selected.liveVerification.buildId !== buildIdentity.buildId
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
        computerVerification.buildId !== buildIdentity.buildId ||
        snapshot.settings.setup.computer.reachable !== "reachable" ||
        snapshot.settings.setup.computer.outcomeUnknown ||
        !workspace
      ) {
        const recorded = await configuration.recordCodexAgentFailure(
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
        buildIdentity.buildId,
        snapshot.settings.computer.computerId,
        snapshot.settings.computer.generation,
        workspace.workspaceId,
      ]);
      if (activeCodexAgentCheck && activeCodexAgentCheck.key !== checkKey) {
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      }
      // The check carries the authority read above; it holds the transition
      // reservation until it is active, and refuses when that authority
      // changed after it was read.
      const agentAdmission = authorityTransitions.tryReserve("agent-admission");
      if (!agentAdmission) {
        return transitionRefusal();
      }
      const current = configuration.snapshot();
      if (
        current.status !== "ready" ||
        current.settings.revision !== snapshot.settings.revision
      ) {
        agentAdmission.release();
        return configurationFailure("AUTHORITY_CHANGE_IN_PROGRESS");
      }

      codexHostTaskAdmission = true;
      let session = activeCodexAgentCheck;
      let closeSession = false;
      try {
        let settings = snapshot.settings;
        // Bound before the closure: the narrowing at the top of this
        // function does not survive into one.
        const settingsService = configuration;
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
            scratchRoot: codexHostProbeRoot(),
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
            buildId: buildIdentity.buildId,
          });
          if (!recordedContract.ok) {
            return {
              active: false,
              refusal: ProductConfigurationResultSchema.parse(recordedContract),
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
            tempPath: app.getPath("temp"),
            clientVersion: buildIdentity.version,
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
            new CodexAgentWorkspaceProbe(settings, nativeWorkspace, () =>
              Date.now(),
            ),
          );
          const started: ActiveCodexAgentCheck = {
            key: checkKey,
            client,
            host,
            boundedRunningObserved: false,
          };
          activeCodexAgentCheck = started;
          return { active: true, session: started };
        });
        if (!activation.active) return activation.refusal;
        session = activation.session;

        const check = await runCodexNativeAgentCheck({
          host: session.host,
          assignments: new PrivateAssignmentStore({
            root: codexAgentAssignmentRoot(),
          }),
          settings,
          workspaceId: workspace.workspaceId,
          executableSha256: selected.executableSha256,
          schemaSha256: selected.schemaSha256,
          buildId: buildIdentity.buildId,
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
            await configuration.recordCodexAgentVerification(evidence);
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
          activeCodexAgentCheck = {
            ...session,
            boundedRunningObserved: true,
          };
          const recorded =
            await configuration.recordCodexAgentFailure("running");
          if (!recorded.ok) {
            return ProductConfigurationResultSchema.parse(recorded);
          }
          return configurationFailure("CODEX_AGENT_STILL_RUNNING");
        }
        closeSession = true;
        const recorded = await configuration.recordCodexAgentFailure(
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
        const recorded = await configuration.recordCodexAgentFailure(
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
          if (activeCodexAgentCheck === session) {
            activeCodexAgentCheck = null;
          }
        }
        codexHostTaskAdmission = false;
        agentAdmission.release();
      }
    }
    case "host.remove-codex":
      if (codexAgentOperationActive()) {
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      }
      return ProductConfigurationResultSchema.parse(
        await configuration.clearCodexHost(),
      );
    case "support.export": {
      try {
        const target = await selectedSupportExportTarget();
        if (target === null) {
          return configurationFailure("SUPPORT_EXPORT_CANCELLED");
        }
        const tasks = productTasksState().tasks;
        const receipt = await writeSupportExport(
          target,
          createSupportExport({
            generatedAt: new Date().toISOString(),
            build: buildIdentity,
            configuration: configuration.snapshot(),
            runtime: {
              state: runtimeState,
              errorCode: supportRuntimeErrorCode(runtimeError),
              identity: runtime?.identity ?? null,
            },
            capabilities: {
              nativeFilesystem: true,
              nativeAgent: productAgentCapabilityAvailable(),
              liveProvider: routeBRuntime !== null,
            },
            embedded: {
              node: process.versions.node,
              electron: process.versions.electron ?? null,
              chrome: process.versions.chrome ?? null,
            },
            tasks:
              runtimeState === "failed" && taskCountsBeforeRuntimeExit
                ? {
                    total: tasks.length,
                    ...taskCountsBeforeRuntimeExit,
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
        );
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration.snapshot(),
          evidence: { kind: "support.exported", ...receipt },
        });
      } catch (error) {
        return configurationFailure(
          error instanceof Error && error.message === "SUPPORT_EXPORT_TOO_LARGE"
            ? "SUPPORT_EXPORT_TOO_LARGE"
            : "SUPPORT_EXPORT_FAILED",
        );
      }
    }
    case "chatgpt.recover-task-result": {
      const retained = recoverableChatGptTask;
      if (!retained || retained.result === null) {
        return configurationFailure("CHATGPT_TASK_RESULT_NOT_FOUND");
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
        evidence: {
          kind: "chatgpt.task-recovery",
          operationId: retained.operationId,
          taskKind: retained.kind,
          ...retained.result,
          conversationContinuity: chatGptConversationContinuity(),
          redelivered: true,
          deliveryAckRequired: true,
        },
      });
    }
    case "chatgpt.reset-conversation": {
      if (chatGptTaskAdmission) {
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      }
      if (pendingChatGptReadonlyTask || pendingChatGptAttachmentTask) {
        return configurationFailure("CHATGPT_TASK_PREVIEW_PENDING");
      }
      const snapshot = configuration.snapshot();
      if (
        snapshot.status === "ready" &&
        snapshot.settings.setup.chatgpt.outcomeUnknown
      ) {
        return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
      }
      if (!chatGptConversationStore || !chatGptRoute) {
        return configurationFailure("CHATGPT_CONVERSATION_STATE_FAILED");
      }
      try {
        await chatGptConversationStore.clear();
        chatGptConversation = null;
        chatGptRoute.resetConversation();
      } catch {
        return configurationFailure("CHATGPT_CONVERSATION_STATE_FAILED");
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
        evidence: { kind: "chatgpt.conversation-reset", state: "new" },
      });
    }
    case "chatgpt.ack-task-result": {
      if (!chatGptTaskJournal) {
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
      }
      const retained = recoverableChatGptTask;
      if (
        retained?.operationId === command.operationId &&
        retained.result !== null &&
        !recoverableChatGptObservationPersisted
      ) {
        const recorded = await configuration.recordChatGptObservation(
          chatGptJournalObservation(retained.result),
        );
        if (!recorded.ok)
          return ProductConfigurationResultSchema.parse(recorded);
        recoverableChatGptObservationPersisted = true;
      }
      try {
        await chatGptTaskJournal.acknowledgeDelivery(command.operationId);
      } catch {
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
      }
      if (recoverableChatGptTask?.operationId === command.operationId) {
        recoverableChatGptTask = null;
        recoverableChatGptObservationPersisted = false;
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
      });
    }
    case "chatgpt.open-sign-in": {
      if (!chatGptRoute) {
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      }
      chatGptSignInBlocked.beginAttempt();
      chatGptSignInOutcome = null;
      chatGptSignInGeneration += 1;
      chatGptSignInOpenGeneration = chatGptSignInGeneration;
      if (embeddedBrowserEnabled()) {
        browserHomeSurfaceOpen = false;
        if (!signInSurfaceOpen || section !== "browser" || setupOpen) {
          signInReturnLayout = { section, setupOpen, taskId: selectedTaskId };
        }
        signInSurfaceOpen = true;
        section = "browser";
        setupOpen = false;
        applyLayout();
        publishLayout();
      }
      let opened: Awaited<ReturnType<ChatGptRoute["open"]>>;
      try {
        opened = await chatGptRoute.openForSignIn(SIGN_IN_WINDOW_TITLE);
      } catch {
        opened = { status: "unreachable" };
      }
      if (opened.status !== "opened" && embeddedBrowserEnabled()) {
        chatGptRoute.returnFromSignIn();
        restoreEmbeddedSignInLayout();
      }
      const recorded =
        opened.status === "opened"
          ? await configuration.markSetupVisited("chatgpt")
          : await configuration.recordChatGptObservation({
              state: "unreachable",
            });
      return ProductConfigurationResultSchema.parse({
        ...recorded,
        ...(opened.status === "unreachable"
          ? {
              evidence: {
                kind: "chatgpt.readiness",
                state: "unreachable",
                code: "CHATGPT_PAGE_UNREACHABLE",
              },
            }
          : {}),
      });
    }
    case "chatgpt.open-browser": {
      if (!embeddedBrowserEnabled() || !chatGptRoute) {
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      }
      if (chatGptSignInOpenGeneration !== null) {
        return configurationFailure("CHATGPT_SIGN_IN_IN_PROGRESS");
      }
      if (chatGptTaskAdmission || connectorTaskAdmission) {
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      }
      browserHomeSurfaceOpen = true;
      section = "browser";
      setupOpen = false;
      applyLayout();
      publishLayout();
      let opened: Awaited<ReturnType<ChatGptRoute["open"]>>;
      try {
        opened = await chatGptRoute.retryFailedOpen();
      } catch {
        opened = { status: "unreachable" };
      }
      if (opened.status !== "opened") {
        browserHomeSurfaceOpen = false;
        applyLayout();
        return configurationFailure("CHATGPT_PAGE_UNREACHABLE");
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
      });
    }
    case "chatgpt.toggle-sidebar": {
      const visibleRoute =
        signInSurfaceOpen ||
        (browserHomeSurfaceOpen && productTasksState().tasks.length === 0)
          ? chatGptRoute
          : liveTaskRoutes.get(selectedTaskId);
      if (!embeddedBrowserEnabled() || !visibleRoute) {
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      }
      if (!(await visibleRoute.toggleSidebar())) {
        return configurationFailure("CHATGPT_PAGE_UNREACHABLE");
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
      });
    }
    case "chatgpt.verify": {
      if (!chatGptRoute) {
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      }
      const observed = await chatGptRoute.observe();
      const recorded = await configuration.recordChatGptObservation(
        observed.state === "authenticated"
          ? {
              state: "authenticated",
              profile: "chatgpt.next-partition/1",
              runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
              buildId: buildIdentity.buildId,
              protocol: "chatgpt-page-readiness/1",
            }
          : { state: observed.state },
      );
      return ProductConfigurationResultSchema.parse({
        ...recorded,
        evidence: { kind: "chatgpt.readiness", ...observed },
      });
    }
    case "chatgpt.sign-in-return":
    case "chatgpt.verification-return": {
      if (embeddedBrowserEnabled()) {
        // A readonly app check leaves sign-in mode before it dispatches. The
        // embedded page still occupies the browser surface, so Return must
        // restore Setup even when there is no sign-in observation to finish.
        const observingSignIn = chatGptRoute?.returnFromSignIn() ?? false;
        if (!observingSignIn && signInSurfaceOpen) {
          const closing = chatGptSignInOpenGeneration;
          chatGptSignInOpenGeneration = null;
          restoreEmbeddedSignInLayout();
          publishShellAction(
            "sign-in-returned",
            command.kind === "chatgpt.verification-return"
              ? "verification-completed"
              : "sign-in-return-command",
            closing,
          );
        }
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
      });
    }
    case "chatgpt.prepare-attachment-task": {
      if (!chatGptRoute) {
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      }
      if (chatGptTaskAdmission) {
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      }
      const conversationFailure = chatGptConversationAdmissionFailure();
      if (conversationFailure) return conversationFailure;
      if (!attachmentStagingReady) {
        return configurationFailure("CHATGPT_ATTACHMENT_STAGING_FAILED");
      }
      if (pendingChatGptReadonlyTask) {
        return configurationFailure("CHATGPT_ATTACHMENT_PREVIEW_PENDING");
      }
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      if (snapshot.settings.setup.chatgpt.outcomeUnknown) {
        return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
      }
      const verification = snapshot.settings.setup.chatgpt.verified;
      if (!verification) {
        return configurationFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
      }
      const existing = pendingChatGptAttachmentTask;
      if (existing) {
        const current =
          Date.now() < existing.expiresAt &&
          isDeepStrictEqual(existing.chatGptVerification, verification);
        if (current) {
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot,
            evidence: chatGptAttachmentTaskPreview(existing),
          });
        }
        pendingChatGptAttachmentTask = null;
        try {
          await discardChatGptAttachments(
            chatGptAttachmentStagingRoot(),
            existing.operationId,
          );
        } catch {
          attachmentStagingReady = false;
          return configurationFailure("CHATGPT_ATTACHMENT_STAGING_FAILED");
        }
        if (!(await discardPreparedChatGptTask(existing.operationId))) {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
      }
      const selected = await selectedChatGptAttachmentPaths();
      if (selected === "cancelled") {
        return configurationFailure("CHATGPT_ATTACHMENT_PICKER_CANCELLED");
      }
      if (selected === "invalid") {
        return configurationFailure("CHATGPT_ATTACHMENT_SELECTION_INVALID");
      }
      const operationId = randomUUID();
      let attachments: StagedChatGptAttachments;
      try {
        attachments = await stageChatGptAttachments({
          root: chatGptAttachmentStagingRoot(),
          operationId,
          paths: selected,
        });
      } catch (error) {
        return attachmentStagingFailure(error);
      }
      const prompt = buildChatGptAttachmentTaskPrompt({
        attachments: attachments.attachments,
      });
      if (!chatGptTaskJournal) {
        await discardChatGptAttachments(
          chatGptAttachmentStagingRoot(),
          operationId,
        ).catch(() => {
          attachmentStagingReady = false;
        });
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
      }
      try {
        const journal = chatGptTaskJournal;
        await journalUnderPromotionLease(liveTaskRegistry, () =>
          journal.prepare({
            operationId,
            kind: "attachment",
          }),
        );
      } catch (error) {
        await discardChatGptAttachments(
          chatGptAttachmentStagingRoot(),
          operationId,
        ).catch(() => {
          attachmentStagingReady = false;
        });
        return configurationFailure(
          error instanceof PromotionPendingRefusal
            ? "CHATGPT_TASK_PROMOTION_PENDING"
            : "CHATGPT_TASK_JOURNAL_FAILED",
        );
      }
      pendingChatGptAttachmentTask = {
        operationId,
        attachments,
        prompt: prompt.text,
        chatGptVerification: verification,
        expiresAt: Date.now() + 10 * 60_000,
      };
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot,
        evidence: chatGptAttachmentTaskPreview(pendingChatGptAttachmentTask),
      });
    }
    case "chatgpt.submit-attachment-task": {
      if (!chatGptRoute) {
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      }
      if (chatGptTaskAdmission) {
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      }
      const pending = pendingChatGptAttachmentTask;
      if (!pending || pending.operationId !== command.operationId) {
        return configurationFailure("CHATGPT_ATTACHMENT_PREVIEW_NOT_FOUND");
      }
      if (Date.now() >= pending.expiresAt) {
        pendingChatGptAttachmentTask = null;
        await discardChatGptAttachments(
          chatGptAttachmentStagingRoot(),
          pending.operationId,
        ).catch(() => {
          attachmentStagingReady = false;
        });
        if (!(await discardPreparedChatGptTask(pending.operationId))) {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        return configurationFailure("CHATGPT_ATTACHMENT_PREVIEW_EXPIRED");
      }
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      if (snapshot.settings.setup.chatgpt.outcomeUnknown) {
        return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
      }
      if (
        !isDeepStrictEqual(
          snapshot.settings.setup.chatgpt.verified,
          pending.chatGptVerification,
        )
      ) {
        pendingChatGptAttachmentTask = null;
        await discardChatGptAttachments(
          chatGptAttachmentStagingRoot(),
          pending.operationId,
        ).catch(() => {
          attachmentStagingReady = false;
        });
        if (!(await discardPreparedChatGptTask(pending.operationId))) {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        return configurationFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
      }
      try {
        await verifyStagedChatGptAttachments(pending.attachments);
      } catch (error) {
        pendingChatGptAttachmentTask = null;
        await discardChatGptAttachments(
          chatGptAttachmentStagingRoot(),
          pending.operationId,
        ).catch(() => {
          attachmentStagingReady = false;
        });
        if (!(await discardPreparedChatGptTask(pending.operationId))) {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        return attachmentStagingFailure(error);
      }
      if (!chatGptTaskJournal) {
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
      }
      try {
        const journal = chatGptTaskJournal;
        await journalUnderPromotionLease(liveTaskRegistry, () =>
          journal.markDispatchIntent(pending.operationId),
        );
      } catch (error) {
        return configurationFailure(
          error instanceof PromotionPendingRefusal
            ? "CHATGPT_TASK_PROMOTION_PENDING"
            : "CHATGPT_TASK_JOURNAL_FAILED",
        );
      }
      pendingChatGptAttachmentTask = null;
      chatGptTaskAdmission = true;
      let task: Awaited<ReturnType<ChatGptRoute["runReadonlyTask"]>>;
      let stagingCleanup: "removed" | "pending_startup_cleanup" = "removed";
      try {
        try {
          task = await chatGptRoute.runReadonlyTask(
            pending.prompt,
            pending.attachments.attachments,
          );
        } catch {
          task = {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_ERROR",
            deltaCount: 0,
            observedCharacters: 0,
          };
        }
      } finally {
        try {
          await discardChatGptAttachments(
            chatGptAttachmentStagingRoot(),
            pending.operationId,
          );
        } catch {
          attachmentStagingReady = false;
          stagingCleanup = "pending_startup_cleanup";
        }
        chatGptTaskAdmission = false;
      }
      const journalResult = {
        state: task.state,
        code: task.code,
        deltaCount: task.deltaCount,
        observedCharacters: task.observedCharacters,
        attachmentCount: pending.attachments.attachments.length,
        totalBytes: pending.attachments.attachments.reduce(
          (total, attachment) => total + attachment.bytes,
          0,
        ),
        stagingCleanup,
      } as const;
      const conversationContinuity = await retainChatGptConversation(
        pending.operationId,
        task.state,
      );
      try {
        await chatGptTaskJournal.retainResult(
          pending.operationId,
          journalResult,
        );
        recoverableChatGptTask = await chatGptTaskJournal.load();
      } catch {
        const unknown = await configuration.recordChatGptObservation({
          state: "outcome_unknown",
        });
        if (!unknown.ok) {
          return ProductConfigurationResultSchema.parse(unknown);
        }
        return ProductConfigurationResultSchema.parse({
          ...unknown,
          evidence: {
            kind: "chatgpt.task-recovery",
            operationId: pending.operationId,
            taskKind: "attachment",
            state: "outcome_unknown",
            code: "CHATGPT_TASK_RESULT_PERSIST_FAILED",
            deltaCount: task.deltaCount,
            observedCharacters: task.observedCharacters,
            attachmentCount: journalResult.attachmentCount,
            totalBytes: journalResult.totalBytes,
            stagingCleanup,
            conversationContinuity,
            redelivered: false,
            deliveryAckRequired: false,
          },
        });
      }
      const observation =
        task.state === "completed"
          ? {
              state: "authenticated" as const,
              profile: "chatgpt.next-partition/1",
              runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
              buildId: buildIdentity.buildId,
              protocol: "chatgpt-page-attachment-task/1",
            }
          : task.state === "not_authenticated"
            ? { state: "signed_out" as const }
            : task.state === "outcome_unknown"
              ? { state: "outcome_unknown" as const }
              : task.code === "CHATGPT_PAGE_UNREACHABLE"
                ? { state: "unreachable" as const }
                : (chatGptAppPreSubmitObservation(task.code) ?? {
                    state: "unsupported" as const,
                  });
      const recorded =
        await configuration.recordChatGptObservation(observation);
      if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
      recoverableChatGptObservationPersisted = true;
      return ProductConfigurationResultSchema.parse({
        ...recorded,
        evidence: {
          kind: "chatgpt.attachment-task",
          operationId: pending.operationId,
          state: task.state,
          code: task.code,
          attachmentCount: pending.attachments.attachments.length,
          totalBytes: pending.attachments.attachments.reduce(
            (total, attachment) => total + attachment.bytes,
            0,
          ),
          deltaCount: task.deltaCount,
          observedCharacters: task.observedCharacters,
          stagingCleanup,
          conversationContinuity,
          redelivered: false,
          deliveryAckRequired: true,
        },
      });
    }
    case "chatgpt.cancel-attachment-task": {
      if (chatGptTaskAdmission) {
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      }
      const pending = pendingChatGptAttachmentTask;
      if (!pending || pending.operationId !== command.operationId) {
        return configurationFailure("CHATGPT_ATTACHMENT_PREVIEW_NOT_FOUND");
      }
      pendingChatGptAttachmentTask = null;
      try {
        await discardChatGptAttachments(
          chatGptAttachmentStagingRoot(),
          pending.operationId,
        );
      } catch {
        attachmentStagingReady = false;
        return configurationFailure("CHATGPT_ATTACHMENT_STAGING_FAILED");
      }
      if (!(await discardPreparedChatGptTask(pending.operationId))) {
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
      });
    }
    case "chatgpt.prepare-readonly-task": {
      if (goReadonlyConversation)
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      if (!chatGptRoute) {
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      }
      if (chatGptTaskAdmission) {
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      }
      const conversationFailure = chatGptConversationAdmissionFailure();
      if (conversationFailure) return conversationFailure;
      if (pendingChatGptAttachmentTask) {
        return configurationFailure("CHATGPT_TASK_PREVIEW_PENDING");
      }
      chatGptTaskAdmission = true;
      try {
        const snapshot = configuration.snapshot();
        if (snapshot.status !== "ready") {
          return configurationFailure("SETTINGS_UNAVAILABLE");
        }
        if (snapshot.settings.setup.chatgpt.outcomeUnknown) {
          return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
        }
        const chatGptVerification = snapshot.settings.setup.chatgpt.verified;
        if (!chatGptVerification) {
          return configurationFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
        }
        const workspace = snapshot.settings.computer.workspaces.find(
          (candidate) => candidate.workspaceId === command.workspaceId,
        );
        const computerVerification = snapshot.settings.setup.computer.verified;
        if (
          !workspace ||
          computerVerification?.workspaceId !== workspace.workspaceId ||
          computerVerification.configRevision !==
            snapshot.settings.computer.generation
        ) {
          return configurationFailure("WORKSPACE_NOT_FOUND");
        }
        const workspaceIdentity = workspace.rootIdentity;
        if (!workspaceIdentity) {
          return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
        }
        const pending = pendingChatGptReadonlyTask;
        if (pending) {
          const pendingStillCurrent =
            Date.now() < pending.expiresAt &&
            pending.computerGeneration ===
              snapshot.settings.computer.generation &&
            isDeepStrictEqual(pending.chatGptVerification, chatGptVerification);
          if (pendingStillCurrent) {
            if (pending.workspaceId !== workspace.workspaceId) {
              return configurationFailure("CHATGPT_TASK_PREVIEW_PENDING");
            }
            return ProductConfigurationResultSchema.parse({
              ok: true,
              snapshot,
              evidence: chatGptReadonlyTaskPreview(pending),
            });
          }
          if (!(await discardPreparedReadonlyTask(pending))) {
            return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
          }
        }
        const relativePath = await selectedWorkspaceFile(workspace, {
          title: "Choose a text file for the read-only ChatGPT task",
          buttonLabel: "Use Selected File",
        });
        if (relativePath === "cancelled") {
          return configurationFailure("WORKSPACE_FILE_PICKER_CANCELLED");
        }
        if (relativePath === "invalid") {
          return configurationFailure("WORKSPACE_FILE_SELECTION_INVALID");
        }
        // The user selected this file for this new pending operation. Bind its
        // identity before the read; demo IDs and settings do not admit a turn.
        const operationId = randomUUID();
        let text: string;
        let bytes: number;
        let goAdmission: ChatComputerAdmissionResponse | undefined;
        if (compiledGoCore !== null) {
          if (!desktopGoCore)
            return configurationFailure("WORKSPACE_READ_FAILED");
          try {
            const observed = await desktopGoCore.readForIntent(
              operationId,
              workspace.workspaceId,
              relativePath,
            );
            goAdmission = observed.admission;
            if (observed.result.status !== "ok") {
              if (!(await withdrawGoReadonlyAdmission(goAdmission)))
                return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
              return workspaceReadFailure(
                observed.result.code ?? "WORKSPACE_READ_FAILED",
              );
            }
            text = observed.result.data.text;
            bytes = Number(observed.result.data.bytes);
          } catch {
            // No TS/Python fallback or fresh key after a possibly effective
            // Go admission. The exact Go owner remains fenced for inspection.
            return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
          }
        } else {
          // Explicit legacy build only. This branch is never an error fallback.
          const workspaceResult = await nativeWorkspace.execute({
            workspace: workspaceDescriptor(workspace, workspaceIdentity),
            operation: { kind: "workspace.read", relativePath },
          });
          if (!workspaceResult.ok)
            return workspaceReadFailure(workspaceResult.error.code);
          if (workspaceResult.value.kind !== "workspace.text")
            return configurationFailure("WORKSPACE_VERIFICATION_FAILED");
          text = workspaceResult.value.text;
          bytes = workspaceResult.value.bytes;
        }
        const prompt = buildChatGptReadonlyTaskPrompt({
          workspaceLabel: workspace.label,
          relativePath,
          text,
        });
        if (
          goAdmission &&
          !ReadConversationPromptSchema.safeParse(prompt.text).success
        ) {
          if (!(await withdrawGoReadonlyAdmission(goAdmission)))
            return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
          return configurationFailure("CHATGPT_PROMPT_TOO_LARGE");
        }
        const expiresAt = Date.now() + 10 * 60_000;
        const excludedPaths = workspaceDeniedPaths(workspace);
        if (!chatGptTaskJournal) {
          if (!(await withdrawGoReadonlyAdmission(goAdmission)))
            return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        try {
          const journal = chatGptTaskJournal;
          await journalUnderPromotionLease(liveTaskRegistry, () =>
            journal.prepare({
              operationId,
              kind: "readonly",
            }),
          );
        } catch (error) {
          if (!(await withdrawGoReadonlyAdmission(goAdmission)))
            return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
          return configurationFailure(
            error instanceof PromotionPendingRefusal
              ? "CHATGPT_TASK_PROMOTION_PENDING"
              : "CHATGPT_TASK_JOURNAL_FAILED",
          );
        }
        pendingChatGptReadonlyTask = {
          operationId,
          workspaceId: workspace.workspaceId,
          workspaceLabel: workspace.label,
          computerGeneration: snapshot.settings.computer.generation,
          relativePath,
          bytes,
          ...(goAdmission ? { goAdmission } : {}),
          contextCharacters: prompt.contextCharacters,
          contextTruncated: prompt.contextTruncated,
          excludedPaths,
          prompt: prompt.text,
          chatGptVerification,
          expiresAt,
        };
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot,
          evidence: chatGptReadonlyTaskPreview(pendingChatGptReadonlyTask),
        });
      } finally {
        chatGptTaskAdmission = false;
      }
    }
    case "chatgpt.inspect-readonly-account":
    case "chatgpt.approve-readonly-account": {
      const pending = pendingChatGptReadonlyTask;
      const route = chatGptRoute;
      const core = desktopGoCore;
      if (chatGptTaskAdmission)
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      if (!pending || pending.operationId !== command.operationId)
        return configurationFailure("CHATGPT_TASK_PREVIEW_NOT_FOUND");
      if (
        !route ||
        !core ||
        !pending.goAdmission ||
        !readonlyAccountCurrent(pending, route, core)
      )
        return configurationFailure("CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
      let confirmation = readonlyAccountConfirmations.get(pending);
      if (
        !confirmation &&
        command.kind === "chatgpt.inspect-readonly-account"
      ) {
        confirmation = new ReadAccountConfirmation({
          admission: pending.goAdmission,
          current: () => readonlyAccountCurrent(pending, route, core),
          read: () => route.observeAccount(),
          approve: (input) => core.approveReadAccount(input),
        });
        readonlyAccountConfirmations.set(pending, confirmation);
      }
      if (!confirmation)
        return configurationFailure("CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
      chatGptTaskAdmission = true;
      try {
        if (command.kind === "chatgpt.inspect-readonly-account")
          await confirmation.inspect();
        else await confirmation.confirm(command.confirmationId);
        if (!readonlyAccountCurrent(pending, route, core))
          return configurationFailure(
            command.kind === "chatgpt.inspect-readonly-account"
              ? "CHATGPT_ACCOUNT_CONFIRMATION_INVALID"
              : "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED",
          );
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration?.snapshot(),
          evidence: chatGptReadonlyTaskPreview(pending),
        });
      } catch (error) {
        return configurationFailure(readAccountFailure(command, error));
      } finally {
        chatGptTaskAdmission = false;
      }
    }
    case "chatgpt.submit-readonly-task": {
      if (!chatGptRoute) {
        return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
      }
      if (chatGptTaskAdmission) {
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      }
      const pending = pendingChatGptReadonlyTask;
      if (!pending || pending.operationId !== command.operationId) {
        return configurationFailure("CHATGPT_TASK_PREVIEW_NOT_FOUND");
      }
      if (Date.now() >= pending.expiresAt) {
        if (!(await discardPreparedReadonlyTask(pending))) {
          return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
        }
        return configurationFailure("CHATGPT_TASK_PREVIEW_EXPIRED");
      }
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      if (snapshot.settings.setup.chatgpt.outcomeUnknown) {
        if (!(await discardPreparedReadonlyTask(pending))) {
          return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
        }
        return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
      }
      if (
        !isDeepStrictEqual(
          snapshot.settings.setup.chatgpt.verified,
          pending.chatGptVerification,
        )
      ) {
        if (!(await discardPreparedReadonlyTask(pending))) {
          return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
        }
        return configurationFailure("CHATGPT_CONNECTION_NOT_VERIFIED");
      }
      const workspace = snapshot.settings.computer.workspaces.find(
        (candidate) => candidate.workspaceId === pending.workspaceId,
      );
      const computerVerification = snapshot.settings.setup.computer.verified;
      if (
        !workspace ||
        snapshot.settings.computer.generation !== pending.computerGeneration ||
        computerVerification?.workspaceId !== pending.workspaceId ||
        computerVerification.configRevision !== pending.computerGeneration
      ) {
        if (!(await discardPreparedReadonlyTask(pending))) {
          return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
        }
        return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
      }
      if (pending.goAdmission) {
        if (!ReadConversationPromptSchema.safeParse(pending.prompt).success)
          return configurationFailure("CHATGPT_PROMPT_TOO_LARGE");
        const core = desktopGoCore;
        const profile = goChatStartupProfile;
        if (!core || !profile)
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        if (
          readonlyAccountConfirmations.get(pending)?.projection()?.state !==
          "approved"
        )
          return configurationFailure("CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
        let current: ReturnType<typeof captureChatStartupProfile>;
        try {
          current = captureChatStartupProfile({
            environment: runtimeEnvironment,
            e2e: process.env.FAROL_NEXT_E2E === "1",
            origin: chatGptE2eOrigin,
            tasks: snapshot.settings.tasks,
          });
        } catch {
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        }
        if (
          !current ||
          current.snapshot.configSHA256 !== profile.snapshot.configSHA256
        )
          return configurationFailure("CHATGPT_ROUTE_UNAVAILABLE");
        const client = new ReadConversationClient(
          {
            resolve: (input) => core.resolveReadIntent(input),
            promote: (input) => core.promoteReadIntent(input),
          },
          core.chat,
        );
        const admission = pending.goAdmission;
        const start = Promise.resolve().then(
          async (): Promise<ProductConfigurationResult> => {
            chatGptTaskAdmission = true;
            try {
              const projection = await client.start(
                {
                  admission,
                  policy: current.snapshot.policy,
                  profiles: current.snapshot.profiles,
                  requested: {},
                },
                pending.prompt,
              );
              return ProductConfigurationResultSchema.parse({
                ok: true,
                snapshot: configuration!.snapshot(),
                evidence: projectReadConversation(
                  pending.operationId,
                  projection,
                ),
              });
            } catch (error) {
              return configurationFailure(
                error instanceof BridgeError && error.state === "refused"
                  ? "CHATGPT_CONVERSATION_REFUSED"
                  : "CHATGPT_CONVERSATION_UNCONFIRMED",
              );
            } finally {
              chatGptTaskAdmission = false;
            }
          },
        );
        // Publish the original attempt before any await so repeated IPC cannot
        // mint another promotion or Send after a lost renderer reply.
        goReadonlyConversation = {
          pending,
          operationId: pending.operationId,
          core,
          client,
          start,
        };
        return start;
      }
      if (!chatGptTaskJournal) {
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
      }
      try {
        const journal = chatGptTaskJournal;
        await journalUnderPromotionLease(liveTaskRegistry, () =>
          journal.markDispatchIntent(pending.operationId),
        );
      } catch (error) {
        return configurationFailure(
          error instanceof PromotionPendingRefusal
            ? "CHATGPT_TASK_PROMOTION_PENDING"
            : "CHATGPT_TASK_JOURNAL_FAILED",
        );
      }
      chatGptTaskAdmission = true;
      pendingChatGptReadonlyTask = null;
      let task: Awaited<ReturnType<ChatGptRoute["runReadonlyTask"]>>;
      try {
        try {
          task = await chatGptRoute.runReadonlyTask(pending.prompt);
        } catch {
          task = {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_ERROR",
            deltaCount: 0,
            observedCharacters: 0,
          };
        }
      } finally {
        chatGptTaskAdmission = false;
      }
      const journalResult = {
        state: task.state,
        code: task.code,
        deltaCount: task.deltaCount,
        observedCharacters: task.observedCharacters,
      } as const;
      const conversationContinuity = await retainChatGptConversation(
        pending.operationId,
        task.state,
      );
      try {
        await chatGptTaskJournal.retainResult(
          pending.operationId,
          journalResult,
        );
        recoverableChatGptTask = await chatGptTaskJournal.load();
      } catch {
        const unknown = await configuration.recordChatGptObservation({
          state: "outcome_unknown",
        });
        if (!unknown.ok) {
          return ProductConfigurationResultSchema.parse(unknown);
        }
        return ProductConfigurationResultSchema.parse({
          ...unknown,
          evidence: {
            kind: "chatgpt.task-recovery",
            operationId: pending.operationId,
            taskKind: "readonly",
            state: "outcome_unknown",
            code: "CHATGPT_TASK_RESULT_PERSIST_FAILED",
            deltaCount: task.deltaCount,
            observedCharacters: task.observedCharacters,
            attachmentCount: 0,
            totalBytes: 0,
            stagingCleanup: null,
            conversationContinuity,
            redelivered: false,
            deliveryAckRequired: false,
          },
        });
      }
      const observation =
        task.state === "completed"
          ? {
              state: "authenticated" as const,
              profile: "chatgpt.next-partition/1",
              runtimeGeneration: `${activeDesktopIdentity.chatGptPartition}:${buildIdentity.buildId}`,
              buildId: buildIdentity.buildId,
              protocol: "chatgpt-page-readonly-task/1",
            }
          : task.state === "not_authenticated"
            ? { state: "signed_out" as const }
            : task.state === "outcome_unknown"
              ? { state: "outcome_unknown" as const }
              : task.code === "CHATGPT_PAGE_UNREACHABLE"
                ? { state: "unreachable" as const }
                : (chatGptAppPreSubmitObservation(task.code) ?? {
                    state: "unsupported" as const,
                  });
      const recorded =
        await configuration.recordChatGptObservation(observation);
      if (!recorded.ok) {
        return ProductConfigurationResultSchema.parse(recorded);
      }
      recoverableChatGptObservationPersisted = true;
      return ProductConfigurationResultSchema.parse({
        ...recorded,
        evidence: {
          kind: "chatgpt.readonly-task",
          operationId: pending.operationId,
          state: task.state,
          code: task.code,
          workspaceId: pending.workspaceId,
          relativePath: pending.relativePath,
          bytes: pending.bytes,
          contextCharacters: pending.contextCharacters,
          contextLimit: MAX_CHATGPT_CONTEXT_CHARACTERS,
          contextTruncated: pending.contextTruncated,
          deltaCount: task.deltaCount,
          observedCharacters: task.observedCharacters,
          conversationContinuity,
          redelivered: false,
          deliveryAckRequired: true,
        },
      });
    }
    case "chatgpt.cancel-readonly-task": {
      const conversation = goReadonlyConversation;
      if (
        conversation?.pending?.operationId === command.operationId &&
        !conversation.client.canWithdrawAdmission()
      )
        return configurationFailure("CHATGPT_CONVERSATION_REFUSED");
      if (chatGptTaskAdmission) {
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      }
      if (
        !pendingChatGptReadonlyTask ||
        pendingChatGptReadonlyTask.operationId !== command.operationId
      ) {
        return configurationFailure("CHATGPT_TASK_PREVIEW_NOT_FOUND");
      }
      const pending = pendingChatGptReadonlyTask;
      chatGptTaskAdmission = true;
      try {
        if (!(await discardPreparedReadonlyTask(pending)))
          return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
        if (
          conversation?.pending === pending &&
          goReadonlyConversation === conversation
        )
          goReadonlyConversation = null;
      } finally {
        chatGptTaskAdmission = false;
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
      });
    }
    case "general.update":
      return ProductConfigurationResultSchema.parse(
        await configuration.updateGeneral({
          openAtLaunch: command.openAtLaunch,
          sidebarDefault: command.sidebarDefault,
          activityDetail: command.activityDetail,
        }),
      );
    case "computer.rename":
      return ProductConfigurationResultSchema.parse(
        await configuration.renameComputer(command.name),
      );
    case "computer.choose-workspace": {
      if (codexAgentOperationActive())
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      pendingWorkspacePick = null;
      const selected = await selectedWorkspace();
      if (selected === "cancelled")
        return configurationFailure("WORKSPACE_PICKER_CANCELLED");
      if (selected === "invalid")
        return configurationFailure("WORKSPACE_SELECTION_INVALID");
      if (codexAgentOperationActive())
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      const selectionId = randomUUID();
      pendingWorkspacePick = {
        id: selectionId,
        selected,
        expiresAt: Date.now() + 300_000,
      };
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
        evidence: {
          kind: "computer.workspace-pick",
          selectionId,
          displayPath: selected.root,
        },
      });
    }
    case "computer.add-workspace": {
      if (codexAgentOperationActive())
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      const picked = pendingWorkspacePick;
      if (command.selectionId) pendingWorkspacePick = null;
      const selected = command.selectionId
        ? picked?.id === command.selectionId && picked.expiresAt > Date.now()
          ? picked.selected
          : "invalid"
        : await selectedWorkspace();
      if (selected === "cancelled") {
        return configurationFailure("WORKSPACE_PICKER_CANCELLED");
      }
      if (selected === "invalid") {
        return configurationFailure("WORKSPACE_SELECTION_INVALID");
      }
      const currentIdentity = await measuredRootIdentity(selected.root);
      if (
        !currentIdentity ||
        currentIdentity.device !== selected.rootIdentity.device ||
        currentIdentity.inode !== selected.rootIdentity.inode
      ) {
        return configurationFailure("WORKSPACE_ROOT_CHANGED");
      }
      const added = await configuration.addReadonlyWorkspace(selected);
      if (!added.ok || added.snapshot.status !== "ready")
        return ProductConfigurationResultSchema.parse(added);
      // Report the native pick even when it is an already approved folder.
      // Inferring it from a snapshot diff fails on that no-op path.
      const workspace = added.snapshot.settings.computer.workspaces.find(
        (candidate) => candidate.root === selected.root,
      );
      if (!workspace)
        return configurationFailure("WORKSPACE_SELECTION_INVALID");
      return ProductConfigurationResultSchema.parse({
        ...added,
        evidence: {
          kind: "computer.workspace-selection",
          workspaceId: workspace.workspaceId,
        },
      });
    }
    case "computer.remove-workspace":
      return ProductConfigurationResultSchema.parse(
        await configuration.removeWorkspace(command.workspaceId),
      );
    case "computer.update-exclusions": {
      const snapshot = configuration.snapshot();
      const workspace =
        snapshot.status === "ready"
          ? snapshot.settings.computer.workspaces.find(
              (candidate) => candidate.workspaceId === command.workspaceId,
            )
          : undefined;
      if (!workspace) return configurationFailure("WORKSPACE_NOT_FOUND");
      return ProductConfigurationResultSchema.parse(
        await configuration.updateWorkspaceExclusions(
          workspace.workspaceId,
          command.excludedPaths.map((relative) =>
            path.join(workspace.root, ...relative.split("/")),
          ),
        ),
      );
    }
    case "computer.update-access":
      return ProductConfigurationResultSchema.parse(
        await configuration.updateWorkspaceAccess(
          command.workspaceId,
          command.access,
        ),
      );
    case "computer.update-git-history":
      return ProductConfigurationResultSchema.parse(
        await configuration.updateWorkspaceGitHistory(
          command.workspaceId,
          command.approved,
        ),
      );
    case "computer.update-commands":
      return ProductConfigurationResultSchema.parse(
        await configuration.updateComputerCommands(command.commands),
      );
    case "computer.update-file-policy":
      return ProductConfigurationResultSchema.parse(
        await configuration.updateComputerFilePolicy(command.filePolicy),
      );
    case "computer.check-folder": {
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready")
        return configurationFailure("SETTINGS_UNAVAILABLE");
      const workspace = snapshot.settings.computer.workspaces.find(
        (item) => item.workspaceId === command.workspaceId,
      );
      if (!workspace) return configurationFailure("WORKSPACE_NOT_FOUND");
      const identity = workspace.rootIdentity;
      if (!identity)
        return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
      // Recheck only the already approved root through the same descriptor.
      // No child names/content are returned and no selected-folder binding changes.
      const checked = await listOwnerWorkspace(
        snapshot.settings.computer.generation,
        workspace,
        identity,
        ".",
        `settings:computer.check-folder:${workspace.workspaceId}`,
      );
      const reachable = checked.ok;
      const recorded = await configuration.recordFolderAccessCheck(
        workspace.workspaceId,
        snapshot.settings.computer.generation,
        buildIdentity.buildId,
        identity,
        reachable,
      );
      if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
      return reachable
        ? ProductConfigurationResultSchema.parse(recorded)
        : workspaceReadFailure(checked.code);
    }
    case "computer.verify-workspace": {
      let snapshot = configuration.snapshot();
      let workspace =
        snapshot.status === "ready"
          ? snapshot.settings.computer.workspaces.find(
              (candidate) => candidate.workspaceId === command.workspaceId,
            )
          : undefined;
      if (!workspace) return configurationFailure("WORKSPACE_NOT_FOUND");
      // Verifying is the owner's explicit act that binds the folder. The folder
      // at the path now is measured; one already bound must still be that
      // object, and one saved before identities existed is bound to what is
      // measured here only because the owner asked for this verification.
      const measured = await measuredRootIdentity(workspace.root);
      if (measured === null) {
        return configurationFailure("WORKSPACE_VERIFICATION_FAILED");
      }
      const bound = workspace.rootIdentity;
      if (
        bound &&
        (bound.device !== measured.device || bound.inode !== measured.inode)
      ) {
        return configurationFailure("WORKSPACE_ROOT_CHANGED");
      }
      if (!bound) {
        if (snapshot.status !== "ready")
          return configurationFailure("SETTINGS_UNAVAILABLE");
        const bindingAdmission = configurationAdmission(command.kind, {
          agentActive: codexAgentOperationActive(),
          connectorRunning:
            connectorTaskAdmission ||
            secureMcpConnectorRuntime?.isRunning() === true,
        });
        if (bindingAdmission !== "admitted")
          return configurationFailure(bindingAdmission);
        const binding = await configuration.bindWorkspaceRootIdentity(
          workspace.workspaceId,
          snapshot.settings.revision,
          workspace.root,
          measured,
        );
        if (!binding.ok) return ProductConfigurationResultSchema.parse(binding);
        snapshot = configuration.snapshot();
        workspace =
          snapshot.status === "ready"
            ? snapshot.settings.computer.workspaces.find(
                (item) => item.workspaceId === command.workspaceId,
              )
            : undefined;
      }
      if (!workspace || snapshot.status !== "ready")
        return configurationFailure("WORKSPACE_NOT_FOUND");
      // Go performs bounded content-free inspection under the exact published
      // approval. Native binding and final current authority are both checked.
      const generation = snapshot.settings.computer.generation;
      const result = await listOwnerWorkspace(
        generation,
        workspace,
        measured,
        ".",
        `settings:computer.verify-workspace:${workspace.workspaceId}`,
      );
      if (!result.ok) return workspaceReadFailure(result.code);
      // Preserve the measured layout for task selection. Primary metadata is
      // bound only with explicit full-Git approval; linked grants stay exact.
      const gitMetadata = await discoverWorkspaceGitMetadata(
        workspace.root,
        workspace.gitHistoryApproved === true,
      );
      // The listing takes a moment, and a connector or Agent may have started
      // meanwhile; a re-verification rebinds the authority either would carry,
      // so it is admitted again right before it commits.
      const readmitted = configurationAdmission(command.kind, {
        agentActive: codexAgentOperationActive(),
        connectorRunning:
          connectorTaskAdmission ||
          secureMcpConnectorRuntime?.isRunning() === true,
      });
      if (readmitted !== "admitted") return configurationFailure(readmitted);
      const recorded = await configuration.recordComputerVerification(
        workspace.workspaceId,
        {
          profile: `computer.local.${workspace.access}/1`,
          runtimeGeneration: `${runtime?.identity ?? "runtime-offline"}:${buildIdentity.buildId}`,
          buildId: buildIdentity.buildId,
          protocol:
            workspace.access === "write"
              ? "mutable-workspace/1"
              : "readonly-workspace/1",
        },
        {
          rootIdentity: measured,
          gitMetadata,
          expectedGeneration: generation,
          expectedRoot: workspace.root,
        },
      );
      if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
      return ProductConfigurationResultSchema.parse({
        ...recorded,
        evidence: {
          kind: "computer.workspace-list",
          workspaceId: workspace.workspaceId,
          relativePath: ".",
          entries: result.entries,
          truncated: result.truncated,
        },
      });
    }
    case "computer.list-workspace": {
      const selected = verifiedProductWorkspace(command.workspaceId);
      if (selected.status === "not_found") {
        return configurationFailure("WORKSPACE_NOT_FOUND");
      }
      if (selected.status === "not_verified") {
        return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
      }
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready")
        return configurationFailure("SETTINGS_UNAVAILABLE");
      const result = await listOwnerWorkspace(
        snapshot.settings.computer.generation,
        selected.workspace,
        selected.workspace.rootIdentity,
        command.relativePath,
      );
      if (!result.ok) return workspaceReadFailure(result.code);
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
        evidence: {
          kind: "computer.workspace-list",
          workspaceId: selected.workspace.workspaceId,
          relativePath: command.relativePath,
          entries: result.entries,
          truncated: result.truncated,
        },
      });
    }
    case "computer.search-workspace": {
      const selected = verifiedProductWorkspace(command.workspaceId);
      if (selected.status === "not_found") {
        return configurationFailure("WORKSPACE_NOT_FOUND");
      }
      if (selected.status === "not_verified") {
        return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
      }
      const result = await nativeWorkspace.execute({
        workspace: workspaceDescriptor(
          selected.workspace,
          selected.workspace.rootIdentity,
        ),
        operation: {
          kind: "workspace.search",
          relativePath: command.relativePath,
          pattern: command.pattern,
        },
      });
      if (!result.ok) return workspaceReadFailure(result.error.code);
      if (result.value.kind !== "workspace.matches") {
        return configurationFailure("WORKSPACE_READ_FAILED");
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
        evidence: {
          kind: "computer.workspace-search",
          workspaceId: selected.workspace.workspaceId,
          relativePath: command.relativePath,
          pattern: command.pattern,
          matches: result.value.matches,
          resultLimited: result.value.resultLimited,
          scanLimited: result.value.scanLimited,
        },
      });
    }
    case "computer.run-git-status":
    case "computer.run-git-head": {
      const verificationCommand =
        command.kind === "computer.run-git-status" ? "git.status" : "git.head";
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      if (snapshot.settings.computer.commands === "none") {
        return configurationFailure("WORKSPACE_COMMAND_APPROVAL_REQUIRED");
      }
      const selected = verifiedProductWorkspace(command.workspaceId);
      if (selected.status === "not_found") {
        return configurationFailure("WORKSPACE_NOT_FOUND");
      }
      if (selected.status === "not_verified") {
        return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
      }
      const action = verificationWorkspaceAction(
        snapshot.settings,
        selected.workspace,
        Date.now() + 30_000,
      );
      if (!action) {
        return configurationFailure("WORKSPACE_COMMAND_APPROVAL_REQUIRED");
      }
      const result = await action.execute({
        ownerId: "owner-desktop",
        sessionId: "desktop-command-session",
        taskId: "desktop-command-task",
        taskEpoch: snapshot.settings.computer.generation,
        participantId: "desktop-command-main",
        turnId: `desktop-command-${snapshot.settings.computer.generation}`,
        generation: snapshot.settings.computer.generation,
        callId: randomUUID(),
        workspaceId: selected.workspace.workspaceId,
        operation: {
          kind: "verification.run",
          command: verificationCommand,
          relativePath: ".",
        },
      });
      if (!result.ok) return workspaceCommandFailure(result.error.code);
      if (result.value.output.kind !== "workspace.command") {
        return configurationFailure("WORKSPACE_COMMAND_FAILED");
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
        evidence: {
          kind: "computer.workspace-command",
          workspaceId: selected.workspace.workspaceId,
          command: result.value.output.command,
          exitCode: result.value.output.exitCode,
          stdout: result.value.output.stdout,
          stderr: result.value.output.stderr,
          outputBytes: result.value.output.outputBytes,
          network: result.value.output.network,
          coverage: result.value.output.coverage,
          layout: result.value.output.layout,
        },
      });
    }
    case "computer.prepare-workspace-edit": {
      if (workspaceMutationAdmission) {
        return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
      }
      const core = compiledGoCore === null ? null : desktopGoCore;
      if (!core) return configurationFailure("WORKSPACE_READ_FAILED");
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      const selected = verifiedProductWorkspace(command.workspaceId);
      if (selected.status === "not_found") {
        return configurationFailure("WORKSPACE_NOT_FOUND");
      }
      if (selected.status === "not_verified") {
        return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
      }
      if (selected.workspace.access !== "write") {
        return configurationFailure("WORKSPACE_WRITE_APPROVAL_REQUIRED");
      }
      // A new edit waits until the outcome of the last one was delivered, so
      // an unknown result is observed instead of being buried under a retry.
      if (snapshot.settings.computer.pendingEdit !== null) {
        return configurationFailure("WORKSPACE_MUTATION_RESULT_PENDING");
      }
      const pending = pendingWorkspaceEdit;
      if (pending) {
        const pendingStillCurrent =
          Date.now() < pending.expiresAt &&
          pending.computerGeneration === snapshot.settings.computer.generation;
        if (pendingStillCurrent) {
          if (pending.workspaceId !== selected.workspace.workspaceId) {
            return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
          }
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot,
            evidence: workspaceEditPreview(pending),
          });
        }
        pendingWorkspaceEdit = null;
      }
      const relativePath = await selectedWorkspaceFile(selected.workspace, {
        title: "Choose a text file for a guarded edit",
        buttonLabel: "Review Edit",
      });
      if (relativePath === "cancelled") {
        return configurationFailure("WORKSPACE_FILE_PICKER_CANCELLED");
      }
      if (relativePath === "invalid") {
        return configurationFailure("WORKSPACE_FILE_SELECTION_INVALID");
      }
      const operationId = randomUUID();
      const expiresAt = Date.now() + 10 * 60_000;
      const binding = {
        generation: snapshot.settings.computer.generation,
        workspaceId: selected.workspace.workspaceId,
        relativePath,
        root: {
          path: selected.workspace.root,
          ...selected.workspace.rootIdentity,
        },
      };
      const observed = await readGoWorkspaceSnapshot({
        binding,
        current: () => {
          const now = configuration?.snapshot();
          const folder =
            now?.status === "ready"
              ? now.settings.computer.workspaces.find(
                  (item) => item.workspaceId === binding.workspaceId,
                )
              : undefined;
          if (
            desktopGoCore !== core ||
            now?.status !== "ready" ||
            !folder?.rootIdentity
          )
            return null;
          return {
            generation: now.settings.computer.generation,
            workspaceId: folder.workspaceId,
            relativePath,
            root: { path: folder.root, ...folder.rootIdentity },
          };
        },
        read: (value) =>
          core.snapshotSettingsWorkspace(
            value.generation,
            value.workspaceId,
            value.relativePath,
          ),
      });
      if (!observed.ok) return workspaceReadFailure(observed.code);
      pendingWorkspaceEdit = {
        operationId,
        workspaceId: binding.workspaceId,
        computerGeneration: binding.generation,
        relativePath,
        bytes: observed.bytes,
        beforeSha256: observed.sha256,
        expiresAt,
      };
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot,
        evidence: workspaceEditPreview(pendingWorkspaceEdit),
      });
    }
    case "computer.apply-workspace-edit": {
      if (workspaceMutationAdmission) {
        return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
      }
      const pending = pendingWorkspaceEdit;
      if (!pending || pending.operationId !== command.operationId) {
        return configurationFailure("WORKSPACE_MUTATION_PREVIEW_NOT_FOUND");
      }
      if (Date.now() >= pending.expiresAt) {
        pendingWorkspaceEdit = null;
        return configurationFailure("WORKSPACE_MUTATION_PREVIEW_EXPIRED");
      }
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        pendingWorkspaceEdit = null;
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      const workspace = snapshot.settings.computer.workspaces.find(
        (candidate) => candidate.workspaceId === pending.workspaceId,
      );
      const verification = snapshot.settings.setup.computer.verified;
      if (
        !workspace ||
        workspace.access !== "write" ||
        snapshot.settings.computer.generation !== pending.computerGeneration ||
        verification?.workspaceId !== pending.workspaceId ||
        verification.configRevision !== pending.computerGeneration
      ) {
        pendingWorkspaceEdit = null;
        return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
      }
      const goCore = compiledGoCore === null ? null : desktopGoCore;
      try {
        if (!goCore) throw new Error("GO_MUTATION_HOST_UNAVAILABLE");
        goCore.settingsMutationProfile();
      } catch {
        pendingWorkspaceEdit = null;
        return configurationFailure("WORKSPACE_MUTATION_FAILED");
      }
      if (snapshot.settings.computer.pendingEdit !== null) {
        pendingWorkspaceEdit = null;
        return configurationFailure("WORKSPACE_MUTATION_RESULT_PENDING");
      }
      workspaceMutationAdmission = true;
      pendingWorkspaceEdit = null;
      try {
        // Go owns durable pending admission, one executor call and the offer.
        return await withSettingsEditLease(
          pending.operationId,
          async () => {
            try {
              const result = await goCore.editSettingsWorkspace(
                pending.operationId,
                pending.computerGeneration,
                pending.workspaceId,
                pending.relativePath,
                pending.beforeSha256,
                command.oldText,
                command.newText,
              );
              return goWorkspaceEditResult(result, false);
            } catch {
              // No retry and no host-side ACK/invalidation decision. The exact
              // retained pending remains observable through the Go service.
              return configurationFailure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN");
            }
          },
          configuration.releaseWorkspaceEditLease.bind(configuration),
        );
      } finally {
        workspaceMutationAdmission = false;
      }
    }
    case "computer.observe-workspace-edit": {
      if (workspaceMutationAdmission) {
        return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
      }
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      const pendingEdit = snapshot.settings.computer.pendingEdit;
      if (pendingEdit?.operationId !== command.operationId) {
        return configurationFailure("WORKSPACE_MUTATION_NOT_PENDING");
      }
      if ("backend" in pendingEdit) {
        try {
          const core = desktopGoCore;
          if (compiledGoCore === null || !core)
            throw new Error("GO_MUTATION_HOST_UNAVAILABLE");
          const result = await core.observeSettingsMutation({
            backend: pendingEdit.backend,
            operationId: pendingEdit.operationId,
            profileId: pendingEdit.profileId,
            workspaceId: pendingEdit.workspaceId,
            relativePath: pendingEdit.relativePath,
            computerGeneration: String(pendingEdit.computerGeneration),
            beforeSHA256: pendingEdit.beforeSha256,
            submittedAt: pendingEdit.submittedAt,
          });
          return goWorkspaceEditResult(result, true);
        } catch {
          return configurationFailure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN");
        }
      }
      // Observation reads the durable operation record only: it executes
      // nothing and needs no write authority.
      const observed = await observeWorkspaceEdit(
        { mutationStateRoot: workspaceMutationStateRoot() },
        pendingEdit,
      );
      switch (observed.status) {
        case "completed":
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration.snapshot(),
            evidence: {
              kind: "computer.workspace-mutation",
              operationId: observed.operationId,
              workspaceId: pendingEdit.workspaceId,
              relativePath: observed.receipt.relativePath,
              operation: observed.receipt.operation,
              bytes: observed.receipt.bytes,
              replacements: observed.receipt.replacements,
              beforeSha256: observed.receipt.beforeSha256,
              afterSha256: observed.receipt.afterSha256,
              resultRetention: "durable",
              redelivered: observed.redelivered,
            },
          });
        case "failed":
          return workspaceMutationFailure(observed.code);
        case "not_admitted":
          return configurationFailure("WORKSPACE_MUTATION_NOT_ADMITTED");
        case "outcome_unknown":
          await configuration.recordComputerMutationOutcomeUnknown(
            pendingEdit.workspaceId,
          );
          return configurationFailure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN");
        case "unavailable":
          return configurationFailure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN");
      }
      break;
    }
    case "computer.ack-workspace-edit": {
      if (workspaceMutationAdmission)
        return configurationFailure("WORKSPACE_MUTATION_IN_PROGRESS");
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready")
        return configurationFailure("SETTINGS_UNAVAILABLE");
      const pending = snapshot.settings.computer.pendingEdit;
      if (pending?.operationId !== command.operationId)
        return configurationFailure("WORKSPACE_MUTATION_NOT_PENDING");
      if ("backend" in pending) {
        try {
          if (compiledGoCore === null || !desktopGoCore)
            throw new Error("GO_MUTATION_HOST_UNAVAILABLE");
          await desktopGoCore.acknowledgeSettingsMutation(command.operationId);
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration.snapshot(),
          });
        } catch {
          return configurationFailure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN");
        }
      }
      // Existing-only legacy delivery remains separate until migration is qualified.
      return ProductConfigurationResultSchema.parse(
        await configuration.clearPendingWorkspaceEdit(command.operationId),
      );
    }
    case "computer.cancel-workspace-edit":
      if (
        !pendingWorkspaceEdit ||
        pendingWorkspaceEdit.operationId !== command.operationId
      ) {
        return configurationFailure("WORKSPACE_MUTATION_PREVIEW_NOT_FOUND");
      }
      pendingWorkspaceEdit = null;
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
      });
    case "setup.progress":
      return ProductConfigurationResultSchema.parse(
        await configuration.setSetupJourney({
          currentStep: command.currentStep,
          dismissed: command.dismissed,
        }),
      );
    case "model.status": {
      if (!modelLifecycle) {
        return configurationFailure("MODEL_ENDPOINT_UNAVAILABLE");
      }
      // `checkStatus()` adds one read-only loopback probe of a conflicting
      // port so the status can say what holds it.
      const payload = modelStatusEvidencePayload(
        await modelLifecycle.checkStatus(),
      );
      if (!payload) return configurationFailure("MODEL_ENDPOINT_UNAVAILABLE");
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
        evidence: payload,
      });
    }
    case "model.preview": {
      const spec = await farolModelProviderSpec();
      if (!spec) return configurationFailure("MODEL_ENDPOINT_UNAVAILABLE");
      const configPath = farolModelCodexConfigPath();
      const blockPreview = await previewFarolModelConfigBlock(configPath, spec);
      const selectionPreview =
        command.selectAsDefault &&
        blockPreview.status !== "insecure_permissions" &&
        blockPreview.status !== "symlink" &&
        blockPreview.status !== "malformed"
          ? await previewFarolModelProviderSelection(configPath, spec)
          : null;
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
        evidence: {
          kind: "model.config-preview",
          configPath,
          providerBlockStatus: blockPreview.status,
          ...(blockPreview.status === "install" ||
          blockPreview.status === "update"
            ? {
                providerBlockDiff: blockPreview.diff,
                providerBlockTokenRedacted: blockPreview.tokenRedacted,
              }
            : {}),
          ...(blockPreview.status === "conflict"
            ? { providerBlockConflicts: blockPreview.conflicts }
            : {}),
          ...(blockPreview.status === "insecure_permissions"
            ? { providerBlockInsecureMode: blockPreview.mode }
            : {}),
          providerSelectionRequested: command.selectAsDefault,
          ...(selectionPreview
            ? {
                providerSelectionStatus: selectionPreview.status,
                ...(selectionPreview.status === "install" ||
                selectionPreview.status === "update"
                  ? { providerSelectionDiff: selectionPreview.diff }
                  : {}),
                ...(selectionPreview.status === "conflict"
                  ? { providerSelectionConflicts: selectionPreview.conflicts }
                  : {}),
              }
            : {}),
        },
      });
    }
    case "model.apply": {
      const spec = await farolModelProviderSpec();
      if (!spec) return configurationFailure("MODEL_ENDPOINT_UNAVAILABLE");
      const configPath = farolModelCodexConfigPath();
      try {
        const blockResult = await applyFarolModelConfigBlock(configPath, spec);
        if (blockResult.status === "insecure_permissions") {
          return configurationFailure("MODEL_CONFIG_INSECURE_PERMISSIONS");
        }
        if (blockResult.status === "conflict") {
          return configurationFailure("MODEL_CONFIG_CONFLICT");
        }
        if (blockResult.status === "symlink") {
          return configurationFailure("MODEL_CONFIG_SYMLINK");
        }
        if (blockResult.status === "malformed") {
          return configurationFailure("MODEL_CONFIG_MALFORMED");
        }
        let selectionApplied = false;
        if (command.selectAsDefault) {
          const selectionResult = await applyFarolModelProviderSelection(
            configPath,
            spec,
          );
          if (selectionResult.status === "conflict") {
            return configurationFailure("MODEL_CONFIG_CONFLICT");
          }
          if (selectionResult.status === "symlink") {
            return configurationFailure("MODEL_CONFIG_SYMLINK");
          }
          if (selectionResult.status === "malformed") {
            return configurationFailure("MODEL_CONFIG_MALFORMED");
          }
          selectionApplied = selectionResult.status === "applied";
        }
        // A host that is running read its config at start and needs a
        // restart; one that is not picks the block up at its next start.
        const codexHost = await farolModelCodexHostPresence();
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration.snapshot(),
          evidence: {
            kind: "model.config-applied",
            providerBlockApplied: blockResult.status === "applied",
            providerSelectionApplied: selectionApplied,
            restartStep: "restart_codex_to_apply",
            codexHost,
          },
        });
      } catch {
        return configurationFailure("MODEL_CONFIG_APPLY_FAILED");
      }
    }
    case "model.rollback": {
      const configPath = farolModelCodexConfigPath();
      try {
        // Each rollback removes exactly its own managed region from the
        // file's current bytes — never a backup — so the order only decides
        // which refusal is reported first when a marker is damaged.
        const selectionRollback =
          await rollbackFarolModelProviderSelection(configPath);
        if (selectionRollback.status === "symlink") {
          return configurationFailure("MODEL_CONFIG_SYMLINK");
        }
        if (selectionRollback.status === "malformed") {
          return configurationFailure("MODEL_CONFIG_MALFORMED");
        }
        const blockRollback = await rollbackFarolModelConfigBlock(configPath);
        if (blockRollback.status === "symlink") {
          return configurationFailure("MODEL_CONFIG_SYMLINK");
        }
        if (blockRollback.status === "malformed") {
          return configurationFailure("MODEL_CONFIG_MALFORMED");
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration.snapshot(),
          evidence: {
            kind: "model.config-rollback",
            providerBlockRestored: blockRollback.status === "restored",
            providerSelectionRestored: selectionRollback.status === "restored",
          },
        });
      } catch {
        return configurationFailure("MODEL_CONFIG_ROLLBACK_FAILED");
      }
    }
    case "model.rotate-token": {
      if (!modelLifecycle) {
        return configurationFailure("MODEL_ENDPOINT_UNAVAILABLE");
      }
      try {
        // S35-H2-1: one operation, not two. `rotateAndRewrite` inspects the
        // installed block BEFORE the token moves, so a block it cannot
        // rewrite refuses while the owner's Codex config still
        // authenticates, and a rewrite that fails after the rotation puts
        // the previous token back. A block that is not installed is still
        // not installed by this action.
        const rotated = await modelLifecycle.rotateAndRewrite({
          configPath: farolModelCodexConfigPath(),
          spec: farolModelProviderSpec,
          preview: previewFarolModelConfigBlock,
          apply: applyFarolModelConfigBlock,
        });
        if (!rotated.ok) return configurationFailure(rotated.code);
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration.snapshot(),
          evidence: {
            kind: "model.token-rotated",
            providerBlockUpdated: rotated.providerBlockUpdated,
            providerBlockStatus: rotated.providerBlockStatus,
          },
        });
      } catch {
        return configurationFailure("MODEL_TOKEN_ROTATE_FAILED");
      }
    }
  }
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

function currentWindowState(): WindowState {
  let trafficLightPosition: WindowState["trafficLightPosition"] = null;
  if (window && !window.isDestroyed() && process.platform === "darwin") {
    try {
      trafficLightPosition = window.getWindowButtonPosition();
    } catch {
      trafficLightPosition = null;
    }
  }
  return {
    focused: window?.isFocused() ?? false,
    fullScreen: window?.isFullScreen() ?? false,
    trafficLightPosition,
  };
}

function publishWindowState(): void {
  window?.webContents.send(channels.windowState, currentWindowState());
}

function publishLayout(): void {
  window?.webContents.send(channels.layout, {
    section,
    taskId: selectedTaskId,
    setupOpen,
    checkFeedbackVisible,
    sidebar: sidebarMode,
    sidebarWidth,
    overlay: shellOverlay,
  });
}

let sectionNavigationSequence = 0;
type SectionNavigationTarget = Pick<
  Extract<ShellAction, { action: "navigate-section" }>,
  "section" | "taskId" | "sequence"
>;

function publishShellAction(
  action: Exclude<ShellAction["action"], "navigate-section">,
  source: Exclude<ShellActionSource, "section-shortcut-command">,
  authWindowGeneration?: number | null,
): void;
function publishShellAction(
  action: "navigate-section",
  source: "section-shortcut-command",
  authWindowGeneration: null,
  navigation: SectionNavigationTarget,
): void;
function publishShellAction(
  action: ShellAction["action"],
  source: ShellActionSource,
  authWindowGeneration: number | null = null,
  navigation?: SectionNavigationTarget,
): void {
  window?.webContents.send(channels.shellAction, {
    action,
    eventId: randomUUID(),
    source,
    authWindowGeneration,
    ...navigation,
  });
}

function focusForLayout(): void {
  if (
    !window ||
    window.isDestroyed() ||
    !window.isFocused() ||
    window.webContents.isDestroyed()
  ) {
    return;
  }
  if (setupOpen || shellOverlay !== "none" || section !== "browser") {
    window.webContents.focus();
    return;
  }
  const selected = taskViews.get(selectedTaskId);
  if (!selected || !nativeViewVisibility.focus(window, selected)) {
    if (!window.webContents.isDestroyed()) window.webContents.focus();
  }
}

function focusForLayoutAfterRendererCommit(): void {
  setImmediate(focusForLayout);
}

function requestQuickSwitcher(): void {
  if (installedUpdateAdmission) return;
  if (!window || setupOpen) return;
  shellOverlay = "quick-switcher";
  applyLayout();
  publishShellAction("open-quick-switcher", "quick-switcher-command");
  window.webContents.focus();
}

function requestSidebarToggle(): void {
  if (installedUpdateAdmission) return;
  if (!window || window.isDestroyed()) return;
  publishShellAction("toggle-sidebar", "sidebar-command");
}

function requestUpdates(): void {
  if (installedUpdateAdmission) return;
  void containWindowOpenFailure(async () => {
    await ensureWindow();
    if (installedUpdateAdmission || !window || window.isDestroyed()) return;
    publishShellAction("open-updates", "update-command");
    window.webContents.focus();
  }, recoverWindowOpenFailure);
}

function requestSettings(): void {
  if (installedUpdateAdmission) return;
  if (!window) return;
  publishShellAction("open-settings", "settings-command");
  window.webContents.focus();
}

function closeShellOverlay(): void {
  if (installedUpdateAdmission) return;
  if (shellOverlay === "none") return;
  // Keep native input hidden until the renderer acknowledges the complete
  // dismissal, including an active resize or compact page-list overlay.
  publishShellAction("close-overlay", "overlay-dismissed");
  window?.webContents.focus();
}

function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? ([
          {
            label: displayProductName,
            submenu: [
              { role: "about" },
              {
                id: "app.updates",
                label: "Check for Updates…",
                click: () => {
                  requestUpdates();
                },
              },
              { type: "separator" },
              {
                id: "app.settings",
                label: "Settings…",
                accelerator: "CommandOrControl+,",
                click: requestSettings,
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : ([
          {
            label: "File",
            submenu: [
              {
                id: "app.settings",
                label: "Settings",
                accelerator: "CommandOrControl+,",
                click: requestSettings,
              },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          id: "view.toggle-sidebar",
          label: "Show/Hide Sidebar",
          ...(navigationShortcuts.sidebar === "off"
            ? {}
            : {
                accelerator: `Control+Command+${navigationShortcuts.sidebar.toUpperCase()}`,
              }),
          click: requestSidebarToggle,
        },
        {
          id: "view.quick-switcher",
          label: "Quick Switcher",
          accelerator: "CommandOrControl+K",
          click: requestQuickSwitcher,
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function attachTaskView(
  taskId: string,
  view: WebContentsView,
  bounds: Electron.Rectangle,
): void {
  if (
    !window ||
    window.isDestroyed() ||
    view.webContents?.isDestroyed() !== false ||
    taskViews.get(taskId) !== view
  ) {
    return;
  }
  nativeViewVisibility.show(window, view, bounds);
}

function attachTaskViews(): void {
  applyLayout();
}

function detachTaskViews(): void {
  if (window) nativeViewVisibility.detachHost(window);
}

function liveChatGptSurfaceFactory(taskId: string): ChatGptRouteSurfaceFactory {
  return ({ webPreferences }): ChatGptRouteSurface => {
    const existing = taskViews.get(taskId);
    if (existing && !existing.webContents.isDestroyed()) {
      throw new Error("CHATGPT_TASK_SURFACE_ALREADY_EXISTS");
    }
    const view = new WebContentsView({
      webPreferences: {
        ...webPreferences,
        backgroundThrottling: false,
      },
    });
    const contents = view.webContents;
    const closingListeners = new Set<() => void>();
    const closedListeners = new Set<() => void>();
    let closingNotified = false;
    let closedNotified = false;
    const notifyClosing = () => {
      if (closingNotified) return;
      closingNotified = true;
      for (const listener of closingListeners) listener();
    };
    const notifyClosed = () => {
      if (closedNotified) return;
      closedNotified = true;
      for (const listener of closedListeners) listener();
    };
    view.setVisible(false);
    taskViews.set(taskId, view);
    taskViewKinds.set(taskId, "chatgpt");
    contents.on("before-input-event", (event, input) => {
      if (handleShortcut(input)) event.preventDefault();
    });
    contents.once("destroyed", () => {
      disposeTaskView(taskId, view);
      notifyClosed();
    });
    return {
      kind: "embedded",
      webContents: contents,
      isDestroyed: () => contents.isDestroyed(),
      loadURL: (url) => contents.loadURL(url),
      hide: () => nativeViewVisibility.hide(view),
      reveal: () => {
        if (taskViews.get(taskId) !== view || contents.isDestroyed()) {
          return;
        }
        applyLayout();
      },
      focus: () => {
        if (window && taskViews.get(taskId) === view) {
          nativeViewVisibility.focus(window, view);
        }
      },
      setTitle: () => undefined,
      destroy: () => {
        if (!contents.isDestroyed()) notifyClosing();
        disposeTaskView(taskId, view);
        notifyClosed();
      },
      onPageTitleUpdated: (listener) => {
        contents.on("page-title-updated", (event) => listener(event));
      },
      onClosing: (listener) => closingListeners.add(listener),
      onClosed: (listener) => closedListeners.add(listener),
    };
  };
}

function embeddedBrowserEnabled(): boolean {
  return embeddedBrowserSelected({
    environment: runtimeEnvironment,
    demoMode,
    legacySetupTestMode,
  });
}

function signInChatGptSurfaceFactory(): ChatGptRouteSurfaceFactory {
  const create = liveChatGptSurfaceFactory(SIGN_IN_SURFACE_ID);
  return (options) => {
    const surface = create(options);
    return {
      ...surface,
      focus: () => {
        if (window?.isFocused()) surface.focus();
      },
      close: () => surface.destroy(),
    };
  };
}

function disposeTaskView(taskId: string, view: WebContentsView): void {
  if (taskViews.get(taskId) === view) {
    taskViews.delete(taskId);
    taskViewKinds.delete(taskId);
  }
  nativeViewVisibility.hide(view);
  const contents = view.webContents;
  if (contents && !contents.isDestroyed()) {
    contents.close({ waitForBeforeUnload: false });
  }
}

function disposeTaskViews(kind?: "runtime" | "chatgpt"): void {
  for (const [taskId, view] of [...taskViews]) {
    if (kind && taskViewKinds.get(taskId) !== kind) continue;
    disposeTaskView(taskId, view);
  }
}

function stopStreams(): void {
  for (const controller of streamControllers.values()) controller.abort();
  streamControllers.clear();
}

function publishTaskSurfaceStatus(status: TaskSurfaceStatus): void {
  window?.webContents.send(channels.taskSurfaceState, status);
}

function failTaskSurface(taskId: string): void {
  const controller = streamControllers.get(taskId);
  controller?.abort();
  streamControllers.delete(taskId);
  pendingComputer.delete(taskId);
  const error = "TASK_STREAM_FAILED";
  taskSurfaceFailures.set(taskId, error);
  publishTaskSurfaceStatus({ taskId, state: "failed", error });
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
  runtimeStopping = false;
  const child = utilityProcess.fork(path.join(directory, "runtime.cjs"), [], {
    env: {
      LANG: process.env.LANG ?? "en_US.UTF-8",
      FAROL_NEXT_RUNTIME_IDENTITY: activeDesktopIdentity.runtimeIdentity,
      FAROL_NEXT_PREVIEW_SCENARIO: process.argv.includes(
        "--preview-stream-failure",
      )
        ? "stream-failure"
        : process.env.FAROL_NEXT_E2E === "1" &&
            process.argv.includes("--preview-runtime-start-failure")
          ? "startup-failure"
          : process.argv.includes("--preview-failure")
            ? "failure"
            : "normal",
      FAROL_NEXT_PREVIEW_MODE: demoMode ? "demo" : "empty",
    },
    serviceName: activeDesktopIdentity.runtimeServiceName,
    stdio: "ignore",
  });
  runtimeChild = child;
  try {
    runtime = await new Promise<RuntimeReady>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("RUNTIME_START_TIMEOUT"));
      }, 10_000);
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

function partitionName(): string {
  return activeDesktopIdentity.runtimePartition;
}

function installNetworkFence(): Electron.Session | null {
  const base = runtimeBase();
  if (!base) return null;
  const isolated = session.fromPartition(partitionName(), { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${base}/`) });
  });
  return isolated;
}

function handleShortcut(input: Input): boolean {
  if (input.isComposing || input.isAutoRepeat) return false;
  const key = input.key.toLowerCase();
  if (input.meta && input.key === ",") {
    requestSettings();
    return true;
  }
  if (setupOpen) return false;
  if (
    input.control &&
    input.meta &&
    sidebarShortcutMatches(navigationShortcuts, key)
  ) {
    requestSidebarToggle();
    return true;
  }
  if (input.meta && key === "k") {
    requestQuickSwitcher();
    return true;
  }
  if (input.key === "Escape" && shellOverlay !== "none") {
    closeShellOverlay();
    return true;
  }
  if (input.control && input.key === "Tab") {
    if (installedUpdateAdmission) return true;
    const tasks = productTasksState().tasks;
    if (tasks.length === 0) return false;
    const index = tasks.findIndex((task) => task.taskId === selectedTaskId);
    const direction = input.shift ? -1 : 1;
    const next = (index + direction + tasks.length) % tasks.length;
    // Retain the native task cursor for consecutive Tab presses. Presentation
    // and overlay closure are acknowledged by the single renderer owner.
    selectedTaskId = tasks[next]?.taskId ?? selectedTaskId;
    publishShellAction("navigate-section", "section-shortcut-command", null, {
      section: "browser",
      taskId: selectedTaskId,
      sequence: ++sectionNavigationSequence,
    });
    if (liveTaskRoutes.has(selectedTaskId)) {
      void openLiveTaskSurface(selectedTaskId);
    } else {
      focusForLayout();
    }
    return true;
  }
  const shortcut =
    input.meta && !input.control && !input.alt && !input.shift
      ? sectionForShortcut(navigationShortcuts, input.key)
      : null;
  if (shortcut) {
    if (installedUpdateAdmission) return true;
    publishShellAction("navigate-section", "section-shortcut-command", null, {
      section: shortcut,
      taskId: selectedTaskId,
      sequence: ++sectionNavigationSequence,
    });
    if (shortcut === "browser" && liveTaskRoutes.has(selectedTaskId)) {
      void openLiveTaskSurface(selectedTaskId);
    } else {
      focusForLayout();
    }
    return true;
  }
  return false;
}

function applyRendererLayout(value: unknown): void {
  const parsed = ShellLayoutSchema.safeParse(value);
  if (!parsed.success) return;
  const tasks = productTasksState().tasks;
  const knownTask =
    tasks.length === 0
      ? parsed.data.taskId === ""
      : tasks.some((task) => task.taskId === parsed.data.taskId);
  // Shell navigation can conceal a browser even if its retained task selection
  // is missing or stale. It cannot select a replacement or reveal an unknown
  // conversation. Browser admission still requires the exact known task.
  const concealsBrowser =
    parsed.data.section !== "browser" ||
    parsed.data.setupOpen ||
    parsed.data.overlay !== "none";
  if (!knownTask && !concealsBrowser) return;
  const focusTargetChanged =
    section !== parsed.data.section ||
    (knownTask && selectedTaskId !== parsed.data.taskId) ||
    setupOpen !== parsed.data.setupOpen ||
    shellOverlay !== parsed.data.overlay;
  section = parsed.data.section;
  if (knownTask) selectedTaskId = parsed.data.taskId;
  setupOpen = parsed.data.setupOpen;
  checkFeedbackVisible = parsed.data.checkFeedbackVisible;
  sidebarMode = parsed.data.sidebar;
  sidebarWidth = parsed.data.sidebarWidth;
  shellOverlay = parsed.data.overlay;
  applyLayout();
  if (focusTargetChanged) focusForLayoutAfterRendererCommit();
}

function applyLayout(): void {
  if (!window || window.isDestroyed()) return;
  const [width = 1, height = 1] = window.getContentSize();
  const showBrowserHome =
    signInSurfaceOpen ||
    (browserHomeSurfaceOpen && productTasksState().tasks.length === 0);
  const selectedViewKind = showBrowserHome
    ? "chatgpt"
    : taskViewKinds.get(selectedTaskId);
  const layout = deriveSurfaceLayout({
    width,
    height,
    sidebar: sidebarMode,
    sidebarWidth,
    overlay: shellOverlay,
    section,
    setupOpen,
    runtimeReady: selectedViewKind === "chatgpt" || runtimeState === "ready",
    selectedTaskPresent: showBrowserHome || taskViews.has(selectedTaskId),
    browserChromeVisible:
      showBrowserHome || productTasksState().tasks.length > 0,
    compactBrowser: compactBrowserSelected({
      environment: runtimeEnvironment,
      demoMode,
      legacySetupTestMode,
    }),
    checkFeedbackVisible,
  });
  const visibleTaskId =
    !installedUpdateAdmission && layout.pageVisible
      ? showBrowserHome
        ? SIGN_IN_SURFACE_ID
        : selectedTaskId
      : null;
  // Detach covered and unselected pages first so the host has at most one
  // browser child, regardless of task insertion order.
  for (const [taskId, view] of taskViews) {
    if (taskId !== visibleTaskId || view.webContents?.isDestroyed() !== false) {
      nativeViewVisibility.hide(view);
    }
  }
  if (visibleTaskId !== null) {
    const view = taskViews.get(visibleTaskId);
    if (view) attachTaskView(visibleTaskId, view, layout.pageBounds);
  }
}

async function createTaskViews(): Promise<void> {
  if (!window || !runtime) return;
  const activeRuntime = runtime;
  const base = runtimeBase();
  if (!base || !installNetworkFence()) return;
  for (const task of activeRuntime.tasks) {
    if (runtimeState !== "ready" || runtime !== activeRuntime) return;
    const retained = taskViews.get(task.taskId);
    if (retained && !retained.webContents.isDestroyed()) {
      continue;
    }
    const view = new WebContentsView({
      webPreferences: {
        partition: partitionName(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    view.setVisible(false);
    taskViews.set(task.taskId, view);
    taskViewKinds.set(task.taskId, "runtime");
    view.webContents.once("destroyed", () => {
      disposeTaskView(task.taskId, view);
    });
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(`${base}/`)) event.preventDefault();
    });
    view.webContents.on("before-input-event", (event, input) => {
      if (handleShortcut(input)) event.preventDefault();
    });
    try {
      await view.webContents.loadURL(
        `${base}/task/${encodeURIComponent(task.taskId)}`,
        {
          extraHeaders: `Authorization: Bearer ${task.readToken}\n`,
        },
      );
      taskSurfaceFailures.delete(task.taskId);
      publishTaskSurfaceStatus({
        taskId: task.taskId,
        state: "ready",
        error: null,
      });
    } catch (error) {
      if (taskViews.get(task.taskId) === view) {
        disposeTaskView(task.taskId, view);
      }
      if (runtimeState !== "ready" || runtime !== activeRuntime) return;
      throw error;
    }
  }
  if (runtimeState === "ready" && runtime === activeRuntime) applyLayout();
}

async function consumeSse(task: RuntimeReady["tasks"][number]): Promise<void> {
  if (!runtime || !window) return;
  const controller = new AbortController();
  streamControllers.get(task.taskId)?.abort();
  streamControllers.set(task.taskId, controller);
  const response = await fetch(
    `http://127.0.0.1:${runtime.port}/events/${encodeURIComponent(task.taskId)}`,
    {
      headers: { authorization: `Bearer ${task.readToken}` },
      signal: controller.signal,
    },
  );
  if (!response.ok || !response.body)
    throw new Error("RUNTIME_STREAM_UNAVAILABLE");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  while (!controller.signal.aborted) {
    const part = await reader.read();
    if (part.done) {
      if (!controller.signal.aborted) throw new Error("RUNTIME_STREAM_ENDED");
      break;
    }
    carry += decoder.decode(part.value, { stream: true });
    const frames = carry.split("\n\n");
    carry = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (!data) continue;
      const parsed = ClientEventSchema.safeParse(JSON.parse(data));
      if (!parsed.success) throw new Error("RUNTIME_EVENT_INVALID");
      if (
        parsed.data.ownerId !== task.ownerId ||
        parsed.data.sessionId !== task.sessionId ||
        parsed.data.taskId !== task.taskId ||
        parsed.data.turnId !== task.turnId ||
        parsed.data.generation !== task.generation
      ) {
        throw new Error("RUNTIME_EVENT_CORRELATION");
      }
      if (parsed.data.kind === "computer.requested") {
        pendingComputer.set(task.taskId, parsed.data);
      } else if (
        parsed.data.kind === "computer.completed" ||
        parsed.data.kind === "turn.terminal"
      ) {
        pendingComputer.delete(task.taskId);
      }
      window?.webContents.send(channels.runtimeEvent, parsed.data);
    }
  }
  if (streamControllers.get(task.taskId) === controller) {
    streamControllers.delete(task.taskId);
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
  if (process.env.FAROL_NEXT_E2E !== "1" || demoMode) {
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
  ipcMain.handle(channels.installedUpdate, (event, value: unknown) =>
    isTrustedIpcSender(event, window)
      ? installedUpdateCommand(value)
      : { error: "IPC_SENDER_DENIED" },
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
  ipcMain.handle(channels.task, (event, value: unknown) =>
    isTrustedIpcSender(event, window)
      ? runProductTaskCommand(value)
      : taskFailure("TASKS_UNAVAILABLE"),
  );
  ipcMain.handle(channels.navigationShortcuts, (event, value: unknown) => {
    if (!isTrustedIpcSender(event, window)) return { ok: false };
    const parsed = parseNavigationShortcuts(value);
    if (!parsed) return { ok: false };
    navigationShortcuts = parsed;
    installApplicationMenu();
    return { ok: true };
  });
  ipcMain.handle(channels.control, async (event, value: unknown) => {
    if (installedUpdateAdmission) return { error: "UPDATE_IN_PROGRESS" };
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
  ipcMain.on(channels.layout, (event, value: unknown) => {
    if (installedUpdateAdmission || !isTrustedIpcSender(event, window)) return;
    applyRendererLayout(value);
  });
}

async function createWindow(): Promise<void> {
  const testPlacement =
    windowMode === "secondary-visible"
      ? selectPreviewWindowPlacement(
          screen.getAllDisplays(),
          screen.getPrimaryDisplay().id,
          initialWindowSize,
          allowPrimaryDisplay,
          builtInDisplayOnly,
        )
      : null;
  window = new BrowserWindow({
    title: displayWindowTitle,
    width: initialWindowSize.width,
    height: initialWindowSize.height,
    ...(testPlacement?.bounds ?? {}),
    minWidth: 640,
    minHeight: 520,
    backgroundColor: "#111216",
    titleBarStyle: "hiddenInset",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 14, y: 18 } }
      : {}),
    show: false,
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("before-input-event", (event, input) => {
    if (handleShortcut(input)) event.preventDefault();
  });
  window.on("resize", () => {
    applyLayout();
    publishWindowState();
  });
  window.on("focus", () => {
    publishWindowState();
    focusForLayoutAfterRendererCommit();
  });
  window.on("blur", publishWindowState);
  window.on("enter-full-screen", () => {
    applyLayout();
    publishWindowState();
  });
  window.on("leave-full-screen", () => {
    applyLayout();
    publishWindowState();
  });
  const taskViewHost = window;
  window.on("close", () => nativeViewVisibility.detachHost(taskViewHost));
  window.on("closed", () => {
    nativeViewVisibility.detachHost(taskViewHost);
    if (window !== taskViewHost) return;
    stopStreams();
    window = null;
    windowPresentationReady = false;
  });
  await window.loadFile(path.join(directory, "shell.html"));
  publishWindowState();
  attachTaskViews();
  await createTaskViews();
  if (!demoMode && selectedTaskId) {
    await openLiveTaskSurface(selectedTaskId);
    // Restore the other retained ChatGPT views behind the selected one. A
    // tab switch can then show its already loaded page in the same frame;
    // embedded surfaces only focus when they are actually visible.
    void Promise.allSettled(
      [...liveTaskRoutes.entries()]
        .filter(([taskId]) => taskId !== selectedTaskId)
        .map(([, route]) => route.open()),
    );
  }
  for (const task of runtime?.tasks ?? []) {
    void consumeSse(task).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return;
      if (runtimeState !== "ready") return;
      failTaskSurface(task.taskId);
    });
  }
  windowPresentationReady = true;
  revealWindow();
}

function selectedVisibleTestPlacement(
  requested: Readonly<{ width: number; height: number }>,
) {
  return selectPreviewWindowPlacement(
    screen.getAllDisplays(),
    screen.getPrimaryDisplay().id,
    requested,
    allowPrimaryDisplay,
    builtInDisplayOnly,
  );
}

function chatGptWindowPresentation(): ChatGptWindowPresentation | undefined {
  if (windowMode === "default") return undefined;
  if (windowMode === "hidden") return { mode: "hidden" };
  return {
    mode: "secondary-visible",
    place: (requested) => selectedVisibleTestPlacement(requested).bounds,
  };
}

function chatGptWindowPresentationOption(): Readonly<{
  windowPresentation?: ChatGptWindowPresentation;
}> {
  const presentation = chatGptWindowPresentation();
  return presentation === undefined ? {} : { windowPresentation: presentation };
}

function revealWindow(): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  const action = presentationAction(windowMode);
  if (action === "show-inactive") {
    window.setBounds(selectedVisibleTestPlacement(initialWindowSize).bounds);
    window.showInactive();
  } else if (action === "show-and-focus") window.show();
}

function reconcileVisibleTestDisplay(): void {
  if (windowMode !== "secondary-visible") return;
  if (windowPresentationReady && window !== null && !window.isDestroyed()) {
    window.hide();
    try {
      window.setBounds(selectedVisibleTestPlacement(initialWindowSize).bounds);
      window.showInactive();
    } catch {
      // The accepted test policy has a primary-display fallback only when the
      // owner explicitly passed --allow-primary-display; otherwise none
      // exists here. A later display event can re-evaluate and reveal this
      // exact owned window.
    }
  }
  for (const route of managedChatGptRoutes) {
    route.reconcileWindowPresentation();
  }
}

function ensureWindow(): Promise<void> {
  return windowOpenCoordinator.ensure({
    hasWindow: () => window !== null && !window.isDestroyed(),
    reveal: revealWindow,
    open: createWindow,
  });
}

function recoverWindowOpenFailure(): void {
  stopStreams();
  disposeTaskViews("runtime");
  detachTaskViews();
  pendingComputer.clear();
  taskSurfaceFailures.clear();
  const failedWindow = window;
  window = null;
  if (failedWindow && !failedWindow.isDestroyed()) failedWindow.destroy();
}

function reopenWindow(): void {
  void containWindowOpenFailure(ensureWindow, recoverWindowOpenFailure);
}

// Set when a quit begins; a quit drain always ends in the real quit.
let quitInProgress = false;

function isPrimaryReady(): boolean {
  return primaryStartupReady({
    stopping: quitInProgress || runtimeStopping,
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
  if (status === "reopened" && (quitInProgress || runtimeStopping)) {
    // The primary is quitting: acknowledge that it cannot take this launch
    // instead of reopening a window that is about to close.
    status = "reopen-failed";
  }
  if (status === "reopened") {
    try {
      await primaryStartup.whenReady();
      // Quit may have begun while this launch waited for startup: check
      // again before opening a window that is about to close.
      if (quitInProgress || runtimeStopping) {
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
  runtimeChild?.postMessage("shutdown");
}

function disposeChatGptRoutes(): void {
  for (const route of [...managedChatGptRoutes]) route.dispose();
  managedChatGptRoutes.clear();
  liveTaskRoutes.clear();
}

async function main(quitSignals: GracefulQuitSignals): Promise<void> {
  app.on(
    "second-instance",
    (_event, _commandLine, _workingDirectory, candidate) => {
      void handleSecondInstance(candidate);
    },
  );
  const updateRelaunch = await waitForInstalledUpdateRelaunch({
    args: process.argv,
    directory,
    userData: app.getPath("userData"),
    build: buildIdentity,
  });
  const stateRoot = path.join(app.getPath("userData"), "farol-next-state");
  const previousRunClean = await withStartupPromotionLease(
    app.getPath("userData"),
    buildIdentity.buildId,
    async (verify) => {
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
      if (compiledGoCore !== null && !clean) {
        // Reloading complete-looking handoff bytes cannot settle a lost
        // recorder response or an unconfirmed host drain.
        throw new Error("DESKTOP_PREVIOUS_QUIT_UNCONFIRMED");
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
    },
  );
  if (process.platform === "darwin") {
    const icon = nativeImage.createFromPath(
      path.join(
        directory,
        activeDesktopIdentity.environment === "dev"
          ? "farol-dev-mark.png"
          : "farol-mark.png",
      ),
    );
    if (icon.isEmpty()) throw new Error("DESKTOP_BRAND_IMAGE_INVALID");
    app.dock?.setIcon(icon);
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
    await cleanupChatGptAttachmentStaging(chatGptAttachmentStagingRoot());
  } catch {
    attachmentStagingReady = false;
  }
  configuration = new ProductConfigurationService(
    new ProductSettingsStore({
      root: path.join(app.getPath("userData"), "farol-next-state"),
    }),
    {
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
    process.env.FAROL_NEXT_E2E === "1"
      ? process.env.FAROL_NEXT_E2E_CHATGPT_URL
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
            e2e: process.env.FAROL_NEXT_E2E === "1",
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
      startDesktopGoCore({
        compiledArtifact: compiledGoCore,
        previousHostDrainConfirmed: previousRunClean,
        build: buildIdentity,
        artifactRoot: directory,
        stateRoot,
        home: app.getPath("home"),
        settings: currentSettings,
        browser: (context) =>
          createDesktopChatBrowser({
            context,
            partition: activeDesktopIdentity.chatGptPartition,
            // Public control profiles still require native qualification before a
            // production model may be admitted. The normal host owns this adapter;
            // a missing profile cannot select the legacy browser executor instead.
            driver: (lookup) =>
              new GoChatBrowserDriver({
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
    await runDesktopStartupBoundary("go-settings", () => {
      configuration!.attachComputerAuthority(() => desktopGoCore!.withdraw());
      desktopGoCore!.connectSettingsStore((profileId) => {
        const store = configuration!.attachSettingsDeliveryStore({
          profileId,
          ownerId: "owner-desktop",
        });
        return {
          read: (input) => store.read(input.deadlineMillis),
          replace: (input) => store.replace(input.change, input.deadlineMillis),
          fence: () => store.fence(),
        };
      });
    });
  }
  productAgentStore = new PrivateProductAgentStore({
    root: productAgentInputRoot(),
  });
  connectorCredentialStore = new PrivateConnectorKeyStore({
    root: secureMcpCredentialRoot(),
  });
  secureMcpConnectorRuntime = new SecureMcpConnectorRuntime({
    root: secureMcpConnectorRoot(),
    homePath: await codexHostProcessHomePath(),
    tempPath: app.getPath("temp"),
  });
  // Starts with the app, on the persisted port, and never autospawns a
  // host: see Decisions.md N04, item 1. The real chat-turn route (packet
  // N04c) is the already-running Route B provider: `routeBModelTurnHandler`
  // reads `routeBRuntime` at call time (it starts after this endpoint does,
  // via `initializeRouteBRuntime()` below, and can also close before it), so
  // a request before start or after close still answers
  // FAROL_MODEL_ROUTE_UNAVAILABLE, never silently dropped or fabricated.
  // The one exception is this exact E2E seam: with FAROL_NEXT_E2E=1 *and*
  // FAROL_MODEL_E2E_SYNTHETIC_REPLY set, requests get a synthetic
  // completed reply instead — proof that the "connected" indicator only
  // lights up once a request is actually served, with no real Codex or
  // ChatGPT account involved. It never activates outside that double gate.
  const modelSyntheticReply =
    process.env.FAROL_NEXT_E2E === "1"
      ? process.env.FAROL_MODEL_E2E_SYNTHETIC_REPLY
      : undefined;
  if (FAROL_MODEL_ENABLED) {
    modelLifecycle = new FarolModelLifecycle({
      stateRoot: modelEndpointStateRoot(),
      model: ROUTE_B_MODEL,
      handler: modelSyntheticReply
        ? syntheticModelTurnHandler(modelSyntheticReply)
        : routeBModelTurnHandler(() => routeBRuntime?.endpoint ?? null),
      compactionHandler: routeBModelCompactionHandler(
        () => routeBRuntime?.endpoint ?? null,
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
    chatGptTaskJournal = new PrivateChatGptTaskJournal({
      root: chatGptTaskJournalRoot(),
    });
    recoverableChatGptTask = await chatGptTaskJournal.reconcileAfterRestart();
    if (recoverableChatGptTask?.result) {
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
    chatGptConversationStore = new PrivateChatGptConversationStore({
      root: chatGptConversationStoreRoot(),
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
    collapseSidebarByDefault: embeddedBrowserEnabled(),
    e2eOrigin: e2eChatGptOrigin,
    parent: () => window,
    ...chatGptWindowPresentationOption(),
    ...(embeddedBrowserEnabled()
      ? { surfaceFactory: signInChatGptSurfaceFactory() }
      : {}),
    ...(process.env.FAROL_NEXT_E2E === "1"
      ? { taskTimeoutMs: 5_000, taskPollMs: 50 }
      : {}),
    onSignInOutcome: (status, diagnostic) => {
      if (embeddedBrowserEnabled()) {
        restoreEmbeddedSignInLayout();
      }
      chatGptSignInOutcome = diagnostic;
      const closing = chatGptSignInOpenGeneration;
      chatGptSignInOpenGeneration = null;
      void recordChatGptSignInOutcome(closing, status);
    },
    onSignInBlocked: (diagnostic) => {
      chatGptSignInBlocked.record(diagnostic);
    },
    onLoadStateChanged: (state) => {
      if (!embeddedBrowserEnabled()) return;
      if (
        !signInSurfaceOpen &&
        section === "browser" &&
        productTasksState().tasks.length === 0
      ) {
        if (state === "loading" || state === "failed")
          browserHomeSurfaceOpen = false;
        if (state === "loaded") browserHomeSurfaceOpen = true;
        applyLayout();
      }
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
    completedPreviously:
      initialSettings?.connectors.secureMcp.lastVerifiedAttachment != null,
    currentStep: initialSettings?.setup.journey.currentStep ?? "chatgpt",
    openAtLaunch: initialSettings?.general.openAtLaunch ?? "browser",
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
  if (process.env.FAROL_NEXT_E2E !== "1" && process.platform === "darwin") {
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
        () => ({
          label:
            runtimeState === "ready"
              ? "Farol · Local service available"
              : "Farol · Service unavailable",
          current:
            productTasksState().tasks.find(
              (task) => task.lifecycle === "running",
            )?.label ?? null,
        }),
      ),
    );
    app.once("will-quit", disposeMenuBar);
  }
  await runDesktopStartupBoundary("local-runtime", startRuntime);
  await runDesktopStartupBoundary("main-window", ensureWindow);
  screen.on("display-added", reconcileVisibleTestDisplay);
  screen.on("display-removed", reconcileVisibleTestDisplay);
  screen.on("display-metrics-changed", reconcileVisibleTestDisplay);
  app.on("activate", reopenWindow);
  // Quit waits, up to one deadline, for every owned child to confirm it
  // stopped, then quits for real; what did not confirm is recorded instead
  // of being reported as drained.
  const quitDrain = createQuitDrain({
    deadlineMs: QUIT_DRAIN_DEADLINE_MS,
    // The receipt first, then — only for a confirmed drain — the run marker
    // written at start (N03/D2). An undrained quit, or a receipt that could
    // not be written, leaves the marker in place, and the next promotion
    // reads that as a stop that never confirmed, never as a clean quit.
    record: async (receipt) => {
      await recordQuitReceipt(receipt);
      if (receipt.drained) {
        await removeRunMarker(
          path.join(app.getPath("userData"), "farol-next-state"),
          process.pid,
        );
      }
    },
    quit: () => app.quit(),
    collect: () => {
      const closers: OwnedCloser[] = [
        ...(desktopGoCore
          ? [{ name: "go-core", close: () => desktopGoCore!.close() }]
          : []),
        {
          name: "installed-updater",
          close: async () => {
            await installedUpdater?.close();
            // Creation can still be reading its private state when Quit starts.
            // initializeInstalledUpdater closes that late lifetime without checking.
            await installedUpdaterInitialization;
            await installedUpdater?.close();
          },
        },
      ];
      const attachmentTask = pendingChatGptAttachmentTask;
      pendingChatGptAttachmentTask = null;
      if (attachmentTask) {
        void discardChatGptAttachments(
          chatGptAttachmentStagingRoot(),
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
      if (connector) {
        const inFlightStart = connectorStartInFlight;
        closers.push({
          name: "connector",
          close: async () => {
            try {
              await stopAndConfirmComputerMcp(connector, inFlightStart);
            } finally {
              // Even an unconfirmed MCP drain must close account admission.
              // close() waits for already admitted work; it does not cancel Send
              // or turn the rejected connector close into a confirmed drain.
              const savedChat = savedChatBridgeRuntime;
              if (savedChat) {
                await savedChat.close();
                if (savedChatBridgeRuntime === savedChat)
                  savedChatBridgeRuntime = null;
              }
            }
          },
        });
      }
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
      const savedChat = connector ? null : savedChatBridgeRuntime;
      if (savedChat) {
        savedChatBridgeRuntime = null;
        closers.push({
          name: "saved-chat-bridge",
          close: () => savedChat.close(),
        });
      }
      disposeChatGptRoutes();
      disposeTaskViews("runtime");
      stopRuntime();
      return closers;
    },
  });
  app.on("before-quit", (event) => {
    quitInProgress = true;
    if (installedUpdateTimer) clearInterval(installedUpdateTimer);
    quitDrain.onBeforeQuit(event);
  });
  app.on("window-all-closed", () => {
    if (windowAllClosedAction(process.platform) === "quit") app.quit();
  });
  quitSignals.ready();
  installedUpdaterInitialization = initializeInstalledUpdater();
  void resumeComputerConnector(
    {
      environment: runtimeEnvironment,
      buildEnvironment,
      buildId: buildIdentity.buildId,
      previousRunClean,
      snapshot: configuration.snapshot(),
    },
    {
      current: () => configuration!.snapshot(),
      // The normal command retains authority reservation, physical-root and
      // Go inspection checks. No synthetic verification receipt is written.
      verifyWorkspace: (workspaceId) =>
        configureProduct({ kind: "computer.verify-workspace", workspaceId }),
      start: () => startSecureMcpConnector(false, true),
    },
  ).then(
    (status) => {
      startupStage(
        status === "started"
          ? "connector-resumed"
          : status === "skipped"
            ? "connector-resume-skipped"
            : "connector-resume-refused",
      );
      if (!quitInProgress && window && !window.isDestroyed())
        window.webContents.send(channels.configurationChanged);
    },
    () => startupStage("connector-resume-failed"),
  );
}

const primaryInstanceLock = app.requestSingleInstanceLock(instanceRequest);
startupStage(primaryInstanceLock ? "lock-primary" : "lock-secondary");
if (!primaryInstanceLock) {
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
    isQuitting: () => quitInProgress,
  });
  const initialization = main(quitSignals);
  const readiness = initialization.then(() => {
    if (!isPrimaryReady()) throw new Error("PRIMARY_STARTUP_INCOMPLETE");
  });
  primaryStartup.begin(readiness);
  void initialization
    .then(() => {
      startupStage("startup-complete");
      process.stderr.write(
        `${secondInstanceResultPrefix}${isPrimaryReady() ? "primary-started" : "reopen-failed"}\n`,
      );
    })
    .catch(async (error: unknown) => {
      try {
        await desktopGoCore?.abortStartup();
      } catch {
        error = new Error("GO_CORE_STARTUP_CLEANUP_UNCONFIRMED");
      }
      terminateDesktopStartup(error, runtimeEnvironment, {
        write: (message) => process.stderr.write(message),
        exit: (code) => app.exit(code),
      });
    });
}
