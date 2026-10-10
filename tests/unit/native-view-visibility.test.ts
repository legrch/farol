import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { parse } from "@babel/parser";
import type { Rectangle } from "electron";
import { describe, expect, it } from "vitest";
import {
  NativeViewVisibility,
  type NativeViewHost,
} from "../../apps/desktop/bridge/native-view-visibility";
import { deriveSurfaceLayout } from "../../src/apps/desktop/surface-layout";
import { ShellLayoutSchema } from "../../src/pkg/ipc/shell-state";

// Native-interface fakes and extracted production callbacks only. These tests
// prove attachment/focus calls, not Electron pixels, macOS AX, or provider state.
class Contents {
  destroyed = false;
  focused = false;
  private readonly destroyedListeners: (() => void)[] = [];
  constructor(
    readonly label: string,
    readonly events: string[],
  ) {}
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    if (this.destroyed) throw Error("DESTROYED_CONTENTS_ACCESS");
    return this.focused;
  }
  focus() {
    if (this.destroyed) throw Error("DESTROYED_CONTENTS_FOCUS");
    this.events.push(`${this.label}:focus`);
    this.focused = true;
  }
  on() {}
  send() {}
  setWindowOpenHandler() {}
  async loadURL() {}
  once(_event: string, listener: () => void) {
    this.destroyedListeners.push(listener);
  }
  close() {
    if (this.destroyed) throw Error("DESTROYED_CONTENTS_CLOSE");
    this.events.push(`${this.label}:close`);
    this.destroyed = true;
    for (const listener of this.destroyedListeners.splice(0)) listener();
  }
}

class BrowserView {
  visible = false;
  bounds: Rectangle | null = null;
  readonly webContents: Contents;
  constructor(
    readonly label: string,
    readonly events: string[],
  ) {
    this.webContents = new Contents(label, events);
  }
  getVisible() {
    if (this.webContents.destroyed) throw Error("DESTROYED_VIEW_ACCESS");
    return this.visible;
  }
  setVisible(visible: boolean) {
    this.getVisible();
    this.visible = visible;
    this.events.push(`${this.label}:visible:${visible}`);
  }
  setBounds(bounds: Rectangle) {
    this.getVisible();
    this.bounds = bounds;
    this.events.push(`${this.label}:bounds`);
  }
}

class Host implements NativeViewHost<BrowserView> {
  destroyed = false;
  focused = true;
  readonly webContents: Contents;
  readonly children: BrowserView[] = [];
  readonly listeners = new Map<string, () => void>();
  readonly contentView;
  constructor(
    readonly label: string,
    readonly events: string[],
  ) {
    this.webContents = new Contents(`${label}:shell`, events);
    this.contentView = {
      get children() {
        if (host.destroyed) throw Error("DESTROYED_HOST_ACCESS");
        return host.children;
      },
      addChildView(view: BrowserView) {
        if (host.destroyed) throw Error("DESTROYED_HOST_ADD");
        host.events.push(`${host.label}:add:${view.label}`);
        host.children.push(view);
      },
      removeChildView(view: BrowserView) {
        if (host.destroyed) throw Error("DESTROYED_HOST_REMOVE");
        host.events.push(`${host.label}:remove:${view.label}`);
        const index = host.children.indexOf(view);
        if (index >= 0) host.children.splice(index, 1);
      },
    };
    const host = this;
  }
  isDestroyed() {
    return this.destroyed;
  }
  getContentSize() {
    return [1180, 760];
  }
  on(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }
  isFocused() {
    if (this.destroyed) throw Error("DESTROYED_HOST_FOCUS");
    return this.focused;
  }
}

const bounds = { x: 236, y: 58, width: 944, height: 702 };
function fixture() {
  const events: string[] = [];
  const owner = new NativeViewVisibility<BrowserView>();
  const host = new Host("host", events);
  const view = new BrowserView("page", events);
  return { events, owner, host, view };
}

