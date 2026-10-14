import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import type { GracefulQuitSignals } from "../../../src/apps/desktop/quit-signal";

const quitChannel = "farol:startup-recovery:quit";

export type StartupRecoveryWindow = Readonly<{
  ready: Promise<void>;
  quitRequested: Promise<void>;
  reopen(): Promise<void>;
  dispose(): void;
}>;

/** UI-only lifetime. The caller retains startup exclusion until this closes.
 * No configuration, runtime, Computer, provider or updater port is available.
 * The predecessor's run marker and receipts remain owned by recovery, not Quit.
 */
export function openStartupRecoveryWindow(
  options: Readonly<{
    directory: string;
    mode: "default" | "hidden" | "secondary-visible";
    placement: () => Readonly<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
    quitSignals: GracefulQuitSignals;
    onQuitting(): void;
  }>,
): StartupRecoveryWindow {
  const document = path.join(options.directory, "shell.html");
  const documentURL = pathToFileURL(document).href + "#farol-startup-recovery";
  const window = new BrowserWindow({
    title: "Farol",
    width: 640,
    height: 520,
    minWidth: 640,
    minHeight: 520,
    ...(options.mode === "secondary-visible" ? options.placement() : {}),
    show: false,
    backgroundColor: "#fafafa",
    titleBarStyle: "hiddenInset",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 14, y: 18 } }
      : {}),
    webPreferences: {
      preload: path.join(options.directory, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ["--farol-startup-recovery"],
    },
  });
  let stopping = false;
  let disposed = false;
  let rendered = false;
  let requestQuit!: () => void;
  const quitRequested = new Promise<void>((resolve) => {
    requestQuit = resolve;
  });
  const beforeQuit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    options.onQuitting();
    if (!window.isDestroyed()) window.hide();
    requestQuit();
  };
  const reveal = () => {
    if (!rendered || stopping || disposed || window.isDestroyed()) return;
    if (options.mode === "hidden") return;
    if (window.isMinimized()) window.restore();
    if (options.mode === "secondary-visible") {
      window.setBounds(options.placement());
      window.showInactive();
    } else window.show();
  };
  const reconcile = () => {
    if (options.mode !== "secondary-visible" || window.isDestroyed()) return;
    window.hide();
    try {
      reveal();
    } catch {
      /* Stay hidden until an eligible display returns. */
    }
  };
  const quitFromRenderer = (event: Electron.IpcMainEvent) => {
    if (stopping || disposed || window.isDestroyed()) return;
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== documentURL
    )
      return;
    app.quit();
  };
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => {
    if (!disposed && !stopping) app.quit();
  });
  app.on("before-quit", beforeQuit);
  app.on("activate", reveal);
  ipcMain.on(quitChannel, quitFromRenderer);
  screen.on("display-added", reconcile);
  screen.on("display-removed", reconcile);
  screen.on("display-metrics-changed", reconcile);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Farol", submenu: [{ role: "quit" }] },
      { role: "editMenu" },
    ]),
  );
  options.quitSignals.ready();
  const ready = window
    .loadFile(document, { hash: "farol-startup-recovery" })
    .then(() => {
      if (stopping || disposed || window.isDestroyed()) {
        throw new Error("STARTUP_RECOVERY_WINDOW_WITHDRAWN");
      }
      rendered = true;
      reveal();
    });
  // A second launch may await readiness before the primary's continuation does.
  void ready.catch(() => undefined);
  return {
    ready,
    quitRequested,
    reopen: async () => {
      await ready;
      reveal();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ipcMain.removeListener(quitChannel, quitFromRenderer);
      app.removeListener("before-quit", beforeQuit);
      app.removeListener("activate", reveal);
      screen.removeListener("display-added", reconcile);
      screen.removeListener("display-removed", reconcile);
      screen.removeListener("display-metrics-changed", reconcile);
      options.quitSignals.dispose();
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
