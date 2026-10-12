import { createHash } from "node:crypto";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserWindow, screen, type Rectangle } from "electron";

export const ABOUT_PANEL_SIZE = { width: 340, height: 330 } as const;

export interface AboutPanelOptions {
  owner: BrowserWindow;
  name: string;
  version: string;
  builtAt: string;
  icon: string;
  mode: "default" | "hidden" | "secondary-visible";
  place: () => Rectangle;
}

export function aboutPanelDocument(
  input: Pick<AboutPanelOptions, "name" | "version" | "builtAt" | "icon">,
): string {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u.test(input.icon)) {
    throw new Error("DESKTOP_ABOUT_ICON_INVALID");
  }
  const date = new Date(input.builtAt);
  if (!Number.isFinite(date.getTime()))
    throw new Error("DESKTOP_ABOUT_DATE_INVALID");
  const released = date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const css = `:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:light-dark(#25242b,#f2f1f6);background:light-dark(#faf9fc,#25242b)}*{box-sizing:border-box}body{margin:0;padding:54px 24px 32px;text-align:center;user-select:text}img{width:76px;height:76px;display:block;margin:0 auto 18px}h1{font-size:23px;line-height:1.2;letter-spacing:-.45px;font-weight:650;margin:0 0 14px}p{font-size:13px;line-height:1.5;margin:4px 0;color:light-dark(#6b6875,#bbb7c7)}.date{font-size:12px;margin-top:10px}`;
  const hash = createHash("sha256").update(css).digest("base64");
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      h(
        "html",
        { lang: "en" },
        h(
          "head",
          null,
          h("meta", { charSet: "utf-8" }),
          h("meta", {
            name: "viewport",
            content: "width=device-width,initial-scale=1",
          }),
          h("meta", {
            httpEquiv: "Content-Security-Policy",
            content: `default-src 'none'; img-src data:; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'`,
          }),
          h("title", null, `About ${input.name}`),
          h("style", null, css),
        ),
        h(
          "body",
          null,
          h(
            "main",
            null,
            h("img", { src: input.icon, alt: "" }),
            h("h1", null, input.name),
            h("p", null, `Version ${input.version}`),
            h("p", { className: "date" }, released),
          ),
        ),
      ),
    )
  );
}

/** A separate native window with no preload, application bridge or navigation. */
export class DesktopAboutPanel {
  private panel: BrowserWindow | null = null;
  private options: AboutPanelOptions | null = null;

  async open(options: AboutPanelOptions): Promise<void> {
    this.options = options;
    if (this.panel && !this.panel.isDestroyed()) {
      this.reconcile();
      return;
    }
    const document = aboutPanelDocument(options);
    const bounds = this.placement(options);
    const panel = new BrowserWindow({
      ...bounds,
      title: `About ${options.name}`,
      parent: options.owner,
      show: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      titleBarStyle: "hiddenInset",
      backgroundColor: "#faf9fc",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    });
    this.panel = panel;
    panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    panel.webContents.on("will-navigate", (event) => event.preventDefault());
    panel.webContents.on("before-input-event", (event, input) => {
      if (
        input.type === "keyDown" &&
        (input.key === "Escape" ||
          ((input.meta || input.control) && input.key.toLowerCase() === "w"))
      ) {
        event.preventDefault();
        panel.close();
      }
    });
    panel.once("closed", () => {
      if (this.panel === panel) this.panel = null;
    });
    try {
      await panel.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(document)}`,
      );
      if (this.panel === panel && !panel.isDestroyed()) this.reconcile();
    } catch (error) {
      if (!panel.isDestroyed()) panel.destroy();
      throw error;
    }
  }

  reconcile(): void {
    const panel = this.panel;
    const options = this.options;
    if (!panel || panel.isDestroyed() || !options) return;
    if (options.mode === "hidden") {
      panel.hide();
      return;
    }
    try {
      panel.setBounds(this.placement(options));
      if (options.mode === "secondary-visible") panel.showInactive();
      else panel.show();
    } catch {
      panel.hide();
    }
  }

  private placement(options: AboutPanelOptions): Rectangle {
    if (options.mode === "secondary-visible") return options.place();
    const area = screen.getDisplayMatching(options.owner.getBounds()).workArea;
    return {
      x: Math.round(area.x + (area.width - ABOUT_PANEL_SIZE.width) / 2),
      y: Math.round(area.y + (area.height - ABOUT_PANEL_SIZE.height) / 2),
      ...ABOUT_PANEL_SIZE,
    };
  }
}
