import { describe, expect, it, vi } from "vitest";
import { channels } from "../../../src/pkg/ipc/channels";
import { defaultNavigationShortcuts } from "../../../src/pkg/ipc/navigation-shortcuts";
import { updatesChannels } from "../renderer/updates/contract";
import { createIpc, type IpcPorts } from "./ipc";

// The table is exercised through a recording `ipcMain`: every channel it
// registers, the kind of each, and what each handler does with a trusted and an
// untrusted sender. The ports are fakes; nothing here loads Electron.

type Kind = "on" | "handle";
type Listener = (event: never, ...args: unknown[]) => unknown;
type Registration = Readonly<{
  channel: string;
  kind: Kind;
  listener: Listener;
}>;

const frame = { id: "main-frame" };
const otherFrame = { id: "other-frame" };

function fake<T>(value: unknown): T {
  return value as T;
}

function harness(
  overrides: Partial<{
    window: object | null;
    closed: boolean;
    snapshot: unknown;
    updater: object | null;
    installedUpdateData: { kind: string } | null;
    runtime: unknown;
    pending: unknown;
    selectedTaskId: string;
    section: string;
    setupOpen: boolean;
    shellOverlay: string;
    chatGptRoute: unknown;
    liveRoute: unknown;
    startupConnectionChecking: boolean;
    connectionAdmission: boolean;
    controlData: unknown;
    expected: readonly { taskId: string }[];
    surfaceFailed: boolean;
  }> = {},
) {
  const registered: Registration[] = [];
  const order: string[] = [];
  const state = {
    window: (overrides.window === undefined
      ? { webContents: { mainFrame: frame }, isDestroyed: () => false }
      : overrides.window) as {
      webContents: { mainFrame: object };
      isDestroyed: () => boolean;
    } | null,
    closed: overrides.closed ?? false,
    startupConnectionChecking: overrides.startupConnectionChecking ?? false,
    connectionAdmission: overrides.connectionAdmission ?? false,
    section: overrides.section ?? "browser",
    setupOpen: overrides.setupOpen ?? false,
    shellOverlay: overrides.shellOverlay ?? "none",
    selectedTaskId: overrides.selectedTaskId ?? "task-1",
    runtime:
      overrides.runtime === undefined
        ? {
            tasks: [
              {
                ownerId: "owner",
                sessionId: "session",
                taskId: "task-1",
                turnId: "turn",
                generation: 3,
              },
            ],
          }
        : overrides.runtime,
    desktopGoCore: { id: "core" } as object | null,
  };
  const panel = {
    bindOwner: vi.fn(),
    publish: vi.fn(),
    settle: vi.fn(),
    settleDirect: vi.fn(),
    relay: vi.fn(),
    close: vi.fn(),
    isPanel: vi.fn(() => false),
    isOwner: vi.fn(() => false),
    state: vi.fn(() => ({ status: "unavailable" })),
    open: vi.fn(async (_options: unknown) => {}),
    beginDirect: vi.fn(() => true),
    endDirect: vi.fn(),
  };
  const operations = {
    setWorkspaceLabels: vi.fn(() => {
      order.push("labels");
    }),
    snapshot: vi.fn(async () => ({ entries: [{ id: 1 }], corruptLines: 2 })),
  };
  const calls = {
    runSelfTestCommand: vi.fn(
      async (
        _core: () => unknown,
        _accepting: () => boolean,
        _value: unknown,
      ) => "self-test",
    ),
    readChatHistoryView: vi.fn(
      async (_core: () => unknown, _value: unknown) => "history",
    ),
    readRetiredRepliesView: vi.fn(
      async (_core: () => unknown, _value: unknown) => "retired",
    ),
    bootstrap: vi.fn(() => "bootstrap"),
    runtimeJson: vi.fn(async (..._args: unknown[]) => "runtime-json"),
    configureProduct: vi.fn((_value: unknown) => "configured"),
    configurationFailure: vi.fn((code: string) => ({ failure: code })),
    runProductTaskCommand: vi.fn((_value: unknown) => "task-run"),
    taskFailure: vi.fn((code: string) => ({ failure: code })),
    setNavigationShortcuts: vi.fn(),
    installApplicationMenu: vi.fn(),
    runContextFixtureControl: vi.fn(async (..._args: unknown[]) => "fixture"),
    applyRendererLayout: vi.fn(),
    connectionAdmissionInProgress: vi.fn(() => state.connectionAdmission),
    selectedVisibleTestPlacement: vi.fn((_size: unknown) => ({
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    })),
    travelHistory: vi.fn((_direction: -1 | 1) => true),
    navigationHistory: vi.fn(() => ({ back: true, forward: false })),
    taskSurfaceFailures: vi.fn(() => overrides.surfaceFailed ?? false),
    pendingGet: vi.fn((_id: string) => overrides.pending),
    command: vi.fn(async (_value: unknown) => "command-result"),
  };
  const route = {
    travelHistory: calls.travelHistory,
    navigationHistory: calls.navigationHistory,
  };
  const chatGptRoute = overrides.chatGptRoute ?? route;
  const liveRoute = overrides.liveRoute ?? route;
  const liveRouteLookup = vi.fn((_id: string): unknown => liveRoute);
  const installedUpdateData =
    overrides.installedUpdateData === undefined
      ? { kind: "check" }
      : overrides.installedUpdateData;
  const controlData = overrides.controlData;
  const ports: IpcPorts = {
    ipcMain: {
      on: (channel, listener) => {
        order.push(`on:${channel}`);
        registered.push({ channel, kind: "on", listener });
      },
      handle: (channel, listener) => {
        order.push(`handle:${channel}`);
        registered.push({ channel, kind: "handle", listener });
      },
    },
    window: () => fake(state.window),
    updatesPanel: fake(panel),
    installedUpdates: {
      updater: overrides.updater === undefined ? {} : overrides.updater,
      resources: () => ({ directory: "/app" }),
      command: calls.command,
    },
    desktopAdmission: { closed: () => state.closed },
    windowMode: "hidden",
    UPDATES_PANEL_SIZE: { width: 400, height: 340 },
    selectedVisibleTestPlacement: calls.selectedVisibleTestPlacement,
    configuration: () =>
      overrides.snapshot === undefined
        ? null
        : fake({ snapshot: () => overrides.snapshot }),
    operationsStore: () => fake(operations),
    startupConnectionChecking: () => state.startupConnectionChecking,
    connectionAdmissionInProgress: calls.connectionAdmissionInProgress,
    runSelfTestCommand: calls.runSelfTestCommand,
    desktopGoCore: () => fake(state.desktopGoCore),
    installedUpdateCommandSchema: {
      safeParse: () =>
        installedUpdateData
          ? { success: true, data: installedUpdateData }
          : { success: false },
    },
    bootstrap: calls.bootstrap,
    runtimeJson: calls.runtimeJson,
    configureProduct: calls.configureProduct,
    configurationFailure: calls.configurationFailure,
    readChatHistoryView: calls.readChatHistoryView,
    readRetiredRepliesView: calls.readRetiredRepliesView,
    runProductTaskCommand: calls.runProductTaskCommand,
    taskFailure: calls.taskFailure,
    setNavigationShortcuts: calls.setNavigationShortcuts,
    installApplicationMenu: calls.installApplicationMenu,
    controlSchema: {
      safeParse: () =>
        controlData
          ? { success: true, data: fake(controlData) }
          : { success: false },
    },
    runContextFixtureControl: calls.runContextFixtureControl,
    expectedTasks: overrides.expected ?? [{ taskId: "task-1" }],
    runtime: () => fake(state.runtime),
    taskSurfaceFailures: { has: calls.taskSurfaceFailures },
    pendingComputer: { get: fake(calls.pendingGet) },
    section: () => fake(state.section),
    setupOpen: () => state.setupOpen,
    shellOverlay: () => fake(state.shellOverlay),
    selectedTaskId: () => state.selectedTaskId,
    chatGptRoute: () => fake(chatGptRoute),
    liveTaskRoutes: { get: fake(liveRouteLookup) },
    applyRendererLayout: calls.applyRendererLayout,
  };
  createIpc(ports).install();
  const find = (channel: string): Registration => {
    const found = registered.find((entry) => entry.channel === channel);
    if (!found) throw new Error(`NOT_REGISTERED:${channel}`);
    return found;
  };
  const trusted = () => ({
    sender: state.window?.webContents,
    senderFrame: frame,
  });
  const untrusted = () => ({ sender: {}, senderFrame: frame });
  const invoke = (
    channel: string,
    event: unknown,
    ...args: unknown[]
  ): unknown => find(channel).listener(fake<never>(event), ...args);
  return {
    registered,
    order,
    state,
    panel,
    operations,
    calls,
    liveRouteLookup,
    trusted,
    untrusted,
    invoke,
  };
}

