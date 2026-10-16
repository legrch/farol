import { beforeEach, describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";

// Electron port fixtures only. Native windows/renderer/lease are qualified separately.
const harness = vi.hoisted(() => ({
  windows: [] as any[],
  appEvents: new Map<string, (...args: any[]) => void>(),
  ipcHandlers: new Map<string, (...args: any[]) => Promise<unknown>>(),
  ipcEvents: new Map<string, (...args: any[]) => void>(),
  screenEvents: new Map<string, (...args: any[]) => void>(),
  quit: vi.fn(),
  loadError: false,
}));
vi.mock("electron", () => ({
  app: {
    on: (event: string, action: (...args: any[]) => void) =>
      harness.appEvents.set(event, action),
    removeListener: (event: string) => harness.appEvents.delete(event),
    quit: harness.quit,
  },
  ipcMain: {
    handle: (channel: string, action: (...args: any[]) => Promise<unknown>) =>
      harness.ipcHandlers.set(channel, action),
    removeHandler: (channel: string) => harness.ipcHandlers.delete(channel),
    on: (event: string, action: (...args: any[]) => void) =>
      harness.ipcEvents.set(event, action),
    removeListener: (event: string) => harness.ipcEvents.delete(event),
  },
  screen: {
    on: (event: string, action: (...args: any[]) => void) =>
      harness.screenEvents.set(event, action),
    removeListener: (event: string) => harness.screenEvents.delete(event),
  },
  Menu: {
    buildFromTemplate: (template: unknown) => template,
    setApplicationMenu: vi.fn(),
  },
  BrowserWindow: class {
    options: any;
    destroyed = false;
    events = new Map<string, (...args: any[]) => void>();
    webContents = {
      mainFrame: { url: "" },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    };
    hide = vi.fn();
    show = vi.fn();
    showInactive = vi.fn();
    setBounds = vi.fn();
    restore = vi.fn();
    constructor(options: unknown) {
      this.options = options;
      harness.windows.push(this);
    }
    on(event: string, action: (...args: any[]) => void) {
      this.events.set(event, action);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() {
      return false;
    }
    destroy() {
      this.destroyed = true;
      this.events.get("closed")?.();
    }
    async loadFile(file: string, options: { hash: string }) {
      this.webContents.mainFrame.url =
        pathToFileURL(file).href + "#" + options.hash;
      if (harness.loadError) throw new Error("load failed");
    }
  },
}));
import { openStartupRecoveryWindow } from "../../apps/desktop/recovery/host";

beforeEach(() => {
  harness.windows = [];
  harness.appEvents.clear();
  harness.ipcEvents.clear();
  harness.ipcHandlers.clear();
  harness.screenEvents.clear();
  harness.quit.mockClear();
  harness.loadError = false;
});
function options(mode: "hidden" | "default" | "secondary-visible" = "hidden") {
  return {
    directory: "/fixture/recovery",
    session: {
      state: vi.fn(async () => ({ status: "settings_unavailable" as const })),
      read: vi.fn(async (_input: unknown) => ({ status: "refused" as const })),
      close: vi.fn(async () => undefined),
    },
    mode,
    placement: vi.fn(() => ({ x: -1000, y: 40, width: 640, height: 520 })),
    quitSignals: { ready: vi.fn(), dispose: vi.fn() },
    onQuitting: vi.fn(),
  };
}
describe("startup recovery window lifetime", () => {
  it("loads a dedicated isolated document without exposing normal desktop IPC", async () => {
    const input = options();
    const view = openStartupRecoveryWindow(input);
    await view.ready;
    const win = harness.windows[0];
    expect(win.options.webPreferences).toEqual({
      preload: "/fixture/recovery/preload.cjs",
      additionalArguments: ["--farol-startup-recovery"],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect([...harness.ipcEvents.keys()]).toEqual([
      "farol:startup-recovery:quit",
    ]);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({
      action: "deny",
    });
    const event = { preventDefault: vi.fn() };
    win.webContents.on.mock.calls[0][1](event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(input.quitSignals.ready).toHaveBeenCalledOnce();
    view.dispose();
    expect(harness.quit).not.toHaveBeenCalled();
    expect(
      harness.appEvents.size +
        harness.ipcEvents.size +
        harness.ipcHandlers.size +
        harness.screenEvents.size,
    ).toBe(0);
    expect(input.quitSignals.dispose).toHaveBeenCalledOnce();
  });
  it("accepts Quit only from the exact local main frame", async () => {
    const view = openStartupRecoveryWindow(options());
    await view.ready;
    const win = harness.windows[0],
      send = harness.ipcEvents.get("farol:startup-recovery:quit")!;
    send({ sender: {}, senderFrame: win.webContents.mainFrame });
    send({
      sender: win.webContents,
      senderFrame: { url: win.webContents.mainFrame.url },
    });
    win.webContents.mainFrame.url = "https://example.invalid/";
    send({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
    expect(harness.quit).not.toHaveBeenCalled();
    win.webContents.mainFrame.url =
      "file:///fixture/recovery/shell.html#farol-startup-recovery";
    send({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
    expect(harness.quit).toHaveBeenCalledOnce();
    view.dispose();
  });
  it("defers actual Quit until its caller releases startup exclusion", async () => {
    const input = options("default"),
      view = openStartupRecoveryWindow(input);
    await view.ready;
    const event = { preventDefault: vi.fn() };
    harness.appEvents.get("before-quit")!(event);
    harness.appEvents.get("before-quit")!(event);
    await view.quitRequested;
    expect(input.onQuitting).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    const win = harness.windows[0];
    expect(win.hide).toHaveBeenCalledOnce();
    await view.reopen();
    expect(win.show).toHaveBeenCalledOnce();
    expect(harness.quit).not.toHaveBeenCalled();
    view.dispose();
    view.dispose();
    expect(input.quitSignals.dispose).toHaveBeenCalledOnce();
  });
  it("reuses its own window and hides when its selected display disappears", async () => {
    const input = options("secondary-visible"),
      view = openStartupRecoveryWindow(input);
    await view.ready;
    const win = harness.windows[0];
    await view.reopen();
    expect(harness.windows).toHaveLength(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.showInactive).toHaveBeenCalledTimes(2);
    expect(win.options).toMatchObject(input.placement());
    input.placement.mockImplementation(() => {
      throw new Error("display removed");
    });
    harness.screenEvents.get("display-removed")!();
    expect(win.hide).toHaveBeenCalledOnce();
    expect(win.showInactive).toHaveBeenCalledTimes(2);
    view.dispose();
  });
  it("preserves a failed load as failed and lets the caller perform bounded cleanup", async () => {
    harness.loadError = true;
    const view = openStartupRecoveryWindow(options());
    await expect(view.ready).rejects.toThrow("load failed");
    await expect(view.reopen()).rejects.toThrow("load failed");
    view.dispose();
    expect(harness.windows[0].destroyed).toBe(true);
    expect(harness.quit).not.toHaveBeenCalled();
  });
});

it("binds state/read IPC to the exact document and never exposes normal actions", async () => {
  const input = options(),
    view = openStartupRecoveryWindow(input);
  await view.ready;
  const win = harness.windows[0],
    event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const state = harness.ipcHandlers.get("farol:startup-recovery:state")!,
    read = harness.ipcHandlers.get("farol:startup-recovery:read")!;
  expect([...harness.ipcHandlers.keys()].sort()).toEqual([
    "farol:startup-recovery:read",
    "farol:startup-recovery:state",
  ]);
  await expect(
    state({ sender: {}, senderFrame: event.senderFrame }),
  ).rejects.toThrow("STARTUP_RECOVERY_DOCUMENT_UNAVAILABLE");
  await expect(
    read(
      { sender: event.sender, senderFrame: { url: event.senderFrame.url } },
      {},
    ),
  ).rejects.toThrow("STARTUP_RECOVERY_DOCUMENT_UNAVAILABLE");
  expect(input.session.state).not.toHaveBeenCalled();
  expect(input.session.read).not.toHaveBeenCalled();
  expect(await state(event)).toEqual({ status: "settings_unavailable" });
  expect(await read(event, { kind: "shell" })).toEqual({ status: "refused" });
  expect(input.session.read).toHaveBeenCalledExactlyOnceWith({ kind: "shell" });
  view.dispose();
  expect(harness.ipcHandlers.size).toBe(0);
});
it("withholds IPC results when Quit crosses the original session read", async () => {
  const input = options();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  input.session.read.mockImplementationOnce(async () => {
    await pending;
    return { status: "refused" };
  });
  const view = openStartupRecoveryWindow(input);
  await view.ready;
  const win = harness.windows[0];
  const result = harness.ipcHandlers.get("farol:startup-recovery:read")!(
    { sender: win.webContents, senderFrame: win.webContents.mainFrame },
    {},
  );
  harness.appEvents.get("before-quit")!({ preventDefault: vi.fn() });
  release();
  await expect(result).rejects.toThrow("STARTUP_RECOVERY_DOCUMENT_UNAVAILABLE");
  expect(input.session.close).not.toHaveBeenCalled(); // The startup caller owns closure.
  view.dispose();
});
