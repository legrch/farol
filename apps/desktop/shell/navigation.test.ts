import { afterEach, describe, expect, it, vi } from "vitest";
import { channels } from "../../../src/pkg/ipc/channels";
import { defaultNavigationShortcuts } from "../../../src/pkg/ipc/navigation-shortcuts";
import {
  surfaceNavigation,
  type NavigationState,
  type SurfaceNavigationPorts,
} from "./navigation";

// Surface navigation over a fixture that stands in for main-process state: a
// focused window, two ChatGPT page views and the shell on the Browser section.
// Every port reads the fixture when it is called. No Electron window, view,
// focus or renderer runs; layout comes from the real derivation.
function fixture() {
  const events: string[] = [];
  const sent: unknown[][] = [];
  const view = (name: string) => ({
    name,
    webContents: { isDestroyed: () => false },
    setBounds: () => events.push(`${name}:bounds`),
  });
  const first = view("first");
  const second = view("second");
  const taskViews = new Map([
    ["first", first],
    ["second", second],
  ]);
  const state: { -readonly [K in keyof NavigationState]: NavigationState[K] } =
    {
      section: "browser",
      selectedTaskId: "first",
      setupOpen: false,
      checkFeedbackVisible: false,
      sidebarMode: "full",
      sidebarWidth: 180,
      shellOverlay: "none",
      browserHomeSurfaceOpen: false,
      navigationShortcuts: defaultNavigationShortcuts,
    };
  const shell = {
    destroyed: false,
    focused: true,
    isDestroyed() {
      return this.destroyed;
    },
    isFocused() {
      return this.focused;
    },
    getContentSize: () => [1180, 760],
    webContents: {
      isDestroyed: () => false,
      send: (...values: unknown[]) => sent.push(values),
      focus: () => events.push("shell:focus"),
    },
  };
  const world = {
    window: shell as typeof shell | null,
    quitInProgress: false,
    installedUpdateAdmission: false,
    live: new Set<string>(),
  };
  const ports = {
    state,
    window: () => world.window,
    quitInProgress: () => world.quitInProgress,
    installedUpdateAdmission: () => world.installedUpdateAdmission,
    runtimeState: () => "ready",
    taskViews: () => taskViews,
    taskViewKinds: () =>
      new Map([...taskViews.keys()].map((taskId) => [taskId, "chatgpt"])),
    nativeViewVisibility: () => ({
      hide: (hidden: { name: string }) => events.push(`${hidden.name}:hide`),
      focus: (_host: unknown, focused: { name: string }) => {
        events.push(`${focused.name}:focus`);
        return true;
      },
    }),
    liveTaskRoutes: { has: (taskId: string) => world.live.has(taskId) },
    signInSurfaceId: "sign-in",
    compactBrowser: () => false,
    productTasksState: () => ({
      tasks: [...taskViews.keys()].map((taskId) => ({ taskId })),
    }),
    attachTaskView: (taskId: string) => events.push(`${taskId}:attach`),
    openLiveTaskSurface: async (taskId: string) => {
      events.push(`${taskId}:open-live`);
    },
    requestSettings: () => events.push("settings"),
  };
  // The doubles carry only the members navigation reads.
  const navigation = surfaceNavigation(
    ports as unknown as SurfaceNavigationPorts,
  );
  const actions = () =>
    sent
      .filter(([channel]) => channel === channels.shellAction)
      .map(([, action]) => action as Record<string, unknown>);
  return { navigation, state, world, shell, events, sent, actions, taskViews };
}

function key(input: Record<string, unknown>) {
  return {
    type: "keyDown",
    key: "",
    meta: false,
    control: false,
    alt: false,
    shift: false,
    isComposing: false,
    isAutoRepeat: false,
    ...input,
  } as Parameters<ReturnType<typeof surfaceNavigation>["handleShortcut"]>[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shell publications", () => {
  it("publishes the layout state under the renderer's field names", () => {
    const f = fixture();
    f.state.shellOverlay = "task-menu";
    f.navigation.publishLayout();
    expect(f.sent).toEqual([
      [
        channels.layout,
        {
          section: "browser",
          taskId: "first",
          setupOpen: false,
          checkFeedbackVisible: false,
          sidebar: "full",
          sidebarWidth: 180,
          overlay: "task-menu",
        },
      ],
    ]);
  });

  it("stamps each shell action with a fresh id, its source and no auth window", () => {
    const f = fixture();
    f.navigation.publishShellAction("open-settings", "settings-command");
    f.navigation.publishShellAction(
      "sign-in-returned",
      "auth-window-closed",
      4,
    );
    const [first, second] = f.actions();
    expect(first).toMatchObject({
      action: "open-settings",
      source: "settings-command",
      authWindowGeneration: null,
    });
    expect(second).toMatchObject({
      action: "sign-in-returned",
      source: "auth-window-closed",
      authWindowGeneration: 4,
    });
    expect(first?.eventId).not.toBe(second?.eventId);
  });

  it("publishes nothing without a window", () => {
    const f = fixture();
    f.world.window = null;
    f.navigation.publishLayout();
    f.navigation.publishShellAction("open-settings", "settings-command");
    expect(f.sent).toEqual([]);
  });
});

