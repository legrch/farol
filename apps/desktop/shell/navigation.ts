import { randomUUID } from "node:crypto";
import type {
  BrowserWindow,
  Input,
  Rectangle,
  WebContentsView,
} from "electron";
import { deriveSurfaceLayout } from "../../../src/apps/desktop/surface-layout";
import { channels } from "../../../src/pkg/ipc/channels";
import {
  sectionForShortcut,
  sidebarShortcutMatches,
  type NavigationShortcuts,
} from "../../../src/pkg/ipc/navigation-shortcuts";
import {
  ShellLayoutSchema,
  type ShellAction,
  type ShellActionSource,
  type ShellOverlay,
  type SidebarMode,
  type SurfaceSection,
} from "../../../src/pkg/ipc/shell-state";
import type { NativeViewVisibility } from "../bridge/native-view-visibility";

// Surface navigation of the one main window: what the shell shows (section,
// selected task, overlay, sidebar), which page view that leaves visible and
// focused, and the native commands and shortcuts that ask the renderer to
// move. The main process keeps the window, the page views and the navigation
// state itself and lends them through the ports below.

/** The navigation state main.ts owns; assignments here write its variables. */
export type NavigationState = {
  section: SurfaceSection;
  selectedTaskId: string;
  setupOpen: boolean;
  checkFeedbackVisible: boolean;
  sidebarMode: SidebarMode;
  sidebarWidth: number;
  shellOverlay: ShellOverlay;
  readonly browserHomeSurfaceOpen: boolean;
  readonly navigationShortcuts: NavigationShortcuts;
};

/** Main-process state and owners, read at the moment a function runs. */
export type SurfaceNavigationPorts = Readonly<{
  state: NavigationState;
  window(): BrowserWindow | null;
  quitInProgress(): boolean;
  installedUpdateAdmission(): boolean;
  runtimeState(): "starting" | "ready" | "offline" | "failed";
  taskViews(): ReadonlyMap<string, WebContentsView>;
  taskViewKinds(): ReadonlyMap<string, "runtime" | "chatgpt">;
  nativeViewVisibility(): Pick<
    NativeViewVisibility<WebContentsView>,
    "focus" | "hide"
  >;
  liveTaskRoutes: Readonly<{ has(taskId: string): boolean }>;
  /** The retained ChatGPT home document's key in the page views. */
  signInSurfaceId: string;
  /** `compactBrowserSelected` for this launch's environment and modes. */
  compactBrowser(): boolean;
  productTasksState(): Readonly<{
    tasks: ReadonlyArray<Readonly<{ taskId: string }>>;
  }>;
  attachTaskView(
    taskId: string,
    view: WebContentsView,
    bounds: Rectangle,
  ): void;
  openLiveTaskSurface(taskId: string): Promise<unknown>;
  requestSettings(): void;
}>;

type SectionNavigationTarget = Pick<
  Extract<ShellAction, { action: "navigate-section" }>,
  "section" | "taskId" | "sequence"
>;

/** The two publications the renderer's shell listens to. */
export function shellPublisher(host: SurfaceNavigationPorts) {
  const { state } = host;

  function publishLayout(): void {
    const window = host.window();
    window?.webContents.send(channels.layout, {
      section: state.section,
      taskId: state.selectedTaskId,
      setupOpen: state.setupOpen,
      checkFeedbackVisible: state.checkFeedbackVisible,
      sidebar: state.sidebarMode,
      sidebarWidth: state.sidebarWidth,
      overlay: state.shellOverlay,
    });
  }

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
    const window = host.window();
    window?.webContents.send(channels.shellAction, {
      action,
      eventId: randomUUID(),
      source,
      authWindowGeneration,
      ...navigation,
    });
  }

  return { publishLayout, publishShellAction };
}
export type ShellPublisher = ReturnType<typeof shellPublisher>;

