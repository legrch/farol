import type {
  BrowserWindow,
  Input,
  Rectangle,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from "electron";
import { channels } from "../../../src/pkg/ipc/channels";
import {
  ClientEventSchema,
  type ClientEventDto,
} from "../../../src/modules/chat/contract/client-event";
import type { TaskSurfaceStatus } from "../../../src/pkg/ipc/task-surface-status";
import type {
  ChatGptRouteSurface,
  ChatGptRouteSurfaceFactory,
} from "../../../src/apps/desktop/chatgpt-route";
import type { NativeViewVisibility } from "../bridge/native-view-visibility";
import type { OperationsStore } from "../operations/store";
import { chatTerminalOperationCode } from "../renderer/operations-vocabulary";

export type SurfaceTask = Readonly<{
  taskId: string;
  ownerId: string;
  sessionId: string;
  turnId: string;
  generation: number;
  readToken: string;
}>;
export type SurfaceRuntime = Readonly<{
  port: number;
  tasks: readonly SurfaceTask[];
}>;
export type TaskSurfaceState = {
  readonly window: BrowserWindow | null;
  readonly runtime: SurfaceRuntime | null;
  readonly runtimeState: "starting" | "ready" | "offline" | "failed";
  readonly quitInProgress: boolean;
  readonly installedUpdateAdmission: boolean;
  browserHomeSurfaceOpen: boolean;
};
export type TaskSurfacePorts = Readonly<{
  state: TaskSurfaceState;
  WebContentsView: new (
    options: WebContentsViewConstructorOptions,
  ) => WebContentsView;
  taskViews: Map<string, WebContentsView>;
  taskViewKinds: Map<string, "runtime" | "chatgpt">;
  nativeViewVisibility: Pick<
    NativeViewVisibility<WebContentsView>,
    "show" | "hide" | "focus" | "detachHost"
  >;
  streamControllers: Map<string, AbortController>;
  taskSurfaceFailures: Map<string, string>;
  pendingComputer: Map<
    string,
    Extract<ClientEventDto, { kind: "computer.requested" }>
  >;
  runtimePartition: string;
  signInSurfaceId: string;
  session: Pick<typeof import("electron").session, "fromPartition">;
  runtimeBase(): string | null;
  currentSurfaceLayout(): Readonly<{ pageBounds: Rectangle }> | null;
  applyLayout(): void;
  handleShortcut(input: Input): boolean;
  preventEmbeddedWindowDrag(contents: WebContentsView["webContents"]): void;
  operationsStore(): Pick<OperationsStore, "record">;
  fetch: typeof globalThis.fetch;
}>;

// Main owns the mutable host and runtime state. Each callback reads that state
// when it runs, including after an awaited load or stream read settles.
export function taskSurfaces(host: TaskSurfacePorts) {
  function attachTaskView(
    taskId: string,
    view: WebContentsView,
    bounds: Electron.Rectangle,
  ): void {
    if (
      !host.state.window ||
      host.state.window.isDestroyed() ||
      view.webContents?.isDestroyed() !== false ||
      host.taskViews.get(taskId) !== view
    ) {
      return;
    }
    host.nativeViewVisibility.show(host.state.window, view, bounds);
  }

  function attachTaskViews(): void {
    host.applyLayout();
  }

  function detachTaskViews(): void {
    if (host.state.window)
      host.nativeViewVisibility.detachHost(host.state.window);
  }

  function liveChatGptSurfaceFactory(
    taskId: string,
  ): ChatGptRouteSurfaceFactory {
    return ({ webPreferences }): ChatGptRouteSurface => {
      const existing = host.taskViews.get(taskId);
      if (existing && !existing.webContents.isDestroyed()) {
        throw new Error("CHATGPT_TASK_SURFACE_ALREADY_EXISTS");
      }
      const view = new host.WebContentsView({
        webPreferences: {
          ...webPreferences,
          backgroundThrottling: false,
        },
      });
      const contents = view.webContents;
      host.preventEmbeddedWindowDrag(contents);
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
      // A background document needs a real viewport before its first load. This
      // does not attach, reveal or focus the retained browser surface.
      const layout = host.currentSurfaceLayout();
      if (layout) view.setBounds(layout.pageBounds);
      host.taskViews.set(taskId, view);
      host.taskViewKinds.set(taskId, "chatgpt");
      contents.on("before-input-event", (event, input) => {
        if (host.handleShortcut(input)) event.preventDefault();
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
        hide: () => host.nativeViewVisibility.hide(view),
        retire: () => {
          // Layout selects a view by task id: leaving the maps takes away its
          // only way back onto the host, and the contents stay destroyable.
          if (host.taskViews.get(taskId) === view) {
            host.taskViews.delete(taskId);
            host.taskViewKinds.delete(taskId);
          }
          host.nativeViewVisibility.hide(view);
        },
        reveal: () => {
          if (host.taskViews.get(taskId) !== view || contents.isDestroyed()) {
            return;
          }
          host.applyLayout();
        },
        focus: () => {
          if (host.state.window && host.taskViews.get(taskId) === view) {
            host.nativeViewVisibility.focus(host.state.window, view);
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

  function signInChatGptSurfaceFactory(): ChatGptRouteSurfaceFactory {
    const create = liveChatGptSurfaceFactory(host.signInSurfaceId);
    return (options) => {
      const surface = create(options);
      host.state.browserHomeSurfaceOpen = true;
      return {
        ...surface,
        focus: () => {
          if (host.state.window?.isFocused()) surface.focus();
        },
        close: () => surface.destroy(),
      };
    };
  }

  function disposeTaskView(taskId: string, view: WebContentsView): void {
    if (host.taskViews.get(taskId) === view) {
      host.taskViews.delete(taskId);
      host.taskViewKinds.delete(taskId);
    }
    host.nativeViewVisibility.hide(view);
    const contents = view.webContents;
    if (contents && !contents.isDestroyed()) {
      contents.close({ waitForBeforeUnload: false });
    }
  }

  function disposeTaskViews(kind?: "runtime" | "chatgpt"): void {
    for (const [taskId, view] of [...host.taskViews]) {
      if (kind && host.taskViewKinds.get(taskId) !== kind) continue;
      disposeTaskView(taskId, view);
    }
  }

  function stopStreams(): void {
    for (const controller of host.streamControllers.values())
      controller.abort();
    host.streamControllers.clear();
  }

  function publishTaskSurfaceStatus(status: TaskSurfaceStatus): void {
    host.state.window?.webContents.send(channels.taskSurfaceState, status);
  }

  function failTaskSurface(taskId: string): void {
    const controller = host.streamControllers.get(taskId);
    controller?.abort();
    host.streamControllers.delete(taskId);
    host.pendingComputer.delete(taskId);
    const error = "TASK_STREAM_FAILED";
    host.taskSurfaceFailures.set(taskId, error);
    publishTaskSurfaceStatus({ taskId, state: "failed", error });
  }

  function partitionName(): string {
    return host.runtimePartition;
  }

  function installNetworkFence(): Electron.Session | null {
    const base = host.runtimeBase();
    if (!base) return null;
    const isolated = host.session.fromPartition(partitionName(), {
      cache: false,
    });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(`${base}/`) });
    });
    return isolated;
  }

  async function createTaskViews(): Promise<void> {
    if (!host.state.window || !host.state.runtime) return;
    const taskViewHost = host.state.window;
    const activeRuntime = host.state.runtime;
    const startupIsCurrent = () =>
      host.state.window === taskViewHost &&
      !taskViewHost.isDestroyed() &&
      !host.state.quitInProgress &&
      !host.state.installedUpdateAdmission &&
      host.state.runtimeState === "ready" &&
      host.state.runtime === activeRuntime;
    if (!startupIsCurrent()) return;
    const base = host.runtimeBase();
    if (!base || !installNetworkFence()) return;
    for (const task of activeRuntime.tasks) {
      if (!startupIsCurrent()) return;
      const retained = host.taskViews.get(task.taskId);
      if (retained && retained.webContents?.isDestroyed() === false) {
        continue;
      }
      const view = new host.WebContentsView({
        webPreferences: {
          partition: partitionName(),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      view.setVisible(false);
      host.taskViews.set(task.taskId, view);
      host.taskViewKinds.set(task.taskId, "runtime");
      view.webContents.once("destroyed", () => {
        disposeTaskView(task.taskId, view);
      });
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      view.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith(`${base}/`)) event.preventDefault();
      });
      view.webContents.on("before-input-event", (event, input) => {
        if (host.handleShortcut(input)) event.preventDefault();
      });
      try {
        await view.webContents.loadURL(
          `${base}/task/${encodeURIComponent(task.taskId)}`,
          {
            extraHeaders: `Authorization: Bearer ${task.readToken}\n`,
          },
        );
        if (
          !startupIsCurrent() ||
          host.taskViews.get(task.taskId) !== view ||
          view.webContents?.isDestroyed() !== false
        )
          return;
        host.taskSurfaceFailures.delete(task.taskId);
        publishTaskSurfaceStatus({
          taskId: task.taskId,
          state: "ready",
          error: null,
        });
      } catch (error) {
        if (host.taskViews.get(task.taskId) === view) {
          disposeTaskView(task.taskId, view);
        }
        if (
          host.state.runtimeState !== "ready" ||
          host.state.runtime !== activeRuntime
        )
          return;
        throw error;
      }
    }
    if (startupIsCurrent()) host.applyLayout();
  }

  async function consumeSse(
    task: SurfaceRuntime["tasks"][number],
    controller = new AbortController(),
  ): Promise<void> {
    const activeRuntime = host.state.runtime;
    const taskViewHost = host.state.window;
    if (
      !activeRuntime ||
      !taskViewHost ||
      taskViewHost.isDestroyed() ||
      host.state.runtimeState !== "ready" ||
      host.state.quitInProgress ||
      host.state.installedUpdateAdmission
    )
      return;
    host.streamControllers.get(task.taskId)?.abort();
    host.streamControllers.set(task.taskId, controller);
    const streamIsCurrent = () =>
      !controller.signal.aborted &&
      host.streamControllers.get(task.taskId) === controller &&
      host.state.runtime === activeRuntime &&
      host.state.runtimeState === "ready" &&
      host.state.window === taskViewHost &&
      !taskViewHost.isDestroyed();
    const response = await host.fetch(
      `http://127.0.0.1:${activeRuntime.port}/events/${encodeURIComponent(task.taskId)}`,
      {
        headers: { authorization: `Bearer ${task.readToken}` },
        signal: controller.signal,
      },
    );
    if (!streamIsCurrent()) {
      if (host.streamControllers.get(task.taskId) === controller) {
        host.streamControllers.delete(task.taskId);
      }
      return;
    }
    if (!response.ok || !response.body)
      throw new Error("RUNTIME_STREAM_UNAVAILABLE");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let carry = "";
    while (streamIsCurrent()) {
      const part = await reader.read();
      // A dispatched read may still settle after its controller or host was
      // replaced. Its bytes cannot update the replacement's projection.
      if (!streamIsCurrent()) break;
      if (part.done) {
        throw new Error("RUNTIME_STREAM_ENDED");
      }
      carry += decoder.decode(part.value, { stream: true });
      const frames = carry.split("\n\n");
      carry = frames.pop() ?? "";
      for (const frame of frames) {
        if (!streamIsCurrent()) break;
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
          host.pendingComputer.set(task.taskId, parsed.data);
        } else if (
          parsed.data.kind === "computer.completed" ||
          parsed.data.kind === "turn.terminal"
        ) {
          host.pendingComputer.delete(task.taskId);
        }
        if (parsed.data.kind === "turn.terminal") {
          const event = parsed.data;
          host
            .operationsStore()
            .record(
              { source: "Codex", kind: "chat.turn", target: {} },
              event.phase === "completed"
                ? "done"
                : event.phase === "outcome_unknown"
                  ? "unknown"
                  : "failed",
              chatTerminalOperationCode(event.code),
              0,
            );
        }
        taskViewHost.webContents.send(channels.runtimeEvent, parsed.data);
      }
    }
    if (host.streamControllers.get(task.taskId) === controller) {
      host.streamControllers.delete(task.taskId);
    }
  }

  function startStreams(taskViewHost: BrowserWindow): readonly Promise<void>[] {
    const pending: Promise<void>[] = [];
    const startupIsCurrent = () =>
      host.state.window === taskViewHost &&
      !taskViewHost.isDestroyed() &&
      !host.state.quitInProgress &&
      !host.state.installedUpdateAdmission;
    for (const task of host.state.runtime?.tasks ?? []) {
      if (!startupIsCurrent()) return pending;
      const activeRuntime = host.state.runtime;
      const controller = new AbortController();
      const admitted = consumeSse(task, controller);
      pending.push(admitted);
      void admitted.catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        if (
          host.state.window !== taskViewHost ||
          taskViewHost.isDestroyed() ||
          host.state.runtimeState !== "ready" ||
          host.state.runtime !== activeRuntime ||
          controller.signal.aborted ||
          host.streamControllers.get(task.taskId) !== controller
        )
          return;
        failTaskSurface(task.taskId);
      });
    }
    return pending;
  }
  return {
    attachTaskView,
    attachTaskViews,
    detachTaskViews,
    liveChatGptSurfaceFactory,
    signInChatGptSurfaceFactory,
    disposeTaskView,
    disposeTaskViews,
    stopStreams,
    publishTaskSurfaceStatus,
    failTaskSurface,
    partitionName,
    installNetworkFence,
    createTaskViews,
    consumeSse,
    startStreams,
  };
}
export type TaskSurfaceActions = ReturnType<typeof taskSurfaces>;
