import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Rectangle,
} from "electron";
import { z } from "zod";
import { isTrustedIpcSender } from "../../../src/apps/desktop/ipc-sender";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import { channels } from "../../../src/pkg/ipc/channels";
import {
  parseNavigationShortcuts,
  type NavigationShortcuts,
} from "../../../src/pkg/ipc/navigation-shortcuts";
import type {
  ShellOverlay,
  SurfaceSection,
} from "../../../src/pkg/ipc/shell-state";
import type { DesktopAdmission } from "../host/admission";
import type { readChatHistoryView } from "../chat-history-view";
import type { DesktopGoCore } from "../go-core-host";
import type { OperationsStore } from "../operations/store";
import { updatesChannels } from "../renderer/updates/contract";
import type { readRetiredRepliesView } from "../retired-replies-view";
import type { runSelfTestCommand } from "../self-test-ipc";
import type {
  DesktopUpdatesPanel,
  UPDATES_PANEL_SIZE as UpdatesPanelSize,
} from "../updates-panel";

// The renderer-to-main IPC table: every channel the one trusted main window may
// speak on, in the order main registered them, each with the sender check it
// always had. Main keeps every owner and variable; each `let` there is a late
// getter or a setter here, so a value changed while a handler waits is seen at
// the next read. The sender-trust predicate and the channel names are imported,
// not lent, so no caller can swap the check a handler makes. Nothing here
// retries: a refused or failed command answers once with its classified error.

type ControlCorrelation = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
}>;

type ControlCommand = Readonly<{
  taskId: string;
  action:
    | "release-tool"
    | "finish-demo"
    | "compact-context-fixture"
    | "confirm-context-fixture";
}>;

type InstalledUpdateCommand = Readonly<{ kind: string }>;