/** The layout the current state leaves, and its page view attachment. */
export function surfaceLayout(host: SurfaceNavigationPorts) {
  const { state } = host;

  function currentSurfaceLayout() {
    const window = host.window();
    if (!window || window.isDestroyed()) return null;
    const [width = 1, height = 1] = window.getContentSize();
    const showBrowserHome =
      state.browserHomeSurfaceOpen && state.selectedTaskId === "";
    const selectedViewKind = showBrowserHome
      ? "chatgpt"
      : host.taskViewKinds().get(state.selectedTaskId);
    const layout = deriveSurfaceLayout({
      width,
      height,
      sidebar: state.sidebarMode,
      sidebarWidth: state.sidebarWidth,
      overlay: state.shellOverlay,
      section: state.section,
      setupOpen: state.setupOpen,
      runtimeReady: host.runtimeState() === "ready",
      browserDocumentPresent: selectedViewKind === "chatgpt",
      selectedTaskPresent:
        showBrowserHome || host.taskViews().has(state.selectedTaskId),
      browserChromeVisible:
        showBrowserHome || host.productTasksState().tasks.length > 0,
      compactBrowser: host.compactBrowser(),
      checkFeedbackVisible: state.checkFeedbackVisible,
    });
    return { ...layout, showBrowserHome };
  }

  function applyLayout(): void {
    const layout = currentSurfaceLayout();
    if (!layout) return;
    const visibleTaskId =
      !host.quitInProgress() &&
      !host.installedUpdateAdmission() &&
      layout.pageVisible
        ? layout.showBrowserHome
          ? host.signInSurfaceId
          : state.selectedTaskId
        : null;
    // Detach covered and unselected pages first so the host has at most one
    // browser child, regardless of task insertion order.
    for (const [taskId, view] of host.taskViews()) {
      if (
        taskId !== visibleTaskId ||
        view.webContents?.isDestroyed() !== false
      ) {
        host.nativeViewVisibility().hide(view);
        // Keep hidden documents responsive to the current host geometry without
        // making their native input or accessibility subtree visible.
        if (view.webContents?.isDestroyed() === false)
          view.setBounds(layout.pageBounds);
      }
    }
    if (visibleTaskId !== null) {
      const view = host.taskViews().get(visibleTaskId);
      if (view) host.attachTaskView(visibleTaskId, view, layout.pageBounds);
    }
  }

  return { currentSurfaceLayout, applyLayout };
}
export type SurfaceLayout = ReturnType<typeof surfaceLayout>;

/** Native focus for the surface the layout leaves in front. */
export function surfaceFocus(
  host: SurfaceNavigationPorts,
  layout: Pick<SurfaceLayout, "currentSurfaceLayout">,
) {
  const { state } = host;
  const { currentSurfaceLayout } = layout;

  function focusForLayout(): void {
    const window = host.window();
    if (
      !window ||
      window.isDestroyed() ||
      !window.isFocused() ||
      window.webContents.isDestroyed()
    ) {
      return;
    }
    if (
      state.setupOpen ||
      state.shellOverlay !== "none" ||
      state.section !== "browser"
    ) {
      window.webContents.focus();
      return;
    }
    const layout = currentSurfaceLayout();
    const selected = layout?.pageVisible
      ? host
          .taskViews()
          .get(
            layout.showBrowserHome
              ? host.signInSurfaceId
              : state.selectedTaskId,
          )
      : undefined;
    if (!selected || !host.nativeViewVisibility().focus(window, selected)) {
      if (!window.webContents.isDestroyed()) window.webContents.focus();
    }
  }

  function focusForLayoutAfterRendererCommit(): void {
    setImmediate(focusForLayout);
  }

  return { focusForLayout, focusForLayoutAfterRendererCommit };
}
export type SurfaceFocus = ReturnType<typeof surfaceFocus>;

