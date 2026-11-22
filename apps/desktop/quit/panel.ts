import { createHash } from "node:crypto";
import { BrowserWindow, screen, type Rectangle } from "electron";

import type { QuitStage } from "../../../src/apps/desktop/quit-drain";
import {
  createQuitProgress,
  presentQuitProgress,
  reduceQuitProgress,
  type QuitProgressState,
} from "./progress";

// One small inactive window that says what Quit is still waiting for. It is
// strictly optional: nothing in the drain awaits it, it has no button that
// changes Quit, closing it does not cancel Quit, and every callback after the
// attempt ends is ignored. Electron's terminal exit destroys it directly.

export const QUIT_PROGRESS_DELAY_MS = 1_500;
const SIZE = { width: 380, height: 220 } as const;

const CSS = [
  ":root{color-scheme:light dark}",
  "body{margin:0;padding:22px 24px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9fc;color:#1d1b20;-webkit-user-select:none;cursor:default}",
  "@media (prefers-color-scheme:dark){body{background:#1f1e22;color:#ece9f0}}",
  "h1{font-size:15px;font-weight:600;margin:0 0 12px}",
  "ul{margin:0 0 14px;padding-left:18px}li{margin:3px 0}",
  "p{margin:0;opacity:.7;font-size:12px}",
].join("");
const CSS_SHA256 = createHash("sha256").update(CSS).digest("base64");

function escape(text: string): string {
  return text.replace(
    /[&<>"']/gu,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

export function quitProgressDocument(
  view: ReturnType<typeof presentQuitProgress>,
): string {
  return [
    "<!doctype html><html><head><meta charset='utf-8'>",
    `<meta http-equiv='Content-Security-Policy' content="default-src 'none'; style-src 'sha256-${CSS_SHA256}'">`,
    `<title>${escape(view.title)}</title><style>${CSS}</style></head><body>`,
    `<h1>${escape(view.title)}</h1><ul>`,
    ...view.lines.map((line) => `<li>${escape(line)}</li>`),
    `</ul><p>${escape(view.footer)}</p></body></html>`,
  ].join("");
}

export type QuitProgressWindowOptions = Readonly<{
  deadlineMs: number;
  delayMs?: number;
  /** Hidden test launches never show it. */
  visible?: () => boolean;
  /** Bounds for test placement; the default centers on the active display. */
  placement?: () => Rectangle;
  now?: () => number;
}>;

export type QuitProgressWindow = Readonly<{
  observe(stage: QuitStage): void;
  dispose(): void;
}>;

export function createQuitProgressWindow(
  options: QuitProgressWindowOptions,
): QuitProgressWindow {
  const now = options.now ?? (() => Date.now());
  let state: QuitProgressState = createQuitProgress();
  let deadlineAt: number | null = null;
  let disposed = false;
  let panel: BrowserWindow | null = null;
  let showTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;

  // A supplied placement policy that cannot select a display means no panel:
  // the optional window never falls back onto a display the policy excludes.
  const bounds = (): Rectangle | null => {
    if (options.placement) {
      try {
        return options.placement();
      } catch {
        return null;
      }
    }
    const area = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).workArea;
    return {
      x: Math.round(area.x + (area.width - SIZE.width) / 2),
      y: Math.round(area.y + (area.height - SIZE.height) / 3),
      ...SIZE,
    };
  };
  const render = () => {
    if (disposed || !panel || panel.isDestroyed() || deadlineAt === null)
      return;
    const view = presentQuitProgress(state, (deadlineAt - now()) / 1000);
    void panel.webContents
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(quitProgressDocument(view))}`,
      )
      .catch(() => undefined);
  };
  // Placement is checked again before the first show and whenever displays
  // change: a panel whose display went away is hidden, never moved onto a
  // display the policy excludes.
  const reconcile = (first: boolean) => {
    if (disposed || !panel || panel.isDestroyed()) return;
    try {
      const selected = bounds();
      if (!selected) {
        panel.hide();
        return;
      }
      panel.setBounds(selected);
      if (first || panel.isVisible()) panel.showInactive();
    } catch {
      try {
        panel.hide();
      } catch {
        // Terminal exit destroys the window anyway.
      }
    }
  };
  const onDisplays = () => reconcile(false);
  let watchingDisplays = false;
  const unwatchDisplays = () => {
    if (!watchingDisplays) return;
    watchingDisplays = false;
    try {
      screen.removeListener("display-removed", onDisplays);
      screen.removeListener("display-added", onDisplays);
      screen.removeListener("display-metrics-changed", onDisplays);
    } catch {
      // Nothing else depends on these listeners.
    }
  };
  const show = () => {
    if (disposed || panel || state.step === "exiting") return;
    try {
      if (options.visible && !options.visible()) return;
      const selected = bounds();
      if (!selected) return;
      panel = new BrowserWindow({
        ...selected,
        title: "Farol is quitting",
        show: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        focusable: false,
        alwaysOnTop: true,
        titleBarStyle: "hiddenInset",
        backgroundColor: "#faf9fc",
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
        },
      });
      panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      panel.webContents.on("will-navigate", (event) => {
        // Only this module's own data documents load here.
        if (!event.url.startsWith("data:text/html")) event.preventDefault();
      });
      panel.once("closed", () => {
        panel = null;
        unwatchDisplays();
      });
      panel.once("ready-to-show", () => reconcile(true));
      screen.on("display-removed", onDisplays);
      screen.on("display-added", onDisplays);
      screen.on("display-metrics-changed", onDisplays);
      watchingDisplays = true;
      render();
      refreshTimer = setInterval(render, 1_000);
      // Never keeps the process alive on its own.
      refreshTimer.unref?.();
    } catch {
      // A window that cannot open changes nothing about Quit.
      panel = null;
    }
  };

  return {
    observe(stage) {
      if (disposed) return;
      try {
        if (stage.stage === "drain-entered" && deadlineAt === null) {
          deadlineAt = now() + options.deadlineMs;
          showTimer = setTimeout(
            show,
            options.delayMs ?? QUIT_PROGRESS_DELAY_MS,
          );
          showTimer.unref?.();
        }
        state = reduceQuitProgress(state, stage);
        if (stage.stage === "exit-requested") clearTimeout(showTimer);
      } catch {
        // Observation can never change Quit.
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unwatchDisplays();
      clearTimeout(showTimer);
      clearInterval(refreshTimer);
      try {
        if (panel && !panel.isDestroyed()) panel.destroy();
      } catch {
        // Terminal exit destroys remaining windows anyway.
      }
      panel = null;
    },
  };
}
