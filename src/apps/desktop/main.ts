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
  type UtilityProcess,
} from "electron";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ClientEventSchema } from "../../modules/chat/contract/client-event";
import { channels } from "../../pkg/ipc/channels";
import type { RuntimeStatus } from "../../pkg/ipc/runtime-status";
import type { TaskSurfaceStatus } from "../../pkg/ipc/task-surface-status";
import {
  ProductConfigurationCommandSchema,
  ProductConfigurationResultSchema,
  type ProductConfigurationResult,
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
const windowOpenCoordinator = new WindowOpenCoordinator();
const taskViews = new Map<string, WebContentsView>();
const streamControllers = new Map<string, AbortController>();
const taskSurfaceFailures = new Map<string, string>();
const pendingComputer = new Map<
  string,
  Extract<z.infer<typeof ClientEventSchema>, { kind: "computer.requested" }>
>();

function runtimeBase(): string | null {
  return runtime ? `http://127.0.0.1:${runtime.port}` : null;
}

function bootstrap() {
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
    tasks: (runtime?.tasks ?? expectedTasks).map(
      ({ ownerId: _ownerId, generation: _generation, ...task }) => {
        const { readToken: _readToken, ...safeTask } = task as typeof task & {
          readToken?: string;
        };
        return safeTask;
      },
    ),
    partition: "persist:farol-next-preview",
    updateChannel: buildIdentity.updateChannel,
    nativeFilesystem: false,
    nativeAgent: false,
    liveProvider: false,
    windowState: currentWindowState(),
  };
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

async function configureProduct(
  value: unknown,
): Promise<ProductConfigurationResult> {
  if (!configuration) return configurationFailure("SETTINGS_UNAVAILABLE");
  const parsed = ProductConfigurationCommandSchema.safeParse(value);
  if (!parsed.success) return configurationFailure("SETTINGS_INPUT_INVALID");
  const command = parsed.data;
  switch (command.kind) {
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
    case "computer.verify-workspace": {
      const snapshot = configuration.snapshot();
      const workspace =
        snapshot.status === "ready"
          ? snapshot.settings.computer.workspaces.find(
              (candidate) => candidate.workspaceId === command.workspaceId,
            )
          : undefined;
      if (!workspace) return configurationFailure("WORKSPACE_NOT_FOUND");
      const result = await nativeWorkspace.execute({
        workspace: {
          workspaceId: workspace.workspaceId,
          root: workspace.root,
          deniedPaths: workspace.excludedPaths.flatMap((excluded) => {
            const prefix = workspace.root === "/" ? "/" : `${workspace.root}/`;
            return excluded.startsWith(prefix)
              ? [excluded.slice(prefix.length)]
              : [];
          }),
        },
        operation: { kind: "workspace.list", relativePath: "." },
      });
      if (!result.ok || result.value.kind !== "workspace.entries") {
        return configurationFailure("WORKSPACE_VERIFICATION_FAILED");
      }
      return ProductConfigurationResultSchema.parse(
        await configuration.recordComputerVerification(workspace.workspaceId, {
          profile: "computer.local.readonly/1",
          runtimeGeneration: `${runtime?.identity ?? "runtime-offline"}:${buildIdentity.buildId}`,
          buildId: buildIdentity.buildId,
          protocol: "readonly-workspace/1",
        }),
      );
    }
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
  publishShellAction("toggle-sidebar");
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

function disposeTaskView(taskId: string, view: WebContentsView): void {
  taskViews.delete(taskId);
  if (window && !window.isDestroyed()) {
    window.contentView.removeChildView(view);
  }
  if (!view.webContents.isDestroyed()) {
    view.webContents.close({ waitForBeforeUnload: false });
  }
}

function disposeTaskViews(): void {
  for (const [taskId, view] of [...taskViews]) {
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
  disposeTaskViews();
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
    const tasks = runtime?.tasks ?? expectedTasks;
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
    focusForLayout();
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
    focusForLayout();
    return true;
  }
  return false;
}

function applyLayout(): void {
  if (!window) return;
  const [width = 1, height = 1] = window.getContentSize();
  const layout = deriveSurfaceLayout({
    width,
    height,
    sidebar: sidebarMode,
    overlay: shellOverlay,
    section,
    setupOpen,
    runtimeReady: runtimeState === "ready",
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
    window.contentView.addChildView(view);
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
    if (
      !parsed.success ||
      (expectedTasks.length === 0
        ? parsed.data.taskId !== ""
        : !expectedTasks.some((task) => task.taskId === parsed.data.taskId))
    )
      return;
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
  window.on("focus", publishWindowState);
  window.on("blur", publishWindowState);
  window.on("enter-full-screen", () => {
    applyLayout();
    publishWindowState();
  });
  window.on("leave-full-screen", () => {
    applyLayout();
    publishWindowState();
  });
  window.on("closed", () => {
    stopStreams();
    disposeTaskViews();
    taskViews.clear();
    window = null;
  });
  await window.loadFile(path.join(directory, "shell.html"));
  publishWindowState();
  await createTaskViews();
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
  disposeTaskViews();
  taskViews.clear();
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
    taskViewCount: taskViews.size,
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

async function main(): Promise<void> {
  app.on(
    "second-instance",
    (_event, _commandLine, _workingDirectory, candidate) => {
      void handleSecondInstance(candidate);
    },
  );
  await app.whenReady();
  configuration = new ProductConfigurationService(
    new ProductSettingsStore({
      root: path.join(app.getPath("userData"), "farol-next-state"),
    }),
  );
  await configuration.initialize();
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
  app.on("before-quit", stopRuntime);
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
