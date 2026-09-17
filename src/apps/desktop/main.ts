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
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ClientEventSchema } from "../../modules/chat/contract/client-event";
import {
  ProductTaskCommandResultSchema,
  ProductTaskCommandSchema,
  ProductTasksStateSchema,
  type ProductTask,
  type ProductTaskCommandResult,
} from "../../modules/chat/contract/product-task";
import { LiveTaskRegistry } from "./live-task-registry";
import { channels } from "../../pkg/ipc/channels";
import type { RuntimeStatus } from "../../pkg/ipc/runtime-status";
import type { TaskSurfaceStatus } from "../../pkg/ipc/task-surface-status";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationResultSchema,
  type ApprovedProductWorkspace,
  type ProductConfigurationResult,
  type ProductSettings,
} from "../../pkg/product-settings/contract";
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
  createInstanceRequest,
  decideSecondInstance,
  readBuildLaunchIdentity,
  sameLaunchIdentity,
  waitForInstanceAcknowledgement,
  writeInstanceAcknowledgement,
} from "./single-instance";
import {
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
import {
  CHATGPT_HOME,
  CHATGPT_PARTITION,
  canonicalChatGptConversationUrl,
} from "./chatgpt-page-policy";
import {
  MAX_CHATGPT_CONTEXT_CHARACTERS,
  buildChatGptAttachmentTaskPrompt,
  buildChatGptReadonlyTaskPrompt,
} from "./chatgpt-readonly-task";
import {
  ChatGptRoute,
  type ChatGptRouteSurface,
  type ChatGptRouteSurfaceFactory,
} from "./chatgpt-route";
import {
  PrivateLiveTaskStore,
  type LiveTaskStoreRecord,
  type StoredLiveTask,
} from "./live-task-store";
import { RunMutableComputerAction } from "../../modules/computer/app/service/run-mutable-computer-action";
import { RunReadonlyComputerAction } from "../../modules/computer/app/service/run-readonly-computer-action";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type AuthorityCapability,
  type ComputerApproval,
  type TaskAdmission,
} from "../../modules/computer/domain/execution-authority";
import { Sha256WorkspaceMutationDigester } from "../../modules/computer/infra/native/sha256-workspace-mutation-digester";
import { InMemoryAuthorityRepository } from "../../modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../modules/computer/infra/repo/in-memory-computer-approvals";
import { PrivateWorkspaceMutationStore } from "../../modules/computer/infra/repo/private-workspace-mutation-store";
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
import { launchCodexAppServer } from "./codex-app-server-process";
import { runCodexHostSmoke } from "./codex-host-smoke";
import { runCodexNativeAgentCheck } from "./codex-native-agent-check";
import { CodexAgentWorkspaceProbe } from "./codex-agent-workspace-probe";
import { CodexNativeAgentHost } from "../../modules/agent/infra/native/codex-native-agent-host";
import { PrivateAssignmentStore } from "../../modules/agent/infra/repo/private-assignment-store";

const directory = __dirname;
const buildIdentity = readRuntimeBuildIdentity(directory);
const productName = buildIdentity.product;
const bundleId = buildIdentity.bundleId;
const launchIdentity = readBuildLaunchIdentity(directory);
const nativeWorkspace = new NativeReadonlyWorkspace({
  helperPath: path.join(directory, "computer-safe-open.py"),
  helper: NEXT_SAFE_OPEN_HELPER,
});
const instanceRequest = createInstanceRequest(launchIdentity);
const secondInstanceResultPrefix = "FAROL_NEXT_SECOND_INSTANCE_RESULT:";
const primaryStartup = new PrimaryStartup();
const startupDelayMs = previewStartupDelay(
  process.argv,
  process.env.FAROL_NEXT_E2E === "1",
);
const demoMode = process.argv.includes("--demo");
const windowMode = parsePreviewWindowMode(process.argv);
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
  identity: z.literal("farol-next-preview-runtime"),
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
  action: z.enum(["release-tool", "finish-demo"]),
});