describe("native view attachment ownership (fake interfaces)", () => {
  it("bounds before attaching and shows exactly once without focusing", () => {
    const f = fixture();
    const identity = f.view.webContents;
    f.owner.show(f.host, f.view, bounds);
    f.owner.show(f.host, f.view, bounds);
    expect(f.events).toEqual([
      "page:bounds",
      "host:add:page",
      "page:visible:true",
      "page:bounds",
    ]);
    expect(f.host.children).toEqual([f.view]);
    expect(f.view.webContents).toBe(identity);
  });
  it("hides and detaches idempotently without closing the page", () => {
    const f = fixture();
    f.owner.show(f.host, f.view, bounds);
    f.events.length = 0;
    f.owner.hide(f.view);
    f.owner.hide(f.view);
    expect(f.events).toEqual(["page:visible:false", "host:remove:page"]);
    expect(f.host.children).toEqual([]);
    expect(f.view.webContents.destroyed).toBe(false);
    f.owner.show(f.host, f.view, bounds);
    expect(f.host.children).toEqual([f.view]);
  });
  it.each(["owned", "shell", "inactive", "detached", "destroyed-shell"])(
    "transfers hide focus only for a currently focused attached page: %s",
    (focus) => {
      const f = fixture();
      f.owner.show(f.host, f.view, bounds);
      f.view.webContents.focused = focus !== "shell";
      f.host.focused = focus !== "inactive";
      if (focus === "detached") f.host.children.length = 0;
      if (focus === "destroyed-shell") f.host.webContents.destroyed = true;
      f.events.length = 0;
      f.owner.hide(f.view);
      expect(f.events.filter((event) => event.endsWith(":focus"))).toEqual(
        focus === "owned" ? ["host:shell:focus"] : [],
      );
      if (focus === "owned")
        expect(f.events).toEqual([
          "page:visible:false",
          "host:remove:page",
          "host:shell:focus",
        ]);
    },
  );
  it("detaches an old live host before reattaching the same page to a new host", () => {
    const f = fixture();
    const next = new Host("next", f.events);
    f.owner.show(f.host, f.view, bounds);
    f.view.webContents.focused = true;
    f.events.length = 0;
    f.owner.show(next, f.view, bounds);
    f.owner.detachHost(f.host);
    expect(f.events).toEqual([
      "page:visible:false",
      "host:remove:page",
      "page:bounds",
      "next:add:page",
      "page:visible:true",
    ]);
    expect(f.host.children).toEqual([]);
    expect(next.children).toEqual([f.view]);
  });
  it("forgets a destroyed host without calling its native APIs", () => {
    const f = fixture();
    f.owner.show(f.host, f.view, bounds);
    f.host.destroyed = true;
    f.owner.detachHost(f.host);
    const next = new Host("next", f.events);
    f.owner.show(next, f.view, bounds);
    expect(next.children).toEqual([f.view]);
    expect(f.owner.focus(f.host, f.view)).toBe(false);
  });
  it("removes a destroyed page without accessing its drawing or focus APIs", () => {
    const f = fixture();
    f.owner.show(f.host, f.view, bounds);
    f.view.webContents.destroyed = true;
    f.events.length = 0;
    f.owner.hide(f.view);
    f.owner.hide(f.view);
    f.owner.show(f.host, f.view, bounds);
    expect(f.events).toEqual(["host:remove:page"]);
    expect(f.host.children).toEqual([]);
  });
  it("refuses to show into a destroyed window", () => {
    const f = fixture();
    f.host.destroyed = true;
    f.owner.show(f.host, f.view, bounds);
    expect(f.events).toEqual([]);
  });
  it("host closure detaches without focus transfer or WebContents destruction", () => {
    const f = fixture();
    f.owner.show(f.host, f.view, bounds);
    f.view.webContents.focused = true;
    f.events.length = 0;
    f.owner.detachHost(f.host);
    f.owner.detachHost(f.host);
    expect(f.events).toEqual(["page:visible:false", "host:remove:page"]);
    expect(f.view.webContents.destroyed).toBe(false);
  });
  it.each(["hidden", "unattached", "inactive", "destroyed", "wrong-host"])(
    "rejects a late focus call for %s pages",
    (reason) => {
      const f = fixture();
      f.owner.show(f.host, f.view, bounds);
      if (reason === "hidden") f.owner.hide(f.view);
      if (reason === "unattached") f.host.children.length = 0;
      if (reason === "inactive") f.host.focused = false;
      if (reason === "destroyed") f.view.webContents.destroyed = true;
      const target =
        reason === "wrong-host" ? new Host("other", f.events) : f.host;
      f.events.length = 0;
      expect(f.owner.focus(target, f.view)).toBe(false);
      expect(f.events).toEqual([]);
    },
  );
  it("focuses a visible attached page only on its active host", () => {
    const f = fixture();
    f.owner.show(f.host, f.view, bounds);
    f.events.length = 0;
    expect(f.owner.focus(f.host, f.view)).toBe(true);
    expect(f.events).toEqual(["page:focus"]);
  });
  it("propagates native removal failure without forgetting ownership", () => {
    const f = fixture();
    f.owner.show(f.host, f.view, bounds);
    f.host.contentView.removeChildView = () => {
      throw Error("NATIVE_REMOVE_FAILED");
    };
    expect(() => f.owner.hide(f.view)).toThrow("NATIVE_REMOVE_FAILED");
    expect(f.host.children).toEqual([f.view]);
    expect(f.owner.focus(f.host, f.view)).toBe(false);
  });
  it("replaces the host's browser lane before adding another view", () => {
    const f = fixture();
    const replacement = new BrowserView("replacement", f.events);
    f.owner.show(f.host, f.view, bounds);
    f.events.length = 0;
    f.owner.show(f.host, replacement, bounds);
    expect(f.host.children).toEqual([replacement]);
    expect(f.events).toEqual([
      "page:visible:false",
      "host:remove:page",
      "replacement:bounds",
      "host:add:replacement",
      "replacement:visible:true",
    ]);
  });
});