export type IpcPorts = Readonly<{
  ipcMain: Readonly<{
    on: (
      channel: string,
      listener: (event: IpcMainEvent, ...args: unknown[]) => void,
    ) => unknown;
    handle: (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => unknown;
  }>;
  window: () => BrowserWindow | null;
  updatesPanel: Pick<
    DesktopUpdatesPanel,
    | "bindOwner"
    | "publish"
    | "settle"
    | "settleDirect"
    | "relay"
    | "close"
    | "isPanel"
    | "isOwner"
    | "state"
    | "open"
    | "beginDirect"
    | "endDirect"
  >;
  installedUpdates: Readonly<{
    updater: object | null | undefined;
    resources: () => Readonly<{ directory: string }>;
    command: (value: unknown) => Promise<unknown>;
  }>;
  desktopAdmission: Pick<DesktopAdmission, "closed">;
  windowMode: "default" | "hidden" | "secondary-visible";
  UPDATES_PANEL_SIZE: typeof UpdatesPanelSize;
  selectedVisibleTestPlacement: (
    size: typeof UpdatesPanelSize,
  ) => Readonly<{ bounds: Rectangle }>;
  configuration: () => Pick<ProductConfigurationService, "snapshot"> | null;
  operationsStore: () => Pick<
    OperationsStore,
    "setWorkspaceLabels" | "snapshot"
  >;
  startupConnectionChecking: () => boolean;
  connectionAdmissionInProgress: () => boolean;
  runSelfTestCommand: typeof runSelfTestCommand;
  desktopGoCore: () => DesktopGoCore | null;
  installedUpdateCommandSchema: Readonly<{
    safeParse: (
      value: unknown,
    ) =>
      | Readonly<{ success: true; data: InstalledUpdateCommand }>
      | Readonly<{ success: false }>;
  }>;
  bootstrap: () => unknown;
  runtimeJson: (
    pathname: string,
    method?: string,
    body?: unknown,
  ) => Promise<unknown>;
  configureProduct: (value: unknown) => unknown;
  configurationFailure: (error: "SETTINGS_UNAVAILABLE") => unknown;
  readChatHistoryView: typeof readChatHistoryView;
  readRetiredRepliesView: typeof readRetiredRepliesView;
  runProductTaskCommand: (value: unknown) => unknown;
  taskFailure: (error: "TASKS_UNAVAILABLE") => unknown;
  setNavigationShortcuts: (value: NavigationShortcuts) => void;
  installApplicationMenu: () => void;
  controlSchema: Readonly<{
    safeParse: (
      value: unknown,
    ) =>
      | Readonly<{ success: true; data: ControlCommand }>
      | Readonly<{ success: false }>;
  }>;
  runContextFixtureControl: (
    taskId: string,
    action: "compact-context-fixture" | "confirm-context-fixture",
  ) => Promise<unknown>;
  expectedTasks: readonly Readonly<{ taskId: string }>[];
  runtime: () => Readonly<{ tasks: readonly ControlCorrelation[] }> | null;
  taskSurfaceFailures: Pick<Map<string, unknown>, "has">;
  pendingComputer: Pick<
    Map<string, ControlCorrelation & Readonly<{ callId: string }>>,
    "get"
  >;
  section: () => SurfaceSection;
  setupOpen: () => boolean;
  shellOverlay: () => ShellOverlay;
  selectedTaskId: () => string;
  chatGptRoute: () => Pick<
    ChatGptRoute,
    "travelHistory" | "navigationHistory"
  > | null;
  liveTaskRoutes: Pick<
    Map<string, Pick<ChatGptRoute, "travelHistory" | "navigationHistory">>,
    "get"
  >;
  applyRendererLayout: (value: unknown) => void;
}>;

export function createIpc(ports: IpcPorts) {
  const {
    ipcMain,
    window,
    updatesPanel,
    installedUpdates,
    desktopAdmission,
    windowMode,
    UPDATES_PANEL_SIZE,
    selectedVisibleTestPlacement,
    configuration,
    operationsStore,
    startupConnectionChecking,
    connectionAdmissionInProgress,
    runSelfTestCommand,
    desktopGoCore,
    installedUpdateCommandSchema,
    bootstrap,
    runtimeJson,
    configureProduct,
    configurationFailure,
    readChatHistoryView,
    readRetiredRepliesView,
    runProductTaskCommand,
    taskFailure,
    setNavigationShortcuts,
    installApplicationMenu,
    controlSchema,
    runContextFixtureControl,
    expectedTasks,
    runtime,
    taskSurfaceFailures,
    pendingComputer,
    section,
    setupOpen,
    shellOverlay,
    selectedTaskId,
    chatGptRoute,
    liveTaskRoutes,
    applyRendererLayout,
  } = ports;

  function install(): void {
    ipcMain.on(updatesChannels.projection, (event, value: unknown) => {
      const owner = window();
      if (
        !isTrustedIpcSender(event, owner) ||
        !owner ||
        event.senderFrame !== owner.webContents.mainFrame
      )
        return;
      updatesPanel.bindOwner(owner, installedUpdates.resources().directory);
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
      const opening = window();
      if (!updatesPanel.isOwner(event) || !opening || desktopAdmission.closed())
        return;
      const owner = opening;
      void updatesPanel
        .open({
          owner,
          directory: installedUpdates.resources().directory,
          mode: windowMode,
          place: () => selectedVisibleTestPlacement(UPDATES_PANEL_SIZE).bounds,
          admitted: () =>
            window() === owner &&
            !owner.isDestroyed() &&
            !desktopAdmission.closed(),
        })
        .catch(() => console.error("DESKTOP_UPDATES_PRESENTATION_FAILED"));
    });
    const settings = configuration()?.snapshot();
    if (settings?.status === "ready")
      operationsStore().setWorkspaceLabels(
        settings.settings.computer.workspaces,
      );
    ipcMain.handle(channels.operations, async (event) => {
      if (!isTrustedIpcSender(event, window()))
        return { entries: [], corruptLines: 0, writeFailures: 1 };
      const snapshot = await operationsStore().snapshot();
      return {
        ...snapshot,
        connectionChecking:
          startupConnectionChecking() || connectionAdmissionInProgress(),
      };
    });
    ipcMain.handle(channels.selfTest, (event, value: unknown) =>
      isTrustedIpcSender(event, window()) &&
      event.senderFrame === event.sender.mainFrame
        ? runSelfTestCommand(
            () => desktopGoCore(),
            () => !desktopAdmission.closed(),
            value,
          )
        : { ok: false, code: "SELF_TEST_UNAVAILABLE" },
    );
    ipcMain.handle(
      channels.installedUpdate,
      async (event, value: unknown, operationId: unknown) => {
        if (!isTrustedIpcSender(event, window()))
          return { error: "IPC_SENDER_DENIED" };
        const parsed = installedUpdateCommandSchema.safeParse(value);
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
      isTrustedIpcSender(event, window())
        ? bootstrap()
        : { error: "IPC_SENDER_DENIED" },
    );
    ipcMain.handle(channels.snapshot, (event) =>
      isTrustedIpcSender(event, window())
        ? runtimeJson("/snapshot")
        : { error: "IPC_SENDER_DENIED" },
    );
    ipcMain.handle(channels.configuration, (event, value: unknown) =>
      isTrustedIpcSender(event, window())
        ? configureProduct(value)
        : configurationFailure("SETTINGS_UNAVAILABLE"),
    );
    ipcMain.handle(channels.chatHistory, (event, value: unknown) =>
      isTrustedIpcSender(event, window())
        ? readChatHistoryView(() => desktopGoCore(), value)
        : { error: "IPC_SENDER_DENIED" },
    );
    ipcMain.handle(channels.retiredReplies, (event, value: unknown) =>
      isTrustedIpcSender(event, window())
        ? readRetiredRepliesView(() => desktopGoCore(), value)
        : { error: "IPC_SENDER_DENIED" },
    );
    ipcMain.handle(channels.task, (event, value: unknown) =>
      isTrustedIpcSender(event, window())
        ? runProductTaskCommand(value)
        : taskFailure("TASKS_UNAVAILABLE"),
    );
    ipcMain.handle(channels.navigationShortcuts, (event, value: unknown) => {
      if (!isTrustedIpcSender(event, window())) return { ok: false };
      if (desktopAdmission.closed()) return { ok: false };
      const parsed = parseNavigationShortcuts(value);
      if (!parsed) return { ok: false };
      setNavigationShortcuts(parsed);
      installApplicationMenu();
      return { ok: true };
    });
    ipcMain.handle(channels.control, async (event, value: unknown) => {
      if (desktopAdmission.closed()) return { error: "UPDATE_IN_PROGRESS" };
      if (!isTrustedIpcSender(event, window()))
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
      const task = runtime()?.tasks.find(
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
        !isTrustedIpcSender(event, window()) ||
        section() !== "browser" ||
        setupOpen() ||
        shellOverlay() !== "none" ||
        request.data.taskId !== selectedTaskId()
      )
        return { handled: false, taskId: "", back: false, forward: false };
      const route =
        selectedTaskId() === ""
          ? chatGptRoute()
          : liveTaskRoutes.get(selectedTaskId());
      const handled = route?.travelHistory(request.data.direction) ?? false;
      return {
        handled,
        taskId: selectedTaskId(),
        back: false,
        forward: false,
        ...route?.navigationHistory(),
      };
    });
    ipcMain.on(channels.layout, (event, value: unknown) => {
      if (desktopAdmission.closed() || !isTrustedIpcSender(event, window()))
        return;
      applyRendererLayout(value);
    });
  }

  return { install };
}
