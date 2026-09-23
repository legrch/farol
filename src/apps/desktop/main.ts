import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
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
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
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
import {
  reconcileTaskContexts,
  toProductTaskContext,
} from "./context-task-state";
import {
  createCodexContextController,
  type CodexContextController,
} from "./codex-context-runtime";
import { channels } from "../../pkg/ipc/channels";
import type { ShellActionSource } from "../../pkg/ipc/shell-state";
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
  foreignAcknowledgementCount,
  readBuildLaunchIdentity,
  sameLaunchIdentity,
  waitForInstanceAcknowledgement,
  writeInstanceAcknowledgement,
} from "./single-instance";
import {
  parseAllowPrimaryDisplay,
  parsePreviewWindowMode,
  selectPreviewWindowPlacement,
} from "./window-placement";
import {
  PrimaryStartup,
  primaryStartupReady,
  previewStartupDelay,
} from "./primary-startup";
import { readRuntimeBuildIdentity } from "./build-identity";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "./product-configuration";
import { deriveSurfaceLayout } from "./surface-layout";
import {
  NativeReadonlyWorkspace,
  NEXT_SAFE_OPEN_HELPER,
} from "../../modules/computer/infra/native/native-readonly-workspace";
import { discoverLinkedGitMetadata } from "../../modules/computer/infra/native/native-verification-command";
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
  claimConnectorAppVerificationAttempt,
  connectorAppVerificationAttemptExists,
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
import { writeQuitReceipt } from "./quit-receipt-store";
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
  applyWorkspaceEdit,
  desktopMutableWorkspaceAction,
  observeWorkspaceEdit,
  prepareWorkspaceEdit,
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
import { probeTunnelClient } from "./tunnel-client-probe";
import { identityBoundWorkspaces } from "./identity-bound-workspaces";
import { AuthorityTransitionReservation } from "./authority-transition";
import {
  PrivateSecureMcpLaunchStore,
  createSecureMcpLaunchContract,
} from "./secure-mcp-launch-contract";
import { SecureMcpConnectorRuntime } from "./secure-mcp-connector-runtime";
import {
  checkConnectorAttachment,
  clearConnectorVerificationReceipt,
  readConnectorVerificationReceipt,
} from "../../modules/computer/infra/mcp/connector-verification-receipt";
import { PrivateExecutionFence } from "../../modules/computer/infra/mcp/execution-fence";
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
  codexChildHomePath,
  desktopAppDataPath,
  desktopEnvironment,
  desktopIdentity,
} from "./desktop-environment";
import { terminateDesktopStartup } from "./desktop-startup-failure";
import { resolveDevDataDirectoryName } from "./dev-profile-directory";