describe("surface layout", () => {
  it("has no layout without a live window", () => {
    const f = fixture();
    f.world.window = null;
    expect(f.navigation.currentSurfaceLayout()).toBeNull();
    f.navigation.applyLayout();
    expect(f.events).toEqual([]);
  });

  it("shows the retained home document only with no task selected", () => {
    const f = fixture();
    f.state.browserHomeSurfaceOpen = true;
    expect(f.navigation.currentSurfaceLayout()?.showBrowserHome).toBe(false);
    f.state.selectedTaskId = "";
    expect(f.navigation.currentSurfaceLayout()?.showBrowserHome).toBe(true);
  });

  it("hides every other page before attaching the selected one", () => {
    const f = fixture();
    f.navigation.applyLayout();
    expect(f.events).toEqual(["second:hide", "second:bounds", "first:attach"]);
  });

  it("attaches no page while the shell covers the browser, during Quit or an update", () => {
    for (const cover of [
      (f: ReturnType<typeof fixture>) => {
        f.state.shellOverlay = "task-menu";
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.section = "settings";
      },
      (f: ReturnType<typeof fixture>) => {
        f.world.quitInProgress = true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.world.installedUpdateAdmission = true;
      },
    ]) {
      const f = fixture();
      cover(f);
      f.navigation.applyLayout();
      expect(f.events).toEqual([
        "first:hide",
        "first:bounds",
        "second:hide",
        "second:bounds",
      ]);
    }
  });
});

describe("focus", () => {
  it("focuses the selected page, and the shell when it covers the browser", () => {
    const f = fixture();
    f.navigation.focusForLayout();
    expect(f.events).toEqual(["first:focus"]);
    f.events.length = 0;
    f.state.shellOverlay = "quick-switcher";
    f.navigation.focusForLayout();
    expect(f.events).toEqual(["shell:focus"]);
  });

  it("leaves focus alone in an unfocused window", () => {
    const f = fixture();
    f.shell.focused = false;
    f.navigation.focusForLayout();
    expect(f.events).toEqual([]);
  });

  it("defers the renderer-commit focus to the next immediate", () => {
    const f = fixture();
    const immediate = vi
      .spyOn(globalThis, "setImmediate")
      .mockImplementation((() => undefined) as unknown as typeof setImmediate);
    f.navigation.focusForLayoutAfterRendererCommit();
    expect(immediate).toHaveBeenCalledExactlyOnceWith(
      f.navigation.focusForLayout,
    );
    expect(f.events).toEqual([]);
  });
});

describe("native commands", () => {
  it("opens the quick switcher over a hidden page and focuses the shell", () => {
    const f = fixture();
    f.navigation.requestQuickSwitcher();
    expect(f.state.shellOverlay).toBe("quick-switcher");
    expect(f.events).toEqual([
      "first:hide",
      "first:bounds",
      "second:hide",
      "second:bounds",
      "shell:focus",
    ]);
    expect(f.actions()).toMatchObject([
      { action: "open-quick-switcher", source: "quick-switcher-command" },
    ]);
  });

  it("refuses every command during Quit, an update or (quick switcher) setup", () => {
    for (const refuse of [
      (f: ReturnType<typeof fixture>) => {
        f.world.quitInProgress = true;
      },
      (f: ReturnType<typeof fixture>) => {
        f.world.installedUpdateAdmission = true;
      },
    ]) {
      const f = fixture();
      f.state.shellOverlay = "task-menu";
      refuse(f);
      f.navigation.requestQuickSwitcher();
      f.navigation.requestSidebarToggle();
      f.navigation.closeShellOverlay();
      expect(f.sent).toEqual([]);
      expect(f.events).toEqual([]);
      expect(f.state.shellOverlay).toBe("task-menu");
    }
    const f = fixture();
    f.state.setupOpen = true;
    f.navigation.requestQuickSwitcher();
    expect(f.sent).toEqual([]);
  });

  it("asks the renderer to toggle the sidebar and to dismiss an open overlay", () => {
    const f = fixture();
    f.navigation.requestSidebarToggle();
    f.navigation.closeShellOverlay();
    f.state.shellOverlay = "task-menu";
    f.navigation.closeShellOverlay();
    expect(f.actions()).toMatchObject([
      { action: "toggle-sidebar", source: "sidebar-command" },
      { action: "close-overlay", source: "overlay-dismissed" },
    ]);
    // The overlay stays until the renderer acknowledges the dismissal.
    expect(f.state.shellOverlay).toBe("task-menu");
    expect(f.events).toEqual(["shell:focus"]);
  });
});