describe("IPC table registration", () => {
  it("registers the same channels, in the same order, with the same kinds", () => {
    const h = harness();
    expect(
      h.registered.map((entry) => `${entry.kind}:${entry.channel}`),
    ).toEqual([
      `on:${updatesChannels.projection}`,
      `on:${updatesChannels.settled}`,
      `on:${updatesChannels.directSettled}`,
      `on:${updatesChannels.intent}`,
      `on:${updatesChannels.close}`,
      `handle:${updatesChannels.state}`,
      `on:${updatesChannels.open}`,
      `handle:${channels.operations}`,
      `handle:${channels.selfTest}`,
      `handle:${channels.installedUpdate}`,
      `handle:${channels.bootstrap}`,
      `handle:${channels.snapshot}`,
      `handle:${channels.configuration}`,
      `handle:${channels.chatHistory}`,
      `handle:${channels.retiredReplies}`,
      `handle:${channels.task}`,
      `handle:${channels.navigationShortcuts}`,
      `handle:${channels.control}`,
      `handle:${channels.browserHistory}`,
      `on:${channels.layout}`,
    ]);
  });

  it("registers no channel twice", () => {
    const h = harness();
    expect(new Set(h.registered.map((entry) => entry.channel)).size).toBe(
      h.registered.length,
    );
  });

  it("labels the operations store between the updates channels and the first product channel", () => {
    const h = harness({
      snapshot: {
        status: "ready",
        settings: { computer: { workspaces: ["a", "b"] } },
      },
    });
    expect(h.operations.setWorkspaceLabels).toHaveBeenCalledWith(["a", "b"]);
    expect(h.order.indexOf("labels")).toBe(
      h.order.indexOf(`on:${updatesChannels.open}`) + 1,
    );
    expect(h.order.indexOf("labels")).toBe(
      h.order.indexOf(`handle:${channels.operations}`) - 1,
    );
  });

  it("leaves the labels alone without a ready configuration", () => {
    expect(
      harness({ snapshot: { status: "failed" } }).operations.setWorkspaceLabels,
    ).not.toHaveBeenCalled();
    expect(harness().operations.setWorkspaceLabels).not.toHaveBeenCalled();
  });
});

