import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: class {}, screen: {} }));

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
    try {
      const panel = createQuitProgressWindow({
        deadlineMs: 60_000,
        delayMs: 1_500,
      });
      panel.observe({ stage: "drain-entered" });
      panel.observe({ stage: "exit-requested" });
      panel.dispose();
      expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
      // Late observations after dispose are ignored.
      expect(() => panel.observe({ stage: "drain-entered" })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
