import { beforeEach, describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import {
  updatesChannels,
  type UpdatesProjection,
} from "../../apps/desktop/renderer/updates/contract";

const harness = vi.hoisted(() => ({
  windows: [] as any[],
  loadError: false,
  sendError: false,
}));
vi.mock("electron", () => {
  class Events {
    listeners = new Map<string, ((...args: any[]) => void)[]>();
    on(name: string, action: (...args: any[]) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), action]);
    }
    once(name: string, action: (...args: any[]) => void) {
      this.on(name, action);
    }
    emit(name: string, ...args: any[]) {
      for (const action of this.listeners.get(name) ?? []) action(...args);
    }
  }
  class Contents extends Events {
    mainFrame = { url: "" };
    isDestroyed = () => false;
    getURL = () => this.mainFrame.url;
    setWindowOpenHandler = vi.fn();
    send = vi.fn((channel: string, _value: unknown) => {
      if (harness.sendError && channel === updatesChannels.command)
        throw Error("lost send result");
    });
  }
  return {
    screen: {
      getDisplayMatching: () => ({
        workArea: { x: 100, y: 30, width: 1000, height: 800 },
      }),
    },
    BrowserWindow: class extends Events {
      destroyed = false;
      webContents = new Contents();
      setBounds = vi.fn();
      show = vi.fn();
      showInactive = vi.fn();
      hide = vi.fn();
      constructor(public options: any) {
        super();
        harness.windows.push(this);
      }
      getBounds() {
        return { x: 100, y: 30, width: 900, height: 700 };
      }
      isDestroyed() {
        return this.destroyed;
      }
      close() {
        this.destroy();
      }
      destroy() {
        this.destroyed = true;
        this.emit("closed");
      }
      async loadURL(url: string) {
        this.webContents.mainFrame.url = url;
        if (harness.loadError) throw Error("load failure");
      }
    },
  };
});
import { BrowserWindow } from "electron";
import { DesktopUpdatesPanel } from "../../apps/desktop/updates-panel";

const projection: UpdatesProjection = {
  update: { phase: "idle", checkedAt: null },
  installedVersion: "0.4.0",
  outcome: null,
  automaticEnabled: false,
  allowed: {
    check: true,
    download: false,
    skip: false,
    later: false,
    "restart-confirmed": false,
    automatic: true,
    recovery: true,
  },
};
const event = (window: any) => ({
  sender: window.webContents,
  senderFrame: window.webContents.mainFrame,
});
beforeEach(() => {
  harness.windows = [];
  harness.loadError = false;
  harness.sendError = false;
});
async function fixture(
  mode: "default" | "hidden" | "secondary-visible" = "hidden",
) {
  const owner = new BrowserWindow({});
  await owner.loadURL(pathToFileURL("/app/shell.html").href);
  const panel = new DesktopUpdatesPanel();
  panel.bindOwner(owner, "/app");
  panel.publish(event(owner), projection);
  let admitted = true;
  const options = {
    owner,
    directory: "/app",
    mode,
    place: () => ({ x: -1200, y: 50, width: 480, height: 560 }),
    admitted: () => admitted,
  };
  await panel.open(options);
  return {
    owner: owner as any,
    panel,
    options,
    window: harness.windows[1],
    admission: (value: boolean) => {
      admitted = value;
    },
  };
}

