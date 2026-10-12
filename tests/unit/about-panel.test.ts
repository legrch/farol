import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ windows: [] as any[], loadError: false }));
vi.mock("electron", () => ({
  screen: {
    getDisplayMatching: () => ({
      workArea: { x: -1135, y: 30, width: 1135, height: 759 },
    }),
  },
  BrowserWindow: class {
    destroyed = false;
    events = new Map<string, (...args: any[]) => void>();
    options: any;
    url = "";
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
    setBounds = vi.fn();
    show = vi.fn();
    showInactive = vi.fn();
    hide = vi.fn();
    constructor(options: any) {
      this.options = options;
      harness.windows.push(this);
    }
    once(event: string, action: (...args: any[]) => void) {
      this.events.set(event, action);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.events.get("closed")?.();
    }
    close() {
      this.destroy();
    }
    async loadURL(url: string) {
      this.url = url;
      if (harness.loadError) throw Error("load failure");
    }
  },
}));
import {
  aboutPanelDocument,
  DesktopAboutPanel,
  type AboutPanelOptions,
} from "../../apps/desktop/about-panel";

const options = (
  mode: AboutPanelOptions["mode"] = "default",
): AboutPanelOptions => ({
  owner: {
    getBounds: () => ({ x: -1100, y: 30, width: 1000, height: 700 }),
  } as any,
  name: "Farol",
  version: "0.2.2",
  builtAt: "2026-10-12T17:00:00.000Z",
  icon: "data:image/png;base64,YQ==",
  mode,
  place: () => ({ x: -1100, y: 40, width: 340, height: 330 }),
});
beforeEach(() => {
  harness.windows = [];
  harness.loadError = false;
});

describe("About panel", () => {
  it("shows name, version and date with no bridge, source hash or network content", () => {
    const html = aboutPanelDocument(options());
    expect(html).toContain("Version 0.2.2");
    expect(html).toContain("October 12, 2026");
    expect(html).toContain("default-src &#x27;none&#x27;");
    expect(html).toContain("style-src &#x27;sha256-");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("Source ");
    expect(
      aboutPanelDocument({ ...options(), name: '<script>"test"</script>' }),
    ).toContain("&lt;script&gt;&quot;test&quot;&lt;/script&gt;");
    expect(() =>
      aboutPanelDocument({ ...options(), icon: "file:///private-file" }),
    ).toThrow("DESKTOP_ABOUT_ICON_INVALID");
    expect(() =>
      aboutPanelDocument({ ...options(), builtAt: "invalid" }),
    ).toThrow("DESKTOP_ABOUT_DATE_INVALID");
  });
  it("coalesces opens and keeps the native window on its owner's display", async () => {
    const panel = new DesktopAboutPanel();
    await panel.open(options());
    await panel.open(options());
    expect(harness.windows).toHaveLength(1);
    const win = harness.windows[0];
    expect(win.options).toMatchObject({
      title: "About Farol",
      x: -737,
      y: 245,
      width: 340,
      height: 330,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    });
    expect(win.options.webPreferences.preload).toBeUndefined();
    expect(win.show).toHaveBeenCalledTimes(2);
    expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({
      action: "deny",
    });
    win.close();
    await panel.open(options());
    expect(harness.windows).toHaveLength(2);
  });
  it("preserves hidden mode and secondary inactive presentation", async () => {
    const hidden = new DesktopAboutPanel();
    await hidden.open(options("hidden"));
    const hiddenWindow = harness.windows[0];
    expect(hiddenWindow.show).not.toHaveBeenCalled();
    expect(hiddenWindow.showInactive).not.toHaveBeenCalled();
    const secondary = new DesktopAboutPanel();
    const scoped = options("secondary-visible");
    await secondary.open(scoped);
    const win = harness.windows[1];
    expect(win.show).not.toHaveBeenCalled();
    expect(win.showInactive).toHaveBeenCalledOnce();
    scoped.place = () => {
      throw Error("display removed");
    };
    secondary.reconcile();
    expect(win.hide).toHaveBeenCalledOnce();
  });
  it("destroys only its failed window and allows a fresh About open", async () => {
    const panel = new DesktopAboutPanel();
    harness.loadError = true;
    await expect(panel.open(options())).rejects.toThrow("load failure");
    expect(harness.windows[0].destroyed).toBe(true);
    harness.loadError = false;
    await panel.open(options());
    expect(harness.windows).toHaveLength(2);
  });
});