type RuntimeReady = z.infer<typeof readySchema>;
app.setName(productName);
if (process.platform === "win32") app.setAppUserModelId(bundleId);

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
let chatGptRoute: ChatGptRoute | null = null;
const liveTaskRegistry = new LiveTaskRegistry(5);
const liveTaskRoutes = new Map<string, ChatGptRoute>();
const liveTaskConversationUrls = new Map<string, string | null>();
let liveTaskStore: PrivateLiveTaskStore | null = null;
let liveTaskPersistence: Promise<void> = Promise.resolve();
let taskMutationInFlight = false;
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
type PendingWorkspaceEdit = Readonly<{
  operationId: string;
  workspaceId: string;
  computerGeneration: number;
  relativePath: string;
  bytes: number;
  beforeSha256: string;
  expiresAt: number;
}>;
let pendingWorkspaceEdit: PendingWorkspaceEdit | null = null;
let workspaceMutationAdmission = false;
let codexHostTaskAdmission = false;
const agentCheckConfigurationMutations = new Set<string>([
  "computer.rename",
  "computer.add-workspace",
  "computer.remove-workspace",
  "computer.update-exclusions",
  "computer.update-access",
  "computer.update-commands",
  "computer.verify-workspace",
]);
type ActiveCodexAgentCheck = Readonly<{
  key: string;
  client: Awaited<ReturnType<typeof launchCodexAppServer>>;
  host: CodexNativeAgentHost;
  boundedRunningObserved: boolean;
}>;
let activeCodexAgentCheck: ActiveCodexAgentCheck | null = null;

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

