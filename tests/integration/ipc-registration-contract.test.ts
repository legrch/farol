import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createIpc, type IpcPorts } from "../../apps/desktop/shell/ipc";
import { channels } from "../../src/pkg/ipc/channels";
import { defaultNavigationShortcuts } from "../../src/pkg/ipc/navigation-shortcuts";

// S35-TA-9. This guards REGISTRATION COMPLETENESS and the sender check each
// registration makes.
//
// What the predicate does when it runs is covered by the eight cases in
// `tests/unit/ipc-sender.test.ts`, which call `isTrustedIpcSender` directly.
// What that cannot cover is the handler nobody wrote yet, or one that never
// asked. The registrations live in `createIpc(ports).install()` in
// `apps/desktop/shell/ipc.ts`, which takes its ports as arguments, so this
// builds the table against a recording `ipcMain` and enumerates what it really
// registers instead of reading source text. The regression this file exists for
// is another privileged channel, registered next year by someone who does not
// notice that checking the sender is part of registering one.
//
// The predicate is replaced by a spy that defaults to the real one. Each
// channel is exercised twice: once to see that it asked the predicate with the
// event and the window this process owns, and once with the predicate answering
// false while the sender really is the owned window, to see that it refused
// instead of ignoring the answer. Every port a command would reach throws, so a
// handler that ran its command after a refusal fails here by rejecting.
//
// Note on scope: only these registered channels are renderer-to-main. The others
// are main-to-renderer sends and correctly have no sender check, which is why
// this counts registrations rather than iterating the channel list — a test
// built on the channel list would demand checks on outbound channels and be
// wrong.

const trust = vi.hoisted(() => ({
  spy: undefined as unknown,
  real: undefined as unknown,
}));

vi.mock("../../src/apps/desktop/ipc-sender", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/apps/desktop/ipc-sender")>();
  trust.real = actual.isTrustedIpcSender;
  trust.spy = vi.fn(actual.isTrustedIpcSender);
  return { isTrustedIpcSender: trust.spy };
});

type Predicate =
  typeof import("../../src/apps/desktop/ipc-sender").isTrustedIpcSender;

function spy(): Mock<Predicate> {
  if (!trust.spy) throw new Error("PREDICATE_SPY_MISSING");
  return trust.spy as Mock<Predicate>;
}

const mainSource = path.resolve(
  import.meta.dirname,
  "../../src/apps/desktop/main.ts",
);
const tableSource = path.resolve(
  import.meta.dirname,
  "../../apps/desktop/shell/ipc.ts",
);

type Kind = "on" | "handle";
type Registered = Readonly<{
  channel: string;
  kind: Kind;
  listener: (event: never, ...args: unknown[]) => unknown;
}>;

const mainFrame = { id: "main-frame" };
const owned = {
  webContents: { mainFrame },
  isDestroyed: () => false,
};

function unused(): never {
  throw new Error("PORT_REACHED_AFTER_REFUSAL");
}

function event(sender: unknown, senderFrame: unknown): never {
  return { sender, senderFrame } as never;
}

/** The table built against a recording ipcMain, in registration order. */
function table(): ReadonlyArray<Registered> {
  const recorded: Registered[] = [];
  const task = {
    ownerId: "owner",
    sessionId: "session",
    taskId: "task-1",
    turnId: "turn",
    generation: 1,
  };
  const ports: IpcPorts = {
    ipcMain: {
      on: (channel, listener) =>
        recorded.push({ channel, kind: "on", listener }),
      handle: (channel, listener) =>
        recorded.push({ channel, kind: "handle", listener }),
    },
    window: () => owned as never,
    updatesPanel: {
      bindOwner: unused,
      publish: unused,
      settle: unused,
      settleDirect: unused,
      relay: unused,
      close: unused,
      isPanel: unused,
      isOwner: unused,
      state: unused,
      open: unused,
      beginDirect: unused,
      endDirect: unused,
    },
    installedUpdates: {
      updater: null,
      resources: () => ({ directory: "/app" }),
      command: unused,
    },
    desktopAdmission: { closed: () => false },
    windowMode: "hidden",
    UPDATES_PANEL_SIZE: { width: 400, height: 340 },
    selectedVisibleTestPlacement: unused,
    configuration: () => null,
    operationsStore: () => ({ setWorkspaceLabels: unused, snapshot: unused }),
    startupConnectionChecking: () => false,
    connectionAdmissionInProgress: () => false,
    runSelfTestCommand: unused,
    desktopGoCore: () => null,
    installedUpdateCommandSchema: { safeParse: () => ({ success: false }) },
    bootstrap: unused,
    runtimeJson: unused,
    configureProduct: unused,
    configurationFailure: (error) => ({ failure: error }),
    readChatHistoryView: unused,
    readRetiredRepliesView: unused,
    runProductTaskCommand: unused,
    taskFailure: (error) => ({ failure: error }),
    setNavigationShortcuts: unused,
    installApplicationMenu: unused,
    controlSchema: {
      safeParse: () => ({
        success: true,
        data: { taskId: "task-1", action: "finish-demo" },
      }),
    },
    runContextFixtureControl: unused,
    expectedTasks: [{ taskId: "task-1" }],
    runtime: () => ({ tasks: [task] }),
    taskSurfaceFailures: { has: () => false },
    pendingComputer: { get: unused },
    section: () => "browser",
    setupOpen: () => false,
    shellOverlay: () => "none",
    selectedTaskId: () => "task-1",
    chatGptRoute: () => null,
    liveTaskRoutes: { get: unused },
    applyRendererLayout: unused,
  };
  createIpc(ports).install();
  return recorded;
}