const callbackNames = [
  "attachTaskView",
  "attachTaskViews",
  "detachTaskViews",
  "disposeTaskView",
  "applyLayout",
  "applyRendererLayout",
  "focusForLayout",
  "liveChatGptSurfaceFactory",
  "createTaskViews",
] as const;
const source = readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const nodes = parse(source, { sourceType: "module", plugins: ["typescript"] })
  .program.body;
let routeLoadCallback = "";
function findRouteLoadCallback(node: unknown): void {
  if (typeof node !== "object" || node === null) return;
  const value = node as Record<string, unknown>;
  if (
    value.type === "ObjectProperty" &&
    (value.key as { name?: string } | undefined)?.name === "onLoadStateChanged"
  ) {
    const callback = value.value as { start: number; end: number };
    routeLoadCallback = stripTypeScriptTypes(
      source.slice(callback.start, callback.end),
    );
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(findRouteLoadCallback);
    else if (typeof child === "object") findRouteLoadCallback(child);
  }
}
nodes.forEach(findRouteLoadCallback);
if (!routeLoadCallback) throw Error("MISSING_ROUTE_LOAD_CALLBACK");
const callbacks = callbackNames
  .map((name) => {
    const node = nodes.find(
      (node) => node.type === "FunctionDeclaration" && node.id?.name === name,
    );
    if (!node || node.start == null || node.end == null)
      throw Error(`MISSING_CALLBACK:${name}`);
    return stripTypeScriptTypes(source.slice(node.start, node.end));
  })
  .join("\n");

const createWindow = nodes.find(
  (node) =>
    node.type === "FunctionDeclaration" && node.id?.name === "createWindow",
);
if (!createWindow || createWindow.type !== "FunctionDeclaration")
  throw Error("MISSING_CREATE_WINDOW");
const closeCallbacks = createWindow.body.body
  .filter((node) => {
    if (
      node.type !== "ExpressionStatement" ||
      node.expression.type !== "CallExpression"
    )
      return false;
    const { callee, arguments: args } = node.expression;
    return (
      callee.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "window" &&
      callee.property.type === "Identifier" &&
      callee.property.name === "on" &&
      args[0]?.type === "StringLiteral" &&
      ["close", "closed"].includes(args[0].value)
    );
  })
  .map((node) => {
    if (node.start == null || node.end == null)
      throw Error("MISSING_CLOSE_CALLBACK_RANGE");
    return stripTypeScriptTypes(source.slice(node.start, node.end));
  })
  .join("\n");