describe("IPC sender trust", () => {
  // Every renderer-to-main channel whose answer for an untrusted sender is the
  // one it always gave, with the port that must stay untouched.
  const refusals: ReadonlyArray<
    Readonly<{
      channel: string;
      args: unknown[];
      answer: unknown;
      untouched: (h: ReturnType<typeof harness>) => unknown;
    }>
  > = [
    {
      channel: channels.operations,
      args: [],
      answer: { entries: [], corruptLines: 0, writeFailures: 1 },
      untouched: (h) => h.operations.snapshot,
    },
    {
      channel: channels.selfTest,
      args: [{}],
      answer: { ok: false, code: "SELF_TEST_UNAVAILABLE" },
      untouched: (h) => h.calls.runSelfTestCommand,
    },
    {
      channel: channels.installedUpdate,
      args: [{ kind: "check" }, "op"],
      answer: { error: "IPC_SENDER_DENIED" },
      untouched: (h) => h.calls.command,
    },
    {
      channel: channels.bootstrap,
      args: [],
      answer: { error: "IPC_SENDER_DENIED" },
      untouched: (h) => h.calls.bootstrap,
    },
    {
      channel: channels.snapshot,
      args: [],
      answer: { error: "IPC_SENDER_DENIED" },
      untouched: (h) => h.calls.runtimeJson,
    },
    {
      channel: channels.configuration,
      args: [{}],
      answer: { failure: "SETTINGS_UNAVAILABLE" },
      untouched: (h) => h.calls.configureProduct,
    },
    {
      channel: channels.chatHistory,
      args: [{}],
      answer: { error: "IPC_SENDER_DENIED" },
      untouched: (h) => h.calls.readChatHistoryView,
    },
    {
      channel: channels.retiredReplies,
      args: [{}],
      answer: { error: "IPC_SENDER_DENIED" },
      untouched: (h) => h.calls.readRetiredRepliesView,
    },
    {
      channel: channels.task,
      args: [{}],
      answer: { failure: "TASKS_UNAVAILABLE" },
      untouched: (h) => h.calls.runProductTaskCommand,
    },
    {
      channel: channels.navigationShortcuts,
      args: [defaultNavigationShortcuts],
      answer: { ok: false },
      untouched: (h) => h.calls.setNavigationShortcuts,
    },
    {
      channel: channels.control,
      args: [{}],
      answer: { error: "IPC_SENDER_DENIED" },
      untouched: (h) => h.calls.runtimeJson,
    },
    {
      channel: channels.browserHistory,
      args: [{ taskId: "task-1", direction: 1 }],
      answer: { handled: false, taskId: "", back: false, forward: false },
      untouched: (h) => h.calls.travelHistory,
    },
    {
      channel: channels.layout,
      args: [{}],
      answer: undefined,
      untouched: (h) => h.calls.applyRendererLayout,
    },
  ];

  it("covers exactly the thirteen product channels the contract names", () => {
    expect(refusals.map((entry) => entry.channel)).toEqual(
      harness()
        .registered.map((entry) => entry.channel)
        .filter(
          (channel) =>
            !(Object.values(updatesChannels) as string[]).includes(channel),
        ),
    );
  });

  for (const entry of refusals) {
    it(`refuses ${entry.channel} for a sender that is not the owned window`, async () => {
      const h = harness({
        controlData: { taskId: "task-1", action: "finish-demo" },
      });
      expect(
        await h.invoke(entry.channel, h.untrusted(), ...entry.args),
      ).toEqual(entry.answer);
      expect(entry.untouched(h)).not.toHaveBeenCalled();
    });

    it(`refuses ${entry.channel} while there is no window`, async () => {
      const h = harness({
        window: null,
        controlData: { taskId: "task-1", action: "finish-demo" },
      });
      expect(
        await h.invoke(
          entry.channel,
          { sender: {}, senderFrame: frame },
          ...entry.args,
        ),
      ).toEqual(entry.answer);
      expect(entry.untouched(h)).not.toHaveBeenCalled();
    });
  }

  it("answers an in-flight sender from a replaced window with a refusal", async () => {
    const h = harness();
    const old = h.trusted();
    h.state.window = {
      webContents: { mainFrame: frame },
      isDestroyed: () => false,
    };
    expect(await h.invoke(channels.bootstrap, old)).toEqual({
      error: "IPC_SENDER_DENIED",
    });
    expect(h.calls.bootstrap).not.toHaveBeenCalled();
    expect(h.invoke(channels.bootstrap, h.trusted())).toBe("bootstrap");
  });

  it("limits the self-test effect to the trusted main frame", async () => {
    const h = harness();
    const mainFrame = { id: "sender-main" };
    const sender = { mainFrame };
    h.state.window = {
      webContents: fake(sender),
      isDestroyed: () => false,
    };
    expect(
      h.invoke(channels.selfTest, { sender, senderFrame: otherFrame }, {}),
    ).toEqual({ ok: false, code: "SELF_TEST_UNAVAILABLE" });
    expect(h.calls.runSelfTestCommand).not.toHaveBeenCalled();
    await expect(
      h.invoke(channels.selfTest, { sender, senderFrame: mainFrame }, {}),
    ).resolves.toBe("self-test");
  });
});