/** Native commands, shortcuts and the renderer's layout report. */
export function shellCommands(
  host: SurfaceNavigationPorts,
  parts: Pick<ShellPublisher, "publishShellAction"> &
    Pick<SurfaceLayout, "applyLayout"> &
    SurfaceFocus,
) {
  const { state } = host;
  const {
    publishShellAction,
    applyLayout,
    focusForLayout,
    focusForLayoutAfterRendererCommit,
  } = parts;
  let sectionNavigationSequence = 0;

  function requestQuickSwitcher(): void {
    const window = host.window();
    if (host.quitInProgress() || host.installedUpdateAdmission()) return;
    if (!window || state.setupOpen) return;
    state.shellOverlay = "quick-switcher";
    applyLayout();
    publishShellAction("open-quick-switcher", "quick-switcher-command");
    window.webContents.focus();
  }

  function requestSidebarToggle(): void {
    const window = host.window();
    if (host.quitInProgress() || host.installedUpdateAdmission()) return;
    if (!window || window.isDestroyed()) return;
    publishShellAction("toggle-sidebar", "sidebar-command");
  }

  function closeShellOverlay(): void {
    const window = host.window();
    if (host.quitInProgress() || host.installedUpdateAdmission()) return;
    if (state.shellOverlay === "none") return;
    // Keep native input hidden until the renderer acknowledges the complete
    // dismissal, including an active resize or compact page-list overlay.
    publishShellAction("close-overlay", "overlay-dismissed");
    window?.webContents.focus();
  }

  function handleShortcut(input: Input): boolean {
    if (input.isComposing || input.isAutoRepeat) return false;
    const key = input.key.toLowerCase();
    if (
      input.type === "keyDown" &&
      input.meta &&
      !input.control &&
      !input.alt &&
      !input.shift &&
      (input.key === "[" || input.key === "]") &&
      state.shellOverlay === "none"
    ) {
      if (!host.quitInProgress() && !host.installedUpdateAdmission())
        publishShellAction(
          input.key === "[" ? "history-back" : "history-forward",
          "history-shortcut-command",
        );
      return true;
    }
    if (input.meta && input.key === ",") {
      host.requestSettings();
      return true;
    }
    const shortcut =
      input.type === "keyDown" &&
      input.meta &&
      !input.control &&
      !input.alt &&
      !input.shift
        ? sectionForShortcut(state.navigationShortcuts, input.key)
        : null;
    if (state.setupOpen && !shortcut) return false;
    if (
      input.control &&
      input.meta &&
      sidebarShortcutMatches(state.navigationShortcuts, key)
    ) {
      requestSidebarToggle();
      return true;
    }
    if (input.meta && key === "k") {
      requestQuickSwitcher();
      return true;
    }
    if (input.key === "Escape" && state.shellOverlay !== "none") {
      closeShellOverlay();
      return true;
    }
    if (input.control && input.key === "Tab") {
      if (host.installedUpdateAdmission()) return true;
      const tasks = host.productTasksState().tasks;
      if (tasks.length === 0) return false;
      const index = tasks.findIndex(
        (task) => task.taskId === state.selectedTaskId,
      );
      const direction = input.shift ? -1 : 1;
      const next = (index + direction + tasks.length) % tasks.length;
      // Retain the native task cursor for consecutive Tab presses. Presentation
      // and overlay closure are acknowledged by the single renderer owner.
      state.selectedTaskId = tasks[next]?.taskId ?? state.selectedTaskId;
      publishShellAction("navigate-section", "section-shortcut-command", null, {
        section: "browser",
        taskId: state.selectedTaskId,
        sequence: ++sectionNavigationSequence,
      });
      if (host.liveTaskRoutes.has(state.selectedTaskId)) {
        void host.openLiveTaskSurface(state.selectedTaskId);
      } else {
        focusForLayout();
      }
      return true;
    }
    if (shortcut) {
      if (host.installedUpdateAdmission()) return true;
      publishShellAction("navigate-section", "section-shortcut-command", null, {
        section: shortcut,
        taskId: state.selectedTaskId,
        sequence: ++sectionNavigationSequence,
      });
      if (
        shortcut === "browser" &&
        host.liveTaskRoutes.has(state.selectedTaskId)
      ) {
        void host.openLiveTaskSurface(state.selectedTaskId);
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
    const tasks = host.productTasksState().tasks;
    const knownTask =
      parsed.data.taskId === "" ||
      tasks.some((task) => task.taskId === parsed.data.taskId);
    // Shell navigation can conceal a browser even if its retained task selection
    // is missing or stale. It cannot select a replacement or reveal an unknown
    // conversation. An explicit blank ID selects only the retained home page,
    // never an incidental previously selected task.
    const concealsBrowser =
      parsed.data.section !== "browser" ||
      parsed.data.setupOpen ||
      parsed.data.overlay !== "none";
    if (!knownTask && !concealsBrowser) return;
    const focusTargetChanged =
      state.section !== parsed.data.section ||
      (knownTask && state.selectedTaskId !== parsed.data.taskId) ||
      state.setupOpen !== parsed.data.setupOpen ||
      state.shellOverlay !== parsed.data.overlay;
    state.section = parsed.data.section;
    if (knownTask) {
      state.selectedTaskId = parsed.data.taskId;
    }
    state.setupOpen = parsed.data.setupOpen;
    state.checkFeedbackVisible = parsed.data.checkFeedbackVisible;
    state.sidebarMode = parsed.data.sidebar;
    state.sidebarWidth = parsed.data.sidebarWidth;
    state.shellOverlay = parsed.data.overlay;
    applyLayout();
    if (focusTargetChanged) focusForLayoutAfterRendererCommit();
  }

  return {
    requestQuickSwitcher,
    requestSidebarToggle,
    closeShellOverlay,
    handleShortcut,
    applyRendererLayout,
  };
}

/** The whole of surface navigation over one set of main-process ports. */
export function surfaceNavigation(host: SurfaceNavigationPorts) {
  const publisher = shellPublisher(host);
  const layout = surfaceLayout(host);
  const focus = surfaceFocus(host, layout);
  const commands = shellCommands(host, { ...publisher, ...layout, ...focus });
  return { ...publisher, ...layout, ...focus, ...commands };
}
