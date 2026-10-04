// Mocked native menu policy; no visible macOS menu/focus acceptance.
import type { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { createMenuBar } from "../../src/apps/desktop/menu-bar";
type Item = { label?: string; click?: () => void; enabled?: boolean };
type Menu = { items: Item[] };
type OwnedTray = EventEmitter & {
  setContextMenu: ReturnType<typeof vi.fn>;
  popUpContextMenu: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
const owned = vi.hoisted(() => ({ trays: [] as OwnedTray[] }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Tray extends EventEmitter {
    setContextMenu = vi.fn();
    popUpContextMenu = vi.fn();
    destroy = vi.fn();
    setToolTip = vi.fn();
    setIgnoreDoubleClickEvents = vi.fn();
    constructor() {
      super();
      owned.trays.push(this);
    }
  }
  return {
    Tray,
    Menu: { buildFromTemplate: (items: Item[]) => ({ items }) },
    nativeImage: {
      createFromBuffer: () => ({
        addRepresentation: vi.fn(),
        isEmpty: () => false,
        setTemplateImage: vi.fn(),
      }),
    },
  };
});
beforeEach(() => {
  owned.trays.length = 0;
});
function fixture() {
  const actions = {
    open: vi.fn(),
    current: vi.fn(),
    updates: vi.fn(),
    quit: vi.fn(),
  };
  let status: { label: string; current: string | null } = {
    label: "Service unavailable",
    current: null,
  };
  const dispose = createMenuBar(actions, () => status);
  const tray = owned.trays[0]!;
  return {
    actions,
    dispose,
    tray,
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}
it("reads status at left-click opening rather than presenting the startup snapshot", () => {
  const f = fixture();
  f.setStatus({ label: "Service ready", current: "Current task" });
  f.tray.emit("click");
  expect(f.tray.setContextMenu).not.toHaveBeenCalled();
  expect(f.tray.popUpContextMenu).toHaveBeenCalledTimes(1);
  const menu = f.tray.popUpContextMenu.mock.calls[0]?.[0] as Menu;
  expect(menu.items[0]?.label).toBe("Service ready");
  expect(menu.items.some((item) => item.label === "Current task")).toBe(true);
  f.dispose();
});
it("right-click observes task replacement and removal on each opening", () => {
  const f = fixture();
  for (const current of ["First task", "Next task", null]) {
    f.setStatus({ label: "Service ready", current });
    f.tray.emit("right-click");
    expect(f.tray.popUpContextMenu).toHaveBeenCalled();
    const menu = f.tray.popUpContextMenu.mock.lastCall?.[0] as Menu;
    expect(menu.items.map((item) => item.label)).toEqual([
      "Service ready",
      undefined,
      "Open Farol",
      ...(current ? [current] : []),
      "Check for Updates…",
      undefined,
      "Quit Farol",
    ]);
  }
  expect(f.tray.popUpContextMenu).toHaveBeenCalledTimes(3);
  f.dispose();
});
it("opening is passive and menu commands use the existing host callbacks once", () => {
  const f = fixture();
  f.setStatus({ label: "Service ready", current: "Current task" });
  f.tray.emit("click");
  expect(f.tray.popUpContextMenu).toHaveBeenCalled();
  const menu = f.tray.popUpContextMenu.mock.lastCall?.[0] as Menu;
  Object.values(f.actions).forEach((action) =>
    expect(action).not.toHaveBeenCalled(),
  );
  for (const item of menu.items) item.click?.();
  Object.values(f.actions).forEach((action) =>
    expect(action).toHaveBeenCalledTimes(1),
  );
  f.dispose();
});
it("disposal removes listeners, destroys once and fences a queued opening", () => {
  const f = fixture();
  const queued = f.tray.listeners("click")[0]!;
  f.dispose();
  f.dispose();
  queued();
  f.tray.emit("right-click");
  expect(f.tray.popUpContextMenu).not.toHaveBeenCalled();
  expect(f.tray.listenerCount("click")).toBe(0);
  expect(f.tray.listenerCount("right-click")).toBe(0);
  expect(f.tray.destroy).toHaveBeenCalledTimes(1);
});