function desktopFixture() {
  const f = fixture();
  const taskViews = new Map([["page", f.view]]);
  const taskViewKinds = new Map([["page", "chatgpt"]]);
  const context = {
    window: f.host as Host | null,
    nativeViewVisibility: f.owner,
    taskViews,
    taskViewKinds,
    section: "browser",
    selectedTaskId: "page",
    setupOpen: false,
    sidebarMode: "full",
    sidebarWidth: 180,
    shellOverlay: "none",
    quitInProgress: false,
    installedUpdateAdmission: false,
    runtimeState: "ready",
    runtime: { tasks: [{ taskId: "runtime", readToken: "fixture-only" }] },
    runtimeBase: () => "http://fixture.invalid",
    installNetworkFence: () => true,
    partitionName: () => "fixture-only",
    taskSurfaceFailures: new Set<string>(),
    publishTaskSurfaceStatus: () => undefined,
    browserHomeSurfaceOpen: false,
    signInSurfaceOpen: false,
    checkFeedbackVisible: false,
    runtimeEnvironment: "dev",
    demoMode: false,
    legacySetupTestMode: false,
    windowPresentationReady: true,
    stopStreams: () => f.events.push("stop-streams"),
    SIGN_IN_SURFACE_ID: "sign-in",
    channels: { browserRouteState: "fixture-route" },
    embeddedBrowserEnabled: () => true,
    deriveSurfaceLayout,
    ShellLayoutSchema,
    focusForLayoutAfterRendererCommit: () => f.events.push("deferred-focus"),
    compactBrowserSelected: () => false,
    productTasksState: () => ({
      tasks: [...taskViews.keys()].map((taskId) => ({ taskId })),
    }),
    WebContentsView: class extends BrowserView {
      constructor() {
        super("surface", f.events);
      }
    },
    handleShortcut: () => false,
  };
  const api = vm.runInNewContext(
    `${callbacks}\n({${callbackNames.join(",")}, onLoadStateChanged: ${routeLoadCallback}})`,
    context,
  ) as {
    applyLayout(): void;
    onLoadStateChanged(state: "loading" | "loaded" | "failed"): void;
    applyRendererLayout(value: unknown): void;
    attachTaskViews(): void;
    detachTaskViews(): void;
    focusForLayout(): void;
    disposeTaskView(taskId: string, view: BrowserView): void;
    createTaskViews(): Promise<void>;
    liveChatGptSurfaceFactory(taskId: string): (options: {
      webPreferences: object;
    }) => {
      webContents: Contents;
      hide(): void;
      reveal(): void;
      focus(): void;
      destroy(): void;
    };
  };
  vm.runInNewContext(
    `const taskViewHost = window;\n${closeCallbacks}`,
    context,
  );
  return { ...f, context, api, taskViews, taskViewKinds };
}