describe("Updates panel native fixture (no Electron process or installed updater)", () => {
  it("uses only existing attested assets, is nonmodal and coalesces opens", async () => {
    const f = await fixture("secondary-visible");
    await f.panel.open(f.options);
    expect(harness.windows).toHaveLength(2);
    expect(f.window.options).toMatchObject({
      modal: false,
      parent: f.owner,
      x: -1200,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        preload: "/app/preload.cjs",
        additionalArguments: ["--farol-updates"],
      },
    });
    expect(f.window.webContents.getURL()).toBe(
      "file:///app/shell.html#farol-updates",
    );
    expect(f.window.showInactive).toHaveBeenCalledTimes(2);
    expect(f.window.show).not.toHaveBeenCalled();
    expect(f.owner.webContents.send).not.toHaveBeenCalled();
  });
  it.each(["sender", "subframe", "url"])(
    "denies a spoofed %s for state, intent and projection",
    async (fault) => {
      const f = await fixture();
      const forged = event(f.window);
      if (fault === "sender") forged.sender = f.owner.webContents;
      if (fault === "subframe")
        forged.senderFrame = { url: f.window.webContents.getURL() };
      if (fault === "url") f.window.webContents.mainFrame.url += "-other";
      expect(f.panel.isPanel(forged)).toBe(false);
      f.panel.relay(forged, { kind: "check" });
      f.panel.publish(forged, { ...projection, outcome: "unknown" });
      expect(f.owner.webContents.send).not.toHaveBeenCalled();
      expect(f.panel.state()).toMatchObject({ projection: { outcome: null } });
    },
  );
  it("rejects panel projection/settlement and shell effect relay", async () => {
    const f = await fixture();
    f.panel.publish(event(f.window), { ...projection, outcome: "unknown" });
    f.panel.relay(event(f.owner), { kind: "check" });
    f.panel.relay(event(f.window), { kind: "check", arbitrary: true });
    expect(f.owner.webContents.send).not.toHaveBeenCalled();
    f.panel.relay(event(f.window), { kind: "check" });
    f.panel.settle(event(f.window), { sequence: 1 });
    f.panel.settle(event(f.owner), { sequence: 2 });
    expect(f.panel.state()).toMatchObject({ pending: true });
  });
  it.each(["sender", "subframe", "url"])(
    "denies an owner %s spoof without clearing the relay",
    async (fault) => {
      const f = await fixture();
      f.panel.relay(event(f.window), { kind: "check" });
      const forged = event(f.owner);
      if (fault === "sender") forged.sender = f.window.webContents;
      if (fault === "subframe")
        forged.senderFrame = { url: f.owner.webContents.getURL() };
      if (fault === "url") f.owner.webContents.mainFrame.url += "-other";
      expect(f.panel.isOwner(forged)).toBe(false);
      f.panel.publish(forged, { ...projection, outcome: "unknown" });
      f.panel.settle(forged, { sequence: 1 });
      if (fault === "url")
        f.owner.webContents.mainFrame.url = "file:///app/shell.html";
      expect(f.panel.state()).toMatchObject({
        pending: true,
        projection: { outcome: null },
      });
    },
  );
  it("retains the original relay across close/reopen and observation publications", async () => {
    const f = await fixture();
    f.panel.relay(event(f.window), { kind: "check" });
    f.window.close();
    await f.panel.open(f.options);
    const reopened = harness.windows[2];
    f.panel.publish(event(f.owner), projection);
    f.panel.relay(event(reopened), { kind: "check" });
    expect(f.owner.webContents.send).toHaveBeenCalledExactlyOnceWith(
      updatesChannels.command,
      { sequence: 1, intent: { kind: "check" } },
    );
    expect(f.panel.state()).toMatchObject({ pending: true });
    f.panel.settle(event(f.owner), { sequence: 1 });
    expect(f.panel.state()).toMatchObject({ pending: false });
  });
  it("does not retry after an ambiguous send, even after reopening", async () => {
    const f = await fixture();
    harness.sendError = true;
    f.panel.relay(event(f.window), { kind: "check" });
    f.window.close();
    await f.panel.open(f.options);
    f.panel.relay(event(harness.windows[2]), { kind: "check" });
    expect(f.panel.state()).toMatchObject({ pending: true });
    expect(f.owner.webContents.send).toHaveBeenCalledTimes(1);
  });
  it.each(["closed", "render-process-gone", "destroyed", "navigation"])(
    "permanently fails closed after owner %s, preserving the original relay",
    async (kind) => {
      const f = await fixture();
      f.panel.relay(event(f.window), { kind: "check" });
      if (kind === "closed") f.owner.close();
      else if (kind === "navigation")
        f.owner.webContents.emit(
          "did-start-navigation",
          {},
          "file:///app/shell.html",
          false,
          true,
        );
      else f.owner.webContents.emit(kind);
      f.panel.publish(event(f.owner), projection);
      f.panel.settle(event(f.owner), { sequence: 1 });
      f.panel.relay(event(f.window), { kind: "check" });
      f.window.close();
      const replacement = new BrowserWindow({});
      await replacement.loadURL("file:///app/shell.html");
      f.panel.bindOwner(replacement, "/app");
      await f.panel.open({ ...f.options, owner: replacement });
      expect(f.panel.state()).toEqual({ status: "unavailable" });
      expect(harness.windows).toHaveLength(3);
      expect(f.owner.webContents.send).toHaveBeenCalledTimes(1);
      expect((replacement as any).webContents.send).not.toHaveBeenCalled();
    },
  );
  it("retains UNKNOWN through a later ready projection and panel reopening", async () => {
    const f = await fixture();
    f.panel.publish(event(f.owner), {
      ...projection,
      outcome: "unknown",
      update: {
        phase: "ready",
        version: "0.4.1",
        blockedBy: null,
        deferred: false,
      },
      allowed: { ...projection.allowed, check: false, automatic: false },
    });
    f.window.close();
    await f.panel.open(f.options);
    f.panel.relay(event(harness.windows[2]), { kind: "check" });
    expect(f.panel.state()).toMatchObject({
      projection: { outcome: "unknown" },
    });
    expect(f.owner.webContents.send).not.toHaveBeenCalled();
  });
  it("rechecks Quit/applying admission before open and relay", async () => {
    const f = await fixture();
    f.admission(false);
    f.panel.relay(event(f.window), { kind: "check" });
    f.window.close();
    await f.panel.open(f.options);
    expect(harness.windows).toHaveLength(2);
    expect(f.owner.webContents.send).not.toHaveBeenCalled();
  });
  it("rejects an intent after the exact owner URL changes, even before navigation notification", async () => {
    const f = await fixture();
    f.owner.webContents.mainFrame.url = "file:///app/shell.html#other";
    f.panel.relay(event(f.window), { kind: "check" });
    expect(f.owner.webContents.send).not.toHaveBeenCalled();
    expect(f.panel.state()).toEqual({ status: "unavailable" });
  });
  it("rejects a stale restart version and never sends the generic restart command", async () => {
    const f = await fixture();
    f.panel.publish(event(f.owner), {
      ...projection,
      update: {
        phase: "ready",
        version: "0.4.1",
        blockedBy: null,
        deferred: false,
      },
      allowed: { ...projection.allowed, "restart-confirmed": true },
    });
    f.panel.relay(event(f.window), { kind: "restart" });
    f.panel.relay(event(f.window), {
      kind: "restart-confirmed",
      version: "0.4.0",
    });
    expect(f.owner.webContents.send).not.toHaveBeenCalled();
    f.panel.relay(event(f.window), {
      kind: "restart-confirmed",
      version: "0.4.1",
    });
    expect(f.owner.webContents.send).toHaveBeenCalledExactlyOnceWith(
      updatesChannels.command,
      { sequence: 1, intent: { kind: "restart-confirmed", version: "0.4.1" } },
    );
  });
  it("denies navigation, new windows and webviews, and closes the panel without settling the command", async () => {
    const f = await fixture();
    f.panel.relay(event(f.window), { kind: "check" });
    for (const name of ["will-navigate", "will-attach-webview"]) {
      const preventDefault = vi.fn();
      f.window.webContents.emit(name, { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
    expect(
      f.window.webContents.setWindowOpenHandler.mock.calls[0][0](),
    ).toEqual({ action: "deny" });
    const preventDefault = vi.fn();
    f.window.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "Escape" },
    );
    expect(f.window.destroyed).toBe(true);
    expect(f.panel.state()).toMatchObject({ pending: true });
  });
  it("withdraws malformed projection without settling pending", async () => {
    const f = await fixture();
    f.panel.relay(event(f.window), { kind: "check" });
    f.panel.publish(event(f.owner), { malformed: true });
    expect(f.panel.state()).toEqual({ status: "unavailable" });
    f.panel.publish(event(f.owner), projection);
    expect(f.panel.state()).toMatchObject({ pending: true });
  });
  it("contains load failure without discarding owner command state", async () => {
    const f = await fixture();
    f.panel.relay(event(f.window), { kind: "check" });
    f.window.close();
    harness.loadError = true;
    await expect(f.panel.open(f.options)).rejects.toThrow("load failure");
    expect(harness.windows[2].destroyed).toBe(true);
    expect(f.panel.state()).toMatchObject({ pending: true });
  });
});
