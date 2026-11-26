// The two owner requests the application menu and the menu bar raise: open the
// updates view, and open settings. Each one reads its owners when it runs, not
// when it is built, and each is a no-op once admission has closed. The updates
// request opens the window first, contained so a failed open is recovered and
// never becomes an unhandled rejection; settings acts only on a window that
// already exists.

export type ShellRequestPorts = Readonly<{
  closed: () => boolean;
  /** Runs the work inside the window-open failure containment. */
  contain: (work: () => Promise<void>) => Promise<unknown>;
  ensureWindow: () => Promise<void>;
  window: () => Readonly<{
    isDestroyed(): boolean;
    webContents: { focus(): void };
  }> | null;
  publishShellAction: (
    action: "open-updates" | "open-settings",
    source: "update-command" | "settings-command",
  ) => void;
  requestUpdateCheck: () => Promise<unknown>;
}>;

export function createShellRequests(ports: ShellRequestPorts) {
  function requestUpdates(): void {
    if (ports.closed()) return;
    void ports.contain(async () => {
      await ports.ensureWindow();
      const window = ports.window();
      if (ports.closed() || !window || window.isDestroyed()) return;
      ports.publishShellAction("open-updates", "update-command");
      window.webContents.focus();
      void ports.requestUpdateCheck();
    });
  }

  function requestSettings(): void {
    if (ports.closed()) return;
    const window = ports.window();
    if (!window) return;
    ports.publishShellAction("open-settings", "settings-command");
    window.webContents.focus();
  }

  return { requestUpdates, requestSettings };
}