describe("updates channels", () => {
  it("publishes a projection only from the owned window's main frame", () => {
    const h = harness();
    const owner = h.state.window;
    h.invoke(
      updatesChannels.projection,
      { sender: {}, senderFrame: frame },
      {},
    );
    h.invoke(
      updatesChannels.projection,
      { sender: owner?.webContents, senderFrame: { ...frame } },
      {},
    );
    expect(h.panel.bindOwner).not.toHaveBeenCalled();
    const event = h.trusted();
    h.invoke(updatesChannels.projection, event, { projection: true });
    expect(h.panel.bindOwner).toHaveBeenCalledWith(owner, "/app");
    expect(h.panel.publish).toHaveBeenCalledWith(event, { projection: true });
  });

  it("does not publish while there is no window", () => {
    const h = harness({ window: null });
    h.invoke(updatesChannels.projection, h.untrusted(), {});
    expect(h.panel.bindOwner).not.toHaveBeenCalled();
    expect(h.panel.publish).not.toHaveBeenCalled();
  });

  it("routes settled, direct-settled, intent and close to the panel with the event", () => {
    const h = harness();
    const event = h.trusted();
    h.invoke(updatesChannels.settled, event, "a");
    h.invoke(updatesChannels.directSettled, event, "b");
    h.invoke(updatesChannels.intent, event, "c");
    h.invoke(updatesChannels.close, event);
    expect(h.panel.settle).toHaveBeenCalledWith(event, "a");
    expect(h.panel.settleDirect).toHaveBeenCalledWith(event, "b");
    expect(h.panel.relay).toHaveBeenCalledWith(event, "c");
    expect(h.panel.close).toHaveBeenCalledWith(event);
  });

  it("answers state only for the panel", () => {
    const h = harness();
    expect(h.invoke(updatesChannels.state, {})).toEqual({
      status: "unavailable",
    });
    expect(h.panel.state).not.toHaveBeenCalled();
    h.panel.isPanel.mockReturnValue(true);
    h.panel.state.mockReturnValue({ status: "panel-state" });
    expect(h.invoke(updatesChannels.state, {})).toEqual({
      status: "panel-state",
    });
  });

  it("opens only for the shell owner, an existing window and an open admission", async () => {
    const h = harness();
    const event = h.trusted();
    h.invoke(updatesChannels.open, event);
    expect(h.panel.open).not.toHaveBeenCalled();
    h.panel.isOwner.mockReturnValue(true);
    h.state.closed = true;
    h.invoke(updatesChannels.open, event);
    expect(h.panel.open).not.toHaveBeenCalled();
    h.state.closed = false;
    h.state.window = null;
    h.invoke(updatesChannels.open, event);
    expect(h.panel.open).not.toHaveBeenCalled();
  });

  it("opens with the owner, directory, mode, placement and a live admission", () => {
    const h = harness();
    const owner = h.state.window;
    h.panel.isOwner.mockReturnValue(true);
    h.invoke(updatesChannels.open, h.trusted());
    expect(h.panel.open).toHaveBeenCalledOnce();
    const options = h.panel.open.mock.calls[0]![0] as {
      owner: unknown;
      directory: string;
      mode: string;
      place: () => unknown;
      admitted: () => boolean;
    };
    expect(options.owner).toBe(owner);
    expect(options.directory).toBe("/app");
    expect(options.mode).toBe("hidden");
    expect(options.place()).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(h.calls.selectedVisibleTestPlacement).toHaveBeenCalledWith({
      width: 400,
      height: 340,
    });
    expect(options.admitted()).toBe(true);
    h.state.closed = true;
    expect(options.admitted()).toBe(false);
    h.state.closed = false;
    h.state.window = {
      webContents: { mainFrame: frame },
      isDestroyed: () => false,
    };
    expect(options.admitted()).toBe(false);
    h.state.window = owner;
    expect(options.admitted()).toBe(true);
    if (owner) owner.isDestroyed = () => true;
    expect(options.admitted()).toBe(false);
  });

  it("logs a failed presentation once and does not rethrow", async () => {
    const h = harness();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.panel.isOwner.mockReturnValue(true);
    h.panel.open.mockRejectedValue(new Error("x"));
    h.invoke(updatesChannels.open, h.trusted());
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith("DESKTOP_UPDATES_PRESENTATION_FAILED");
    error.mockRestore();
  });
});

