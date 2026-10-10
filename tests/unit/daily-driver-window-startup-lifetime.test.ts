import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";

// Actual host startup functions and existing route/stream helpers. Native
// mechanics, route settlements and fetch dispatches are controlled; this does
// not exercise Electron, native load ordering or a provider connection.
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const callbacks = [
  "createWindow",
  "createTaskViews",
  "openLiveTaskSurface",
  "consumeSse",
  "revealWindow",
  "attachTaskViews",
  "disposeTaskView",
].map((name) => {
  const node = tree.program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === name,
  );
  if (!node || node.start === null || node.end === null)
    throw new Error(`WINDOW_STARTUP_CALLBACK_MISSING:${name}`);
  return source.slice(node.start, node.end);
});

type Stage = "shell" | "view" | "selected";
type Withdrawal = "close" | "replace" | "quit" | "update";
type Event = {
  kind: string;
  detail: string | number | undefined;
  late: boolean;
};

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function host({
  stage = "shell",
  reentrant,
  extraBackground = false,
}: {
  stage?: Stage;
  reentrant?: { event: string; action: Withdrawal };
  extraBackground?: boolean;
} = {}) {
  const reached = deferred();
  const pending = deferred();
  const events: Event[] = [];
  const destroyedViews = new Map<number, () => void>();
  let interrupted = false;
  let reentered = false;
  let ordinal = 0;
  let captured!: FakeWindow;
  const context = {
    path,
    directory: "/controlled-only",
    windowMode: "default",
    displayWindowTitle: "Controlled host",
    initialWindowSize: { width: 800, height: 600 },
    process: { platform: "linux", stderr: { write: () => undefined } },
    buildIdentity: { buildId: "controlled-only" },
    window: null as FakeWindow | null,
    windowPresentationReady: false,
    quitInProgress: false,
    installedUpdateAdmission: false,
    runtimeStopping: false,
    runtimeState: "ready",
    demoMode: false,
    runtime: {
      port: 0,
      tasks: [
        { taskId: "runtime-1", readToken: "controlled-only" },
        { taskId: "runtime-2", readToken: "controlled-only" },
      ],
    } as {
      port: number;
      tasks: { taskId: string; readToken: string }[];
    } | null,
    runtimeBase: () => "http://controlled.invalid",
    partitionName: () => "controlled-only",
    selectedTaskId: "selected",
    taskViews: new Map<string, { webContents: { isDestroyed(): boolean } }>(),
    taskViewKinds: new Map<string, string>(),
    taskSurfaceFailures: new Set(["runtime-1", "runtime-2"]),
    streamControllers: new Map<string, AbortController>(),
    pendingComputer: new Map(),
    observeRendererLifecycle: () => undefined,
    handleShortcut: () => false,
    AbortController,
    TextDecoder,
    encodeURIComponent,
    presentationAction: () => "show-and-focus",
    liveTaskRegistry: { get: () => ({ lifecycle: "idle" }) },
  };
  const record = (kind: string, detail?: string | number) => {
    events.push({ kind, detail, late: interrupted });
    if (!reentered && kind === reentrant?.event) {
      reentered = true;
      withdraw(reentrant.action);
    }
  };
  function withdraw(action: Withdrawal) {
    interrupted = true;
    if (action === "close") captured.close();
    if (action === "replace") {
      context.window = new FakeWindow();
      context.windowPresentationReady = false;
      // The old native close callback must not detach the replacement host.
      captured.close();
    }
    if (action === "quit") context.quitInProgress = true;
    if (action === "update") context.installedUpdateAdmission = true;
  }
  const waitAt = (current: Stage) => {
    if (stage !== current) return Promise.resolve();
    reached.resolve();
    return pending.promise;
  };
  class FakeWindow {
    destroyed = false;
    listeners = new Map<string, () => void>();
    webContents = { setWindowOpenHandler() {}, on() {} };
    constructor() {
      record("window-create");
    }
    on(name: string, callback: () => void) {
      this.listeners.set(name, callback);
    }
    loadFile() {
      record("shell-load");
      return waitAt("shell");
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    show() {
      record("show");
    }
    close() {
      this.listeners.get("close")?.();
      this.destroyed = true;
      this.listeners.get("closed")?.();
    }
  }
  class FakeView {
    webContents: {
      isDestroyed(): boolean;
      once(name: string, callback: () => void): void;
      on(): void;
      setWindowOpenHandler(): void;
      loadURL(): Promise<void>;
      close(): void;
    };
    constructor() {
      const id = ++ordinal;
      let destroyed = false;
      record("view-create", id);
      this.webContents = {
        isDestroyed: () => destroyed,
        once(name, callback) {
          if (name === "destroyed") destroyedViews.set(id, callback);
        },
        on() {},
        setWindowOpenHandler() {},
        loadURL: () => {
          record("view-load", id);
          return id === 1 ? waitAt("view") : Promise.resolve();
        },
        close: () => {
          destroyed = true;
          record("view-close", id);
        },
      };
    }
    setVisible() {}
  }
  Object.assign(context, {
    BrowserWindow: class extends FakeWindow {
      constructor() {
        super();
        captured = this;
      }
    },
    WebContentsView: FakeView,
    installNetworkFence: () => {
      record("network-fence");
      return true;
    },
    applyLayout: () => record("layout"),
    publishWindowState: () => record("publish-window"),
    focusForLayoutAfterRendererCommit: () => record("focus-layout"),
    publishTaskSurfaceStatus: (status: { taskId: string }) => {
      record("publish-task", status.taskId);
    },
    setLiveTaskLifecycle: (taskId: string) => record("task-lifecycle", taskId),
    failTaskSurface: (taskId: string) => record("fail-task", taskId),
    nativeViewVisibility: {
      detachHost: () => record("detach-host"),
      hide: () => record("hide-view"),
    },
    stopStreams: () => {
      record("stop-streams");
      for (const controller of context.streamControllers.values()) {
        controller.abort();
      }
      context.streamControllers.clear();
    },
    // The real consumeSse starts, then its fetch promise remains pending with
    // no I/O, response body, timers or native resources.
    fetch: () => {
      record("stream-dispatch");
      return new Promise(() => {});
    },
    liveTaskRoutes: new Map([
      [
        "selected",
        {
          open: async () => {
            record("selected-open");
            await waitAt("selected");
            return { status: "opened" };
          },
        },
      ],
      [
        "background",
        {
          open: async () => {
            record("background-open");
            return { status: "opened" };
          },
        },
      ],
      ...(extraBackground
        ? ([
            [
              "background-2",
              {
                open: async () => {
                  record("background-open");
                  return { status: "opened" };
                },
              },
            ],
          ] as const)
        : []),
    ]),
  });
  const actions = vm.runInNewContext(
    stripTypeScriptTypes(
      `${callbacks.join("\n")}\n({ create: createWindow, views: createTaskViews })`,
    ),
    context,
  ) as { create(): Promise<void>; views(): Promise<void> };
  const count = (kind: string, lateOnly = false) =>
    events.filter((event) => event.kind === kind && (!lateOnly || event.late))
      .length;
  return {
    ...actions,
    context,
    events,
    count,
    withdraw,
    reached: reached.promise,
    finish: pending.resolve,
    reject: pending.reject,
    captured: () => captured,
    fireViewDestroyed: (id: number) => {
      const callback = destroyedViews.get(id);
      if (!callback) throw new Error("CONTROLLED_DESTROYED_CALLBACK_MISSING");
      callback();
    },
  };
}

const stages = ["shell", "view", "selected"] as const;
const withdrawals = ["close", "replace", "quit", "update"] as const;

it.each(
  stages.flatMap((stage) => withdrawals.map((action) => ({ stage, action }))),
)(
  "withdraws subsequent startup stages after $action during $stage",
  async ({ stage, action }) => {
    const h = host({ stage });
    const creating = h.create();
    await h.reached;
    h.withdraw(action);
    const withdrawnHost = h.context.window;
    h.finish();
    await creating;
    expect(h.context.window).toBe(withdrawnHost);
    expect(h.context.windowPresentationReady).toBe(false);
    for (const kind of [
      "view-create",
      "view-load",
      "background-open",
      "stream-dispatch",
      "show",
    ]) {
      expect(h.count(kind, true), kind).toBe(0);
    }
    if (stage !== "selected") {
      expect(h.count("selected-open")).toBe(0);
    }
    if (stage === "view") {
      expect(
        h.events.some(
          (event) =>
            event.kind === "publish-task" &&
            event.detail === "runtime-1" &&
            event.late,
        ),
      ).toBe(false);
      // The admitted successful view is not canceled or destroyed here.
      expect(h.count("view-close")).toBe(0);
    }
  },
);

it.each(stages)(
  "retains healthy startup through the %s await",
  async (stage) => {
    const h = host({ stage });
    const creating = h.create();
    await h.reached;
    h.finish();
    await creating;
    expect(h.context.window).toBe(h.captured());
    expect(h.context.windowPresentationReady).toBe(true);
    expect(h.count("view-load")).toBe(2);
    expect(h.count("selected-open")).toBe(1);
    expect(h.count("background-open")).toBe(1);
    expect(h.count("stream-dispatch")).toBe(2);
    expect(h.count("show")).toBe(1);
  },
);

it("retains runtimeStopping-only offline diagnostic startup", async () => {
  const h = host();
  h.context.runtimeStopping = true;
  h.context.runtimeState = "failed";
  h.context.runtime = null;
  h.context.demoMode = true;
  const creating = h.create();
  await h.reached;
  h.finish();
  await creating;
  expect(h.context.windowPresentationReady).toBe(true);
  expect(h.count("show")).toBe(1);
  expect(h.count("view-load")).toBe(0);
  expect(h.count("stream-dispatch")).toBe(0);
});

it.each(["quit", "update"] as const)(
  "refuses a new host when %s already owns admission",
  async (action) => {
    const h = host();
    h.context[
      action === "quit" ? "quitInProgress" : "installedUpdateAdmission"
    ] = true;
    h.finish();
    await h.create();
    expect(h.count("window-create")).toBe(0);
  },
);

it.each(["shell", "view"] as const)(
  "preserves an admitted %s load rejection after close",
  async (stage) => {
    const h = host({ stage });
    const error = new Error("CONTROLLED_LOAD_FAILURE");
    const creating = h.create();
    const rejected = expect(creating).rejects.toBe(error);
    await h.reached;
    h.withdraw("close");
    h.reject(error);
    await rejected;
    expect(h.context.windowPresentationReady).toBe(false);
    expect(h.count("background-open")).toBe(0);
    expect(h.count("show")).toBe(0);
  },
);

it("keeps healthy retained runtime views without creating replacements", async () => {
  const h = host();
  const retained = { webContents: { isDestroyed: () => false } };
  h.context.taskViews.set("runtime-1", retained);
  h.context.taskViews.set("runtime-2", retained);
  const creating = h.create();
  await h.reached;
  h.finish();
  await creating;
  expect(h.context.taskViews.get("runtime-1")).toBe(retained);
  expect(h.context.taskViews.get("runtime-2")).toBe(retained);
  expect(h.count("view-create")).toBe(0);
  expect(h.count("show")).toBe(1);
});

it("retains fulfilled load outcome when the admitted view's contents disappear", async () => {
  const h = host({ stage: "view" });
  const creating = h.create();
  await h.reached;
  const admitted = h.context.taskViews.get("runtime-1");
  expect(admitted).toBeDefined();
  // The load was already dispatched. The native contents can disappear
  // before its destroyed callback has removed the retained map entry.
  Object.defineProperty(admitted, "webContents", { value: undefined });
  h.finish();
  await expect(creating).resolves.toBeUndefined();
  expect(h.context.taskViews.get("runtime-1")).toBe(admitted);
  expect(
    h.events.some(
      (event) => event.kind === "publish-task" && event.detail === "runtime-1",
    ),
  ).toBe(false);
  expect(h.count("view-load")).toBe(1);
});

it("replaces a cleared retained view on the next host without stale callback deletion", async () => {
  const h = host({ stage: "view" });
  const creating = h.create();
  await h.reached;
  const stale = h.context.taskViews.get("runtime-1");
  expect(stale).toBeDefined();
  Object.defineProperty(stale, "webContents", { value: undefined });
  h.finish();
  await creating;
  h.withdraw("replace");
  await expect(h.views()).resolves.toBeUndefined();
  const replacement = h.context.taskViews.get("runtime-1");
  expect(replacement).toBeDefined();
  expect(replacement).not.toBe(stale);
  expect(h.count("view-load")).toBe(3);
  h.fireViewDestroyed(1);
  expect(h.context.taskViews.get("runtime-1")).toBe(replacement);
  expect(h.count("view-close")).toBe(0);
});

it("rechecks after window-state publication before creating views", async () => {
  const h = host({ reentrant: { event: "publish-window", action: "close" } });
  const creating = h.create();
  await h.reached;
  h.finish();
  await creating;
  expect(h.count("view-create")).toBe(0);
  expect(h.count("background-open")).toBe(0);
  expect(h.context.windowPresentationReady).toBe(false);
});

it("rechecks after a view's ready publication before dispatching the next view", async () => {
  const h = host({
    stage: "view",
    reentrant: { event: "publish-task", action: "update" },
  });
  const creating = h.create();
  await h.reached;
  h.finish();
  await creating;
  expect(h.count("view-load")).toBe(1);
  expect(h.count("background-open")).toBe(0);
  expect(h.context.windowPresentationReady).toBe(false);
});

it("rechecks before each background route dispatch", async () => {
  const h = host({
    extraBackground: true,
    reentrant: { event: "background-open", action: "update" },
  });
  const creating = h.create();
  await h.reached;
  h.finish();
  await creating;
  expect(h.count("background-open")).toBe(1);
  expect(h.count("stream-dispatch")).toBe(0);
  expect(h.count("show")).toBe(0);
  expect(h.context.windowPresentationReady).toBe(false);
});

it("rechecks before each stream dispatch and presentation", async () => {
  const h = host({ reentrant: { event: "stream-dispatch", action: "update" } });
  const creating = h.create();
  await h.reached;
  h.finish();
  await creating;
  expect(h.count("stream-dispatch")).toBe(1);
  expect(h.count("show")).toBe(0);
  expect(h.context.windowPresentationReady).toBe(false);
});