function workspaceEditPreview(
  pending: PendingWorkspaceEdit,
): Readonly<Record<string, unknown>> {
  return {
    kind: "computer.workspace-edit-preview",
    operationId: pending.operationId,
    workspaceId: pending.workspaceId,
    relativePath: pending.relativePath,
    bytes: pending.bytes,
    beforeSha256: pending.beforeSha256,
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
}

function mutableWorkspaceAction(
  settings: ProductSettings,
  workspace: ApprovedProductWorkspace,
  expiresAt: number,
): RunMutableComputerAction | null {
  const ownerId = "owner-desktop";
  const sessionId = "desktop-computer-session";
  const taskId = "desktop-computer-task";
  const participantId = "desktop-main";
  const approvalCapabilities: AuthorityCapability[] = [
    "workspace.list",
    "workspace.read",
    "workspace.search",
    ...(settings.computer.workspaces.some(
      (candidate) => candidate.access === "write",
    )
      ? (["workspace.write"] as const)
      : []),
  ];
  const approval: ComputerApproval = {
    ownerId,
    computerId: settings.computer.computerId,
    generation: settings.computer.generation,
    workspaces: settings.computer.workspaces.map((candidate) => ({
      workspaceId: candidate.workspaceId,
      root: candidate.root,
      access: candidate.access,
    })),
    excludedPaths: settings.computer.workspaces.flatMap((candidate) =>
      candidate.excludedPaths.map((excluded) => ({
        workspaceId: candidate.workspaceId,
        path: excluded,
      })),
    ),
    capabilities: approvalCapabilities,
    network: "none",
    commands: "none",
    expiresAt,
  };
  const admission: TaskAdmission = {
    authorityId: `desktop-authority-${settings.computer.generation}`,
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
        access: "write",
      },
    ],
    excludedPaths: workspace.excludedPaths.map((excluded) => ({
      workspaceId: workspace.workspaceId,
      path: excluded,
    })),
    capabilities: ["workspace.read", "workspace.write"],
    network: "none",
    commands: "none",
    expiresAt,
  };
  const grant = deriveTaskGrant(approval, admission, Date.now());
  if (!grant.ok) return null;
  const participant = createParticipantAuthority(grant.value, {
    participantId,
    role: "main",
    mutationOwnership: "task",
  });
  if (!participant.ok) return null;
  return new RunMutableComputerAction(
    new InMemoryAuthorityRepository([participant.value]),
    new InMemoryComputerApprovalRepository([approval]),
    new PrivateWorkspaceMutationStore({
      root: path.join(
        app.getPath("userData"),
        "farol-next-state",
        "workspace-mutations",
      ),
    }),
    new Sha256WorkspaceMutationDigester(),
    nativeWorkspace,
    { now: () => Date.now() },
  );
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
  const approval: ComputerApproval = {
    ownerId,
    computerId: settings.computer.computerId,
    generation: settings.computer.generation,
    workspaces: settings.computer.workspaces.map((candidate) => ({
      workspaceId: candidate.workspaceId,
      root: candidate.root,
      access: candidate.access,
    })),
    excludedPaths: settings.computer.workspaces.flatMap((candidate) =>
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
    partition: "persist:farol-next-preview",
    chatgptPartition: CHATGPT_PARTITION,
    chatgptRecoveryPending: recoverableChatGptTask !== null,
    chatgptConversationState: chatGptConversationState(),
    updateChannel: buildIdentity.updateChannel,
    nativeFilesystem: true,
    nativeAgent: false,
    liveProvider: false,
    windowState: currentWindowState(),
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

function setLiveTaskLifecycle(
  taskId: string,
  lifecycle: ProductTask["lifecycle"],
): void {
  if (liveTaskRegistry.get(taskId)?.lifecycle === lifecycle) return;
  if (!liveTaskRegistry.setLifecycle(taskId, lifecycle)) return;
  publishTasksState();
  void persistLiveTaskState().catch(() => undefined);
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

function createLiveChatGptRoute(
  taskId: string,
  label: string,
  initialUrl = chatGptHomeUrl,
): ChatGptRoute {
  let routeInitialUrl = initialUrl;
  if (chatGptE2eOrigin !== null && initialUrl === chatGptHomeUrl) {
    const fixtureUrl = new URL(initialUrl);
    fixtureUrl.searchParams.set("farol-e2e-task", taskId);
    routeInitialUrl = fixtureUrl.href;
  }
  const recordConversationUrl = (conversationUrl: string | null) => {
    if (!liveTaskRegistry.get(taskId)) return;
    if (liveTaskConversationUrls.get(taskId) === conversationUrl) return;
    liveTaskConversationUrls.set(taskId, conversationUrl);
    void persistLiveTaskState().catch(() => undefined);
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
  return new ChatGptRoute({
    homeUrl: chatGptHomeUrl,
    initialUrl: routeInitialUrl,
    e2eOrigin: chatGptE2eOrigin,
    parent: () => window,
    surfaceFactory: liveChatGptSurfaceFactory(taskId),
    title: `${label} · Farol Next`,
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

async function initializeLiveTaskState(): Promise<void> {
  const store = new PrivateLiveTaskStore({ root: liveTaskStoreRoot() });
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

async function runProductTaskCommand(
  value: unknown,
): Promise<ProductTaskCommandResult> {
  const command = ProductTaskCommandSchema.safeParse(value);
  if (!command.success) return taskFailure("TASK_COMMAND_INVALID");
  if (demoMode) {
    return taskFailure("TASKS_UNAVAILABLE");
  }
  if (taskMutationInFlight) return taskFailure("TASK_OPERATION_IN_PROGRESS");
  if (command.data.kind === "task.activate") {
    taskMutationInFlight = true;
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
      taskMutationInFlight = false;
    }
  }
  if (!liveTaskStore) return taskFailure("TASK_STATE_UNAVAILABLE");
  taskMutationInFlight = true;
  const before = liveTaskRegistry.snapshot();
  try {
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
        ?.setTitle(`${command.data.label.trim()} · Farol Next`);
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
      const removed = liveTaskRegistry.remove(command.data.taskId);
      if (!removed) return taskFailure("TASK_NOT_FOUND");
      try {
        await persistLiveTaskState();
      } catch {
        liveTaskRegistry.rollback(before);
        return taskFailure("TASK_STATE_UNAVAILABLE");
      }
      const route = liveTaskRoutes.get(command.data.taskId);
      liveTaskRoutes.delete(command.data.taskId);
      liveTaskConversationUrls.delete(command.data.taskId);
      route?.dispose();
      const tasks = liveTaskRegistry.snapshot().tasks;
      selectedTaskId =
        selectedTaskId === command.data.taskId
          ? (tasks[0]?.taskId ?? "")
          : selectedTaskId;
      publishTasksState();
      applyLayout();
      publishLayout();
      return taskSuccess(selectedTaskId || null);
    }
    if (command.data.kind === "task.cancel") {
      const task = liveTaskRegistry.get(command.data.taskId);
      if (!task) return taskFailure("TASK_NOT_FOUND");
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
    const admitted = liveTaskRegistry.admit(task);
    if (admitted.status === "capacity") {
      return taskFailure("TASK_CAPACITY_REACHED");
    }
    if (admitted.status !== "admitted") {
      return taskFailure("TASK_ROUTE_UNAVAILABLE");
    }
    const route = createLiveChatGptRoute(task.taskId, task.label);
    liveTaskConversationUrls.set(task.taskId, null);
    try {
      await persistLiveTaskState();
    } catch {
      liveTaskRegistry.rollback(before);
      liveTaskConversationUrls.delete(task.taskId);
      route.dispose();
      return taskFailure("TASK_STATE_UNAVAILABLE");
    }
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
    taskMutationInFlight = false;
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
    title: "Export content-free Farol Next support report",
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
      runtimeGeneration: `${CHATGPT_PARTITION}:${buildIdentity.buildId}`,
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

async function selectedWorkspace(): Promise<
  Readonly<{ root: string; label: string }> | "cancelled" | "invalid"
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
    return { root, label: path.basename(root) || root };
  } catch {
    return "invalid";
  }
}

async function selectedCodexExecutable(): Promise<
  string | "cancelled" | "invalid"
> {
  let selected: string | undefined;
  const testExecutable =
    process.env.FAROL_NEXT_E2E === "1"
      ? process.env.FAROL_NEXT_E2E_CODEX_EXECUTABLE
      : undefined;
  if (testExecutable) {
    selected = testExecutable;
  } else {
    if (!window) return "invalid";
    const result = await dialog.showOpenDialog(window, {
      title: "Choose the Codex executable",
      buttonLabel: "Verify Codex",
      properties: ["openFile"],
      securityScopedBookmarks: false,
    });
    if (result.canceled || result.filePaths.length !== 1) return "cancelled";
    selected = result.filePaths[0];
  }
  return selected && path.isAbsolute(selected) && !selected.includes("\0")
    ? selected
    : "invalid";
}

async function verifyCodexExecutable(
  executablePath: string,
): Promise<ProductConfigurationResult> {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  try {
    const probe = await probeCodexHost({
      executablePath,
      scratchRoot: codexHostProbeRoot(),
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

function workspaceDeniedPaths(
  workspace: ApprovedProductWorkspace,
): readonly string[] {
  const prefix = workspace.root === "/" ? "/" : `${workspace.root}/`;
  return workspace.excludedPaths.flatMap((excluded) =>
    excluded.startsWith(prefix) ? [excluded.slice(prefix.length)] : [],
  );
}

function verifiedProductWorkspace(
  workspaceId: string,
):
  | Readonly<{ status: "verified"; workspace: ApprovedProductWorkspace }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "not_verified" }> {
  const snapshot = configuration?.snapshot();
  if (!snapshot || snapshot.status !== "ready") return { status: "not_found" };
  const workspace = snapshot.settings.computer.workspaces.find(
    (candidate) => candidate.workspaceId === workspaceId,
  );
  if (!workspace) return { status: "not_found" };
  const verification = snapshot.settings.setup.computer.verified;
  if (
    verification?.workspaceId !== workspace.workspaceId ||
    verification.configRevision !== snapshot.settings.computer.generation
  ) {
    return { status: "not_verified" };
  }
  return { status: "verified", workspace };
}

async function selectedWorkspaceFile(
  workspace: ApprovedProductWorkspace,
  labels: Readonly<{ title: string; buttonLabel: string }> = {
    title: "Choose a harmless text file to verify",
    buttonLabel: "Verify Read Access",
  },
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
    case "WORKSPACE_COMMAND_TIMEOUT":
      return configurationFailure("WORKSPACE_COMMAND_TIMEOUT");
    case "WORKSPACE_COMMAND_OUTPUT_TOO_LARGE":
      return configurationFailure("WORKSPACE_COMMAND_OUTPUT_TOO_LARGE");
    default:
      return configurationFailure("WORKSPACE_COMMAND_FAILED");
  }
}

function workspaceMutationFailure(code: string): ProductConfigurationResult {
  switch (code) {
    case "WORKSPACE_PATH_REFUSED":
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
  if (
    activeCodexAgentCheck &&
    agentCheckConfigurationMutations.has(command.kind)
  ) {
    return configurationFailure("CODEX_HOST_TASK_IN_PROGRESS");
  }
  switch (command.kind) {
    case "host.select-codex": {
      if (activeCodexAgentCheck) {
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
    case "host.verify-codex": {
      if (activeCodexAgentCheck) {
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
    case "host.run-codex-smoke": {
      if (codexHostTaskAdmission || activeCodexAgentCheck) {
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
        const configuredCodexHome = process.env.CODEX_HOME;
        client = await launchCodexAppServer({
          executablePath: selected.executablePath,
          cwd: runtimeRoot,
          homePath: app.getPath("home"),
          tempPath: app.getPath("temp"),
          clientVersion: buildIdentity.version,
          ...(configuredCodexHome &&
          path.isAbsolute(configuredCodexHome) &&
          !configuredCodexHome.includes("\0")
            ? { codexHomePath: configuredCodexHome }
            : {}),
        });
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
        codexHostTaskAdmission = false;
      }
    }
    case "host.run-codex-agent-check": {
      if (codexHostTaskAdmission) {
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
        workspace?.access !== "read"
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

      codexHostTaskAdmission = true;
      let session = activeCodexAgentCheck;
      let closeSession = false;
      try {
        let settings = snapshot.settings;
        if (!session) {
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
          if (recordedContract.snapshot.status !== "ready") {
            return configurationFailure("SETTINGS_UNAVAILABLE");
          }
          settings = recordedContract.snapshot.settings;
          const runtimeRoot = await codexHostRuntimeRoot();
          const configuredCodexHome = process.env.CODEX_HOME;
          const client = await launchCodexAppServer({
            executablePath: selected.executablePath,
            cwd: runtimeRoot,
            homePath: app.getPath("home"),
            tempPath: app.getPath("temp"),
            clientVersion: buildIdentity.version,
            ...(configuredCodexHome &&
            path.isAbsolute(configuredCodexHome) &&
            !configuredCodexHome.includes("\0")
              ? { codexHomePath: configuredCodexHome }
              : {}),
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
          session = {
            key: checkKey,
            client,
            host,
            boundedRunningObserved: false,
          };
          activeCodexAgentCheck = session;
        }

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
      }
    }
    case "host.remove-codex":
      if (activeCodexAgentCheck) {
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
              nativeAgent: false,
              liveProvider: false,
            },
            tasks: {
              total: tasks.length,
              running: streamControllers.size,
              waiting: pendingComputer.size,
              failed: taskSurfaceFailures.size,
            },
          }),
        );
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration.snapshot(),
          evidence: { kind: "support.exported", ...receipt },
        });
      } catch {
        return configurationFailure("SUPPORT_EXPORT_FAILED");
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
      let opened: Awaited<ReturnType<ChatGptRoute["open"]>>;
      try {
        opened = await chatGptRoute.open();
      } catch {
        opened = { status: "unreachable" };
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
              runtimeGeneration: `${CHATGPT_PARTITION}:${buildIdentity.buildId}`,
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
        await chatGptTaskJournal.prepare({
          operationId,
          kind: "attachment",
        });
      } catch {
        await discardChatGptAttachments(
          chatGptAttachmentStagingRoot(),
          operationId,
        ).catch(() => {
          attachmentStagingReady = false;
        });
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
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
        await chatGptTaskJournal.markDispatchIntent(pending.operationId);
      } catch {
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
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
              runtimeGeneration: `${CHATGPT_PARTITION}:${buildIdentity.buildId}`,
              buildId: buildIdentity.buildId,
              protocol: "chatgpt-page-attachment-task/1",
            }
          : task.state === "not_authenticated"
            ? { state: "signed_out" as const }
            : task.state === "outcome_unknown"
              ? { state: "outcome_unknown" as const }
              : task.code === "CHATGPT_PAGE_UNREACHABLE"
                ? { state: "unreachable" as const }
                : { state: "unsupported" as const };
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
          workspace: {
            workspaceId: workspace.workspaceId,
            root: workspace.root,
            deniedPaths: workspaceDeniedPaths(workspace),
          },
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
          await chatGptTaskJournal.prepare({
            operationId,
            kind: "readonly",
          });
        } catch {
          return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
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
        await chatGptTaskJournal.markDispatchIntent(pending.operationId);
      } catch {
        return configurationFailure("CHATGPT_TASK_JOURNAL_FAILED");
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
              runtimeGeneration: `${CHATGPT_PARTITION}:${buildIdentity.buildId}`,
              buildId: buildIdentity.buildId,
              protocol: "chatgpt-page-readonly-task/1",
            }
          : task.state === "not_authenticated"
            ? { state: "signed_out" as const }
            : task.state === "outcome_unknown"
              ? { state: "outcome_unknown" as const }
              : task.code === "CHATGPT_PAGE_UNREACHABLE"
                ? { state: "unreachable" as const }
                : { state: "unsupported" as const };
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
      const relativePath = await selectedWorkspaceFile(workspace);
      if (relativePath === "cancelled") {
        return configurationFailure("WORKSPACE_FILE_PICKER_CANCELLED");
      }
      if (relativePath === "invalid") {
        return configurationFailure("WORKSPACE_FILE_SELECTION_INVALID");
      }
      const result = await nativeWorkspace.execute({
        workspace: {
          workspaceId: workspace.workspaceId,
          root: workspace.root,
          deniedPaths: workspaceDeniedPaths(workspace),
        },
        operation: { kind: "workspace.read", relativePath },
      });
      if (!result.ok) return workspaceReadFailure(result.error.code);
      if (result.value.kind !== "workspace.text") {
        return configurationFailure("WORKSPACE_VERIFICATION_FAILED");
      }
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
      );
      if (!recorded.ok) return ProductConfigurationResultSchema.parse(recorded);
      const text = result.value.text.slice(0, 32_768);
      return ProductConfigurationResultSchema.parse({
        ...recorded,
        evidence: {
          kind: "computer.workspace-read",
          workspaceId: workspace.workspaceId,
          relativePath,
          bytes: result.value.bytes,
          text,
          truncated: text.length < result.value.text.length,
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
        workspace: {
          workspaceId: selected.workspace.workspaceId,
          root: selected.workspace.root,
          deniedPaths: workspaceDeniedPaths(selected.workspace),
        },
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
        workspace: {
          workspaceId: selected.workspace.workspaceId,
          root: selected.workspace.root,
          deniedPaths: workspaceDeniedPaths(selected.workspace),
        },
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
    case "computer.run-git-status": {
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
          command: "git.status",
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
      const read = await nativeWorkspace.execute({
        workspace: {
          workspaceId: selected.workspace.workspaceId,
          root: selected.workspace.root,
          deniedPaths: workspaceDeniedPaths(selected.workspace),
        },
        operation: { kind: "workspace.read", relativePath },
      });
      if (!read.ok) return workspaceReadFailure(read.error.code);
      if (read.value.kind !== "workspace.text") {
        return configurationFailure("WORKSPACE_READ_FAILED");
      }
      pendingWorkspaceEdit = {
        operationId: randomUUID(),
        workspaceId: selected.workspace.workspaceId,
        computerGeneration: snapshot.settings.computer.generation,
        relativePath,
        bytes: read.value.bytes,
        beforeSha256: createHash("sha256")
          .update(read.value.text, "utf8")
          .digest("hex"),
        expiresAt: Date.now() + 10 * 60_000,
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
      const action = mutableWorkspaceAction(
        snapshot.settings,
        workspace,
        pending.expiresAt,
      );
      if (!action) {
        pendingWorkspaceEdit = null;
        return configurationFailure("WORKSPACE_WRITE_APPROVAL_REQUIRED");
      }
      workspaceMutationAdmission = true;
      pendingWorkspaceEdit = null;
      try {
        const result = await action.execute({
          operationId: pending.operationId,
          ownerId: "owner-desktop",
          sessionId: "desktop-computer-session",
          taskId: "desktop-computer-task",
          taskEpoch: pending.computerGeneration,
          participantId: "desktop-main",
          turnId: pending.operationId,
          generation: pending.computerGeneration,
          callId: pending.operationId,
          workspaceId: pending.workspaceId,
          operation: {
            kind: "workspace.edit",
            relativePath: pending.relativePath,
            edits: [{ oldText: command.oldText, newText: command.newText }],
            expectedSha256: pending.beforeSha256,
          },
        });
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
    | "close-overlay",
): void {
  window?.webContents.send(channels.shellAction, { action });
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
  publishShellAction("open-quick-switcher");
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
  publishShellAction("open-settings");
  window.webContents.focus();
}

function closeShellOverlay(): void {
  if (shellOverlay === "none") return;
  if (sidebarMode === "overlay") sidebarMode = "rail";
  shellOverlay = "none";
  applyLayout();
  publishShellAction("close-overlay");
  focusForLayout();
}

function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? ([
          {
            label: productName,
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
    serviceName: "Farol Next Runtime",
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
  return "persist:farol-next-preview";
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
  const selectedViewKind = taskViewKinds.get(selectedTaskId);
  const layout = deriveSurfaceLayout({
    width,
    height,
    sidebar: sidebarMode,
    overlay: shellOverlay,
    section,
    setupOpen,
    runtimeReady: selectedViewKind === "chatgpt" || runtimeState === "ready",
    selectedTaskPresent: taskViews.has(selectedTaskId),
  });
  for (const [taskId, view] of taskViews) {
    const visible = layout.pageVisible && taskId === selectedTaskId;
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

function installIpc(): void {
  ipcMain.handle(channels.bootstrap, (event) =>
    event.sender === window?.webContents
      ? bootstrap()
      : { error: "IPC_SENDER_DENIED" },
  );
  ipcMain.handle(channels.snapshot, (event) =>
    event.sender === window?.webContents
      ? runtimeJson("/snapshot")
      : { error: "IPC_SENDER_DENIED" },
  );
  ipcMain.handle(channels.configuration, (event, value: unknown) =>
    event.sender === window?.webContents
      ? configureProduct(value)
      : configurationFailure("SETTINGS_UNAVAILABLE"),
  );
  ipcMain.handle(channels.task, (event, value: unknown) =>
    event.sender === window?.webContents
      ? runProductTaskCommand(value)
      : taskFailure("TASKS_UNAVAILABLE"),
  );
  ipcMain.handle(channels.control, async (event, value: unknown) => {
    if (event.sender !== window?.webContents)
      return { error: "IPC_SENDER_DENIED" };
    const parsed = controlSchema.safeParse(value);
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
    if (event.sender !== window?.webContents) return;
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
        )
      : null;
  window = new BrowserWindow({
    title: productName,
    width: initialWindowSize.width,
    height: initialWindowSize.height,
    ...(testPlacement?.bounds ?? {}),
    minWidth: Math.min(640, testPlacement?.bounds.width ?? 640),
    minHeight: Math.min(520, testPlacement?.bounds.height ?? 520),
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
  revealWindow();
}

function revealWindow(): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  const action = presentationAction(windowMode);
  if (action === "show-inactive") window.showInactive();
  else if (action === "show-and-focus") window.show();
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

function isPrimaryReady(): boolean {
  return primaryStartupReady({
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
  if (status === "reopened") {
    try {
      await primaryStartup.whenReady();
      const outcome = await containWindowOpenFailure(
        ensureWindow,
        recoverWindowOpenFailure,
      );
      if (outcome === "failed" || !isPrimaryReady()) {
        status = "reopen-failed";
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
  } catch {
    // The secondary process fails closed if this bounded acknowledgement is
    // unavailable. Never reopen a mismatched build merely to make it exit 0.
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
  const routes = new Set(liveTaskRoutes.values());
  if (chatGptRoute) routes.add(chatGptRoute);
  for (const route of routes) route.dispose();
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
  try {
    await cleanupChatGptAttachmentStaging(chatGptAttachmentStagingRoot());
  } catch {
    attachmentStagingReady = false;
  }
  configuration = new ProductConfigurationService(
    new ProductSettingsStore({
      root: path.join(app.getPath("userData"), "farol-next-state"),
    }),
  );
  await configuration.initialize();
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
  chatGptRoute = new ChatGptRoute({
    homeUrl: chatGptUrl,
    initialUrl: chatGptInitialUrl,
    e2eOrigin: e2eChatGptOrigin,
    parent: () => window,
    ...(process.env.FAROL_NEXT_E2E === "1"
      ? { taskTimeoutMs: 5_000, taskPollMs: 50 }
      : {}),
  });
  await initializeLiveTaskState();
  const configured = configuration.snapshot();
  if (configured.status === "ready") {
    section = configured.settings.general.openAtLaunch;
    sidebarMode = configured.settings.general.sidebarDefault;
    setupOpen = !configured.settings.setup.journey.dismissed;
  }
  if (startupDelayMs > 0) await delay(startupDelayMs);
  installIpc();
  installApplicationMenu();
  await startRuntime();
  await ensureWindow();
  app.on("activate", reopenWindow);
  app.on("before-quit", () => {
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
    if (agentCheck) void agentCheck.client.close().catch(() => undefined);
    disposeChatGptRoutes();
    disposeTaskViews("runtime");
    stopRuntime();
  });
  app.on("window-all-closed", () => {
    if (windowAllClosedAction(process.platform) === "quit") app.quit();
  });
}

if (!app.requestSingleInstanceLock(instanceRequest)) {
  void waitForInstanceAcknowledgement(app.getPath("userData"), instanceRequest)
    .then((acknowledgement) => {
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
    .catch(() => app.exit(1));
}
