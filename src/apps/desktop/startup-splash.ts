import { BrowserWindow } from "electron";

// A launch shows a window at once instead of 3–5 silent seconds after the
// Dock stops bouncing. It is presentation only: no preload, no IPC, no
// network, no navigation. The real window replaces it when it is revealed.

export type StartupSplashOptions = Readonly<{
  title: string;
  width: number;
  height: number;
  iconDataUrl: string;
  // Test/Dev windows on a secondary display: exact bounds, never focused.
  bounds?: Readonly<{ x: number; y: number; width: number; height: number }>;
  inactive?: boolean;
}>;
export type StartupSplash = Readonly<{ close(): void }>;

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export function startupSplashHtml(title: string, iconDataUrl: string): string {
  const icon = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(iconDataUrl)
    ? `<img src="${iconDataUrl}" alt="" width="72" height="72">`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>
html,body{margin:0;height:100%;background:#111216;color:#a7a9b1;
font:13px -apple-system,BlinkMacSystemFont,sans-serif;-webkit-user-select:none;cursor:default}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;-webkit-app-region:drag}
.spin{width:18px;height:18px;border-radius:50%;border:2px solid #ffffff22;border-top-color:#a7a9b1;
animation:s .9s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style></head><body>${icon}<div class="spin" role="progressbar" aria-label="Starting Farol"></div>
<div>Starting Farol…</div></body></html>`;
}

export function openStartupSplash(
  options: StartupSplashOptions,
): StartupSplash {
  let splash: BrowserWindow | null = new BrowserWindow({
    title: options.title,
    width: options.width,
    height: options.height,
    ...(options.bounds ?? {}),
    backgroundColor: "#111216",
    titleBarStyle: "hiddenInset",
    closable: false,
    minimizable: false,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  });
  const contents = splash.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  splash.once("ready-to-show", () => {
    if (!splash || splash.isDestroyed()) return;
    if (options.inactive) splash.showInactive();
    else splash.show();
  });
  void contents
    .loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        startupSplashHtml(options.title, options.iconDataUrl),
      )}`,
    )
    .catch(() => undefined);
  return Object.freeze({
    close() {
      const current = splash;
      splash = null;
      if (current && !current.isDestroyed()) current.destroy();
    },
  });
}