const directory = __dirname;
const buildIdentity = readRuntimeBuildIdentity(directory);
const productName = buildIdentity.product;
const bundleId = buildIdentity.bundleId;
const runtimeEnvironment = desktopEnvironment(
  process.env.FAROL_NEXT_ENVIRONMENT,
);
const desktopAppData = desktopAppDataPath(
  runtimeEnvironment,
  app.getPath("appData"),
  {
    enabled: process.env.FAROL_NEXT_E2E === "1",
    override: process.env.FAROL_NEXT_E2E_APP_DATA,
  },
);
const declaredDesktopIdentity = desktopIdentity(
  runtimeEnvironment,
  desktopAppData,
  runtimeEnvironment === "dev"
    ? resolveDevDataDirectoryName(desktopAppData)
    : undefined,
);
if (runtimeEnvironment === "dev") {
  // These paths must be selected before the single-instance lock or any
  // browser session is opened. Ordinary DEV rebuilds therefore retain the
  // same private state, while packaged Preview keeps its existing defaults.
  app.setPath("userData", declaredDesktopIdentity.userData);
  app.setPath("sessionData", declaredDesktopIdentity.sessionData);
}
const activeDesktopIdentity = {
  ...declaredDesktopIdentity,
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
// "Developer Preview" edition mark instead — the same pair the renderer's
// own chrome already shows (see shell.html).
const displayProductName = activeDesktopIdentity.displayName;
const displayEdition = activeDesktopIdentity.displayEdition;
const displayWindowTitle = `${displayProductName} · ${displayEdition}`;
// UX34-08: a dedicated, clearly-Farol-owned sign-in surface. DEV embeds it in
// the main window; Preview keeps its existing window presentation.
const SIGN_IN_WINDOW_TITLE = `Sign in to ChatGPT — ${displayProductName}`;
const launchIdentity = readBuildLaunchIdentity(
  directory,
  runtimeEnvironment,
  buildIdentity,
);
const nativeWorkspace = new NativeReadonlyWorkspace({
  helperPath: path.join(directory, "computer-safe-open.py"),
  helper: NEXT_SAFE_OPEN_HELPER,
});
const instanceRequest = createInstanceRequest(launchIdentity);
const secondInstanceResultPrefix = "FAROL_NEXT_SECOND_INSTANCE_RESULT:";
const secondInstanceAcknowledgementPrefix =
  "FAROL_NEXT_SECOND_INSTANCE_ACK_FAILED:";
const primaryStartup = new PrimaryStartup();
const startupDelayMs = previewStartupDelay(
  process.argv,
  process.env.FAROL_NEXT_E2E === "1",
);
const demoMode = process.argv.includes("--demo");
const contextOwnerId = "owner-desktop";
const contextProviderProfileId = "profile-isolated-next";
const contextModel = "farol-next/mind" as const;
const windowMode = parsePreviewWindowMode(process.argv);
// Explicit-only: the owner-handed overnight run passes this itself. Its
// absence keeps every display-selection outcome exactly as before.
const allowPrimaryDisplay = parseAllowPrimaryDisplay(process.argv);
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
process.title = activeDesktopIdentity.applicationName;
if (process.platform === "win32")
  app.setAppUserModelId(activeDesktopIdentity.applicationId);
if (process.platform === "darwin") {
  // macOS's default About panel otherwise reads the raw release identity
  // (app.getName()); this is display-only and does not touch that
  // identity, the bundle ID, or app.setName's own OS-level registration.
  app.setAboutPanelOptions({
    applicationName: displayProductName,
    applicationVersion: `${buildIdentity.version} (${displayEdition})`,
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
let shellOverlay: ShellOverlay = "none";
let configuration: ProductConfigurationService | null = null;
let connectorCredentialStore: PrivateConnectorKeyStore | null = null;
let secureMcpConnectorRuntime: SecureMcpConnectorRuntime | null = null;
let modelLifecycle: FarolModelLifecycle | null = null;
let connectorTaskAdmission = false;
// F3-1b: one authority transition at a time. A command that changes Computer
// authority holds it through its commit; a connector start and an Agent
// admission hold it from reading the settings until they run, so neither can
// start with authority that a concurrent change is about to replace.
const authorityTransitions = new AuthorityTransitionReservation();

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
  return {
    kind: "chatgpt.readonly-task-preview",
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
  };
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
  if (settings.computer.commands !== "verification") return null;
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
    commands: "verification",
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
    commands: "verification",
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
const attachedTaskViewIds = new Set<string>();
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
    productName,
    bundleId,
    environment: activeDesktopIdentity.environment,
    displayName: activeDesktopIdentity.displayName,
    displayEdition: activeDesktopIdentity.displayEdition,
    applicationId: activeDesktopIdentity.applicationId,
    build: buildIdentity,
    demoMode,
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
    mode: "mind",
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
  // Outside Setup the owner is brought to Settings; inside Setup the open
  // step is told the window closed, so it shows the recorded outcome and
  // its next action instead of the state from before sign-in.
  publishShellAction(
    runtimeEnvironment === "dev" || setupOpen
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

const QUIT_DRAIN_DEADLINE_MS = 5_000;

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
  const route = liveTaskRoutes.get(taskId);
  if (!route) return false;
  try {
    const opened = await route.open();
    if (opened.status !== "opened") {
      setLiveTaskLifecycle(taskId, "failed");
      return false;
    }
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
          model: "gpt-6-astra",
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
    session = await openProductAgentSession(input, context, false);
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
  if (!productAgentInputMatchesContext(input, context, buildIdentity.buildId)) {
    return taskFailure("AGENT_NOT_READY");
  }
  let session: ActiveProductAgentSession;
  try {
    session = await openProductAgentSession(input, context);
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
): ProductConfigurationResult {
  return ProductConfigurationResultSchema.parse({
    ok: false,
    error,
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
  if (activeDesktopIdentity.environment === "dev") {
    return path.join(activeDesktopIdentity.codexHome, "config.toml");
  }
  return path.join(os.homedir(), ".codex", "config.toml");
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
    providerName: "farol",
    displayName: "Farol Model",
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
  if (runtimeEnvironment === "dev") return "not_running";
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
  const selected = codexChildHomePath(
    runtimeEnvironment,
    activeDesktopIdentity.codexHome,
    process.env.CODEX_HOME,
  );
  if (selected === undefined) return {};
  if (runtimeEnvironment === "dev") await codexHostHomePath();
  return { codexHomePath: selected };
}

async function codexHostProcessHomePath(): Promise<string> {
  if (runtimeEnvironment !== "dev") return app.getPath("home");
  const root = path.join(
    activeDesktopIdentity.userData,
    "farol-next-private",
    "process-home",
  );
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
): Promise<ProductConfigurationResult> {
  if (
    !configuration ||
    !connectorCredentialStore ||
    !secureMcpConnectorRuntime
  ) {
    return configurationFailure("SETTINGS_UNAVAILABLE");
  }
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
  try {
    if (repair) {
      await secureMcpConnectorRuntime.stop();
      const stopped = await configuration.recordSecureMcpStopped();
      if (!stopped.ok) return ProductConfigurationResultSchema.parse(stopped);
    }
    const snapshot = configuration.snapshot();
    if (snapshot.status !== "ready") {
      return configurationFailure("SETTINGS_UNAVAILABLE");
    }
    const connector = snapshot.settings.connectors.secureMcp;
    if (!connector.tunnelClient || !connector.tunnelId) {
      return configurationFailure("CONNECTOR_CONFIGURE_FAILED");
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
    const preparedDevProof =
      runtimeEnvironment === "dev"
        ? await readDevMcpProofPreparation(devMcpProofRoot()).catch(() => null)
        : null;
    const devMcpProof =
      preparedDevProof !== null &&
      preparedDevProof.buildId === buildIdentity.buildId &&
      preparedDevProof.computerGeneration ===
        snapshot.settings.computer.generation &&
      snapshot.settings.computer.workspaces.some(
        (workspace) =>
          workspace.workspaceId === preparedDevProof.workspaceId &&
          workspace.root === preparedDevProof.workspaceRoot &&
          workspace.rootIdentity !== undefined,
      )
        ? preparedDevProof
        : undefined;
    let launchFile: string;
    let launchContractSha256: string;
    try {
      await clearConnectorVerificationReceipt(secureMcpLaunchRoot());
      const contract = createSecureMcpLaunchContract(snapshot.settings, {
        now: Date.now(),
        runtimeId,
        challengeSha256: verificationChallengeSha256,
        ...(devMcpProof === undefined ? {} : { devMcpProof }),
        ...(callerRelayRuntime
          ? { callerRelay: callerRelayRuntime.endpoint }
          : {}),
      });
      launchFile = await new PrivateSecureMcpLaunchStore({
        root: secureMcpLaunchRoot(),
      }).write(contract);
      launchContractSha256 = createHash("sha256")
        .update(await readFile(launchFile))
        .digest("hex");
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
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
    } catch {
      const failed = await recordConnectorRuntime(
        "unreachable",
        attempt("configure"),
        snapshot.settings.computer.generation,
      );
      if (failed) return failed;
      return configurationFailure("CONNECTOR_CONFIGURE_FAILED");
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
      await secureMcpConnectorRuntime.stop().catch(() => undefined);
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
  }
}

async function checkSecureMcpAttachment(): Promise<ProductConfigurationResult> {
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
    const connector = snapshot.settings.connectors.secureMcp;
    const runtime = connector.runtime;
    const challenge = connector.challenge;
    if (
      runtime?.state !== "ready" ||
      challenge === null ||
      !secureMcpConnectorRuntime.isRunning()
    ) {
      return configurationFailure("CONNECTOR_CHALLENGE_UNAVAILABLE");
    }
    let receipt;
    try {
      receipt = await readConnectorVerificationReceipt(secureMcpLaunchRoot());
    } catch {
      return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
    }
    if (receipt === null) {
      return configurationFailure("CONNECTOR_ATTACHMENT_NOT_FOUND");
    }
    // S35-TA-6: the verdict itself lives in `connector-verification-receipt.ts`
    // so it can be exercised; what stays here is reading the snapshot, which
    // only `main.ts` can do. Every refusal renders as the same closed code:
    // telling an unverified connector which check refused it tells it what to
    // forge next.
    const verdict = checkConnectorAttachment({
      receipt,
      challenge: {
        challengeSha256: challenge.challengeSha256,
        preparedAt: challenge.preparedAt,
      },
      computerGeneration: snapshot.settings.computer.generation,
      approvedWorkspaceIds: snapshot.settings.computer.workspaces.map(
        (workspace) => workspace.workspaceId,
      ),
    });
    if (!verdict.attached) {
      return configurationFailure("CONNECTOR_ATTACHMENT_INVALID");
    }
    const receiptSha256 = createHash("sha256")
      .update(`${JSON.stringify(receipt, null, 2)}\n`)
      .digest("hex");
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
  if (runtimeEnvironment !== "dev") {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_DEV_ONLY");
  }
  if (!configuration || !chatGptRoute || !secureMcpConnectorRuntime) {
    return configurationFailure("SETTINGS_UNAVAILABLE");
  }
  if (chatGptTaskAdmission || connectorTaskAdmission) {
    return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
  }
  const snapshot = configuration.snapshot();
  if (snapshot.status !== "ready")
    return configurationFailure("SETTINGS_UNAVAILABLE");
  const settings = snapshot.settings;
  const connector = settings.connectors.secureMcp;
  const runtime = connector.runtime;
  const challenge = connector.challenge;
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
    !settings.computer.workspaces.some(
      (workspace) => workspace.workspaceId === workspaceId,
    )
  ) {
    return configurationFailure("CONNECTOR_APP_VERIFICATION_NOT_READY");
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
    return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE");
  }
  const prompt = `Use the selected Farol Dev app to call farol_next_connector_verify once with challenge "${challenge.value}" and workspaceId "${workspaceId}". Do not read file contents. Reply briefly with the result.`;
  let claimed = false;
  chatGptTaskAdmission = true;
  connectorTaskAdmission = true;
  try {
    const result = await chatGptRoute.runReadonlyTask(prompt, [], {
      onDispatchIntent: async () => {
        if (claimed) return;
        await claimConnectorAppVerificationAttempt(
          stateRoot,
          challenge.challengeSha256,
        );
        claimed = true;
      },
    });
    if (result.state !== "completed") {
      const preSubmitCode = result.code;
      return configurationFailure(
        claimed
          ? "CONNECTOR_APP_VERIFICATION_OUTCOME_UNKNOWN"
          : preSubmitCode === "CHATGPT_APP_SELECTION_MISSING" ||
              preSubmitCode === "CHATGPT_APP_SELECTION_AMBIGUOUS" ||
              preSubmitCode === "CHATGPT_APP_SELECTION_CONFLICT" ||
              preSubmitCode === "CHATGPT_APP_SELECTION_LOST" ||
              preSubmitCode === "CHATGPT_COMPOSER_DRAFT_PRESENT"
            ? preSubmitCode
            : "CONNECTOR_APP_VERIFICATION_BEFORE_SUBMIT_FAILED",
      );
    }
    if (!claimed) {
      return configurationFailure(
        "CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE",
      );
    }
    const current = configuration.snapshot();
    if (
      current.status !== "ready" ||
      current.settings.computer.generation !== settings.computer.generation ||
      current.settings.connectors.secureMcp.tunnelId !== connector.tunnelId ||
      current.settings.connectors.secureMcp.generation !==
        connector.generation ||
      current.settings.connectors.secureMcp.runtime?.runtimeGeneration !==
        runtime.runtimeGeneration ||
      current.settings.connectors.secureMcp.challenge?.challengeSha256 !==
        challenge.challengeSha256
    ) {
      return configurationFailure("CONNECTOR_APP_VERIFICATION_STATE_CHANGED");
    }
  } finally {
    chatGptTaskAdmission = false;
    connectorTaskAdmission = false;
  }
  return checkSecureMcpAttachment();
}

async function prepareDevMcpProof(): Promise<ProductConfigurationResult> {
  if (runtimeEnvironment !== "dev") {
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
    connectorRunning: secureMcpConnectorRuntime?.isRunning() === true,
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
  if (runtimeEnvironment !== "dev") {
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

async function configureProduct(
  value: unknown,
): Promise<ProductConfigurationResult> {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  const parsed = ProductConfigurationCommandSchema.safeParse(value);
  if (!parsed.success) return configurationFailure("SETTINGS_INPUT_INVALID");
  const command = parsed.data;
  const admission = configurationAdmission(command.kind, {
    agentActive: codexAgentOperationActive(),
    connectorRunning: secureMcpConnectorRuntime?.isRunning() === true,
  });
  if (admission !== "admitted") return configurationFailure(admission);
  if (!changesComputerAuthority(command.kind)) {
    return deliverConfigurationReply(
      command.kind,
      await configureAdmittedProduct(command),
    );
  }
  const reserved = await authorityTransitions.withReservation(
    "authority-change",
    () => configureAdmittedProduct(command),
  );
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
    case "connector.select-client": {
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
    case "connector.start":
      return startSecureMcpConnector(false);
    case "connector.repair":
      return startSecureMcpConnector(true);
    case "connector.check-attachment":
      return checkSecureMcpAttachment();
    case "connector.verify-app":
      return verifySecureMcpApp();
    case "dev-proof.prepare":
      return prepareDevMcpProof();
    case "dev-proof.run":
      return runDevMcpProof();
    case "connector.stop": {
      if (!secureMcpConnectorRuntime) {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      if (connectorTaskAdmission) {
        return configurationFailure("CONNECTOR_ALREADY_RUNNING");
      }
      connectorTaskAdmission = true;
      try {
        await secureMcpConnectorRuntime.stop();
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
      if (codexAgentOperationActive()) {
        return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
      }
      try {
        // Keep the real Detect host action in the E2E lane while ensuring it
        // probes only the synthetic App Server fixture, never a Codex binary
        // or model configuration belonging to the owner.
        const testExecutable = e2eCodexExecutable();
        if (testExecutable === "invalid") {
          return configurationFailure("CODEX_HOST_SELECTION_INVALID");
        }
        if (testExecutable !== undefined) {
          return verifyCodexExecutable(testExecutable);
        }
        const discovered = await discoverExecutables("codex");
        for (const candidate of discovered.candidates) {
          if (candidate.verdict !== "offer") continue;
          if (!candidate.sha256) continue;
          const verified = await verifyCodexExecutable(candidate.path, {
            canonicalPath: candidate.path,
            sha256: candidate.sha256,
          });
          if (verified.ok) return verified;
        }
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
            provider: "farol_next",
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
      if (runtimeEnvironment === "dev" && !signInSurfaceOpen) {
        signInReturnLayout = { section, setupOpen, taskId: selectedTaskId };
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
      if (opened.status !== "opened" && runtimeEnvironment === "dev") {
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
    case "chatgpt.sign-in-return": {
      if (runtimeEnvironment === "dev") chatGptRoute?.returnFromSignIn();
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
          pendingChatGptReadonlyTask = null;
          if (!chatGptTaskJournal) {
            return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
          }
          try {
            await chatGptTaskJournal.discardPrepared(pending.operationId);
          } catch {
            return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
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
        const workspaceResult = await nativeWorkspace.execute({
          workspace: workspaceDescriptor(workspace, workspaceIdentity),
          operation: { kind: "workspace.read", relativePath },
        });
        if (!workspaceResult.ok) {
          return workspaceReadFailure(workspaceResult.error.code);
        }
        if (workspaceResult.value.kind !== "workspace.text") {
          return configurationFailure("WORKSPACE_VERIFICATION_FAILED");
        }
        const prompt = buildChatGptReadonlyTaskPrompt({
          workspaceLabel: workspace.label,
          relativePath,
          text: workspaceResult.value.text,
        });
        const operationId = randomUUID();
        const expiresAt = Date.now() + 10 * 60_000;
        const excludedPaths = workspaceDeniedPaths(workspace);
        if (!chatGptTaskJournal) {
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
          bytes: workspaceResult.value.bytes,
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
        pendingChatGptReadonlyTask = null;
        if (!(await discardPreparedChatGptTask(pending.operationId))) {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        return configurationFailure("CHATGPT_TASK_PREVIEW_EXPIRED");
      }
      const snapshot = configuration.snapshot();
      if (snapshot.status !== "ready") {
        return configurationFailure("SETTINGS_UNAVAILABLE");
      }
      if (snapshot.settings.setup.chatgpt.outcomeUnknown) {
        pendingChatGptReadonlyTask = null;
        if (!(await discardPreparedChatGptTask(pending.operationId))) {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        return configurationFailure("CHATGPT_TASK_REQUIRES_REVIEW");
      }
      if (
        !isDeepStrictEqual(
          snapshot.settings.setup.chatgpt.verified,
          pending.chatGptVerification,
        )
      ) {
        pendingChatGptReadonlyTask = null;
        if (!(await discardPreparedChatGptTask(pending.operationId))) {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
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
        pendingChatGptReadonlyTask = null;
        if (!(await discardPreparedChatGptTask(pending.operationId))) {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
        }
        return configurationFailure("WORKSPACE_VERIFICATION_REQUIRED");
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
      if (chatGptTaskAdmission) {
        return configurationFailure("CHATGPT_TASK_IN_PROGRESS");
      }
      if (
        !pendingChatGptReadonlyTask ||
        pendingChatGptReadonlyTask.operationId !== command.operationId
      ) {
        return configurationFailure("CHATGPT_TASK_PREVIEW_NOT_FOUND");
      }
      pendingChatGptReadonlyTask = null;
      if (!chatGptTaskJournal) {
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
      }
      try {
        await chatGptTaskJournal.discardPrepared(command.operationId);
      } catch {
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
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
    case "computer.add-workspace": {
      const selected = await selectedWorkspace();
      if (selected === "cancelled") {
        return configurationFailure("WORKSPACE_PICKER_CANCELLED");
      }
      if (selected === "invalid") {
        return configurationFailure("WORKSPACE_SELECTION_INVALID");
      }
      return ProductConfigurationResultSchema.parse(
        await configuration.addReadonlyWorkspace(selected),
      );
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
    case "computer.update-commands":
      return ProductConfigurationResultSchema.parse(
        await configuration.updateComputerCommands(command.commands),
      );
    case "computer.verify-workspace": {
      const snapshot = configuration.snapshot();
      const workspace =
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
      // A bounded top-level listing through the descriptor-bound helper proves
      // Farol opens exactly the approved folder. It reads no file content and
      // says nothing about reading files, writing, or Git: those have their own
      // checks, and none of them needs the owner to pick a file here.
      const result = await nativeWorkspace.execute({
        workspace: workspaceDescriptor(workspace, measured),
        operation: { kind: "workspace.list", relativePath: "." },
      });
      if (!result.ok) return workspaceReadFailure(result.error.code);
      if (result.value.kind !== "workspace.entries") {
        return configurationFailure("WORKSPACE_VERIFICATION_FAILED");
      }
      // Verifying the workspace approves the linked Git metadata it has now,
      // and only that; a primary checkout needs no grant.
      const gitMetadata = await discoverLinkedGitMetadata(workspace.root);
      // The listing takes a moment, and a connector or Agent may have started
      // meanwhile; a re-verification rebinds the authority either would carry,
      // so it is admitted again right before it commits.
      const readmitted = configurationAdmission(command.kind, {
        agentActive: codexAgentOperationActive(),
        connectorRunning: secureMcpConnectorRuntime?.isRunning() === true,
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
        { rootIdentity: measured, gitMetadata },
      );
      if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
      return ProductConfigurationResultSchema.parse({
        ...recorded,
        evidence: {
          kind: "computer.workspace-list",
          workspaceId: workspace.workspaceId,
          relativePath: ".",
          entries: result.value.entries,
          truncated: result.value.truncated,
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
      const result = await nativeWorkspace.execute({
        workspace: workspaceDescriptor(
          selected.workspace,
          selected.workspace.rootIdentity,
        ),
        operation: {
          kind: "workspace.list",
          relativePath: command.relativePath,
        },
      });
      if (!result.ok) return workspaceReadFailure(result.error.code);
      if (result.value.kind !== "workspace.entries") {
        return configurationFailure("WORKSPACE_READ_FAILED");
      }
      return ProductConfigurationResultSchema.parse({
        ok: true,
        snapshot: configuration.snapshot(),
        evidence: {
          kind: "computer.workspace-list",
          workspaceId: selected.workspace.workspaceId,
          relativePath: command.relativePath,
          entries: result.value.entries,
          truncated: result.value.truncated,
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
      if (snapshot.settings.computer.commands !== "verification") {
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
      const prepared = await prepareWorkspaceEdit(nativeWorkspace, {
        operationId: randomUUID(),
        workspace: workspaceDescriptor(
          selected.workspace,
          selected.workspace.rootIdentity,
        ),
        computerGeneration: snapshot.settings.computer.generation,
        relativePath,
        expiresAt: Date.now() + 10 * 60_000,
      });
      if (!prepared.ok) return workspaceReadFailure(prepared.code);
      pendingWorkspaceEdit = prepared.pending;
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
      const action = desktopMutableWorkspaceAction(
        snapshot.settings.computer,
        workspace,
        pending.expiresAt,
        {
          mutationStateRoot: workspaceMutationStateRoot(),
          workspace: nativeWorkspace,
          now: () => Date.now(),
        },
      );
      if (!action) {
        pendingWorkspaceEdit = null;
        return configurationFailure("WORKSPACE_WRITE_APPROVAL_REQUIRED");
      }
      if (snapshot.settings.computer.pendingEdit !== null) {
        pendingWorkspaceEdit = null;
        return configurationFailure("WORKSPACE_MUTATION_RESULT_PENDING");
      }
      workspaceMutationAdmission = true;
      pendingWorkspaceEdit = null;
      try {
        // The operation ID is durable before anything executes, so a lost
        // response or a restart leaves this exact operation to observe.
        const recorded = await configuration.recordPendingWorkspaceEdit({
          operationId: pending.operationId,
          workspaceId: pending.workspaceId,
          relativePath: pending.relativePath,
          computerGeneration: pending.computerGeneration,
          submittedAt: new Date().toISOString(),
        });
        if (!recorded.ok) {
          return configurationFailure("SETTINGS_WRITE_FAILED");
        }
        const result = await applyWorkspaceEdit(
          action,
          pending,
          {
            oldText: command.oldText,
            newText: command.newText,
          },
          configuration.releaseWorkspaceEditLease.bind(configuration),
        );
        if (!result.ok) {
          if (result.error.code === "WORKSPACE_MUTATION_OUTCOME_UNKNOWN") {
            await configuration.recordComputerMutationOutcomeUnknown(
              pending.workspaceId,
            );
          }
          return workspaceMutationFailure(result.error.code);
        }
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration.snapshot(),
          evidence: {
            kind: "computer.workspace-mutation",
            operationId: result.value.operationId,
            workspaceId: result.value.workspaceId,
            relativePath: result.value.relativePath,
            operation: result.value.operation,
            bytes: result.value.receipt.bytes,
            replacements: result.value.receipt.replacements,
            beforeSha256: result.value.receipt.beforeSha256,
            afterSha256: result.value.receipt.afterSha256,
            resultRetention: result.value.resultRetention,
            redelivered: result.value.redelivered,
          },
        });
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
    case "computer.ack-workspace-edit":
      return ProductConfigurationResultSchema.parse(
        await configuration.clearPendingWorkspaceEdit(command.operationId),
      );
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
    sidebar: sidebarMode,
    overlay: shellOverlay,
  });
}

function publishShellAction(
  action:
    | "toggle-sidebar"
    | "open-quick-switcher"
    | "open-settings"
    | "sign-in-returned"
    | "close-overlay",
  source: ShellActionSource,
  authWindowGeneration: number | null = null,
): void {
  // S35-TA-16: provenance on the envelope only. Same actions, same
  // recipient, same ordering — a recipient can now tell who asked.
  window?.webContents.send(channels.shellAction, {
    action,
    eventId: randomUUID(),
    source,
    authWindowGeneration,
  });
}

function focusForLayout(): void {
  if (!window || window.isDestroyed()) return;
  if (setupOpen || shellOverlay !== "none" || section !== "browser") {
    window.webContents.focus();
    return;
  }
  const selected = taskViews.get(selectedTaskId);
  if (selected) selected.webContents.focus();
  else window.webContents.focus();
}

function focusForLayoutAfterRendererCommit(): void {
  setImmediate(focusForLayout);
}

function requestQuickSwitcher(): void {
  if (!window || setupOpen) return;
  shellOverlay = "quick-switcher";
  applyLayout();
  publishShellAction("open-quick-switcher", "quick-switcher-command");
  window.webContents.focus();
}

function requestSidebarToggle(): void {
  if (!window || setupOpen) return;
  const [width = 1] = window.getContentSize();
  if (width <= 979) {
    const opening = sidebarMode !== "overlay";
    sidebarMode = opening ? "overlay" : "rail";
    shellOverlay = opening ? "sidebar" : "none";
  } else {
    sidebarMode = sidebarMode === "full" ? "rail" : "full";
    shellOverlay = "none";
  }
  applyLayout();
  publishLayout();
  focusForLayout();
}

function requestSettings(): void {
  if (!window) return;
  publishShellAction("open-settings", "settings-command");
  window.webContents.focus();
}

function closeShellOverlay(): void {
  if (shellOverlay === "none") return;
  if (sidebarMode === "overlay") sidebarMode = "rail";
  shellOverlay = "none";
  applyLayout();
  publishShellAction("close-overlay", "overlay-dismissed");
  focusForLayout();
}

function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? ([
          {
            label: displayProductName,
            submenu: [
              { role: "about" },
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
          accelerator: "Control+Command+S",
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

function attachTaskView(taskId: string, view: WebContentsView): void {
  if (
    !window ||
    window.isDestroyed() ||
    view.webContents.isDestroyed() ||
    attachedTaskViewIds.has(taskId)
  ) {
    return;
  }
  window.contentView.addChildView(view);
  attachedTaskViewIds.add(taskId);
}

function attachTaskViews(): void {
  for (const [taskId, view] of taskViews) attachTaskView(taskId, view);
}

function detachTaskViews(): void {
  const host = window;
  if (host && !host.isDestroyed()) {
    for (const taskId of attachedTaskViewIds) {
      const view = taskViews.get(taskId);
      if (view) host.contentView.removeChildView(view);
    }
  }
  attachedTaskViewIds.clear();
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
    attachTaskView(taskId, view);
    view.webContents.on("before-input-event", (event, input) => {
      if (handleShortcut(input)) event.preventDefault();
    });
    view.webContents.once("destroyed", notifyClosed);
    return {
      kind: "embedded",
      webContents: view.webContents,
      isDestroyed: () => view.webContents.isDestroyed(),
      loadURL: (url) => view.webContents.loadURL(url),
      hide: () => view.setVisible(false),
      reveal: () => {
        attachTaskView(taskId, view);
        applyLayout();
      },
      focus: () => {
        if (view.getVisible()) view.webContents.focus();
      },
      setTitle: () => undefined,
      destroy: () => {
        if (view.webContents.isDestroyed()) {
          notifyClosed();
          return;
        }
        notifyClosing();
        disposeTaskView(taskId, view);
        notifyClosed();
      },
      onPageTitleUpdated: (listener) => {
        view.webContents.on("page-title-updated", (event) => listener(event));
      },
      onClosing: (listener) => closingListeners.add(listener),
      onClosed: (listener) => closedListeners.add(listener),
    };
  };
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
  taskViews.delete(taskId);
  taskViewKinds.delete(taskId);
  if (attachedTaskViewIds.delete(taskId) && window && !window.isDestroyed()) {
    window.contentView.removeChildView(view);
  }
  if (!view.webContents.isDestroyed()) {
    view.webContents.close({ waitForBeforeUnload: false });
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
  const key = input.key.toLowerCase();
  if (input.meta && input.key === ",") {
    requestSettings();
    return true;
  }
  if (setupOpen) return false;
  if (input.control && input.meta && key === "s") {
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
    const tasks = productTasksState().tasks;
    if (tasks.length === 0) return false;
    const index = tasks.findIndex((task) => task.taskId === selectedTaskId);
    const direction = input.shift ? -1 : 1;
    const next = (index + direction + tasks.length) % tasks.length;
    selectedTaskId = tasks[next]?.taskId ?? selectedTaskId;
    section = "browser";
    if (sidebarMode === "overlay") sidebarMode = "rail";
    shellOverlay = "none";
    applyLayout();
    publishLayout();
    if (liveTaskRoutes.has(selectedTaskId)) {
      void openLiveTaskSurface(selectedTaskId);
    } else {
      focusForLayout();
    }
    return true;
  }
  if (input.meta && /^[1-4]$/u.test(input.key)) {
    section = ["browser", "computer", "activity", "settings"][
      Number(input.key) - 1
    ] as SurfaceSection;
    if (sidebarMode === "overlay") sidebarMode = "rail";
    shellOverlay = "none";
    applyLayout();
    publishLayout();
    if (section === "browser" && liveTaskRoutes.has(selectedTaskId)) {
      void openLiveTaskSurface(selectedTaskId);
    } else {
      focusForLayout();
    }
    return true;
  }
  return false;
}

function applyLayout(): void {
  if (!window) return;
  const [width = 1, height = 1] = window.getContentSize();
  const selectedViewKind = signInSurfaceOpen
    ? "chatgpt"
    : taskViewKinds.get(selectedTaskId);
  const layout = deriveSurfaceLayout({
    width,
    height,
    sidebar: sidebarMode,
    overlay: shellOverlay,
    section,
    setupOpen,
    runtimeReady: selectedViewKind === "chatgpt" || runtimeState === "ready",
    selectedTaskPresent: signInSurfaceOpen || taskViews.has(selectedTaskId),
  });
  for (const [taskId, view] of taskViews) {
    const visible =
      layout.pageVisible &&
      taskId === (signInSurfaceOpen ? SIGN_IN_SURFACE_ID : selectedTaskId);
    view.setVisible(visible);
    view.setBounds(layout.pageBounds);
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
      attachTaskView(task.taskId, retained);
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
    attachTaskView(task.taskId, view);
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
  ipcMain.handle(channels.task, (event, value: unknown) =>
    isTrustedIpcSender(event, window)
      ? runProductTaskCommand(value)
      : taskFailure("TASKS_UNAVAILABLE"),
  );
  ipcMain.handle(channels.control, async (event, value: unknown) => {
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
    if (!isTrustedIpcSender(event, window)) return;
    const parsed = ShellLayoutSchema.safeParse(value);
    if (!parsed.success) return;
    const tasks = productTasksState().tasks;
    if (
      tasks.length === 0
        ? parsed.data.taskId !== ""
        : !tasks.some((task) => task.taskId === parsed.data.taskId)
    ) {
      return;
    }
    const focusTargetChanged =
      section !== parsed.data.section ||
      selectedTaskId !== parsed.data.taskId ||
      setupOpen !== parsed.data.setupOpen ||
      shellOverlay !== parsed.data.overlay;
    section = parsed.data.section;
    selectedTaskId = parsed.data.taskId;
    setupOpen = parsed.data.setupOpen;
    sidebarMode = parsed.data.sidebar;
    shellOverlay = parsed.data.overlay;
    applyLayout();
    if (focusTargetChanged) focusForLayoutAfterRendererCommit();
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
  window.on("close", detachTaskViews);
  window.on("closed", () => {
    stopStreams();
    attachedTaskViewIds.clear();
    window = null;
    windowPresentationReady = false;
  });
  await window.loadFile(path.join(directory, "shell.html"));
  publishWindowState();
  attachTaskViews();
  await createTaskViews();
  if (!demoMode && selectedTaskId) {
    await openLiveTaskSurface(selectedTaskId);
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

async function main(): Promise<void> {
  app.on(
    "second-instance",
    (_event, _commandLine, _workingDirectory, candidate) => {
      void handleSecondInstance(candidate);
    },
  );
  await app.whenReady();
  // N03/D2: the run marker is the first thing this generation writes and the
  // last thing it removes — only after a quit whose drain was confirmed (see
  // the quit drain's `record` below and `run-marker.ts`). A promotion that
  // finds it decides between "still running" (a live pid on this boot) and
  // "stopped without confirming its drain" (a dead pid, or another boot)
  // instead of trusting the previous quit's clean receipt after a crash. A
  // marker that cannot be written fails startup like any other state-root
  // failure would: an unmarked generation is one whose crash would go
  // unnoticed.
  await writeRunMarker(path.join(app.getPath("userData"), "farol-next-state"), {
    pid: process.pid,
    now: Date.now(),
    bootTime: currentBootTimeMs(),
    processStart: readProcessStart(process.pid),
  });
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
  await configuration.initialize();
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
    // An unexpected failure here (anything besides a reported port
    // conflict, which `start()` already turns into a status) must not
    // abort the rest of Farol's own startup. `status()` still correctly
    // reports not_running.
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
    e2eOrigin: e2eChatGptOrigin,
    parent: () => window,
    ...chatGptWindowPresentationOption(),
    ...(runtimeEnvironment === "dev"
      ? { surfaceFactory: signInChatGptSurfaceFactory() }
      : {}),
    ...(process.env.FAROL_NEXT_E2E === "1"
      ? { taskTimeoutMs: 5_000, taskPollMs: 50 }
      : {}),
    onSignInOutcome: (status, diagnostic) => {
      if (runtimeEnvironment === "dev") {
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
  });
  await initializeLiveTaskState();
  await recoverProductAgentExpiry();
  await initializeCodexContextController();
  await reconcileContextAfterRestart();
  await initializeCallerRelay();
  await initializeRouteBRuntime();
  const configured = configuration.snapshot();
  if (configured.status === "ready") {
    const initialSetup = initialSetupPresentation({
      environment: activeDesktopIdentity.environment,
      dismissed: configured.settings.setup.journey.dismissed,
      currentStep: configured.settings.setup.journey.currentStep,
      openAtLaunch: configured.settings.general.openAtLaunch,
    });
    section = initialSetup.section;
    sidebarMode = configured.settings.general.sidebarDefault;
    setupOpen = initialSetup.setupOpen;
  }
  if (startupDelayMs > 0) await delay(startupDelayMs);
  installIpc();
  installApplicationMenu();
  await startRuntime();
  await ensureWindow();
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
      const closers: OwnedCloser[] = [];
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
        closers.push({ name: "connector", close: () => connector.stop() });
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
      disposeChatGptRoutes();
      disposeTaskViews("runtime");
      stopRuntime();
      return closers;
    },
  });
  app.on("before-quit", (event) => {
    quitInProgress = true;
    quitDrain.onBeforeQuit(event);
  });
  app.on("window-all-closed", () => {
    if (windowAllClosedAction(process.platform) === "quit") app.quit();
  });
}

if (!app.requestSingleInstanceLock(instanceRequest)) {
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
          "Farol Next refused the second launch because the running build could not be verified as this exact candidate.\n",
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
  const initialization = main();
  const readiness = initialization.then(() => {
    if (!isPrimaryReady()) throw new Error("PRIMARY_STARTUP_INCOMPLETE");
  });
  primaryStartup.begin(readiness);
  void initialization
    .then(() => {
      process.stderr.write(
        `${secondInstanceResultPrefix}${isPrimaryReady() ? "primary-started" : "reopen-failed"}\n`,
      );
    })
    .catch((error: unknown) => {
      terminateDesktopStartup(error, runtimeEnvironment, {
        write: (message) => process.stderr.write(message),
        exit: (code) => app.exit(code),
      });
    });
}
