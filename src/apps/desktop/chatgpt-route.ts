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
  baselineMessageIds: z
    .array(z.string().min(1).max(256))
    .max(512)
    .optional()
    .default([]),
});

const activatedTaskSchema = z.strictObject({ activated: z.boolean() });

const taskProbeSchema = z.strictObject({
  assistantCount: z.number().int().nonnegative(),
  assistantCharacters: z.number().int().nonnegative(),
  assistantText: z.string().max(256 * 1_024),
  userCount: z.number().int().nonnegative(),
  turnUserId: z.string().min(1).max(256).nullable(),
  turnAssistantId: z.string().min(1).max(256).nullable(),
  busy: z.boolean(),
  sendVisible: z.boolean(),
  signInVisible: z.boolean(),
  errorVisible: z.boolean(),
  errorKind: z
    .enum(["none", "usage_limited", "generic"])
    .optional()
    .default("none"),
});

const activityProbeSchema = z.strictObject({ running: z.boolean() });

export type ChatGptProviderErrorKind = "usage_limited" | "generic";

const chatGptUsageLimitPattern =
  /(?:usage|message|rate)\s+limit|limit\s+(?:has\s+been\s+)?reached|reached\s+(?:your|the)\s+(?:usage|message|rate)?\s*limit|too\s+many\s+requests/iu;

export function classifyChatGptProviderError(
  text: string,
): ChatGptProviderErrorKind {
  return chatGptUsageLimitPattern.test(text) ? "usage_limited" : "generic";
}

const hardenedRouteSessions = new WeakSet<Session>();