describe("product channels route to their ports for the owned window", () => {
  it("operations adds the live checking flag to the snapshot", async () => {
    const h = harness();
    expect(await h.invoke(channels.operations, h.trusted())).toEqual({
      entries: [{ id: 1 }],
      corruptLines: 2,
      connectionChecking: false,
    });
    h.state.startupConnectionChecking = true;
    expect(
      (await h.invoke(channels.operations, h.trusted())) as {
        connectionChecking: boolean;
      },
    ).toMatchObject({ connectionChecking: true });
    h.state.startupConnectionChecking = false;
    h.state.connectionAdmission = true;
    expect(
      (await h.invoke(channels.operations, h.trusted())) as {
        connectionChecking: boolean;
      },
    ).toMatchObject({ connectionChecking: true });
  });

  it("selfTest reads the core and the admission when the command runs", async () => {
    const h = harness();
    const main = { id: "m" };
    const sender = { mainFrame: main };
    h.state.window = {
      webContents: fake(sender),
      isDestroyed: () => false,
    };
    await expect(
      h.invoke(channels.selfTest, { sender, senderFrame: main }, { v: 1 }),
    ).resolves.toBe("self-test");
    const [core, accepting, value] = h.calls.runSelfTestCommand.mock.calls[0]!;
    expect(value).toEqual({ v: 1 });
    expect(core()).toBe(h.state.desktopGoCore);
    h.state.desktopGoCore = null;
    expect(core()).toBeNull();
    expect(accepting()).toBe(true);
    h.state.closed = true;
    expect(accepting()).toBe(false);
  });

  it("installedUpdate tracks a non-status command and brackets it", async () => {
    const h = harness();
    const event = h.trusted();
    await expect(
      h.invoke(channels.installedUpdate, event, { kind: "check" }, "op"),
    ).resolves.toBe("command-result");
    expect(h.panel.beginDirect).toHaveBeenCalledWith(event, "op");
    expect(h.panel.endDirect).toHaveBeenCalledWith(
      event,
      "op",
      true,
      "command-result",
    );
  });

  it("installedUpdate refuses a tracked command the panel cannot begin", async () => {
    const h = harness();
    h.panel.beginDirect.mockReturnValue(false);
    await expect(
      h.invoke(channels.installedUpdate, h.trusted(), { kind: "check" }, "op"),
    ).resolves.toEqual({ phase: "unavailable", code: "UPDATE_ACTION_INVALID" });
    expect(h.calls.command).not.toHaveBeenCalled();
    expect(h.panel.endDirect).not.toHaveBeenCalled();
  });

  it("installedUpdate does not track status, an invalid command or a missing updater", async () => {
    for (const overrides of [
      { installedUpdateData: { kind: "status" } },
      { installedUpdateData: null },
      { updater: null },
    ]) {
      const h = harness(overrides);
      await expect(
        h.invoke(channels.installedUpdate, h.trusted(), { kind: "x" }, "op"),
      ).resolves.toBe("command-result");
      expect(h.panel.beginDirect).not.toHaveBeenCalled();
      expect(h.panel.endDirect).not.toHaveBeenCalled();
    }
  });

  it("installedUpdate closes a tracked command as not returned when the host throws", async () => {
    const h = harness();
    h.calls.command.mockRejectedValue(new Error("boom"));
    const event = h.trusted();
    await expect(
      h.invoke(channels.installedUpdate, event, { kind: "check" }, "op"),
    ).rejects.toThrow("boom");
    expect(h.panel.endDirect).toHaveBeenCalledWith(
      event,
      "op",
      false,
      undefined,
    );
  });

  it("bootstrap, snapshot, configuration and task answer from their ports", async () => {
    const h = harness();
    expect(h.invoke(channels.bootstrap, h.trusted())).toBe("bootstrap");
    expect(await h.invoke(channels.snapshot, h.trusted())).toBe("runtime-json");
    expect(h.calls.runtimeJson).toHaveBeenCalledWith("/snapshot");
    expect(h.invoke(channels.configuration, h.trusted(), { a: 1 })).toBe(
      "configured",
    );
    expect(h.calls.configureProduct).toHaveBeenCalledWith({ a: 1 });
    expect(h.invoke(channels.task, h.trusted(), { b: 2 })).toBe("task-run");
    expect(h.calls.runProductTaskCommand).toHaveBeenCalledWith({ b: 2 });
  });

  it("chatHistory and retiredReplies read the core at the moment they run", async () => {
    const h = harness();
    await h.invoke(channels.chatHistory, h.trusted(), { q: 1 });
    await h.invoke(channels.retiredReplies, h.trusted(), { q: 2 });
    const [historyCore, historyValue] =
      h.calls.readChatHistoryView.mock.calls[0]!;
    const [retiredCore, retiredValue] =
      h.calls.readRetiredRepliesView.mock.calls[0]!;
    expect([historyValue, retiredValue]).toEqual([{ q: 1 }, { q: 2 }]);
    const first = h.state.desktopGoCore;
    expect(historyCore()).toBe(first);
    expect(retiredCore()).toBe(first);
    h.state.desktopGoCore = { id: "next" };
    expect(historyCore()).toBe(h.state.desktopGoCore);
    expect(retiredCore()).toBe(h.state.desktopGoCore);
  });
});

