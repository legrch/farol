import {
  BrowserWindow,
  session,
  type Session,
  type WebContents,
} from "electron";
import { z } from "zod";
import {
  CHATGPT_PARTITION,
  allowedChatGptPageUrl,
  classifyChatGptPage,
  type ChatGptPageObservation,
} from "./chatgpt-page-policy";

const probeSchema = z.strictObject({
  composerVisible: z.boolean(),
  signInVisible: z.boolean(),
});

const readinessProbe = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const composer = [
    document.querySelector("#prompt-textarea"),
    document.querySelector('[data-testid="prompt-textarea"]'),
    document.querySelector('[contenteditable="true"][data-virtualkeyboard="true"]')
  ].some(visible);
  const explicitSignIn = [
    document.querySelector('[data-testid="login-button"]'),
    document.querySelector('a[href*="/auth/login"]'),
    document.querySelector('button[name="login"]')
  ].some(visible);
  const labelledSignIn = [...document.querySelectorAll("a,button")]
    .some((element) => visible(element) && /^(log in|sign in|sign up)$/iu.test((element.textContent || "").trim()));
  return { composerVisible: composer, signInVisible: explicitSignIn || labelledSignIn };
})()`;

export type ChatGptRouteOptions = Readonly<{
  initialUrl: string;
  e2eOrigin: string | null;
  parent: () => BrowserWindow | null;
}>;

export type ChatGptOpenResult = Readonly<{
  status: "opened" | "unreachable";
}>;

export class ChatGptRoute {
  private routeWindow: BrowserWindow | null = null;
  private readonly popupWindows = new Set<BrowserWindow>();
  private routeSession: Session | null = null;
  private load: "failed" | "loaded" = "failed";

  constructor(private readonly options: ChatGptRouteOptions) {
    if (
      !allowedChatGptPageUrl(options.initialUrl, options.e2eOrigin) ||
      (options.e2eOrigin !== null &&
        new URL(options.initialUrl).origin !== options.e2eOrigin)
    ) {
      throw new Error("CHATGPT_INITIAL_URL_INVALID");
    }
  }

  async open(): Promise<ChatGptOpenResult> {
    if (this.routeWindow && !this.routeWindow.isDestroyed()) {
      if (this.routeWindow.isMinimized()) this.routeWindow.restore();
      this.routeWindow.show();
      this.routeWindow.focus();
      return { status: this.load === "loaded" ? "opened" : "unreachable" };
    }

    const parent = this.options.parent();
    const routeSession = session.fromPartition(CHATGPT_PARTITION, {
      cache: true,
    });
    if (this.routeSession !== routeSession) {
      this.hardenSession(routeSession);
      this.routeSession = routeSession;
    }
    const candidate = new BrowserWindow({
      title: "ChatGPT · Farol Next",
      width: 1080,
      height: 760,
      minWidth: 720,
      minHeight: 560,
      backgroundColor: "#111216",
      show: false,
      ...(parent ? { parent } : {}),
      webPreferences: this.remoteWebPreferences(),
    });
    this.routeWindow = candidate;
    this.hardenContents(candidate.webContents, true);
    candidate.on("closed", () => {
      if (this.routeWindow === candidate) this.routeWindow = null;
    });

    try {
      await candidate.loadURL(this.options.initialUrl);
      this.load = "loaded";
      candidate.show();
      candidate.focus();
      return { status: "opened" };
    } catch {
      this.load = "failed";
      if (!candidate.isDestroyed()) candidate.show();
      return { status: "unreachable" };
    }
  }

  async observe(): Promise<ChatGptPageObservation> {
    const candidate = this.routeWindow;
    if (!candidate || candidate.isDestroyed() || this.load === "failed") {
      return classifyChatGptPage({
        load: "failed",
        composerVisible: false,
        signInVisible: false,
      });
    }
    const currentUrl = candidate.webContents.getURL();
    if (!allowedChatGptPageUrl(currentUrl, this.options.e2eOrigin)) {
      return { state: "unsupported", code: "CHATGPT_UI_UNRECOGNIZED" };
    }
    try {
      const parsed = probeSchema.safeParse(
        await candidate.webContents.executeJavaScript(readinessProbe, true),
      );
      if (!parsed.success) {
        return { state: "unsupported", code: "CHATGPT_UI_UNRECOGNIZED" };
      }
      return classifyChatGptPage({ load: "loaded", ...parsed.data });
    } catch {
      return { state: "unsupported", code: "CHATGPT_UI_UNRECOGNIZED" };
    }
  }

  dispose(): void {
    for (const popup of this.popupWindows) {
      if (!popup.isDestroyed()) popup.destroy();
    }
    this.popupWindows.clear();
    if (this.routeWindow && !this.routeWindow.isDestroyed()) {
      this.routeWindow.destroy();
    }
    this.routeWindow = null;
    this.routeSession = null;
  }

  private hardenSession(routeSession: Session): void {
    routeSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    routeSession.setPermissionCheckHandler(() => false);
    routeSession.on("will-download", (event) => event.preventDefault());
  }

  private hardenContents(
    contents: WebContents,
    tracksRouteReadiness: boolean,
  ): void {
    const allowed = (url: string) =>
      allowedChatGptPageUrl(url, this.options.e2eOrigin);
    contents.on("will-navigate", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!allowed(url)) event.preventDefault();
    });
    if (tracksRouteReadiness) {
      contents.on(
        "did-start-navigation",
        (_event, _url, _inPlace, isMainFrame) => {
          if (isMainFrame) this.load = "failed";
        },
      );
      contents.on(
        "did-fail-load",
        (_event, _code, _description, _url, isMainFrame) => {
          if (isMainFrame) this.load = "failed";
        },
      );
      contents.on("did-finish-load", () => {
        this.load = "loaded";
      });
      contents.on("render-process-gone", () => {
        this.load = "failed";
      });
    }
    contents.setWindowOpenHandler(({ url }) => {
      if (!allowed(url)) return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          title: "Sign in · Farol Next",
          width: 720,
          height: 760,
          backgroundColor: "#111216",
          webPreferences: this.remoteWebPreferences(),
        },
      };
    });
    contents.on("did-create-window", (popup) => {
      this.popupWindows.add(popup);
      this.hardenContents(popup.webContents, false);
      popup.on("closed", () => this.popupWindows.delete(popup));
    });
  }

  private remoteWebPreferences(): Electron.WebPreferences {
    return {
      partition: CHATGPT_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
    };
  }
}