const activityProbe = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const running = [
    document.querySelector('[data-testid="stop-button"]'),
    document.querySelector('button[aria-label="Stop generating"]'),
    document.querySelector('button[aria-label="Stop"]')
  ].some(visible);
  return { running };
})()`;

const cancelTaskScript = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const stop = [
    document.querySelector('[data-testid="stop-button"]'),
    document.querySelector('button[aria-label="Stop generating"]'),
    document.querySelector('button[aria-label="Stop"]')
  ].find((element) => visible(element) && element instanceof HTMLButtonElement && !element.disabled);
  if (!(stop instanceof HTMLButtonElement)) return { activated: false };
  stop.click();
  return { activated: true };
})()`;

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
    const baselineMessageIds = [...new Set(
      [...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')]
        .map((element) => element.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null)
        .filter((value) => typeof value === 'string' && value.length > 0 && value.length <= 256)
    )].slice(-512);
    if (!(composer instanceof HTMLElement)) {
      return { ready: false, baselineAssistantCount, baselineUserCount, baselineMessageIds };
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
    return { ready: true, baselineAssistantCount, baselineUserCount, baselineMessageIds };
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

function taskProbeScript(
  prompt: string,
  baselineMessageIds: readonly string[],
): string {
  return `(() => {
    const prompt = ${JSON.stringify(prompt)};
    const baselineMessageIds = new Set(${JSON.stringify(baselineMessageIds)});
    const usageLimitPattern = new RegExp(${JSON.stringify(chatGptUsageLimitPattern.source)}, ${JSON.stringify(chatGptUsageLimitPattern.flags)});
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const messages = [...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')];
    const assistants = messages.filter((element) => element.getAttribute('data-message-author-role') === 'assistant');
    const messageId = (element) => element?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null;
    const users = messages.filter((element) => element.getAttribute('data-message-author-role') === 'user');
    const currentUser = [...users].reverse().find((element) => {
      const id = messageId(element);
      return id !== null && !baselineMessageIds.has(id) && (element.textContent || '').trim() === prompt.trim();
    }) ?? null;
    const turnUserId = messageId(currentUser);
    let currentAssistant = null;
    if (currentUser && turnUserId !== null) {
      const userIndex = messages.indexOf(currentUser);
      for (const element of messages.slice(userIndex + 1)) {
        const role = element.getAttribute('data-message-author-role');
        if (role === 'user') break;
        if (role !== 'assistant') continue;
        const id = messageId(element);
        if (id === null) continue;
        const parentId = element.closest('[data-parent-message-id]')?.getAttribute('data-parent-message-id') ?? null;
        if (parentId !== null && parentId !== turnUserId) continue;
        currentAssistant = element;
        break;
      }
    }
    const turnAssistantId = messageId(currentAssistant);
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
    const errors = [
      document.querySelector('[data-testid="conversation-turn-error"]'),
      document.querySelector('[data-testid="network-error"]'),
      document.querySelector('[data-testid="usage-limit-message"]'),
      document.querySelector('[data-testid="rate-limit-error"]'),
      ...document.querySelectorAll('[role="alert"]')
    ].filter(visible);
    const usageLimited = errors.some((element) =>
      usageLimitPattern.test((element.textContent || "").trim())
    );
    const errorVisible = errors.length > 0;
    const assistantText = currentAssistant instanceof HTMLElement ? currentAssistant.innerText : "";
    return {
      assistantCount: assistants.length,
      assistantCharacters: assistantText.length,
      assistantText,
      userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
      turnUserId,
      turnAssistantId,
      busy,
      sendVisible,
      signInVisible: explicitSignIn || labelledSignIn,
      errorVisible,
      errorKind: usageLimited ? "usage_limited" : errorVisible ? "generic" : "none"
    };
  })()`;
}

export type ChatGptRouteOptions = Readonly<{
  homeUrl: string;
  initialUrl: string;
  e2eOrigin: string | null;
  parent: () => BrowserWindow | null;
  surfaceFactory?: ChatGptRouteSurfaceFactory;
  title?: string;
  onClosed?: (conversationUrl: string | null, taskRunning: boolean) => void;
  onConversationChanged?: (conversationUrl: string | null) => void;
  onTaskActivityChanged?: (
    state: "idle" | "running" | "outcome_unknown",
  ) => void;
  taskTimeoutMs?: number;
  taskPollMs?: number;
}>;

export type ChatGptOpenResult = Readonly<{
  status: "opened" | "unreachable";
}>;

export type ChatGptRouteSurface = Readonly<{
  kind: "window" | "embedded";
  webContents: WebContents;
  isDestroyed: () => boolean;
  loadURL: (url: string) => Promise<void>;
  reveal: () => void;
  focus: () => void;
  setTitle: (title: string) => void;
  destroy: () => void;
  onPageTitleUpdated: (
    listener: (event: { preventDefault: () => void }) => void,
  ) => void;
  onClosing: (listener: () => void) => void;
  onClosed: (listener: () => void) => void;
}>;

export type ChatGptRouteSurfaceFactory = (input: {
  title: string;
  webPreferences: Electron.WebPreferences;
}) => ChatGptRouteSurface;

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
    | "CHATGPT_USAGE_LIMITED"
    | "CHATGPT_TASK_OUTPUT_CHANGED"
    | "CHATGPT_TASK_TIMEOUT"
    | "CHATGPT_ATTACHMENT_CONTROL_UNAVAILABLE"
    | "CHATGPT_ATTACHMENT_UPLOAD_FAILED"
    | "CHATGPT_ATTACHMENT_UPLOAD_TIMEOUT"
    | null;
  deltaCount: number;
  observedCharacters: number;
  outputText?: string;
  turnUserId?: string | null;
  turnAssistantId?: string | null;
}>;

export type ChatGptTaskTextDelta = Readonly<{
  sequence: number;
  delta: string;
  text: string;
  observedCharacters: number;
}>;

export type ChatGptTaskObserver = Readonly<{
  onTextDelta?: (delta: ChatGptTaskTextDelta) => void | Promise<void>;
}>;

export class ChatGptRoute {
  private routeWindow: ChatGptRouteSurface | null = null;
  private readonly popupWindows = new Set<BrowserWindow>();
  private routeSession: Session | null = null;
  private load: "failed" | "loaded" = "failed";
  private disposing = false;
  private taskInFlight = false;
  private opening: Promise<ChatGptOpenResult> | null = null;
  private entryUrl: string;
  private displayTitle: string;
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private activityPollInFlight = false;
  private activityGeneration = 0;
  private observedTaskRunning: boolean | null = null;

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
      this.routeWindow.reveal();
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
    const candidate = this.options.surfaceFactory
      ? this.options.surfaceFactory({
          title: this.displayTitle,
          webPreferences: this.remoteWebPreferences(),
        })
      : this.createWindowSurface();
    this.routeWindow = candidate;
    this.disposing = false;
    this.hardenContents(candidate.webContents, true);
    let closingConversationObserved = false;
    let closingConversationUrl: string | null = null;
    let closingTaskRunning = false;
    candidate.onPageTitleUpdated((event) => {
      event.preventDefault();
      candidate.setTitle(this.displayTitle);
    });
    candidate.onClosing(() => {
      closingConversationObserved = true;
      closingConversationUrl = this.captureConversationUrl(
        candidate.webContents,
      );
      closingTaskRunning = this.observedTaskRunning === true;
      this.stopTaskActivityWatch();
    });
    candidate.onClosed(() => {
      this.stopTaskActivityWatch();
      if (this.routeWindow === candidate) this.routeWindow = null;
      if (!this.disposing) {
        const retainedConversationUrl = closingConversationObserved
          ? closingConversationUrl
          : canonicalChatGptConversationUrl(
              this.entryUrl,
              this.options.e2eOrigin,
            );
        this.options.onClosed?.(retainedConversationUrl, closingTaskRunning);
      }
      setTimeout(() => {
        if (
          !this.disposing &&
          candidate.kind === "window" &&
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
      candidate.reveal();
      candidate.focus();
      return { status: "opened" };
    } catch {
      this.load = "failed";
      if (!candidate.isDestroyed()) candidate.reveal();
      return { status: "unreachable" };
    }
  }

  private createWindowSurface(): ChatGptRouteSurface {
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
    return {
      kind: "window",
      webContents: candidate.webContents,
      isDestroyed: () => candidate.isDestroyed(),
      loadURL: (url) => candidate.loadURL(url),
      reveal: () => {
        if (candidate.isMinimized()) candidate.restore();
        candidate.show();
      },
      focus: () => candidate.focus(),
      setTitle: (title) => candidate.setTitle(title),
      destroy: () => candidate.destroy(),
      onPageTitleUpdated: (listener) => {
        candidate.on("page-title-updated", (event) => listener(event));
      },
      onClosing: (listener) => {
        candidate.on("close", listener);
      },
      onClosed: (listener) => {
        candidate.on("closed", listener);
      },
    };
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
    observer: ChatGptTaskObserver = {},
  ): Promise<ChatGptReadonlyTaskResult> {
    if (this.taskInFlight) {
      return {
        state: "failed_before_submit",
        code: "CHATGPT_TASK_IN_PROGRESS",
        deltaCount: 0,
        observedCharacters: 0,
        outputText: "",
      };
    }
    this.taskInFlight = true;
    let submissionPhase:
      "not_attempted" | "awaiting_acknowledgement" | "submitted" =
      "not_attempted";
    let deltaCount = 0;
    let observedCharacters = 0;
    let observedText = "";
    let sequence = 0;
    let correlatedUserId: string | null = null;
    let correlatedAssistantId: string | null = null;
    const correlation = () =>
      correlatedUserId === null && correlatedAssistantId === null
        ? {}
        : {
            turnUserId: correlatedUserId,
            turnAssistantId: correlatedAssistantId,
          };
    try {
      const opened = await this.open();
      if (opened.status !== "opened") {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_PAGE_UNREACHABLE",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      const readiness = await this.observe();
      if (readiness.state === "signed_out") {
        return {
          state: "not_authenticated",
          code: "CHATGPT_SIGN_IN_REQUIRED",
          deltaCount,
          observedCharacters,
          outputText: observedText,
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
          outputText: observedText,
        };
      }
      const candidate = this.routeWindow;
      if (!candidate || candidate.isDestroyed()) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_COMPOSER_UNAVAILABLE",
          deltaCount,
          observedCharacters,
          outputText: observedText,
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
            outputText: observedText,
          };
        }
      }
      const submitDeadline = Date.now() + 5_000;
      while (Date.now() < submitDeadline) {
        submissionPhase = "awaiting_acknowledgement";
        const activated = activatedTaskSchema.safeParse(
          await candidate.webContents.executeJavaScript(
            activateTaskScript,
            true,
          ),
        );
        if (!activated.success) {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_ERROR",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        if (activated.data.activated) {
          submissionPhase = "submitted";
          break;
        }
        submissionPhase = "not_attempted";
        await delay(100);
      }
      if (submissionPhase !== "submitted") {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_SUBMIT_UNAVAILABLE",
          deltaCount,
          observedCharacters,
          outputText: observedText,
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
            outputText: observedText,
            ...correlation(),
          };
        }
        const currentUrl = active.webContents.getURL();
        if (!allowedChatGptPageUrl(currentUrl, this.options.e2eOrigin)) {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_PAGE_LOST",
            deltaCount,
            observedCharacters,
            outputText: observedText,
            ...correlation(),
          };
        }
        const probe = taskProbeSchema.safeParse(
          await active.webContents.executeJavaScript(
            taskProbeScript(prompt, prepared.data.baselineMessageIds),
            true,
          ),
        );
        if (!probe.success) {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_ERROR",
            deltaCount,
            observedCharacters,
            outputText: observedText,
            ...correlation(),
          };
        }
        if (probe.data.signInVisible || probe.data.errorVisible) {
          return {
            state: "outcome_unknown",
            code: probe.data.signInVisible
              ? "CHATGPT_TASK_PAGE_LOST"
              : probe.data.errorKind === "usage_limited"
                ? "CHATGPT_USAGE_LIMITED"
                : "CHATGPT_TASK_ERROR",
            deltaCount,
            observedCharacters,
            outputText: observedText,
            ...correlation(),
          };
        }
        if (probe.data.turnUserId !== null) {
          if (correlatedUserId === null) {
            correlatedUserId = probe.data.turnUserId;
          } else if (probe.data.turnUserId !== correlatedUserId) {
            return {
              state: "outcome_unknown",
              code: "CHATGPT_TASK_OUTPUT_CHANGED",
              deltaCount,
              observedCharacters,
              outputText: observedText,
              ...correlation(),
            };
          }
        }
        if (probe.data.turnAssistantId !== null) {
          if (
            probe.data.turnUserId === null ||
            probe.data.turnUserId !== correlatedUserId
          ) {
            return {
              state: "outcome_unknown",
              code: "CHATGPT_TASK_OUTPUT_CHANGED",
              deltaCount,
              observedCharacters,
              outputText: observedText,
              ...correlation(),
            };
          }
          if (correlatedAssistantId === null) {
            correlatedAssistantId = probe.data.turnAssistantId;
          } else if (probe.data.turnAssistantId !== correlatedAssistantId) {
            return {
              state: "outcome_unknown",
              code: "CHATGPT_TASK_OUTPUT_CHANGED",
              deltaCount,
              observedCharacters,
              outputText: observedText,
              ...correlation(),
            };
          }
        }
        accepted ||= correlatedUserId !== null;
        const correlated =
          correlatedUserId !== null &&
          correlatedAssistantId !== null &&
          probe.data.turnUserId === correlatedUserId &&
          probe.data.turnAssistantId === correlatedAssistantId;
        if (correlated && probe.data.assistantText !== observedText) {
          if (observedText.startsWith(probe.data.assistantText)) {
            stablePolls = 0;
            await delay(pollMs);
            continue;
          }
          if (!probe.data.assistantText.startsWith(observedText)) {
            return {
              state: "outcome_unknown",
              code: "CHATGPT_TASK_OUTPUT_CHANGED",
              deltaCount,
              observedCharacters,
              outputText: observedText,
            };
          }
          const delta = probe.data.assistantText.slice(observedText.length);
          observedText = probe.data.assistantText;
          observedCharacters = observedText.length;
          deltaCount += 1;
          sequence += 1;
          await observer.onTextDelta?.({
            sequence,
            delta,
            text: observedText,
            observedCharacters,
          });
          stablePolls = 0;
        } else if (
          correlated &&
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
          correlated &&
          observedCharacters > 0 &&
          probe.data.sendVisible &&
          stablePolls >= 3
        ) {
          return {
            state: "completed",
            code: null,
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        await delay(pollMs);
      }
      return {
        state: "outcome_unknown",
        code: "CHATGPT_TASK_TIMEOUT",
        deltaCount,
        observedCharacters,
        outputText: observedText,
        ...correlation(),
      };
    } catch {
      const submissionMayHaveOccurred =
        submissionPhase === "awaiting_acknowledgement" ||
        submissionPhase === "submitted";
      return {
        state: submissionMayHaveOccurred
          ? "outcome_unknown"
          : "failed_before_submit",
        code: submissionMayHaveOccurred
          ? "CHATGPT_TASK_ERROR"
          : "CHATGPT_SUBMIT_UNAVAILABLE",
        deltaCount,
        observedCharacters,
        outputText: observedText,
        ...correlation(),
      };
    } finally {
      this.taskInFlight = false;
    }
  }

  async observeReadonlyTask(
    input: Readonly<{
      prompt: string;
      turnUserId: string;
      turnAssistantId: string | null;
    }>,
    observer: ChatGptTaskObserver = {},
  ): Promise<ChatGptReadonlyTaskResult> {
    if (this.taskInFlight || !input.turnUserId || !input.prompt) {
      return {
        state: "outcome_unknown",
        code: this.taskInFlight
          ? "CHATGPT_TASK_IN_PROGRESS"
          : "CHATGPT_TASK_OUTPUT_CHANGED",
        deltaCount: 0,
        observedCharacters: 0,
        outputText: "",
        turnUserId: input.turnUserId || null,
        turnAssistantId: input.turnAssistantId,
      };
    }
    this.taskInFlight = true;
    let deltaCount = 0;
    let observedCharacters = 0;
    let observedText = "";
    let sequence = 0;
    let correlatedAssistantId = input.turnAssistantId;
    const result = (
      code: NonNullable<ChatGptReadonlyTaskResult["code"]>,
    ): ChatGptReadonlyTaskResult => ({
      state: "outcome_unknown",
      code,
      deltaCount,
      observedCharacters,
      outputText: observedText,
      turnUserId: input.turnUserId,
      turnAssistantId: correlatedAssistantId,
    });
    try {
      const opened = await this.open();
      if (opened.status !== "opened") {
        return result("CHATGPT_PAGE_UNREACHABLE");
      }
      const readiness = await this.observe();
      if (readiness.state !== "authenticated") {
        return result(
          readiness.state === "signed_out"
            ? "CHATGPT_SIGN_IN_REQUIRED"
            : "CHATGPT_UI_UNRECOGNIZED",
        );
      }
      const candidate = this.routeWindow;
      if (!candidate || candidate.isDestroyed()) {
        return result("CHATGPT_TASK_PAGE_LOST");
      }
      let stablePolls = 0;
      const pollMs = this.options.taskPollMs ?? 250;
      const deadline = Date.now() + (this.options.taskTimeoutMs ?? 180_000);
      while (Date.now() < deadline) {
        const active = this.routeWindow;
        if (!active || active !== candidate || active.isDestroyed()) {
          return result("CHATGPT_TASK_PAGE_LOST");
        }
        const currentUrl = active.webContents.getURL();
        if (!allowedChatGptPageUrl(currentUrl, this.options.e2eOrigin)) {
          return result("CHATGPT_TASK_PAGE_LOST");
        }
        const probe = taskProbeSchema.safeParse(
          await active.webContents.executeJavaScript(
            taskProbeScript(input.prompt, []),
            true,
          ),
        );
        if (!probe.success) return result("CHATGPT_TASK_ERROR");
        if (probe.data.signInVisible || probe.data.errorVisible) {
          return result(
            probe.data.signInVisible
              ? "CHATGPT_SIGN_IN_REQUIRED"
              : probe.data.errorKind === "usage_limited"
                ? "CHATGPT_USAGE_LIMITED"
                : "CHATGPT_TASK_ERROR",
          );
        }
        if (probe.data.turnUserId !== input.turnUserId) {
          stablePolls = 0;
          await delay(pollMs);
          continue;
        }
        if (probe.data.turnAssistantId === null) {
          stablePolls = 0;
          await delay(pollMs);
          continue;
        }
        if (correlatedAssistantId === null) {
          correlatedAssistantId = probe.data.turnAssistantId;
        } else if (probe.data.turnAssistantId !== correlatedAssistantId) {
          return result("CHATGPT_TASK_OUTPUT_CHANGED");
        }
        if (probe.data.assistantText !== observedText) {
          if (
            observedText.startsWith(probe.data.assistantText) ||
            !probe.data.assistantText.startsWith(observedText)
          ) {
            return result("CHATGPT_TASK_OUTPUT_CHANGED");
          }
          const delta = probe.data.assistantText.slice(observedText.length);
          observedText = probe.data.assistantText;
          observedCharacters = observedText.length;
          deltaCount += 1;
          sequence += 1;
          await observer.onTextDelta?.({
            sequence,
            delta,
            text: observedText,
            observedCharacters,
          });
          stablePolls = 0;
        } else if (
          observedCharacters > 0 &&
          !probe.data.busy &&
          probe.data.sendVisible
        ) {
          stablePolls += 1;
        } else {
          stablePolls = 0;
        }
        if (
          observedCharacters > 0 &&
          probe.data.sendVisible &&
          stablePolls >= 3
        ) {
          return {
            state: "completed",
            code: null,
            deltaCount,
            observedCharacters,
            outputText: observedText,
            turnUserId: input.turnUserId,
            turnAssistantId: correlatedAssistantId,
          };
        }
        await delay(pollMs);
      }
      return result("CHATGPT_TASK_TIMEOUT");
    } catch {
      return result("CHATGPT_TASK_ERROR");
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

  retainedConversationUrl(): string | null {
    return canonicalChatGptConversationUrl(
      this.entryUrl,
      this.options.e2eOrigin,
    );
  }

  async cancelActiveTask(): Promise<
    "cancelled" | "not_running" | "outcome_unknown"
  > {
    const candidate = this.routeWindow;
    if (!candidate || candidate.isDestroyed() || this.load !== "loaded") {
      return "not_running";
    }
    try {
      const wasObservedRunning = this.observedTaskRunning === true;
      const activationAttempts = wasObservedRunning ? 5 : 1;
      let stopActivated = false;
      for (let attempt = 0; attempt < activationAttempts; attempt += 1) {
        const activated = activatedTaskSchema.safeParse(
          await candidate.webContents.executeJavaScript(cancelTaskScript, true),
        );
        if (!activated.success) return "outcome_unknown";
        if (activated.data.activated) {
          stopActivated = true;
          break;
        }
        if (!wasObservedRunning) return "not_running";
        await delay(100);
      }
      if (!stopActivated) return "outcome_unknown";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await delay(100);
        if (candidate.isDestroyed()) return "outcome_unknown";
        const observed = activityProbeSchema.safeParse(
          await candidate.webContents.executeJavaScript(activityProbe, true),
        );
        if (!observed.success) return "outcome_unknown";
        if (!observed.data.running) {
          if (this.options.onTaskActivityChanged) {
            this.startTaskActivityWatch(candidate.webContents);
          }
          this.recordTaskActivity(false);
          return "cancelled";
        }
      }
      return "outcome_unknown";
    } catch {
      return "outcome_unknown";
    }
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
    this.stopTaskActivityWatch();
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
    this.options.onConversationChanged?.(null);
  }

  dispose(): void {
    this.disposing = true;
    this.stopTaskActivityWatch();
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
    if (hardenedRouteSessions.has(routeSession)) return;
    routeSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    routeSession.setPermissionCheckHandler(() => false);
    routeSession.on("will-download", (event) => event.preventDefault());
    hardenedRouteSessions.add(routeSession);
  }

  private captureConversationUrl(contents: WebContents): string | null {
    if (contents.isDestroyed()) return null;
    const canonical = canonicalChatGptConversationUrl(
      contents.getURL(),
      this.options.e2eOrigin,
    );
    if (
      canonical !== null &&
      !this.disposing &&
      this.routeWindow?.webContents === contents
    ) {
      this.entryUrl = canonical;
    }
    return canonical;
  }

  private ownsRouteContents(contents: WebContents): boolean {
    return (
      !this.disposing &&
      this.routeWindow !== null &&
      !this.routeWindow.isDestroyed() &&
      this.routeWindow.webContents === contents
    );
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
          if (!isMainFrame || !this.ownsRouteContents(contents)) return;
          this.load = inPlace && allowed(url) ? "loaded" : "failed";
        },
      );
      contents.on(
        "did-fail-load",
        (_event, _code, _description, _url, isMainFrame) => {
          if (isMainFrame && this.ownsRouteContents(contents)) {
            this.load = "failed";
          }
        },
      );
      contents.on("did-finish-load", () => {
        if (!this.ownsRouteContents(contents)) return;
        this.load = "loaded";
        this.reportConversationUrl(contents);
        if (this.options.onTaskActivityChanged) {
          this.startTaskActivityWatch(contents);
        }
      });
      contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
        if (isMainFrame) this.reportConversationUrl(contents);
      });
      contents.on("render-process-gone", () => {
        if (!this.ownsRouteContents(contents)) return;
        if (this.observedTaskRunning === true) {
          this.options.onTaskActivityChanged?.("outcome_unknown");
        }
        this.stopTaskActivityWatch();
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

  private reportConversationUrl(contents: WebContents): void {
    if (
      !this.options.onConversationChanged ||
      !this.ownsRouteContents(contents)
    ) {
      return;
    }
    const canonical = this.captureConversationUrl(contents);
    if (canonical !== null) {
      this.options.onConversationChanged(canonical);
      return;
    }
    try {
      const current = new URL(contents.getURL());
      const home = new URL(this.options.homeUrl);
      const currentPath = current.pathname.replace(/\/$/u, "") || "/";
      const homePath = home.pathname.replace(/\/$/u, "") || "/";
      if (current.origin === home.origin && currentPath === homePath) {
        this.entryUrl = this.options.homeUrl;
        this.options.onConversationChanged(null);
      }
    } catch {
      // Navigation policy owns malformed or unsupported URLs. They never alter
      // a retained conversation binding.
    }
  }

  private startTaskActivityWatch(contents: WebContents): void {
    this.stopTaskActivityWatch();
    const generation = this.activityGeneration;
    const poll = () => void this.pollTaskActivity(contents, generation);
    poll();
    this.activityTimer = setInterval(poll, 250);
    this.activityTimer.unref?.();
  }

  private stopTaskActivityWatch(): void {
    this.activityGeneration += 1;
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = null;
    this.activityPollInFlight = false;
    this.observedTaskRunning = null;
  }

  private async pollTaskActivity(
    contents: WebContents,
    generation: number,
  ): Promise<void> {
    if (
      generation !== this.activityGeneration ||
      this.activityPollInFlight ||
      contents.isDestroyed() ||
      this.load !== "loaded"
    ) {
      return;
    }
    this.activityPollInFlight = true;
    try {
      const observed = activityProbeSchema.safeParse(
        await contents.executeJavaScript(activityProbe, true),
      );
      if (
        generation === this.activityGeneration &&
        !contents.isDestroyed() &&
        this.load === "loaded" &&
        observed.success
      ) {
        this.reportConversationUrl(contents);
        this.recordTaskActivity(observed.data.running);
      }
    } catch {
      // A navigation can invalidate an in-flight probe. Navigation lifecycle
      // events own readiness and the next bounded poll remeasures activity.
    } finally {
      if (generation === this.activityGeneration) {
        this.activityPollInFlight = false;
      }
    }
  }

  private recordTaskActivity(running: boolean): void {
    if (this.observedTaskRunning === running) return;
    this.observedTaskRunning = running;
    this.options.onTaskActivityChanged?.(running ? "running" : "idle");
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
