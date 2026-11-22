import { describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => ({ count: 0 }));
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
    once() {}
    isDestroyed() {
      return false;
    }
    destroy() {}
    showInactive() {}
  },
  screen: {
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
});