// Integration of the actual main.ts callbacks with the shared layout function.
// No Electron module, native process, window, filesystem profile, or provider runs.
describe("desktop layout attachment integration (source callbacks + fake host)", () => {
  it.each(["computer", "activity", "settings"])(
    "retains a late first load while %s conceals it and shows the same view on return",
    (section) => {
      const f = desktopFixture();
      f.taskViews.clear();
      f.taskViewKinds.clear();
      f.context.selectedTaskId = "";
      f.context.productTasksState = () => ({ tasks: [] });
      const surface = f.api.liveChatGptSurfaceFactory("sign-in")({
        webPreferences: {},
      });
      const view = f.taskViews.get("sign-in")!;
      f.api.onLoadStateChanged("loading");
      f.context.section = section;
      f.context.setupOpen = section === "settings";
      f.api.applyLayout();
      f.events.length = 0;
      f.api.onLoadStateChanged("loaded");
      surface.reveal();
      surface.focus();
      expect(f.context.section).toBe(section);
      expect(f.host.children).toEqual([]);
      expect(f.events.filter((event) => event.endsWith(":focus"))).toEqual([]);
      expect(f.context.browserHomeSurfaceOpen).toBe(true);
      f.api.applyRendererLayout({
        section: "browser",
        taskId: "",
        setupOpen: false,
        checkFeedbackVisible: false,
        sidebar: "full",
        sidebarWidth: 180,
        overlay: "none",
      });
      expect(f.host.children).toEqual([view]);
      expect(view.webContents).toBe(surface.webContents);
      expect(view.visible).toBe(true);
      expect(view.webContents.destroyed).toBe(false);
    },
  );
  it.each(["loading", "failed"] as const)(
    "concealed %s clears readiness without destroying or exposing the retained view",
    (state) => {
      const f = desktopFixture();
      f.context.browserHomeSurfaceOpen = true;
      f.context.section = "settings";
      f.context.productTasksState = () => ({ tasks: [] });
      f.api.onLoadStateChanged(state);
      expect(f.context.browserHomeSurfaceOpen).toBe(false);
      expect(f.view.webContents.destroyed).toBe(false);
      expect(f.host.children).toEqual([]);
    },
  );
  it.each([
    { section: "activity" },
    { section: "settings" },
    { setupOpen: true },
    { overlay: "quick-switcher" },
    { overlay: "sidebar" },
  ])(
    "conceals a retained page despite an absent or stale renderer selection: %j",
    (change) => {
      for (const taskId of ["", "removed-task"]) {
        const f = desktopFixture();
        f.api.applyLayout();
        expect(f.host.children).toEqual([f.view]);
        f.api.applyRendererLayout({
          section: "browser",
          taskId,
          setupOpen: false,
          sidebar: "full",
          sidebarWidth: 180,
          overlay: "none",
          ...change,
        });
        expect(f.host.children).toEqual([]);
        expect(f.view.visible).toBe(false);
        expect(f.view.webContents.destroyed).toBe(false);
        expect(f.context.selectedTaskId).toBe("page");
      }
    },
  );
  it("never reveals or substitutes a missing browser selection", () => {
    const f = desktopFixture();
    f.context.section = "activity";
    f.api.applyLayout();
    f.events.length = 0;
    for (const taskId of ["", "removed-task"])
      f.api.applyRendererLayout({
        section: "browser",
        taskId,
        setupOpen: false,
        sidebar: "full",
        overlay: "none",
      });
    expect(f.host.children).toEqual([]);
    expect(f.events).toEqual([]);
    expect(f.context.section).toBe("activity");
    expect(f.context.selectedTaskId).toBe("page");
    f.api.applyRendererLayout({
      section: "browser",
      taskId: "page",
      setupOpen: false,
      sidebar: "full",
      overlay: "none",
    });
    expect(f.host.children).toEqual([f.view]);
  });
  it("rejects malformed concealment messages without changing native layout", () => {
    const f = desktopFixture();
    f.api.applyLayout();
    f.events.length = 0;
    f.api.applyRendererLayout({ section: "activity", taskId: "" });
    expect(f.host.children).toEqual([f.view]);
    expect(f.events).toEqual([]);
  });
  it("runtime view destruction detaches its view and preserves another task", async () => {
    const f = desktopFixture();
    f.context.selectedTaskId = "runtime";
    await f.api.createTaskViews();
    const view = f.taskViews.get("runtime");
    expect(view).toBeDefined();
    expect(f.host.children).toEqual([view]);
    view?.webContents.close();
    expect(f.host.children).toEqual([]);
    expect(f.taskViews.has("runtime")).toBe(false);
    expect(f.taskViews.get("page")).toBe(f.view);
  });
  it("late close callbacks only detach their captured host", () => {
    const f = desktopFixture();
    f.api.applyLayout();
    const next = new Host("next", f.events);
    f.context.window = next;
    f.api.attachTaskViews();
    f.events.length = 0;
    f.host.listeners.get("close")?.();
    f.host.destroyed = true;
    f.host.listeners.get("closed")?.();
    expect(next.children).toEqual([f.view]);
    expect(f.context.window).toBe(next);
    expect(f.context.windowPresentationReady).toBe(true);
    expect(f.events).toEqual([]);
  });
  it("current close preserves the page, clears the host, and stops streams once", () => {
    const f = desktopFixture();
    f.api.applyLayout();
    f.view.webContents.focused = true;
    f.events.length = 0;
    f.host.listeners.get("close")?.();
    f.host.destroyed = true;
    f.host.listeners.get("closed")?.();
    expect(f.host.children).toEqual([]);
    expect(f.context.window).toBe(null);
    expect(f.context.windowPresentationReady).toBe(false);
    expect(f.events).toEqual([
      "page:visible:false",
      "host:remove:page",
      "stop-streams",
    ]);
    expect(f.view.webContents.destroyed).toBe(false);
  });
  it.each([
    { setupOpen: true },
    { section: "computer" },
    { section: "activity" },
    { section: "settings" },
    { shellOverlay: "sidebar" },
    { shellOverlay: "task-menu" },
    { shellOverlay: "quick-switcher" },
    { shellOverlay: "context-preview" },
    { installedUpdateAdmission: true },
  ])("detaches the browser while shell-owned state covers it: %j", (change) => {
    const f = desktopFixture();
    f.api.applyLayout();
    expect(f.host.children).toEqual([f.view]);
    f.view.webContents.focused = true;
    Object.assign(f.context, change);
    f.api.applyLayout();
    expect(f.host.children).toEqual([]);
    expect(f.view.visible).toBe(false);
    expect(f.view.webContents.destroyed).toBe(false);
    expect(
      f.events.filter((event) => event === "host:shell:focus"),
    ).toHaveLength(1);
    f.api.applyLayout();
    expect(
      f.events.filter((event) => event === "host:shell:focus"),
    ).toHaveLength(1);
  });
  it("detaches an old tab before attaching the selected tab regardless of insertion order", () => {
    const f = desktopFixture();
    const earlier = new BrowserView("earlier", f.events);
    f.taskViews.clear();
    f.taskViews.set("earlier", earlier);
    f.taskViews.set("page", f.view);
    f.taskViewKinds.set("earlier", "chatgpt");
    f.api.applyLayout();
    f.events.length = 0;
    f.context.selectedTaskId = "earlier";
    f.api.applyLayout();
    expect(f.host.children).toEqual([earlier]);
    expect(f.events.indexOf("host:remove:page")).toBeLessThan(
      f.events.indexOf("host:add:earlier"),
    );
    expect(f.view.webContents.destroyed).toBe(false);
  });
  it("resizes the attached selected view without reordering it or taking focus", () => {
    const f = desktopFixture();
    f.api.applyLayout();
    f.events.length = 0;
    f.context.sidebarWidth = 240;
    f.api.applyLayout();
    expect(f.view.bounds).toEqual({ x: 296, y: 58, width: 884, height: 702 });
    expect(f.events).toEqual(["page:bounds"]);
  });
  it("retains the page through close/detach and reattaches only the visible page to a new window", () => {
    const f = desktopFixture();
    f.api.applyLayout();
    const identity = f.view.webContents;
    f.api.detachTaskViews();
    f.host.destroyed = true;
    const next = new Host("next", f.events);
    f.context.window = next;
    f.api.attachTaskViews();
    f.api.attachTaskViews();
    expect(next.children).toEqual([f.view]);
    expect(f.view.webContents).toBe(identity);
    expect(f.events.filter((event) => event === "next:add:page")).toHaveLength(
      1,
    );
  });
  it("detaches before closing WebContents and ignores repeated dispose calls", () => {
    const f = desktopFixture();
    f.api.applyLayout();
    f.events.length = 0;
    f.api.disposeTaskView("page", f.view);
    f.api.disposeTaskView("page", f.view);
    expect(f.events).toEqual([
      "page:visible:false",
      "host:remove:page",
      "page:close",
    ]);
    expect(f.taskViews.has("page")).toBe(false);
  });
  it("late disposal of an old view leaves a replacement with the same task ID intact", () => {
    const f = desktopFixture();
    f.api.applyLayout();
    const replacement = new BrowserView("replacement", f.events);
    f.taskViews.set("page", replacement);
    f.api.applyLayout();
    f.api.disposeTaskView("page", f.view);
    expect(f.taskViews.get("page")).toBe(replacement);
    expect(f.taskViewKinds.get("page")).toBe("chatgpt");
    expect(f.host.children).toEqual([replacement]);
  });
  it("does not attach or focus on late layout calls after window destruction", () => {
    const f = desktopFixture();
    f.host.destroyed = true;
    f.api.applyLayout();
    f.api.focusForLayout();
    expect(f.events).toEqual([]);
    f.context.window = null;
    f.api.applyLayout();
    f.api.focusForLayout();
  });
  it("ignores deferred focus when the host loses focus or the page is hidden", () => {
    const f = desktopFixture();
    f.api.applyLayout();
    f.host.focused = false;
    f.events.length = 0;
    f.api.focusForLayout();
    expect(f.events).toEqual([]);
    f.host.focused = true;
    f.context.shellOverlay = "context-preview";
    f.api.applyLayout();
    f.events.length = 0;
    f.api.focusForLayout();
    expect(f.events).toEqual(["host:shell:focus"]);
  });
  it("keeps runtime pages detached when the runtime is unavailable", () => {
    const f = desktopFixture();
    f.taskViewKinds.set("page", "runtime");
    f.context.runtimeState = "offline";
    f.api.applyLayout();
    expect(f.host.children).toEqual([]);
  });
  it("attaches the sign-in view only when the shared layout admits it", () => {
    const f = desktopFixture();
    const signIn = new BrowserView("sign-in", f.events);
    f.taskViews.set("sign-in", signIn);
    f.taskViewKinds.set("sign-in", "chatgpt");
    f.api.applyLayout();
    f.context.signInSurfaceOpen = true;
    f.api.applyLayout();
    expect(f.host.children).toEqual([signIn]);
    f.context.setupOpen = true;
    f.api.applyLayout();
    expect(f.host.children).toEqual([]);
  });
  it("live surface hide detaches and hidden focus is refused; reveal retains identity", () => {
    const f = desktopFixture();
    const surface = f.api.liveChatGptSurfaceFactory("live")({
      webPreferences: {},
    });
    f.context.selectedTaskId = "live";
    surface.reveal();
    const view = f.taskViews.get("live");
    expect(f.host.children).toEqual([view]);
    f.events.length = 0;
    surface.hide();
    surface.focus();
    expect(f.host.children).toEqual([]);
    expect(f.events).toEqual(["surface:visible:false", "host:remove:surface"]);
    surface.reveal();
    expect(view?.webContents).toBe(surface.webContents);
    f.host.focused = false;
    f.events.length = 0;
    surface.focus();
    expect(f.events).toEqual([]);
  });
  it("live surface destroy and late reveal/focus preserve a replacement task", () => {
    const f = desktopFixture();
    const surface = f.api.liveChatGptSurfaceFactory("live")({
      webPreferences: {},
    });
    f.context.selectedTaskId = "live";
    surface.reveal();
    surface.destroy();
    const replacement = new BrowserView("replacement", f.events);
    f.taskViews.set("live", replacement);
    f.taskViewKinds.set("live", "chatgpt");
    f.api.applyLayout();
    f.events.length = 0;
    surface.destroy();
    surface.hide();
    surface.reveal();
    surface.focus();
    expect(f.events).toEqual([]);
    expect(f.taskViews.get("live")).toBe(replacement);
    expect(f.host.children).toEqual([replacement]);
  });
  it("independent WebContents destruction removes its attached surface", () => {
    const f = desktopFixture();
    const surface = f.api.liveChatGptSurfaceFactory("live")({
      webPreferences: {},
    });
    f.context.selectedTaskId = "live";
    surface.reveal();
    surface.webContents.close();
    expect(f.taskViews.has("live")).toBe(false);
    expect(f.host.children).toEqual([]);
  });
  it("handles Electron clearing view.webContents before its destroyed callback", () => {
    const f = desktopFixture();
    const surface = f.api.liveChatGptSurfaceFactory("live")({
      webPreferences: {},
    });
    f.context.selectedTaskId = "live";
    surface.reveal();
    const view = f.taskViews.get("live")!;
    const contents = view.webContents;
    Object.defineProperty(view, "webContents", {
      get: () => (contents.destroyed ? undefined : contents),
    });
    expect(() => contents.close()).not.toThrow();
    expect(f.taskViews.has("live")).toBe(false);
    expect(f.host.children).toEqual([]);
    expect(surface.webContents).toBe(contents);
    f.events.length = 0;
    expect(() => {
      surface.hide();
      surface.reveal();
      surface.focus();
      surface.destroy();
      f.api.applyLayout();
    }).not.toThrow();
    expect(f.events).toEqual([]);
  });
});
