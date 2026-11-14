import path from "node:path";
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Input,
} from "electron";
import { channels } from "../../../src/pkg/ipc/channels";
import type { WindowState } from "../../../src/pkg/ipc/shell-state";
import type { ChatGptWindowPresentation } from "../../../src/apps/desktop/chatgpt-route";
import {
  containWindowOpenFailure,
  presentationAction,
  type WindowOpenCoordinator,
} from "../../../src/apps/desktop/lifecycle-policy";
import {
  selectDevWindowPlacement,
  selectPreviewWindowPlacement,
} from "../../../src/apps/desktop/window-placement";
import type { DesktopEnvironment } from "../../../src/apps/desktop/desktop-environment";
import type { observeRendererLifecycle } from "../renderer-lifecycle-observation";
import type { SurfaceRuntime, TaskSurfaceActions } from "./surface";

export type WindowAdmissionState = {
  window: BrowserWindow | null;
  readonly quitInProgress: boolean;
  readonly installedUpdateAdmission: boolean;
};
export type WindowAdmissionPorts = Readonly<{
  state: WindowAdmissionState;
  coordinator: Pick<WindowOpenCoordinator, "ensure">;
  createWindow(): Promise<void>;
  revealWindow(): void;
  recoverWindowOpenFailure(): void;
}>;
export function windowAdmission(host: WindowAdmissionPorts) {
  function ensureWindow(): Promise<void> {
    if (host.state.quitInProgress || host.state.installedUpdateAdmission)
      return Promise.resolve();
    return host.coordinator.ensure({
      hasWindow: () =>
        host.state.window !== null && !host.state.window.isDestroyed(),
      reveal: () => {
        if (host.state.quitInProgress || host.state.installedUpdateAdmission)
          return;
        host.revealWindow();
      },
      open: () => {
        // The coordinator defers creation. Quit/update may close admission
        // after this request was queued, before the native callback runs.
        if (host.state.quitInProgress || host.state.installedUpdateAdmission)
          return Promise.resolve();
        return host.createWindow();
      },
    });
  }

  function reopenWindow(): void {
    void containWindowOpenFailure(ensureWindow, host.recoverWindowOpenFailure);
  }
  return { ensureWindow, reopenWindow };
}
export type MainWindowState = WindowAdmissionState & {
  windowPresentationReady: boolean;
  readonly runtime: SurfaceRuntime | null;
  readonly runtimeState: "starting" | "ready" | "offline" | "failed";
  readonly selectedTaskId: string;
};
export type MainWindowPorts = Readonly<{
  state: MainWindowState;
  BrowserWindow: new (
    options: BrowserWindowConstructorOptions,
  ) => BrowserWindow;
  surfaces: TaskSurfaceActions;
  pendingComputer: Readonly<{ clear(): void }>;
  taskSurfaceFailures: Readonly<{ clear(): void }>;
  coordinator: Pick<WindowOpenCoordinator, "ensure">;
  nativeViewVisibility: Readonly<{ detachHost(window: BrowserWindow): void }>;
  buildEnvironment: DesktopEnvironment;
  buildIdentity: Readonly<{ buildId: string }>;
  displayWindowTitle: string;
  initialWindowSize: Readonly<{ width: number; height: number }>;
  windowMode: Parameters<typeof presentationAction>[0];
  devSecondaryDisplay: boolean;
  allowPrimaryDisplay: boolean;
  builtInDisplayOnly: boolean;
  sidecarDisplayOnly: boolean;
  explicitPreviewWindowSize: boolean;
  screen: Pick<
    typeof import("electron").screen,
    "getAllDisplays" | "getPrimaryDisplay"
  >;
  managedChatGptRoutes: ReadonlySet<
    Readonly<{ reconcileWindowPresentation(): void }>
  >;
  aboutPanel(): Readonly<{ reconcile(): void }> | null;
  updatesPanel(): Readonly<{ reconcile(): void }>;
  liveTaskRoutes: ReadonlyMap<string, Readonly<{ open(): Promise<unknown> }>>;
  demoMode: boolean;
  platform: NodeJS.Platform;
  writeLog(line: string): unknown;
  desktopExecutionResources(): Readonly<{ directory: string }>;
  observeRendererLifecycle: typeof observeRendererLifecycle;
  handleShortcut(input: Input): boolean;
  applyLayout(): void;
  focusForLayoutAfterRendererCommit(): void;
  openLiveTaskSurface(taskId: string): Promise<unknown>;
  closeStartupSplash(): void;
}>;
export function mainWindow(host: MainWindowPorts) {
  function currentWindowState(): WindowState {
    let trafficLightPosition: WindowState["trafficLightPosition"] = null;
    if (
      host.state.window &&
      !host.state.window.isDestroyed() &&
      host.platform === "darwin"
    ) {
      try {
        trafficLightPosition = host.state.window.getWindowButtonPosition();
      } catch {
        trafficLightPosition = null;
      }
    }
    return {
      focused: host.state.window?.isFocused() ?? false,
      fullScreen: host.state.window?.isFullScreen() ?? false,
      trafficLightPosition,
    };
  }

  function publishWindowState(): void {
    host.state.window?.webContents.send(
      channels.windowState,
      currentWindowState(),
    );
  }

  async function createWindow(): Promise<void> {
    if (host.state.quitInProgress || host.state.installedUpdateAdmission)
      return;
    const testPlacement =
      host.windowMode === "secondary-visible"
        ? selectedVisibleTestPlacement(host.initialWindowSize)
        : null;
    host.state.window = new host.BrowserWindow({
      title: host.displayWindowTitle,
      width: host.initialWindowSize.width,
      height: host.initialWindowSize.height,
      ...(testPlacement?.bounds ?? {}),
      minWidth: 640,
      minHeight: 520,
      backgroundColor: "#111216",
      titleBarStyle: "hiddenInset",
      ...(host.platform === "darwin"
        ? { trafficLightPosition: { x: 14, y: 18 } }
        : {}),
      show: false,
      webPreferences: {
        preload: path.join(
          host.desktopExecutionResources().directory,
          "preload.cjs",
        ),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    host.observeRendererLifecycle(
      host.state.window.webContents,
      host.buildIdentity.buildId,
      (line) => host.writeLog(line),
    );
    // The renderer's neutral HTML title must not replace the Dev window identity.
    if (host.buildEnvironment === "dev")
      host.state.window.on("page-title-updated", (event) =>
        event.preventDefault(),
      );
    host.state.window.webContents.setWindowOpenHandler(() => ({
      action: "deny",
    }));
    host.state.window.webContents.on("will-navigate", (event) =>
      event.preventDefault(),
    );
    host.state.window.webContents.on("before-input-event", (event, input) => {
      if (host.handleShortcut(input)) event.preventDefault();
    });
    host.state.window.on("resize", () => {
      host.applyLayout();
      publishWindowState();
    });
    host.state.window.on("focus", () => {
      publishWindowState();
      host.focusForLayoutAfterRendererCommit();
    });
    host.state.window.on("blur", publishWindowState);
    host.state.window.on("enter-full-screen", () => {
      host.applyLayout();
      publishWindowState();
    });
    host.state.window.on("leave-full-screen", () => {
      host.applyLayout();
      publishWindowState();
    });
    const taskViewHost = host.state.window;
    const startupIsCurrent = () =>
      host.state.window === taskViewHost &&
      !taskViewHost.isDestroyed() &&
      !host.state.quitInProgress &&
      !host.state.installedUpdateAdmission;
    bindWindowLifetime(taskViewHost);
    if (!startupIsCurrent()) return;
    await taskViewHost.loadFile(
      path.join(host.desktopExecutionResources().directory, "shell.html"),
    );
    // Keep the admitted load's outcome, but a withdrawn host cannot dispatch
    // another startup stage or publish readiness for its replacement.
    if (!startupIsCurrent()) return;
    publishWindowState();
    if (!startupIsCurrent()) return;
    host.surfaces.attachTaskViews();
    if (!startupIsCurrent()) return;
    await host.surfaces.createTaskViews();
    if (!startupIsCurrent()) return;
    if (!host.demoMode && host.state.selectedTaskId) {
      await host.openLiveTaskSurface(host.state.selectedTaskId);
      if (!startupIsCurrent()) return;
      // Restore the other retained ChatGPT views behind the selected one. A
      // tab switch can then show its already loaded page in the same frame;
      // embedded surfaces only focus when they are actually visible.
      void Promise.allSettled(
        [...host.liveTaskRoutes.entries()]
          .filter(([taskId]) => taskId !== host.state.selectedTaskId)
          .map(([, route]) => {
            if (!startupIsCurrent()) return;
            return route.open();
          }),
      );
    }
    host.surfaces.startStreams(taskViewHost);
    if (!startupIsCurrent()) return;
    host.state.windowPresentationReady = true;
    revealWindow();
  }

  function bindWindowLifetime(taskViewHost: BrowserWindow): void {
    host.state.window!.on("close", () =>
      host.nativeViewVisibility.detachHost(taskViewHost),
    );
    host.state.window!.on("closed", () => {
      host.nativeViewVisibility.detachHost(taskViewHost);
      if (host.state.window !== taskViewHost) return;
      host.surfaces.stopStreams();
      host.state.window = null;
      host.state.windowPresentationReady = false;
    });
  }

  function selectedVisibleTestPlacement(
    requested: Readonly<{ width: number; height: number }>,
  ) {
    if (host.devSecondaryDisplay)
      return selectDevWindowPlacement(
        host.screen.getAllDisplays(),
        host.screen.getPrimaryDisplay().id,
        requested,
      );
    return selectPreviewWindowPlacement(
      host.screen.getAllDisplays(),
      host.screen.getPrimaryDisplay().id,
      requested,
      host.allowPrimaryDisplay,
      host.builtInDisplayOnly,
      host.sidecarDisplayOnly,
      host.sidecarDisplayOnly && !host.explicitPreviewWindowSize,
    );
  }

  function chatGptWindowPresentation(): ChatGptWindowPresentation | undefined {
    if (host.windowMode === "default") return undefined;
    if (host.windowMode === "hidden") return { mode: "hidden" };
    return {
      mode: "secondary-visible",
      // Fixed test viewports stay exact. An explicit interactive viewport and
      // ordinary Dev may fit auth windows within their selected display.
      size:
        host.buildEnvironment === "dev" ||
        host.explicitPreviewWindowSize ||
        host.sidecarDisplayOnly
          ? "fit"
          : "exact",
      place: (requested) =>
        selectedVisibleTestPlacement(
          host.explicitPreviewWindowSize
            ? {
                width: Math.min(requested.width, host.initialWindowSize.width),
                height: Math.min(
                  requested.height,
                  host.initialWindowSize.height,
                ),
              }
            : requested,
        ).bounds,
    };
  }

  function chatGptWindowPresentationOption(): Readonly<{
    windowPresentation?: ChatGptWindowPresentation;
  }> {
    const presentation = chatGptWindowPresentation();
    return presentation === undefined
      ? {}
      : { windowPresentation: presentation };
  }

  function revealWindow(): void {
    if (!host.state.window || host.state.window.isDestroyed()) return;
    if (host.state.window.isMinimized()) host.state.window.restore();
    const action = presentationAction(host.windowMode);
    if (action === "show-inactive") {
      host.state.window.setBounds(
        selectedVisibleTestPlacement(host.initialWindowSize).bounds,
      );
      host.state.window.showInactive();
    } else if (action === "show-and-focus") host.state.window.show();
    host.closeStartupSplash();
  }

  function reconcileVisibleTestDisplay(): void {
    if (host.windowMode !== "secondary-visible") return;
    host.aboutPanel()?.reconcile();
    host.updatesPanel().reconcile();
    if (
      host.state.windowPresentationReady &&
      host.state.window !== null &&
      !host.state.window.isDestroyed()
    ) {
      host.state.window.hide();
      try {
        host.state.window.setBounds(
          selectedVisibleTestPlacement(host.initialWindowSize).bounds,
        );
        host.state.window.showInactive();
      } catch {
        // An unavailable permitted display keeps this window hidden until the
        // next topology event. Sidecar has no implicit primary fallback.
      }
    }
    for (const route of host.managedChatGptRoutes) {
      route.reconcileWindowPresentation();
    }
  }

  function recoverWindowOpenFailure(): void {
    host.surfaces.stopStreams();
    host.surfaces.disposeTaskViews("runtime");
    host.surfaces.detachTaskViews();
    host.pendingComputer.clear();
    host.taskSurfaceFailures.clear();
    const failedWindow = host.state.window;
    host.state.window = null;
    if (failedWindow && !failedWindow.isDestroyed()) failedWindow.destroy();
  }
  return {
    currentWindowState,
    publishWindowState,
    createWindow,
    bindWindowLifetime,
    selectedVisibleTestPlacement,
    chatGptWindowPresentation,
    chatGptWindowPresentationOption,
    revealWindow,
    reconcileVisibleTestDisplay,
    recoverWindowOpenFailure,
    ...windowAdmission({
      state: host.state,
      coordinator: host.coordinator,
      createWindow,
      revealWindow,
      recoverWindowOpenFailure,
    }),
  };
}