describe("navigation shortcuts channel", () => {
  it("refuses while the admission is closed, without parsing", () => {
    const h = harness();
    h.state.closed = true;
    expect(
      h.invoke(
        channels.navigationShortcuts,
        h.trusted(),
        defaultNavigationShortcuts,
      ),
    ).toEqual({ ok: false });
    expect(h.calls.setNavigationShortcuts).not.toHaveBeenCalled();
    expect(h.calls.installApplicationMenu).not.toHaveBeenCalled();
  });

  it("refuses an unparsable value", () => {
    const h = harness();
    expect(
      h.invoke(channels.navigationShortcuts, h.trusted(), { nonsense: true }),
    ).toEqual({ ok: false });
    expect(h.calls.setNavigationShortcuts).not.toHaveBeenCalled();
    expect(h.calls.installApplicationMenu).not.toHaveBeenCalled();
  });

  it("stores a parsed value, then rebuilds the menu", () => {
    const h = harness();
    h.calls.setNavigationShortcuts.mockImplementation(() => {
      h.order.push("set");
    });
    h.calls.installApplicationMenu.mockImplementation(() => {
      h.order.push("menu");
    });
    expect(
      h.invoke(
        channels.navigationShortcuts,
        h.trusted(),
        defaultNavigationShortcuts,
      ),
    ).toEqual({ ok: true });
    expect(h.calls.setNavigationShortcuts).toHaveBeenCalledWith(
      expect.objectContaining({ sidebar: expect.any(String) }),
    );
    expect(h.order.slice(-2)).toEqual(["set", "menu"]);
  });
});

