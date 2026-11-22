import { describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => ({
  count: 0,
  shown: 0,
  hidden: 0,
  readyToShow: null as null | (() => void),
  bounds: [] as { x: number }[],
  events: [] as string[],
  displays: new Map<string, () => void>(),
}));
vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = {
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      loadURL: () => Promise.resolve(),
    };
    constructor() {
      constructed.count++;
    }
    once(event: string, listener: () => void) {
      if (event === "ready-to-show") constructed.readyToShow = listener;
    }
    isDestroyed() {
      return false;
    }
    isVisible() {
      return constructed.shown > constructed.hidden;
    }
    setBounds(bounds: { x: number }) {
      constructed.bounds.push(bounds);
      constructed.events.push(`bounds:${bounds.x}`);
    }
    destroy() {}
    hide() {
      constructed.hidden++;
    }
    showInactive() {
      constructed.shown++;
      constructed.events.push("show");
    }
  },
  screen: {
    on: (event: string, listener: () => void) =>
      constructed.displays.set(event, listener),
    removeListener: (event: string) => constructed.displays.delete(event),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1000, height: 800 },
    }),
  },
}));

import { createQuitProgressWindow, quitProgressDocument } from "./panel";

describe("Quit progress panel", () => {
  it("renders an inert, escaped document with a strict policy", () => {
    const html = quitProgressDocument({
      title: "Farol is quitting",
      lines: ["<script>x</script>"],
      footer: "f",
    });
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("never opens a window for a Quit that finishes before the delay", () => {
    vi.useFakeTimers();
    constructed.count = 0;
    try {
      const panel = createQuitProgressWindow({
        deadlineMs: 60_000,
        delayMs: 1_500,
      });
      panel.observe({ stage: "drain-entered" });
      panel.observe({ stage: "exit-requested" });
      panel.dispose();
      vi.advanceTimersByTime(5_000);
      expect(constructed.count).toBe(0);
      // Late observations after dispose are ignored.
      expect(() => panel.observe({ stage: "drain-entered" })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens one window after the delay while Quit is still running", () => {
    vi.useFakeTimers();
    constructed.count = 0;
    try {
      const panel = createQuitProgressWindow({
        deadlineMs: 60_000,
        delayMs: 1_500,
      });
      panel.observe({ stage: "drain-entered" });
      vi.advanceTimersByTime(1_600);
      expect(constructed.count).toBe(1);
      panel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens no window when the placement policy cannot select a display", () => {
    vi.useFakeTimers();
    constructed.count = 0;
    try {
      const panel = createQuitProgressWindow({
        deadlineMs: 60_000,
        delayMs: 1_500,
        placement: () => {
          throw new Error("SECONDARY_DISPLAY_UNAVAILABLE");
        },
      });
      panel.observe({ stage: "drain-entered" });
      vi.advanceTimersByTime(5_000);
      expect(constructed.count).toBe(0);
      panel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revalidates placement before the first show and hides when the display goes away", () => {
    vi.useFakeTimers();
    Object.assign(constructed, {
      count: 0,
      shown: 0,
      hidden: 0,
      readyToShow: null,
    });
    constructed.displays.clear();
    let available = true;
    try {
      const panel = createQuitProgressWindow({
        deadlineMs: 60_000,
        delayMs: 1_500,
        placement: () => {
          if (!available) throw new Error("DISPLAY_GONE");
          return { x: 0, y: 0, width: 380, height: 220 };
        },
      });
      panel.observe({ stage: "drain-entered" });
      vi.advanceTimersByTime(1_600);
      expect(constructed.count).toBe(1);
      available = false;
      constructed.readyToShow?.();
      expect(constructed.shown).toBe(0);
      expect(constructed.hidden).toBe(1);
      available = true;
      constructed.displays.get("display-added")?.();
      expect(constructed.shown).toBe(0);
      panel.dispose();
      expect(constructed.displays.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides an already visible panel when its display is removed", () => {
    vi.useFakeTimers();
    Object.assign(constructed, {
      count: 0,
      shown: 0,
      hidden: 0,
      readyToShow: null,
    });
    constructed.displays.clear();
    let available = true;
    try {
      const panel = createQuitProgressWindow({
        deadlineMs: 60_000,
        delayMs: 1_500,
        placement: () => {
          if (!available) throw new Error("DISPLAY_GONE");
          return { x: 0, y: 0, width: 380, height: 220 };
        },
      });
      panel.observe({ stage: "drain-entered" });
      vi.advanceTimersByTime(1_600);
      constructed.readyToShow?.();
      expect(constructed.shown).toBe(1);
      available = false;
      constructed.displays.get("display-removed")?.();
      expect(constructed.hidden).toBe(1);
      panel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies fresh bounds before the first show and after a display change", () => {
    vi.useFakeTimers();
    Object.assign(constructed, {
      count: 0,
      shown: 0,
      hidden: 0,
      readyToShow: null,
      bounds: [],
      events: [],
    });
    constructed.displays.clear();
    let x = 10;
    try {
      const panel = createQuitProgressWindow({
        deadlineMs: 60_000,
        delayMs: 1_500,
        placement: () => ({ x, y: 0, width: 380, height: 220 }),
      });
      panel.observe({ stage: "drain-entered" });
      vi.advanceTimersByTime(1_600);
      x = 20;
      constructed.readyToShow?.();
      x = 30;
      constructed.displays.get("display-metrics-changed")?.();
      expect(constructed.events).toEqual([
        "bounds:20",
        "show",
        "bounds:30",
        "show",
      ]);
      panel.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