describe("shortcuts", () => {
  it("cycles tasks on Control+Tab with a rising sequence and keeps the cursor", () => {
    const f = fixture();
    expect(
      f.navigation.handleShortcut(key({ control: true, key: "Tab" })),
    ).toBe(true);
    expect(f.state.selectedTaskId).toBe("second");
    f.world.live.add("first");
    expect(
      f.navigation.handleShortcut(
        key({ control: true, shift: true, key: "Tab" }),
      ),
    ).toBe(true);
    expect(f.state.selectedTaskId).toBe("first");
    expect(f.actions()).toMatchObject([
      {
        action: "navigate-section",
        source: "section-shortcut-command",
        section: "browser",
        taskId: "second",
        sequence: 1,
      },
      { action: "navigate-section", taskId: "first", sequence: 2 },
    ]);
    expect(f.events).toEqual(["second:focus", "first:open-live"]);
  });

  it("routes Command+comma, Command+K, Control+Command+sidebar and Escape", () => {
    const f = fixture();
    expect(f.navigation.handleShortcut(key({ meta: true, key: "," }))).toBe(
      true,
    );
    expect(f.events).toEqual(["settings"]);
    expect(
      f.navigation.handleShortcut(
        key({
          meta: true,
          control: true,
          key: defaultNavigationShortcuts.sidebar,
        }),
      ),
    ).toBe(true);
    expect(f.navigation.handleShortcut(key({ key: "Escape" }))).toBe(false);
    expect(f.navigation.handleShortcut(key({ meta: true, key: "k" }))).toBe(
      true,
    );
    expect(f.navigation.handleShortcut(key({ key: "Escape" }))).toBe(true);
    expect(f.actions().map((action) => action.action)).toEqual([
      "toggle-sidebar",
      "open-quick-switcher",
      "close-overlay",
    ]);
  });

  it("ignores composition, auto-repeat and, in setup, everything but sections", () => {
    const f = fixture();
    expect(
      f.navigation.handleShortcut(
        key({ meta: true, key: "k", isComposing: true }),
      ),
    ).toBe(false);
    expect(
      f.navigation.handleShortcut(
        key({ meta: true, key: "k", isAutoRepeat: true }),
      ),
    ).toBe(false);
    f.state.setupOpen = true;
    expect(f.navigation.handleShortcut(key({ meta: true, key: "k" }))).toBe(
      false,
    );
    expect(f.sent).toEqual([]);
  });

  it("consumes a section or task shortcut during an update without publishing", () => {
    const f = fixture();
    f.world.installedUpdateAdmission = true;
    expect(
      f.navigation.handleShortcut(key({ control: true, key: "Tab" })),
    ).toBe(true);
    expect(f.navigation.handleShortcut(key({ meta: true, key: "1" }))).toBe(
      true,
    );
    expect(f.sent).toEqual([]);
    expect(f.state.selectedTaskId).toBe("first");
  });
});

describe("renderer layout report", () => {
  const report = (overrides: Record<string, unknown> = {}) => ({
    section: "browser",
    taskId: "second",
    setupOpen: false,
    checkFeedbackVisible: true,
    sidebar: "overlay",
    sidebarWidth: 200,
    overlay: "none",
    ...overrides,
  });

  it("adopts the reported state, applies it and defers focus when the target moved", () => {
    const f = fixture();
    const immediate = vi
      .spyOn(globalThis, "setImmediate")
      .mockImplementation((() => undefined) as unknown as typeof setImmediate);
    f.navigation.applyRendererLayout(report());
    expect(f.state).toMatchObject({
      section: "browser",
      selectedTaskId: "second",
      setupOpen: false,
      checkFeedbackVisible: true,
      sidebarMode: "overlay",
      sidebarWidth: 200,
      shellOverlay: "none",
    });
    expect(f.events.at(-1)).toBe("second:attach");
    expect(immediate).toHaveBeenCalledTimes(1);
    f.navigation.applyRendererLayout(report({ sidebarWidth: 220 }));
    expect(immediate).toHaveBeenCalledTimes(1);
  });

  it("does not reveal an unknown task, but lets the shell conceal the browser", () => {
    const f = fixture();
    vi.spyOn(globalThis, "setImmediate").mockImplementation(
      (() => undefined) as unknown as typeof setImmediate,
    );
    f.navigation.applyRendererLayout(report({ taskId: "unknown" }));
    expect(f.state.selectedTaskId).toBe("first");
    expect(f.state.sidebarWidth).toBe(180);
    expect(f.events).toEqual([]);
    f.navigation.applyRendererLayout(
      report({ taskId: "unknown", section: "settings" }),
    );
    expect(f.state.section).toBe("settings");
    expect(f.state.selectedTaskId).toBe("first");
  });

  it("ignores a report that is not a shell layout", () => {
    const f = fixture();
    f.navigation.applyRendererLayout({ section: "nowhere" });
    f.navigation.applyRendererLayout(null);
    expect(f.state.section).toBe("browser");
    expect(f.events).toEqual([]);
  });
});
