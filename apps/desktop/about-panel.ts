import { createHash } from "node:crypto";
import {
  ABOUT_PANEL_CSS,
  aboutPanelDocument as renderAboutPanelDocument,
} from "../../src/ui/about-panel-document";
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
  return renderAboutPanelDocument({
    ...input,
    styleSha256: createHash("sha256").update(ABOUT_PANEL_CSS).digest("base64"),
  });
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