describe("control channel", () => {
  const correlation = {
    ownerId: "owner",
    sessionId: "session",
    taskId: "task-1",
    turnId: "turn",
    generation: 3,
  };

  it("answers an update in progress before it checks the sender", async () => {
    const h = harness();
    h.state.closed = true;
    expect(await h.invoke(channels.control, h.untrusted(), {})).toEqual({
      error: "UPDATE_IN_PROGRESS",
    });
  });

  it("runs the context fixtures from the parsed command", async () => {
    for (const action of [
      "compact-context-fixture",
      "confirm-context-fixture",
    ]) {
      const h = harness({ controlData: { taskId: "any-task", action } });
      await expect(h.invoke(channels.control, h.trusted(), {})).resolves.toBe(
        "fixture",
      );
      expect(h.calls.runContextFixtureControl).toHaveBeenCalledWith(
        "any-task",
        action,
      );
      expect(h.calls.runtimeJson).not.toHaveBeenCalled();
    }
  });

  it("refuses an invalid command and a task that is not expected", async () => {
    const invalid = harness();
    await expect(
      invalid.invoke(channels.control, invalid.trusted(), {}),
    ).resolves.toEqual({ error: "IPC_CONTROL_INVALID" });
    const unexpected = harness({
      controlData: { taskId: "other", action: "finish-demo" },
    });
    await expect(
      unexpected.invoke(channels.control, unexpected.trusted(), {}),
    ).resolves.toEqual({ error: "IPC_CONTROL_INVALID" });
  });

  it("reports an offline runtime, a failed stream and a missing pending call", async () => {
    const offline = harness({
      runtime: null,
      controlData: { taskId: "task-1", action: "finish-demo" },
    });
    await expect(
      offline.invoke(channels.control, offline.trusted(), {}),
    ).resolves.toEqual({ error: "RUNTIME_OFFLINE" });
    const missingTask = harness({
      runtime: { tasks: [] },
      controlData: { taskId: "task-1", action: "finish-demo" },
    });
    await expect(
      missingTask.invoke(channels.control, missingTask.trusted(), {}),
    ).resolves.toEqual({ error: "RUNTIME_OFFLINE" });
    const failed = harness({
      surfaceFailed: true,
      controlData: { taskId: "task-1", action: "finish-demo" },
    });
    await expect(
      failed.invoke(channels.control, failed.trusted(), {}),
    ).resolves.toEqual({ error: "TASK_STREAM_FAILED" });
    const notPending = harness({
      controlData: { taskId: "task-1", action: "release-tool" },
    });
    await expect(
      notPending.invoke(channels.control, notPending.trusted(), {}),
    ).resolves.toEqual({ error: "CONTROL_NOT_PENDING" });
  });

  it("posts a demo control with a null call id", async () => {
    const h = harness({
      controlData: { taskId: "task-1", action: "finish-demo" },
    });
    await expect(h.invoke(channels.control, h.trusted(), {})).resolves.toBe(
      "runtime-json",
    );
    expect(h.calls.runtimeJson).toHaveBeenCalledWith(
      "/control/task-1/finish-demo",
      "POST",
      { ...correlation, callId: null },
    );
    expect(h.calls.pendingGet).not.toHaveBeenCalled();
  });

  it("posts a release-tool control with the pending call id", async () => {
    const h = harness({
      controlData: { taskId: "task-1", action: "release-tool" },
      pending: { ...correlation, generation: 9, callId: "call-7" },
    });
    await expect(h.invoke(channels.control, h.trusted(), {})).resolves.toBe(
      "runtime-json",
    );
    expect(h.calls.pendingGet).toHaveBeenCalledWith("task-1");
    expect(h.calls.runtimeJson).toHaveBeenCalledWith(
      "/control/task-1/release-tool",
      "POST",
      { ...correlation, generation: 9, callId: "call-7" },
    );
  });

  it("encodes the task id in the path", async () => {
    const h = harness({
      expected: [{ taskId: "a/b c" }],
      runtime: { tasks: [{ ...correlation, taskId: "a/b c" }] },
      controlData: { taskId: "a/b c", action: "finish-demo" },
    });
    await h.invoke(channels.control, h.trusted(), {});
    expect(h.calls.runtimeJson.mock.calls[0]![0]).toBe(
      "/control/a%2Fb%20c/finish-demo",
    );
  });
});

