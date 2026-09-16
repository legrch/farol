import {
  BrowserWindow,
  session,
  type Session,
  type WebContents,
} from "electron";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  CHATGPT_PARTITION,
  allowedChatGptPageUrl,
  canonicalChatGptConversationUrl,
  classifyChatGptPage,
  type ChatGptPageObservation,
} from "./chatgpt-page-policy";
import type { StagedChatGptAttachment } from "./chatgpt-attachment-staging";
import { uploadChatGptAttachments } from "./chatgpt-attachment-upload";

const probeSchema = z.strictObject({
  composerVisible: z.boolean(),
  signInVisible: z.boolean(),
});

const preparedTaskSchema = z.strictObject({
  ready: z.boolean(),
  baselineAssistantCount: z.number().int().nonnegative(),
  baselineUserCount: z.number().int().nonnegative(),
});

const activatedTaskSchema = z.strictObject({ activated: z.boolean() });

const taskProbeSchema = z.strictObject({
  assistantCount: z.number().int().nonnegative(),
  assistantCharacters: z.number().int().nonnegative(),
  userCount: z.number().int().nonnegative(),
  busy: z.boolean(),
  sendVisible: z.boolean(),
  signInVisible: z.boolean(),
  errorVisible: z.boolean(),
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

function prepareTaskScript(prompt: string): string {
  return `(() => {
    const prompt = ${JSON.stringify(prompt)};
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
    ].find(visible);
    const baselineAssistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    const baselineUserCount = document.querySelectorAll('[data-message-author-role="user"]').length;
    if (!(composer instanceof HTMLElement)) {
      return { ready: false, baselineAssistantCount, baselineUserCount };
    }
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return { ready: false, baselineAssistantCount, baselineUserCount };
      setter.call(composer, prompt);
    } else {
      composer.replaceChildren(document.createTextNode(prompt));
    }
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: prompt,
      inputType: "insertText"
    }));
    return { ready: true, baselineAssistantCount, baselineUserCount };
  })()`;
}

const activateTaskScript = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const send = [
    document.querySelector('[data-testid="send-button"]'),
    document.querySelector('button[aria-label="Send prompt"]'),
    document.querySelector('button[aria-label="Send message"]')
  ].find((element) => visible(element) && element instanceof HTMLButtonElement && !element.disabled);
  if (!(send instanceof HTMLButtonElement)) return { activated: false };
  send.click();
  return { activated: true };
})()`;

function taskProbeScript(baselineAssistantCount: number): string {
  return `(() => {
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const current = assistants.slice(${baselineAssistantCount}).at(-1);
    const explicitSignIn = [
      document.querySelector('[data-testid="login-button"]'),
      document.querySelector('a[href*="/auth/login"]'),
      document.querySelector('button[name="login"]')
    ].some(visible);
    const labelledSignIn = [...document.querySelectorAll("a,button")]
      .some((element) => visible(element) && /^(log in|sign in|sign up)$/iu.test((element.textContent || "").trim()));
    const busy = [
      document.querySelector('[data-testid="stop-button"]'),
      document.querySelector('button[aria-label="Stop generating"]'),
      document.querySelector('button[aria-label="Stop"]')
    ].some(visible);
    const sendVisible = [
      document.querySelector('[data-testid="send-button"]'),
      document.querySelector('button[aria-label="Send prompt"]'),
      document.querySelector('button[aria-label="Send message"]')
    ].some(visible);
    const errorVisible = [
      document.querySelector('[data-testid="conversation-turn-error"]'),
      document.querySelector('[data-testid="network-error"]')
    ].some(visible);
    return {
      assistantCount: assistants.length,
      assistantCharacters: current instanceof HTMLElement ? current.innerText.length : 0,
      userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
      busy,
      sendVisible,
      signInVisible: explicitSignIn || labelledSignIn,
      errorVisible
    };
  })()`;
}

export type ChatGptRouteOptions = Readonly<{
  homeUrl: string;
  initialUrl: string;
  e2eOrigin: string | null;
  parent: () => BrowserWindow | null;
  title?: string;
  onClosed?: () => void;
  taskTimeoutMs?: number;
  taskPollMs?: number;
}>;

export type ChatGptOpenResult = Readonly<{
  status: "opened" | "unreachable";
}>;

export type ChatGptReadonlyTaskResult = Readonly<{
  state:
    | "completed"
    | "not_authenticated"
    | "failed_before_submit"
    | "outcome_unknown";
  code:
    | "CHATGPT_TASK_IN_PROGRESS"
    | "CHATGPT_PAGE_UNREACHABLE"
    | "CHATGPT_SIGN_IN_REQUIRED"
    | "CHATGPT_UI_UNRECOGNIZED"
    | "CHATGPT_COMPOSER_UNAVAILABLE"
    | "CHATGPT_SUBMIT_UNAVAILABLE"
    | "CHATGPT_TASK_PAGE_LOST"
    | "CHATGPT_TASK_ERROR"
    | "CHATGPT_TASK_TIMEOUT"
    | "CHATGPT_ATTACHMENT_CONTROL_UNAVAILABLE"
    | "CHATGPT_ATTACHMENT_UPLOAD_FAILED"
    | "CHATGPT_ATTACHMENT_UPLOAD_TIMEOUT"
    | null;
  deltaCount: number;
  observedCharacters: number;
}>;

export class ChatGptRoute {
  private routeWindow: BrowserWindow | null = null;
  private readonly popupWindows = new Set<BrowserWindow>();
  private routeSession: Session | null = null;
  private load: "failed" | "loaded" = "failed";
  private disposing = false;
  private taskInFlight = false;
  private opening: Promise<ChatGptOpenResult> | null = null;
  private entryUrl: string;
  private displayTitle: string;

  constructor(private readonly options: ChatGptRouteOptions) {
    this.entryUrl = options.initialUrl;
    this.displayTitle = options.title ?? "ChatGPT · Farol Next";
    if (
      !allowedChatGptPageUrl(options.homeUrl, options.e2eOrigin) ||
      !allowedChatGptPageUrl(options.initialUrl, options.e2eOrigin) ||
      (options.e2eOrigin !== null &&
        (new URL(options.initialUrl).origin !== options.e2eOrigin ||
          new URL(options.homeUrl).origin !== options.e2eOrigin))
    ) {
      throw new Error("CHATGPT_INITIAL_URL_INVALID");
    }
  }

  async open(): Promise<ChatGptOpenResult> {
    if (this.opening) return this.opening;
    if (this.routeWindow && !this.routeWindow.isDestroyed()) {
      if (this.routeWindow.isMinimized()) this.routeWindow.restore();
      this.routeWindow.show();
      this.routeWindow.focus();
      return { status: this.load === "loaded" ? "opened" : "unreachable" };
    }

    const opening = this.openRouteWindow();
    this.opening = opening;
    try {
      return await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async openRouteWindow(): Promise<ChatGptOpenResult> {
    const parent = this.options.parent();
    const restoreParent = parent?.isVisible() ?? false;
    const routeSession = session.fromPartition(CHATGPT_PARTITION, {
      cache: true,
    });
    if (this.routeSession !== routeSession) {
      this.hardenSession(routeSession);
      this.routeSession = routeSession;
    }
    const candidate = new BrowserWindow({
      title: this.displayTitle,
      width: 1080,
      height: 760,
      minWidth: 720,
      minHeight: 560,
      backgroundColor: "#111216",
      show: false,
      webPreferences: this.remoteWebPreferences(),
    });
    this.routeWindow = candidate;
    this.disposing = false;
    this.hardenContents(candidate.webContents, true);
    candidate.on("page-title-updated", (event) => {
      event.preventDefault();
      candidate.setTitle(this.displayTitle);
    });
    candidate.on("close", () => {
      this.captureConversationUrl(candidate.webContents);
    });
    candidate.on("closed", () => {
      if (this.routeWindow === candidate) this.routeWindow = null;
      if (!this.disposing) this.options.onClosed?.();
      setTimeout(() => {
        if (
          !this.disposing &&
          restoreParent &&
          parent &&
          !parent.isDestroyed()
        ) {
          parent.show();
          parent.focus();
        }
      }, 100);
    });

    try {
      await candidate.loadURL(this.entryUrl);
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

  async runReadonlyTask(
    prompt: string,
    attachments: readonly StagedChatGptAttachment[] = [],
  ): Promise<ChatGptReadonlyTaskResult> {
    if (this.taskInFlight) {
      return {
        state: "failed_before_submit",
        code: "CHATGPT_TASK_IN_PROGRESS",
        deltaCount: 0,
        observedCharacters: 0,
      };
    }
    this.taskInFlight = true;
    let submitted = false;
    let deltaCount = 0;
    let observedCharacters = 0;
    try {
      const opened = await this.open();
      if (opened.status !== "opened") {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_PAGE_UNREACHABLE",
          deltaCount,
          observedCharacters,
        };
      }
      const readiness = await this.observe();
      if (readiness.state === "signed_out") {
        return {
          state: "not_authenticated",
          code: "CHATGPT_SIGN_IN_REQUIRED",
          deltaCount,
          observedCharacters,
        };
      }
      if (readiness.state !== "authenticated") {
        return {
          state: "failed_before_submit",
          code:
            readiness.code === "CHATGPT_PAGE_UNREACHABLE"
              ? "CHATGPT_PAGE_UNREACHABLE"
              : "CHATGPT_UI_UNRECOGNIZED",
          deltaCount,
          observedCharacters,
        };
      }
      const candidate = this.routeWindow;
      if (!candidate || candidate.isDestroyed()) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_COMPOSER_UNAVAILABLE",
          deltaCount,
          observedCharacters,
        };
      }
      const prepared = preparedTaskSchema.safeParse(
        await candidate.webContents.executeJavaScript(
          prepareTaskScript(prompt),
          true,
        ),
      );
      if (!prepared.success || !prepared.data.ready) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_COMPOSER_UNAVAILABLE",
          deltaCount,
          observedCharacters,
        };
      }
      if (attachments.length > 0) {
        const uploaded = await uploadChatGptAttachments(
          candidate.webContents,
          attachments,
        );
        if (uploaded.status === "failed") {
          return {
            state: "failed_before_submit",
            code: uploaded.code,
            deltaCount,
            observedCharacters,
          };
        }
      }
      const submitDeadline = Date.now() + 5_000;
      while (Date.now() < submitDeadline) {
        const activated = activatedTaskSchema.safeParse(
          await candidate.webContents.executeJavaScript(
            activateTaskScript,
            true,
          ),
        );
        if (activated.success && activated.data.activated) {
          submitted = true;
          break;
        }
        await delay(100);
      }
      if (!submitted) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_SUBMIT_UNAVAILABLE",
          deltaCount,
          observedCharacters,
        };
      }

      let accepted = false;
      let stablePolls = 0;
      const pollMs = this.options.taskPollMs ?? 250;
      const deadline = Date.now() + (this.options.taskTimeoutMs ?? 180_000);
      while (Date.now() < deadline) {
        const active = this.routeWindow;
        if (!active || active !== candidate || active.isDestroyed()) {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_PAGE_LOST",
            deltaCount,
            observedCharacters,
          };
        }
        const currentUrl = active.webContents.getURL();
        if (!allowedChatGptPageUrl(currentUrl, this.options.e2eOrigin)) {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_PAGE_LOST",
            deltaCount,
            observedCharacters,
          };
        }
        const probe = taskProbeSchema.safeParse(
          await active.webContents.executeJavaScript(
            taskProbeScript(prepared.data.baselineAssistantCount),
            true,
          ),
        );
        if (!probe.success) {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_ERROR",
            deltaCount,
            observedCharacters,
          };
        }
        if (probe.data.signInVisible || probe.data.errorVisible) {
          return {
            state: "outcome_unknown",
            code: probe.data.signInVisible
              ? "CHATGPT_TASK_PAGE_LOST"
              : "CHATGPT_TASK_ERROR",
            deltaCount,
            observedCharacters,
          };
        }
        accepted ||=
          probe.data.userCount > prepared.data.baselineUserCount ||
          probe.data.assistantCount > prepared.data.baselineAssistantCount ||
          probe.data.busy;
        if (probe.data.assistantCharacters > observedCharacters) {
          observedCharacters = probe.data.assistantCharacters;
          deltaCount += 1;
          stablePolls = 0;
        } else if (
          accepted &&
          observedCharacters > 0 &&
          !probe.data.busy &&
          probe.data.sendVisible
        ) {
          stablePolls += 1;
        } else {
          stablePolls = 0;
        }
        if (
          accepted &&
          observedCharacters > 0 &&
          probe.data.sendVisible &&
          stablePolls >= 3
        ) {
          return {
            state: "completed",
            code: null,
            deltaCount,
            observedCharacters,
          };
        }
        await delay(pollMs);
      }
      return {
        state: "outcome_unknown",
        code: "CHATGPT_TASK_TIMEOUT",
        deltaCount,
        observedCharacters,
      };
    } catch {
      return {
        state: submitted ? "outcome_unknown" : "failed_before_submit",
        code: submitted ? "CHATGPT_TASK_ERROR" : "CHATGPT_SUBMIT_UNAVAILABLE",
        deltaCount,
        observedCharacters,
      };
    } finally {
      this.taskInFlight = false;
    }
  }

  currentConversationUrl(): string | null {
    const candidate = this.routeWindow;
    if (!candidate || candidate.isDestroyed() || this.load !== "loaded") {
      return null;
    }
    return this.captureConversationUrl(candidate.webContents);
  }

  setTitle(title: string): void {
    this.displayTitle = title;
    if (this.routeWindow && !this.routeWindow.isDestroyed()) {
      this.routeWindow.setTitle(title);
    }
  }

  resetConversation(): void {
    this.entryUrl = this.options.homeUrl;
    this.disposing = true;
    for (const popup of this.popupWindows) {
      if (!popup.isDestroyed()) popup.destroy();
    }
    this.popupWindows.clear();
    if (this.routeWindow && !this.routeWindow.isDestroyed()) {
      this.routeWindow.destroy();
    }
    this.routeWindow = null;
    this.load = "failed";
    this.disposing = false;
  }

  dispose(): void {
    this.disposing = true;
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

  private captureConversationUrl(contents: WebContents): string | null {
    if (contents.isDestroyed() || this.load !== "loaded") return null;
    const canonical = canonicalChatGptConversationUrl(
      contents.getURL(),
      this.options.e2eOrigin,
    );
    if (canonical !== null) this.entryUrl = canonical;
    return canonical;
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
        (_event, url, inPlace, isMainFrame) => {
          if (!isMainFrame) return;
          this.load = inPlace && allowed(url) ? "loaded" : "failed";
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
