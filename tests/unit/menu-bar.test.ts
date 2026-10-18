// Mocked native menu policy; no visible macOS menu/focus acceptance.
import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMenuBar } from "../../src/apps/desktop/menu-bar";
type Item = { label?: string; click?: () => void; enabled?: boolean };
type Menu = { items: Item[] };
type OwnedTray = EventEmitter & {
  setContextMenu: ReturnType<typeof vi.fn>;
  popUpContextMenu: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setToolTip: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
};
const owned = vi.hoisted(() => ({ trays: [] as OwnedTray[] }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Tray extends EventEmitter {
    setContextMenu = vi.fn();
    popUpContextMenu = vi.fn();
    destroy = vi.fn();
    setToolTip = vi.fn();
    setTitle = vi.fn();
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
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  const actions = {
    open: vi.fn(),
    current: vi.fn(),
    updates: vi.fn(),
    quit: vi.fn(),
  };
  let status: { label: string; current: string | null; attention?: boolean } = {
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

it("refreshes native status without a click and releases its owned timer", () => {
  const f = fixture();
  expect(f.tray.setToolTip).toHaveBeenLastCalledWith("Service unavailable");
  f.setStatus({
    label: "Startup recovery required",
    current: null,
    attention: true,
  });
  vi.advanceTimersByTime(1_000);
  expect(f.tray.setToolTip).toHaveBeenLastCalledWith(
    "Startup recovery required",
  );
  expect(f.tray.setTitle).toHaveBeenLastCalledWith("!");
  expect(f.tray.popUpContextMenu).not.toHaveBeenCalled();
  Object.values(f.actions).forEach((action) =>
    expect(action).not.toHaveBeenCalled(),
  );
  f.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("fences an already queued refresh after disposal", () => {
  const interval = vi.spyOn(globalThis, "setInterval");
  const f = fixture();
  const refresh = interval.mock.calls[0]?.[0] as () => void;
  expect(refresh).toBeTypeOf("function");
  f.dispose();
  f.tray.setToolTip.mockClear();
  f.tray.setTitle.mockClear();
  refresh();
  expect(f.tray.setToolTip).not.toHaveBeenCalled();
  expect(f.tray.setTitle).not.toHaveBeenCalled();
});

it("exposes only Open and Quit when no normal-runtime actions are supplied", () => {
  const actions = { open: vi.fn(), quit: vi.fn() };
  const dispose = createMenuBar(actions, () => ({
    label: "Startup recovery required",
    current: null,
  }));
  const tray = owned.trays[0]!;
  tray.emit("click");
  const menu = tray.popUpContextMenu.mock.lastCall?.[0] as Menu;
  expect(menu.items.map((item) => item.label).filter(Boolean)).toEqual([
    "Startup recovery required",
    "Open Farol",
    "Quit Farol",
  ]);
  for (const item of menu.items) item.click?.();
  expect(actions.open).toHaveBeenCalledOnce();
  expect(actions.quit).toHaveBeenCalledOnce();
  dispose();
});

it("contains a native refresh and cleanup failure without an uncaught timer", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const f = fixture();
  f.tray.setToolTip.mockImplementation(() => {
    throw new Error("native tooltip unavailable");
  });
  f.tray.destroy.mockImplementation(() => {
    throw new Error("native cleanup unconfirmed");
  });
  expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
  expect(warn).toHaveBeenCalledWith("FAROL_MENU_BAR_UNAVAILABLE");
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(10_000);
  expect(f.tray.destroy).toHaveBeenCalledOnce();
});

it("expires a throwing status producer to an explicit unavailable projection", () => {
  let unavailable = false;
  const dispose = createMenuBar({ open: vi.fn(), quit: vi.fn() }, () => {
    if (unavailable) throw new Error("projection unavailable");
    return { label: "Original observation", current: null };
  });
  const tray = owned.trays[0]!;
  unavailable = true;
  vi.advanceTimersByTime(1_000);
  expect(tray.setToolTip).toHaveBeenLastCalledWith(
    "Farol · Status unavailable",
  );
  expect(tray.setTitle).toHaveBeenLastCalledWith("!");
  tray.emit("click");
  const menu = tray.popUpContextMenu.mock.lastCall?.[0] as Menu;
  expect(menu.items[0]?.label).toBe("Farol · Status unavailable");
  dispose();
});

it("updates the supplied status shape without click or command dispatch", () => {
  const actions = { open: vi.fn(), quit: vi.fn() };
  let marker: "✓" | "…" | "?" = "✓";
  const dispose = createMenuBar(actions, () => ({
    label: "Observed status",
    current: null,
    marker,
  }));
  const tray = owned.trays[0]!;
  expect(tray.setTitle).toHaveBeenLastCalledWith("✓");
  marker = "…";
  vi.advanceTimersByTime(1000);
  expect(tray.setTitle).toHaveBeenLastCalledWith("…");
  marker = "?";
  vi.advanceTimersByTime(1000);
  expect(tray.setTitle).toHaveBeenLastCalledWith("?");
  expect(actions.open).not.toHaveBeenCalled();
  expect(actions.quit).not.toHaveBeenCalled();
  dispose();
});