describe("browser history channel", () => {
  const request = { taskId: "task-1", direction: 1 };
  const refused = { handled: false, taskId: "", back: false, forward: false };

  it("travels the selected task's route and reports its history", () => {
    const h = harness();
    expect(h.invoke(channels.browserHistory, h.trusted(), request)).toEqual({
      handled: true,
      taskId: "task-1",
      back: true,
      forward: false,
    });
    expect(h.calls.travelHistory).toHaveBeenCalledWith(1);
    expect(h.liveRouteLookup).toHaveBeenCalledWith("task-1");
  });

  it("uses the ChatGPT route when no task is selected", () => {
    const own = {
      travelHistory: vi.fn(() => false),
      navigationHistory: vi.fn(() => ({ back: false, forward: true })),
    };
    const h = harness({ selectedTaskId: "", chatGptRoute: own });
    expect(
      h.invoke(channels.browserHistory, h.trusted(), {
        taskId: "",
        direction: -1,
      }),
    ).toEqual({ handled: false, taskId: "", back: false, forward: true });
    expect(own.travelHistory).toHaveBeenCalledWith(-1);
    expect(h.liveRouteLookup).not.toHaveBeenCalled();
  });

  it("answers handled false without a route", () => {
    const h = harness({ liveRoute: undefined });
    h.liveRouteLookup.mockReturnValue(undefined);
    expect(h.invoke(channels.browserHistory, h.trusted(), request)).toEqual({
      handled: false,
      taskId: "task-1",
      back: false,
      forward: false,
    });
  });

  it("refuses a malformed request, a closed admission and every other surface", () => {
    const cases: Array<[string, () => ReturnType<typeof harness>, unknown]> = [
      ["malformed", () => harness(), { taskId: "task-1", direction: 2 }],
      ["extra", () => harness(), { ...request, extra: true }],
      ["long", () => harness(), { taskId: "x".repeat(201), direction: 1 }],
      ["other task", () => harness(), { taskId: "task-2", direction: 1 }],
      [
        "closed",
        () => {
          const h = harness();
          h.state.closed = true;
          return h;
        },
        request,
      ],
      ["section", () => harness({ section: "activity" }), request],
      ["setup", () => harness({ setupOpen: true }), request],
      ["overlay", () => harness({ shellOverlay: "quick-switcher" }), request],
    ];
    for (const [, build, value] of cases) {
      const h = build();
      expect(h.invoke(channels.browserHistory, h.trusted(), value)).toEqual(
        refused,
      );
      expect(h.calls.travelHistory).not.toHaveBeenCalled();
    }
  });
});

describe("layout channel", () => {
  it("applies a layout from the owned window", () => {
    const h = harness();
    h.invoke(channels.layout, h.trusted(), { width: 1 });
    expect(h.calls.applyRendererLayout).toHaveBeenCalledWith({ width: 1 });
  });

  it("ignores a layout while the admission is closed", () => {
    const h = harness();
    h.state.closed = true;
    h.invoke(channels.layout, h.trusted(), {});
    expect(h.calls.applyRendererLayout).not.toHaveBeenCalled();
  });
});