// A request that carries each channel past its own validation to its sender
// check, and, were that check ignored, on to a port that throws.
const requests: Readonly<Record<string, readonly unknown[]>> = {
  [channels.installedUpdate]: [{ kind: "check" }, "operation"],
  [channels.navigationShortcuts]: [defaultNavigationShortcuts],
  [channels.browserHistory]: [{ taskId: "task-1", direction: 1 }],
};

/** The renderer-to-main registrations of the product channels. */
function product(found: ReadonlyArray<Registered>): ReadonlyArray<Registered> {
  const names = new Set<string>(Object.values(channels));
  return found.filter((entry) => names.has(entry.channel));
}

describe("privileged IPC registration contract", () => {
  beforeEach(() => {
    spy().mockReset();
    spy().mockImplementation(trust.real as Predicate);
  });

  it("limits the self-test effect to the trusted main frame", async () => {
    const selfTest = table().find(
      (entry) => entry.channel === channels.selfTest,
    );
    expect(selfTest?.kind).toBe("handle");
    const source = await fs.readFile(tableSource, "utf8");
    expect(source).toContain("event.senderFrame === event.sender.mainFrame");
    // The sender is the owned window itself, speaking from another frame: the
    // command never runs (its port throws) and the answer is the refusal.
    expect(
      selfTest?.listener(event(owned.webContents, { id: "child" }), {}),
    ).toEqual({ ok: false, code: "SELF_TEST_UNAVAILABLE" });
  });

  it("S35-TA-9 every ipcMain registration checks the sender through the named predicate", async () => {
    const found = product(table());

    // If this list changes, the change is the point: a new privileged
    // channel must be added here deliberately, with its check.
    expect(found.map((entry) => entry.channel)).toEqual([
      channels.operations,
      channels.selfTest,
      channels.installedUpdate,
      channels.bootstrap,
      channels.snapshot,
      channels.configuration,
      channels.chatHistory,
      channels.retiredReplies,
      channels.task,
      channels.navigationShortcuts,
      channels.control,
      channels.browserHistory,
      channels.layout,
    ]);
    // The kind each registration has always had: only the layout report is a
    // one-way send; every other channel answers its caller.
    expect(found.map((entry) => entry.kind)).toEqual([
      ...Array<Kind>(12).fill("handle"),
      "on",
    ]);

    for (const entry of found) {
      spy().mockClear();
      const sent = event({}, mainFrame);
      await entry.listener(sent, ...(requests[entry.channel] ?? [{}]));
      // Asked, with this event and the window this process owns right now.
      expect(spy(), entry.channel).toHaveBeenCalledWith(sent, owned);
    }
  });

  it("S35-TA-9 a handler refuses when the predicate says no, instead of ignoring the answer", async () => {
    for (const entry of product(table())) {
      spy().mockReset();
      spy().mockReturnValue(false);
      // The sender is the owned window and its main frame: only the predicate
      // stands between this call and the command's port.
      await entry.listener(
        event(owned.webContents, mainFrame),
        ...(requests[entry.channel] ?? [{}]),
      );
      expect(spy(), entry.channel).toHaveBeenCalledOnce();
    }
  });

  it("S35-TA-9 no registration compares the sender inline instead of using the predicate", async () => {
    // The existing copies were each correct; repetition is how another
    // handler comes to be written without one. A reviewer looking for the
    // check should find one spelling of it, not a family of them.
    for (const file of [mainSource, tableSource]) {
      const source = await fs.readFile(file, "utf8");
      expect(source).not.toContain("event.sender === window?.webContents");
      expect(source).not.toContain("event.sender !== window?.webContents");
      expect(source).not.toContain("event.sender === window()?.webContents");
      expect(source).not.toContain("event.sender !== window()?.webContents");
    }
  });

  it("S35-TA-9 the predicate this file names is the one the table imports", async () => {
    // Guards the test itself: a renamed or removed export would otherwise
    // leave both assertions above passing against a string that means
    // nothing.
    const source = await fs.readFile(tableSource, "utf8");
    expect(source).toContain(
      'import { isTrustedIpcSender } from "../../../src/apps/desktop/ipc-sender";',
    );
    const module = await vi.importActual<
      typeof import("../../src/apps/desktop/ipc-sender")
    >("../../src/apps/desktop/ipc-sender");
    expect(typeof module.isTrustedIpcSender).toBe("function");
  });
});
