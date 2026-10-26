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
import type { VisibleOutputItem } from "./chatgpt-visible-output";
import { publicMarkdownBlock } from "./chatgpt-public-markdown";
import {
  ChatGptUpdateIdleSchema,
  chatGptUpdateIdleProbe,
  type BrowserUpdateAdmission,
  type BrowserUpdateCheck,
} from "./chatgpt-update-idle";
import {
  ChatGptPublicTurn,
  PublicTurnFrameSchema,
  readPublicAssistantMessages,
  publicContentVisible,
} from "./chatgpt-public-turn";
import {
  SavedChatFollowUpActionSchema,
  SavedChatPhysicalBindingSchema,
  SavedChatFollowUpRequestSchema,
  SavedChatFollowUpResultSchema,
  savedChatFollowUpScript,
  type SavedChatPhysicalBinding,
  type SavedChatFollowUpResult,
  type SavedChatFollowUpCode,
  savedChatInsertScript,
  savedChatProofScript,
  savedChatReadinessScript,
  savedChatSubmitScript,
} from "./saved-chat-page-scripts";

import { ChatGptPhysical } from "../../../apps/desktop/chatgpt-physical";
import { chatGptAccountProbeScript } from "../../../apps/desktop/chatgpt-account-probe";
import { observeBoundChatGptAccount } from "../../../apps/desktop/chatgpt-account-observation";
import type {
  ChatGptPhysicalApi,
  PhysicalBinding,
} from "../../../apps/desktop/chatgpt-physical-api";
import type { PhysicalSurface } from "../../../apps/desktop/chatgpt-physical-host-port";
import {
  physicalPrepareProbeScript,
  physicalVerifySendScript,
  physicalSendScript,
  physicalObserveScript,
  physicalCancelScript,
  type PhysicalPageContentProfile,
} from "./chatgpt-physical-page-scripts";

const probeSchema = z.strictObject({
  composerVisible: z.boolean(),
  signInVisible: z.boolean(),
});

// What an in-page submission script returns when it finds the page on
// another URL than the identity the caller validated: it has then touched
// nothing — not the composer, not the send control — and says only that.
const navigatedTaskSchema = z.strictObject({ navigated: z.literal(true) });

const preparedTaskSchema = z.union([
  navigatedTaskSchema,
  z.strictObject({ appSelectionLost: z.literal(true) }),
  z.strictObject({ draftPresent: z.literal(true) }),
  z.strictObject({
    ready: z.boolean(),
    baselineAssistantCount: z.number().int().nonnegative(),
    baselineUserCount: z.number().int().nonnegative(),
    baselineMessageIds: z
      .array(z.string().min(1).max(256))
      .max(512)
      .optional()
      .default([]),
  }),
]);

// A control click's acknowledgement (the stop control on cancel).
const activatedControlSchema = z.strictObject({ activated: z.boolean() });

// The send click's acknowledgement: the same, or the in-page refusal above.
const activatedTaskSchema = z.union([
  navigatedTaskSchema,
  z.strictObject({ appSelectionLost: z.literal(true) }),
  z.strictObject({ profileLost: z.literal(true) }),
  activatedControlSchema,
]);

const taskProbeSchema = z.strictObject({
  publicFrame: PublicTurnFrameSchema.optional(),
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

const appBindingSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("bound") }),
  z.strictObject({ state: z.literal("navigated") }),
  z.strictObject({
    state: z.literal("blocked"),
    reason: z.enum([
      "missing",
      "ambiguous",
      "conflict",
      "draft_present",
      "selection_not_observed",
    ]),
  }),
]);

function appBindingFailureCode(
  reason:
    | "missing"
    | "ambiguous"
    | "conflict"
    | "draft_present"
    | "selection_not_observed",
):
  | "CHATGPT_APP_SELECTION_MISSING"
  | "CHATGPT_APP_SELECTION_AMBIGUOUS"
  | "CHATGPT_APP_SELECTION_CONFLICT"
  | "CHATGPT_APP_SELECTION_LOST"
  | "CHATGPT_COMPOSER_DRAFT_PRESENT" {
  if (reason === "ambiguous") return "CHATGPT_APP_SELECTION_AMBIGUOUS";
  if (reason === "conflict") return "CHATGPT_APP_SELECTION_CONFLICT";
  if (reason === "draft_present") return "CHATGPT_COMPOSER_DRAFT_PRESENT";
  if (reason === "selection_not_observed") return "CHATGPT_APP_SELECTION_LOST";
  return "CHATGPT_APP_SELECTION_MISSING";
}

// How long one page activity probe may take before activity is unknown.
const ACTIVITY_PROBE_DEADLINE_MS = 2_000;
const ROUTE_OPEN_DEADLINE_MS = 30_000;
const READINESS_OBSERVATION_MS = 2_000;

// Page readiness only: no account identity, settings witness or Send authority.
// The host retains the original result and rechecks it immediately before
// publication. A copied/serialized binding is not an independently valid proof.
export type ChatGptSignInStatusBinding = Readonly<{
  sequence: number;
  documentGeneration: number;
}>;

export type ChatGptSignInStatusObservation = Readonly<{
  state: "authenticated" | "signed_out" | "unknown";
  binding: ChatGptSignInStatusBinding | null;
}>;

type ReadinessRead = Readonly<{
  surface: ChatGptRouteSurface | null;
  documentGeneration: number;
  url: string | null;
  sequence: number;
}>;

class RouteOpenTimedOut extends Error {}

export type ChatGptProviderErrorKind = "usage_limited" | "generic";

const chatGptUsageLimitPattern =
  /(?:usage|message|rate)\s+limit|limit\s+(?:has\s+been\s+)?reached|reached\s+(?:your|the)\s+(?:usage|message|rate)?\s*limit|too\s+many\s+requests/iu;

export function classifyChatGptProviderError(
  text: string,
): ChatGptProviderErrorKind {
  return chatGptUsageLimitPattern.test(text) ? "usage_limited" : "generic";
}

const hardenedRouteSessions = new WeakSet<Session>();
const clipboardRouteOwners = new WeakMap<WebContents, () => boolean>();

function routeClipboardWriteAllowed(
  contents: WebContents | null,
  permission: string,
  requestingUrl: string,
  isMainFrame: boolean,
): boolean {
  if (permission !== "clipboard-sanitized-write" || !contents || !isMainFrame)
    return false;
  try {
    return (
      !contents.isDestroyed() &&
      clipboardRouteOwners.get(contents)?.() === true &&
      new URL(requestingUrl).origin === new URL(contents.getURL()).origin
    );
  } catch {
    return false;
  }
}

// A dedicated sign-in surface (see `openForSignIn`) is distinct from the
// same route being reused to run a task: it carries a title of its own, a
// "Return to Farol" banner, and a truthful signed-in/not/unknown status
// reported once on return. DEV embeds the surface in its main window;
// Preview retains the separate-window presentation (UX34-08).
export type ChatGptSignInStatus =
  "authenticated" | "not_authenticated" | "unknown";

// Why the sign-in outcome came out the way it did, so a "unknown" is not
// simply unexplained (S35-R7). Content-free by the same rule as
// `ChatGptSignInBlockedDiagnostic`: a fixed reason token, the page state
// the read classified (or null when there was no reading), how long the
// read ran, and which trigger started it — never a URL, never page text,
// never an error message.
//
// - `answered` — the page read returned and was classified.
// - `timeout` — the read did not return inside
//   `SIGN_IN_CLOSE_OBSERVATION_MS`; the outcome is "unknown" by the bound.
// - `no-window` — there was no live route window to read at all.
// - `load-failed` — the route's own load had already failed.
// - `url-unsupported` — the page was not on an allowed ChatGPT URL.
// - `probe-unrecognized` — the probe answered in a shape this build does
//   not recognise.
// - `probe-threw` — the probe itself failed to run.
export type ChatGptSignInOutcomeDiagnostic = Readonly<{
  reason:
    | "answered"
    | "timeout"
    | "no-window"
    | "load-failed"
    | "url-unsupported"
    | "probe-unrecognized"
    | "probe-threw";
  state: ChatGptPageObservation["state"] | null;
  elapsedMs: number;
  readStartedBy: "return" | "closing";
}>;

// Content-free: a host name, a permission name, or a numeric load-failure
// code — never a URL path, a query string, or anything the page rendered.
export type ChatGptSignInBlockedDiagnostic =
  | Readonly<{ kind: "navigation-blocked"; host: string }>
  | Readonly<{ kind: "popup-blocked"; host: string }>
  | Readonly<{ kind: "permission-denied"; permission: string }>
  | Readonly<{ kind: "load-failed"; code: number }>;

// UX34-07: the block the product shows as current for the sign-in surface.
// A block belongs to the attempt it happened in: the next attempt starts
// with none, so a stale block from an earlier attempt is never shown as
// current, and a later block within an attempt replaces the earlier one.
export class ChatGptSignInBlockLedger {
  private latest: ChatGptSignInBlockedDiagnostic | null = null;

  beginAttempt(): void {
    this.latest = null;
  }

  record(diagnostic: ChatGptSignInBlockedDiagnostic): void {
    this.latest = diagnostic;
  }

  current(): ChatGptSignInBlockedDiagnostic | null {
    return this.latest;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || "(unknown)";
  } catch {
    return "(unknown)";
  }
}

// How long the sign-in window's closing page read may take before the
// outcome is reported as unknown instead of not at all.
const SIGN_IN_CLOSE_OBSERVATION_MS = 2_000;

// What one sign-in page read produced: the observation when it answered in
// time, null when the bound won, and — either way — the content-free
// diagnostic that says which of the two happened and why.
type SignInRead = Readonly<{
  observation: ChatGptPageObservation;
  reason: Exclude<ChatGptSignInOutcomeDiagnostic["reason"], "timeout">;
}>;

type SignInObservation = Readonly<{
  observation: ChatGptPageObservation | null;
  diagnostic: ChatGptSignInOutcomeDiagnostic;
}>;

// A page read taken around closing the sign-in window, bounded so that
// neither the close nor the reported outcome can wait on it forever: after
// the bound it yields null, which is reported as "unknown". The bound is
// deliberately unchanged; what is new is that the outcome now carries how
// long the read ran and which side of the race won, so an "unknown" under
// load can be told from an "unknown" the page itself caused.
function boundedSignInObservation(
  read: Promise<SignInRead>,
  readStartedBy: ChatGptSignInOutcomeDiagnostic["readStartedBy"],
): Promise<SignInObservation> {
  const startedAt = Date.now();
  return Promise.race([
    read.then(({ observation, reason }) => ({
      observation,
      diagnostic: {
        reason,
        state: observation.state,
        elapsedMs: Date.now() - startedAt,
        readStartedBy,
      },
    })),
    new Promise<SignInObservation>((resolve) =>
      setTimeout(
        () =>
          resolve({
            observation: null,
            diagnostic: {
              reason: "timeout",
              state: null,
              elapsedMs: Date.now() - startedAt,
              readStartedBy,
            },
          }),
        SIGN_IN_CLOSE_OBSERVATION_MS,
      ),
    ),
  ]);
}

// The outcome reported when no page read was taken at all: the window was
// never opened, was already gone, or was destroyed without a closing turn.
function unreadSignInOutcome(
  readStartedBy: ChatGptSignInOutcomeDiagnostic["readStartedBy"],
): ChatGptSignInOutcomeDiagnostic {
  return { reason: "no-window", state: null, elapsedMs: 0, readStartedBy };
}
const SIGN_IN_RETURN_SENTINEL = "farol-sign-in-return-to-farol";

// The Return-to-Farol control is only ever added to ChatGPT's own pages. An
// identity provider's page (Google, Apple, Microsoft) is never modified: a
// sign-in or MFA step there runs exactly as the provider serves it, and the
// window's title and close button still return the owner to Farol.
function isChatGptPage(url: string, homeUrl: string): boolean {
  const host = hostOf(url);
  return (
    host === hostOf(homeUrl) ||
    host === "chatgpt.com" ||
    host.endsWith(".chatgpt.com") ||
    host === "openai.com" ||
    host.endsWith(".openai.com")
  );
}
const SIGN_IN_BANNER_ID = "farol-sign-in-banner";

// Injected on every finish-load of the sign-in surface's main frame only
// (never a popup, and CSP does not apply to code injected this way — it
// runs directly in the page's V8 context via the same channel DevTools
// uses, not as a parsed <script> or inline-style attribute). Idempotent:
// a reload or SPA navigation calls this again and it leaves an existing
// banner alone.
function signInBannerScript(title: string): string {
  const bannerId = JSON.stringify(SIGN_IN_BANNER_ID);
  const titleText = JSON.stringify(title);
  const sentinel = JSON.stringify(SIGN_IN_RETURN_SENTINEL);
  return `(() => {
    if (document.getElementById(${bannerId})) return;
    const bar = document.createElement("div");
    bar.id = ${bannerId};
    bar.setAttribute("role", "banner");
    bar.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:6px 6px 6px 12px;background:#111216;color:#f7f7f8;font:12px -apple-system,BlinkMacSystemFont,sans-serif;border:1px solid #333;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.35);box-sizing:border-box;";
    const label = document.createElement("span");
    label.textContent = ${titleText};
    label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const returnButton = document.createElement("button");
    returnButton.type = "button";
    returnButton.textContent = "Return to Farol";
    returnButton.style.cssText = "flex:none;border:1px solid #4a4a52;border-radius:6px;padding:5px 12px;background:#1d1c21;color:#f7f7f8;font:inherit;cursor:pointer;";
    returnButton.addEventListener("click", () => {
      console.log(${sentinel});
    });
    bar.append(label, returnButton);
    document.documentElement.appendChild(bar);
  })()`;
}

// Idempotent removal, used when the same window transitions out of the
// sign-in surface (e.g. straight into a task) without ever closing.
function signInBannerRemovalScript(): string {
  const bannerId = JSON.stringify(SIGN_IN_BANNER_ID);
  return `(() => {
    const bar = document.getElementById(${bannerId});
    if (bar) bar.remove();
  })()`;
}

// ChatGPT owns its sidebar. Ask its own visible control to collapse once per
// document; never hide provider content or keep toggling after the owner opens it.
export function collapseChatGptSidebarScript(): string {
  return `(() => {
    if (globalThis.__farolDefaultSidebarInitialized) return;
    globalThis.__farolDefaultSidebarInitialized = true;
    const labels = new Set(["Close sidebar", "Collapse sidebar", "Hide sidebar"]);
    const openLabels = new Set(["Open sidebar", "Show sidebar", "Expand sidebar"]);
    const cancelKey = "__farolDefaultSidebarCollapse";
    const previous = globalThis[cancelKey];
    if (typeof previous === "function") previous();
    const deadline = Date.now() + 12000;
    let lastAttempt = 0;
    let stopped = false;
    let timer;
    const ownerInput = (event) => { if (event.isTrusted) stop(); };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const kind of ["pointerdown", "pointerover", "keydown"]) document.removeEventListener(kind, ownerInput, true);
      if (globalThis[cancelKey] === stop) delete globalThis[cancelKey];
    };
    globalThis[cancelKey] = stop;
    for (const kind of ["pointerdown", "pointerover", "keydown"]) document.addEventListener(kind, ownerInput, true);
    timer = setInterval(() => {
      if (stopped) return;
      if (Date.now() > deadline) { stop(); return; }
      const close = [...document.querySelectorAll("button[aria-label]")].find(
        (candidate) => (labels.has(candidate.getAttribute("aria-label")) ||
            (candidate.getAttribute("aria-label") === "Toggle sidebar" &&
              (candidate.getAttribute("aria-expanded") === "true" ||
                candidate.closest?.('aside,nav,[data-testid="sidebar"],#stage-sidebar,#stage-slideover-sidebar')))) &&
          candidate.getAttribute("aria-expanded") !== "false" &&
          candidate.getClientRects().length > 0 &&
          !candidate.disabled
      );
      if (!close) {
        // ChatGPT currently calls this control "Show sidebar" and omits
        // aria-expanded. Stop after the first successful collapse; otherwise
        // a human's next click is immediately undone by this timer.
        const open = [...document.querySelectorAll("button[aria-label]")].some(
          (candidate) => openLabels.has(candidate.getAttribute("aria-label")) &&
            candidate.getClientRects().length > 0
        );
        if (open || lastAttempt > 0) stop();
        return;
      }
      // The first click can happen before ChatGPT hydrates its handler. Only
      // stop once its own controls confirm that the sidebar actually closed.
      if (Date.now() - lastAttempt < 500) return;
      lastAttempt = Date.now();
      close.click();
      // A synchronous provider update ends this timer immediately. Hydration
      // may still need a later tick, but any owner input cancels that retry.
      const collapsed = [...document.querySelectorAll("button[aria-label]")].some(
        (candidate) => openLabels.has(candidate.getAttribute("aria-label")) &&
          candidate.getClientRects().length > 0
      );
      if (collapsed) stop();
    }, 250);
  })()`;
}

export const toggleChatGptSidebarScript = `(() => {
  const cancel = globalThis.__farolDefaultSidebarCollapse;
  if (typeof cancel === "function") cancel();
  const labels = new Set(["Close sidebar", "Collapse sidebar", "Hide sidebar",
    "Open sidebar", "Show sidebar", "Expand sidebar", "Toggle sidebar"]);
  const button = [...document.querySelectorAll("button[aria-label]")].find(
    (candidate) => labels.has(candidate.getAttribute("aria-label")) &&
      candidate.getClientRects().length > 0 && !candidate.disabled);
  if (!button) return false;
  button.click();
  return true;
})()`;

// Connector checks must not inherit the owner's current conversation or model.
// These probes intentionally inspect provider controls instead of trusting a
// URL parameter or a saved ChatGPT preference as proof of the active mode.
// The provider includes its generation in the selected model label. Match
// only the whole Instant label, never a menu option or a Pro/Thinking label.
// The selected control can prefix that label with its "Thinking effort" heading.
export const instantModelLabelPattern =
  /^(?:Thinking\s+effort\s+)?(?:(?:GPT[- ]?)?\d+(?:\.\d+)?\s+)?Instant$/iu;

export const temporaryInstantProfileProbe = `(() => {
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
  const draft = composer instanceof HTMLTextAreaElement
    ? composer.value
    : composer?.textContent || "";
  const controls = [...document.querySelectorAll("button")].filter(visible);
  const temporary = new URL(location.href).searchParams.get("temporary-chat") === "true" &&
    controls.some((button) => button.getAttribute("aria-label") === "Turn off temporary chat");
  const personalized = controls.some((button) => /^Personalized$/u.test((button.textContent || "").trim()));
  const personalizationReady = controls.some((button) =>
    /^(Personalized|Unpersonalized)$/u.test((button.textContent || "").trim()));
  const modelButtons = controls.filter((button) =>
    button.getAttribute("aria-label") === "Select ChatGPT model");
  const modelButton = modelButtons[0];
  const instant = modelButton && new RegExp(${JSON.stringify(instantModelLabelPattern.source)}, "iu").test((modelButton.innerText || "").trim());
  // This is the selected public model control only. Retain a bounded label
  // solely when every token belongs to the known model vocabulary; redact
  // unrecognized text instead of emitting arbitrary provider content.
  const label = (modelButton?.innerText || "").trim();
  const visibleModelLabel = label.length <= 80 &&
    /(?:Instant|Thinking|Pro|Auto)/u.test(label) &&
    /^(?:(?:ChatGPT|GPT|Instant|Thinking|effort|Pro|Auto|Fast)|[0-9.\\s\\p{Cf} -])+$/u.test(label) ? label : null;
  return { composerReady: !!composer, draftPresent: draft.trim().length > 0,
    temporary, personalized, personalizationReady, instant: !!instant, modelReady: !!modelButton, visibleModelLabel,
    modelControlCount: Math.min(modelButtons.length, 100),
    labelHasInstant: /Instant/u.test(label),
    labelHasThinkingEffort: /Thinking\\s*effort/iu.test(label),
    labelHasFormatMarks: /\\p{Cf}/u.test(label) };
})()`;

export const openInstantPowerPickerScript = `(() => {
  const modelButton = [...document.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label") === "Select ChatGPT model" && !button.disabled &&
    button.getClientRects().length > 0);
  if (!modelButton) return false;
  modelButton.click();
  return true;
})()`;

export const openTemporaryPersonalizationScript = `(() => {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    (candidate.textContent || "").trim() === "Unpersonalized" &&
    candidate.getClientRects().length > 0 && !candidate.disabled);
  if (!button) return false;
  button.click();
  return true;
})()`;

export const selectTemporaryPersonalizationScript = `(() => {
  const option = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"],[role="option"]')]
    .find((candidate) => /^Personalized\\b/u.test((candidate.textContent || "").trim()) &&
      candidate.getClientRects().length > 0);
  if (!option) return false;
  option.click();
  return true;
})()`;

export const focusInstantPowerSliderScript = `(() => {
  const slider = [...document.querySelectorAll('[role="slider"],input[type="range"]')]
    .find((element) => element.getClientRects().length > 0);
  if (!(slider instanceof HTMLElement)) return { ready: false };
  const minimum = Number(slider.getAttribute("aria-valuemin") ?? (slider instanceof HTMLInputElement ? slider.min : ""));
  const current = Number(slider.getAttribute("aria-valuenow") ?? (slider instanceof HTMLInputElement ? slider.value : ""));
  if (!Number.isFinite(minimum) || !Number.isFinite(current)) return { ready: false };
  slider.focus();
  return { ready: true, atMinimum: current === minimum };
})()`;

const temporaryInstantProfileSchema = z.object({
  composerReady: z.boolean(),
  draftPresent: z.boolean(),
  temporary: z.boolean(),
  personalized: z.boolean(),
  personalizationReady: z.boolean(),
  instant: z.boolean(),
  modelReady: z.boolean(),
  visibleModelLabel: z.string().max(80).nullable().optional(),
  modelControlCount: z.number().int().min(0).max(100).optional(),
  labelHasInstant: z.boolean().optional(),
  labelHasThinkingEffort: z.boolean().optional(),
  labelHasFormatMarks: z.boolean().optional(),
});
const instantPowerSliderSchema = z.object({
  ready: z.boolean(),
  atMinimum: z.boolean().optional(),
});

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

export const readinessProbe = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const composer = [...document.querySelectorAll(
    '#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][data-virtualkeyboard="true"]'
  )].some(visible);
  const explicitSignIn = [
    document.querySelector('[data-testid="login-button"]'),
    document.querySelector('a[href*="/auth/login"]'),
    document.querySelector('button[name="login"]')
  ].some(visible);
  const labelledSignIn = [...document.querySelectorAll("a,button")]
    .some((element) => visible(element) && /^(log in|sign in|sign up)$/iu.test((element.textContent || "").trim()));
  return { composerVisible: composer, signInVisible: explicitSignIn || labelledSignIn };
})()`;

function appSelectionPrelude(appName: string): string {
  return `
    const requiredAppName = ${JSON.stringify(appName)};
    const appElementVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const findComposer = () => [
      document.querySelector("#prompt-textarea"),
      document.querySelector('[data-testid="prompt-textarea"]'),
      document.querySelector('[contenteditable="true"][data-virtualkeyboard="true"]')
    ].find(appElementVisible);
    const selectedSelector = [
      '[data-testid="composer-app-chip"]',
      '[data-testid*="app-mention"]',
      '[data-testid*="connector-chip"]',
      '[data-prompt-link-href^="app://asdk_app_"]'
    ].join(",");
    const normalizedLabel = (element) => {
      const raw = (
        element.getAttribute("data-app-name") ||
        element.getAttribute("aria-label") ||
        element.textContent ||
        ""
      ).trim();
      return raw
        .replace(/^remove\\s+/iu, "")
        .replace(/^app:\\s*/iu, "")
        .replace(/^@/u, "")
        .replace(/\\s+button$/iu, "")
        .trim();
    };
    const exactPickerOption = (option) => {
      if (!(option instanceof HTMLElement) || !appElementVisible(option)) return false;
      if (normalizedLabel(option) === requiredAppName) return true;
      // ChatGPT's picker puts the app description in the option's text.
      // Require a separately rendered exact title, never a text prefix.
      return [...option.querySelectorAll("[data-app-name],[aria-label],span,div,strong")]
        .some((part) => appElementVisible(part) && normalizedLabel(part) === requiredAppName);
    };
    const appSelectionFor = (input) => {
      if (!(input instanceof HTMLElement)) return { state: "missing" };
      const root = input.closest("form") || input.parentElement || input;
      const pluginIdentity = (element) => {
        const promptLink = element.getAttribute("data-prompt-link-href") || "";
        const promptMatch = /^app:\\/\\/(asdk_app_[A-Za-z0-9]+)$/u.exec(promptLink);
        if (promptMatch) return "plugin_" + promptMatch[1];
        const marked = element.getAttribute("data-plugin-id") ||
          element.getAttribute("data-app-id");
        if (marked && /^plugin_asdk_app_[A-Za-z0-9]+$/u.test(marked)) return marked;
        const href = element.getAttribute("href") || "";
        // ChatGPT can change the chip's origin query after the picker closes.
        // Its exact plugin path inside the composer is the durable identity;
        // the query describes how the details page was opened, not selection.
        const match = /^\\/plugins\\/(plugin_asdk_app_[A-Za-z0-9]+)(?:[?#]|$)/u.exec(href);
        return match?.[1] ?? null;
      };
      const selectedLinks = [...input.querySelectorAll('a[href*="/plugins/plugin_asdk_app_"]')]
        .filter((link) => pluginIdentity(link) !== null && appElementVisible(link));
      const markerCandidates = [...root.querySelectorAll(selectedSelector)]
        .filter((element) => appElementVisible(element) &&
          (element.getAttribute("data-prompt-link-href") === null ||
            pluginIdentity(element) !== null));
      const raw = [...new Set([...markerCandidates, ...selectedLinks])];
      const markers = raw.filter((candidate, index) =>
        !raw.some((other, otherIndex) => {
          if (other === candidate) return false;
          if (other.contains(candidate)) return true;
          const crossRepresentation =
            (markerCandidates.includes(candidate) && selectedLinks.includes(other)) ||
            (selectedLinks.includes(candidate) && markerCandidates.includes(other));
          const identity = pluginIdentity(candidate);
          return otherIndex < index && crossRepresentation && identity !== null &&
            identity === pluginIdentity(other);
        })
      );
      const labels = markers.map(normalizedLabel).filter(Boolean);
      const targetCount = labels.filter((label) => label === requiredAppName).length;
      if (targetCount === 1 && labels.length === 1) return { state: "bound" };
      if (targetCount > 1 || labels.length > 1) return { state: "ambiguous" };
      if (labels.length === 1) return { state: "conflict" };
      return { state: "missing" };
    };
    const appSelection = () => appSelectionFor(findComposer());
    const composerDraftText = (input) => {
      if (!(input instanceof HTMLElement)) return "";
      if (input instanceof HTMLTextAreaElement) return input.value;
      const clone = input.cloneNode(true);
      if (!(clone instanceof HTMLElement)) return "";
      for (const marker of clone.querySelectorAll(selectedSelector)) marker.remove();
      const text = clone.innerText || clone.textContent || "";
      // ChatGPT can render the selected app as a plugin link inside the
      // contenteditable while keeping its selection marker beside it. The
      // link alone is not an owner draft; any additional text still blocks.
      if (text.trim() === requiredAppName && appSelectionFor(input).state === "bound") {
        const exactLinks = [...input.querySelectorAll('a[href*="/plugins/plugin_asdk_app_"]')]
          .filter((link) => appElementVisible(link) && normalizedLabel(link) === requiredAppName);
        if (exactLinks.length === 1) return "";
      }
      return text;
    };
  `;
}

export function bindChatGptAppScript(
  appName: string,
  expectedHref: string,
): string {
  return `(async () => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    if (location.href !== expectedHref) return { state: "navigated" };
    ${appSelectionPrelude(appName)}
    const input = findComposer();
    if (!(input instanceof HTMLElement)) return { state: "blocked", reason: "missing" };
    if (composerDraftText(input).trim().length > 0) {
      return { state: "blocked", reason: "draft_present" };
    }
    const current = appSelectionFor(input);
    if (current.state === "bound") return { state: "bound" };
    if (current.state === "ambiguous" || current.state === "conflict") {
      return { state: "blocked", reason: current.state };
    }
    const setComposerText = (value, inputType) => {
      if (input instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (!setter) return false;
        setter.call(input, value);
      } else {
        input.replaceChildren(document.createTextNode(value));
      }
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType
      }));
      return true;
    };
    input.focus();
    const pickerQuery = "@" + requiredAppName;
    const pickerInputAccepted = input instanceof HTMLTextAreaElement
      ? setComposerText(pickerQuery, "insertText")
      : typeof document.execCommand === "function" &&
        document.execCommand("insertText", false, pickerQuery);
    if (!pickerInputAccepted) {
      return { state: "blocked", reason: "missing" };
    }
    const pickerOptions = () => {
      const pickerRoots = [...document.querySelectorAll([
        '[role="listbox"]',
        '[role="menu"]',
        '[data-radix-menu-content]',
        '[data-testid*="mention"]',
        '[data-testid*="app-picker"]'
      ].join(","))].filter(appElementVisible);
      let optionCandidates = [...new Set(pickerRoots.flatMap((root) =>
        [...root.querySelectorAll('[role="option"],[role="menuitem"],button')]
      ))].filter(exactPickerOption);
      if (optionCandidates.length !== 0) return optionCandidates;
      // ChatGPT also renders the mention picker as plain divs. Only use
      // its visible Plugins section next to this composer; never click an
      // arbitrary matching title elsewhere in the conversation.
      const composerRect = input.getBoundingClientRect();
      const nearComposer = (element) => {
        if (!appElementVisible(element) || input.contains(element)) return false;
        const rect = element.getBoundingClientRect();
        return rect.right > composerRect.left && rect.left < composerRect.right &&
          rect.top > composerRect.top - 400 &&
          rect.bottom < composerRect.bottom + 450;
      };
      // The current ChatGPT picker exposes the app row as a plain button
      // without a menu/listbox root. Match that exact row near the composer;
      // never select a similarly named control inside a conversation.
      const buttonOptions = [...document.querySelectorAll('button,[role="option"],[role="menuitem"]')]
        .filter((element) => element instanceof HTMLElement &&
          nearComposer(element) &&
          !element.closest('[data-message-author-role],article,[role="article"]') &&
          exactPickerOption(element));
      if (buttonOptions.length !== 0) return buttonOptions;
      const labels = [...document.querySelectorAll("span,div,strong")]
        .filter((element) => element instanceof HTMLElement && nearComposer(element));
      const pickerRootFor = (element) => {
        if (element.closest('[data-message-author-role],article,[role="article"]')) {
          return null;
        }
        for (let parent = element.parentElement; parent && parent !== document.body;
          parent = parent.parentElement) {
          if (parent.matches?.('[data-message-author-role],article,[role="article"]')) {
            return null;
          }
          const position = getComputedStyle(parent).position;
          if (position !== "absolute" && position !== "fixed") continue;
          const box = parent.getBoundingClientRect();
          return appElementVisible(parent) && !parent.contains(input) &&
            box.width <= Math.max(720, composerRect.width * 1.25) && box.height <= 600
            ? parent : null;
        }
        return null;
      };
      const unclippedInPicker = (element, pickerRoot) => {
        const title = element.getBoundingClientRect();
        const clips = (overflow) => /^(auto|scroll|hidden|clip)$/u.test(overflow || "");
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const box = parent.getBoundingClientRect();
          if (clips(style.overflowY) &&
            (title.top < box.top || title.bottom > box.bottom)) return false;
          if (clips(style.overflowX) &&
            (title.left < box.left || title.right > box.right)) return false;
          if (parent === pickerRoot) return true;
        }
        return false;
      };
      const headings = labels.filter((element) => normalizedLabel(element) === "Plugins" &&
        pickerRootFor(element) !== null);
      const fileHeadings = labels.filter((element) => normalizedLabel(element) === "Files");
      optionCandidates = labels.filter((element) =>
        normalizedLabel(element) === requiredAppName &&
        ![...element.children].some((child) => normalizedLabel(child) === requiredAppName) &&
        headings.some((heading) => {
          const pickerRoot = pickerRootFor(heading);
          if (pickerRoot === null || pickerRootFor(element) !== pickerRoot ||
            !unclippedInPicker(element, pickerRoot)) return false;
          const header = heading.getBoundingClientRect();
          const title = element.getBoundingClientRect();
          const nextFilesTop = Math.min(...fileHeadings
            .filter((files) => pickerRootFor(files) === pickerRoot)
            .map((files) => files.getBoundingClientRect().top)
            .filter((top) => top > header.bottom), Infinity);
          const popup = pickerRoot.getBoundingClientRect();
          // Inspect the whole bounded Plugins section, including later rows.
          // A first-row cutoff misses both valid apps and duplicate exact names.
          return header.bottom <= title.top + 8 && title.bottom <= nextFilesTop &&
            title.top >= popup.top && title.bottom <= popup.bottom &&
            title.left >= popup.left && title.right <= popup.right &&
            Math.abs(title.left - header.left) <= 180;
        })
      );
      return optionCandidates;
    };
    let optionCandidates = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (location.href !== expectedHref) return { state: "navigated" };
      if (appSelectionFor(input).state === "bound") return { state: "bound" };
      const draft = input instanceof HTMLTextAreaElement
        ? input.value
        : (input.innerText || input.textContent || "");
      if (draft.trim() !== pickerQuery) {
        return { state: "blocked", reason: "draft_present" };
      }
      optionCandidates = pickerOptions();
      if (optionCandidates.length > 0) break;
    }
    if (optionCandidates.length !== 1) {
      const draft = input instanceof HTMLTextAreaElement
        ? input.value
        : (input.innerText || input.textContent || "");
      if (draft.trim() === pickerQuery) setComposerText("", "deleteContentBackward");
      return {
        state: "blocked",
        reason: optionCandidates.length > 1 ? "ambiguous" : "missing"
      };
    }
    optionCandidates[0].click();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (location.href !== expectedHref) return { state: "navigated" };
      const selected = appSelection();
      if (selected.state === "bound") return { state: "bound" };
      if (selected.state === "ambiguous" || selected.state === "conflict") {
        return { state: "blocked", reason: selected.state };
      }
    }
    const textAfterSelection = input instanceof HTMLTextAreaElement
      ? input.value
      : (input.innerText || input.textContent || "");
    if (textAfterSelection.trim() === "@" + requiredAppName) {
      setComposerText("", "deleteContentBackward");
    }
    return { state: "blocked", reason: "selection_not_observed" };
  })()`;
}

export function verifyChatGptAppScript(
  appName: string,
  expectedHref: string,
): string {
  return `(() => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    if (location.href !== expectedHref) return { state: "navigated" };
    ${appSelectionPrelude(appName)}
    const selected = appSelection();
    return selected.state === "bound"
      ? { state: "bound" }
      : { state: "blocked", reason: selected.state };
  })()`;
}

export function installManualAppGateScript(appName: string): string {
  return `(() => {
    ${appSelectionPrelude(appName)}
    const showBlockedNotice = (reason) => {
      const noticeId = "farol-dev-app-submit-blocked";
      let notice = document.getElementById(noticeId);
      if (!(notice instanceof HTMLElement)) {
        notice = document.createElement("div");
        notice.id = noticeId;
        notice.setAttribute("role", "alert");
        notice.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:12px 14px;background:#241b0f;color:#fff4df;border:1px solid #b98230;border-radius:10px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)";
        document.documentElement.appendChild(notice);
      }
      notice.textContent = reason === "ambiguous"
        ? "Message blocked before send. Keep exactly one @" + requiredAppName + " app chip, then try again."
        : reason === "conflict"
          ? "Message blocked before send. Remove the other selected app and select @" + requiredAppName + "."
          : "Message blocked before send. Select exactly one @" + requiredAppName + " app, then try again.";
      setTimeout(() => notice?.remove(), 6000);
    };
    const blockUnlessBound = (event, composer) => {
      const selection = appSelectionFor(composer);
      if (selection.state === "bound") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showBlockedNotice(selection.state);
    };
    const fallbackComposerSelector = [
      "textarea",
      '[contenteditable="true"]',
      '[role="textbox"][aria-multiline="true"]'
    ].join(",");
    const fallbackComposerIn = (root) =>
      [...root.querySelectorAll(fallbackComposerSelector)].find(appElementVisible);
    const submissionComposerIn = (root) => {
      const input = findComposer();
      if (input instanceof HTMLElement && root.contains(input)) return input;
      return fallbackComposerIn(root);
    };
    const allowDirectFormSubmission = (form) => {
      const composer = submissionComposerIn(form);
      if (!(composer instanceof HTMLElement)) return true;
      const selection = appSelectionFor(composer);
      if (selection.state === "bound") return true;
      showBlockedNotice(selection.state);
      return false;
    };
    const originalSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function (...args) {
      if (!allowDirectFormSubmission(this)) return undefined;
      return Reflect.apply(originalSubmit, this, args);
    };
    const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    if (typeof originalRequestSubmit === "function") {
      HTMLFormElement.prototype.requestSubmit = function (...args) {
        if (!allowDirectFormSubmission(this)) return undefined;
        return Reflect.apply(originalRequestSubmit, this, args);
      };
    }
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest("button");
      const form = button?.closest("form");
      const knownSend = target.closest('[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Send"]');
      const knownCancel = target.closest('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"]');
      const formComposer = form instanceof HTMLFormElement
        ? submissionComposerIn(form)
        : null;
      const formButton =
        form instanceof HTMLFormElement &&
        button instanceof HTMLButtonElement &&
        form.contains(button) &&
        formComposer instanceof HTMLElement;
      const pickerChoice = target.closest('[role="option"],[role="menuitem"]');
      const exactRequiredAppChoice =
        pickerChoice instanceof HTMLElement &&
        exactPickerOption(pickerChoice);
      const appChipRepair = target.closest(selectedSelector);
      if (
        knownCancel ||
        exactRequiredAppChoice ||
        (appChipRepair instanceof HTMLElement && !knownSend)
      ) {
        return;
      }
      if (knownSend || formButton) {
        blockUnlessBound(
          event,
          form instanceof HTMLFormElement ? formComposer : findComposer()
        );
      }
    }, true);
    document.addEventListener("submit", (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const composer = submissionComposerIn(form);
      if (composer instanceof HTMLElement) {
        blockUnlessBound(event, composer);
      }
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const input = findComposer();
      const target = event.target instanceof Element
        ? event.target
        : event.target instanceof Node && event.target.parentElement instanceof Element
          ? event.target.parentElement
          : null;
      const form = target?.closest("form");
      const fallbackInput = form instanceof HTMLFormElement
        ? submissionComposerIn(form)
        : target?.closest(fallbackComposerSelector);
      if (event.target instanceof Node) {
        const submissionInput = input && input.contains(event.target)
          ? input
          : fallbackInput instanceof HTMLElement && fallbackInput.contains(event.target)
            ? fallbackInput
            : null;
        if (submissionInput instanceof HTMLElement) {
          blockUnlessBound(event, submissionInput);
        }
      }
    }, true);
    // Deliberately install again after each observed navigation. A marker in
    // the provider page's own global object could be forged before Farol's
    // first injection and turn idempotence into a send bypass. Duplicate
    // capture guards are fail-closed: the first refusal stops later handlers,
    // while a bound submission passes every identical check.
    return true;
  })()`;
}

// Both submission scripts take the page identity the caller validated and
// compare it against the page's own location as their first act: the main
// process cannot check anything between dispatching a script and the script
// running, so the last check before typing or clicking happens in-page.
// Exported for the in-page navigation-guard tests (S35-H2-4), which
// evaluate these exact source strings in `node:vm` against a stub page:
// the guard has to be proven on the bytes that are dispatched, not on a
// paraphrase of them.
export function prepareTaskScript(
  prompt: string,
  expectedHref: string,
  requiredAppName?: string,
): string {
  return `(() => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    if (location.href !== expectedHref) return { navigated: true };
    const prompt = ${JSON.stringify(prompt)};
    ${requiredAppName ? appSelectionPrelude(requiredAppName) : ""}
    ${requiredAppName ? 'if (appSelection().state !== "bound") return { appSelectionLost: true };' : ""}
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
    ${requiredAppName ? "if (composerDraftText(composer).trim().length > 0) return { draftPresent: true };" : ""}
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return { ready: false, baselineAssistantCount, baselineUserCount };
      setter.call(composer, prompt);
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: prompt,
        inputType: "insertText"
      }));
    } else {
      ${
        requiredAppName
          ? `
      // Editing a live ChatGPT composer by appending a DOM node bypasses its
      // editor state and can detach the selected app on the next render.
      const range = document.createRange();
      const selection = document.getSelection();
      if (!selection || typeof document.execCommand !== "function") {
        return { ready: false, baselineAssistantCount, baselineUserCount, baselineMessageIds };
      }
      range.selectNodeContents(composer);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("insertText", false, prompt)) {
        return { ready: false, baselineAssistantCount, baselineUserCount, baselineMessageIds };
      }
      `
          : `
      composer.replaceChildren(document.createTextNode(prompt));
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: prompt,
        inputType: "insertText"
      }));`
      }
    }
    return { ready: true, baselineAssistantCount, baselineUserCount, baselineMessageIds };
  })()`;
}

export function activateTaskScript(
  expectedHref: string,
  requiredAppName?: string,
  requireTemporaryInstant = false,
  requireOrdinaryInstant = false,
): string {
  return `(() => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    if (location.href !== expectedHref) return { navigated: true };
    ${
      requireTemporaryInstant
        ? `if (new URL(location.href).searchParams.get("temporary-chat") !== "true" ||
      ![...document.querySelectorAll("button")].some((button) =>
        button.getAttribute("aria-label") === "Turn off temporary chat" && button.getClientRects().length > 0) ||
      ![...document.querySelectorAll("button")].some((button) =>
        (button.textContent || "").trim() === "Personalized" && button.getClientRects().length > 0) ||
      ![...document.querySelectorAll("button")].some((button) =>
        button.getAttribute("aria-label") === "Select ChatGPT model" &&
        new RegExp(${JSON.stringify(instantModelLabelPattern.source)}, "iu").test((button.innerText || "").trim()) && button.getClientRects().length > 0))
      return { profileLost: true };`
        : ""
    }
    ${
      requireOrdinaryInstant
        ? `if (new URL(location.href).searchParams.has("temporary-chat") ||
      [...document.querySelectorAll("button")].some((button) =>
        button.getAttribute("aria-label") === "Turn off temporary chat" && button.getClientRects().length > 0) ||
      ![...document.querySelectorAll("button")].some((button) =>
        button.getAttribute("aria-label") === "Select ChatGPT model" &&
        new RegExp(${JSON.stringify(instantModelLabelPattern.source)}, "iu").test((button.innerText || "").trim()) && button.getClientRects().length > 0))
      return { profileLost: true };`
        : ""
    }
    ${requiredAppName ? appSelectionPrelude(requiredAppName) : ""}
    ${requiredAppName ? 'if (appSelection().state !== "bound") return { appSelectionLost: true };' : ""}
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const send = [
      document.querySelector('[data-testid="send-button"]'),
      document.querySelector('button[aria-label="Send prompt"]'),
      document.querySelector('button[aria-label="Send message"]'),
      document.querySelector('button[aria-label="Send"]')
    ].find((element) => visible(element) && element instanceof HTMLButtonElement && !element.disabled);
    if (!(send instanceof HTMLButtonElement)) return { activated: false };
    send.click();
    return { activated: true };
  })()`;
}

export function taskProbeScript(
  prompt: string,
  baselineMessageIds: readonly string[],
  output: Readonly<{
    semantic: boolean;
    userId: string | null;
    assistantId: string | null;
  }> = { semantic: false, userId: null, assistantId: null },
  requiredAppName?: string,
): string {
  return `(() => {
    const prompt = ${JSON.stringify(prompt)};
    const output = ${JSON.stringify(output)};
    const markdown = ${publicMarkdownBlock.toString()};
    const readMessages = ${readPublicAssistantMessages.toString()};
    const contentVisible = ${publicContentVisible.toString()};
    const baselineMessageIds = new Set(${JSON.stringify(baselineMessageIds)});
    const requiredAppName = ${JSON.stringify(requiredAppName ?? null)};
    const usageLimitPattern = new RegExp(${JSON.stringify(chatGptUsageLimitPattern.source)}, ${JSON.stringify(chatGptUsageLimitPattern.flags)});
    const visible = (element) => {
      if (!contentVisible(element)) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const messages = [...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')];
    const assistants = messages.filter((element) => element.getAttribute('data-message-author-role') === 'assistant');
    const messageId = (element) => element?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null;
    const users = messages.filter((element) => element.getAttribute('data-message-author-role') === 'user');
    const candidates = users.filter((element) => {
      const id = messageId(element);
      if (!(output.semantic ? contentVisible(element) : visible(element)) || id === null) return false;
      // A retained identity wins over repeated text during resumed observation.
      // Before correlation, preserve onboarding's exact app-prefixed prompt form.
      if (output.userId !== null) return id === output.userId;
      if (baselineMessageIds.has(id)) return false;
      const rendered = (element.innerText || '').trim();
      if (rendered === prompt.trim()) return true;
      // App chips may be represented differently in textContent and innerText.
      // This extra form is scoped to the exact app required by this route.
      const appRendered = (element.textContent || rendered).trim();
      return requiredAppName !== null && appRendered.startsWith(requiredAppName) &&
        appRendered.slice(requiredAppName.length).trim() === prompt.trim();
    });
    if (candidates.length > 1) throw new Error("CHATGPT_PUBLIC_USER_AMBIGUOUS");
    const currentUser = candidates[0] ?? null;
    const turnUserId = messageId(currentUser);
    let currentAssistant = null;
    const turnAssistants = [];
    if (currentUser && turnUserId !== null) {
      const userIndex = messages.indexOf(currentUser);
      for (const element of messages.slice(userIndex + 1)) {
        const role = element.getAttribute('data-message-author-role');
        if (role === 'user') break;
        if (role !== 'assistant' || !(output.semantic ? contentVisible(element) : visible(element))) continue;
        const id = messageId(element);
        if (id === null) {
          if (output.semantic) throw new Error("CHATGPT_PUBLIC_SOURCE_UNANCHORED");
          continue;
        }
        const parentId = element.closest('[data-parent-message-id]')?.getAttribute('data-parent-message-id') ?? null;
        if (!output.semantic && parentId !== null && parentId !== turnUserId) continue;
        turnAssistants.push(element);
        currentAssistant ??= element;
      }
    }
    const turnAssistantId = turnUserId === null ? null : (output.semantic ? output.assistantId ?? messageId(currentAssistant) : messageId(currentAssistant));
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
      document.querySelector('button[aria-label="Send message"]'),
      document.querySelector('button[aria-label="Send"]')
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
    const publicMessages = output.semantic && currentUser ? readMessages(turnAssistants, contentVisible, markdown, visible) : null;
    const assistantText = !output.semantic && currentAssistant instanceof HTMLElement ? currentAssistant.innerText : "";
    return {
      ...(publicMessages ? {publicFrame: {
        userId: turnUserId,
        messages: publicMessages,
        terminal: publicMessages.length > 0 && publicMessages.every((message) => message.complete) &&
          publicMessages.at(-1).channel === "answer" && !busy && sendVisible
      }} : {}),
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

/** Fixed classifications only: never attach URLs, DOM, probe replies or errors. */
export type ChatGptUpdateAdmissionDiagnostic =
  | Readonly<{
      stage: "admission";
      reason:
        "busy" | "reservation_lost" | "guard_invalid" | "deadline_expired";
    }>
  | Readonly<{
      stage: "surface";
      reason: "unavailable" | "not_embedded" | "destroyed" | "changed";
    }>
  | Readonly<{
      stage: "document";
      reason: "not_loaded" | "changed" | "url_changed" | "url_unrecognized";
    }>
  | Readonly<{
      stage: "probe" | "paused_probe";
      reason:
        "parse_failed" | "unknown" | "failed" | "timeout" | "running" | "draft";
    }>
  | Readonly<{
      stage: "debugger";
      reason:
        | "already_attached"
        | "devtools_open"
        | "attach_failed"
        | "enable_failed"
        | "timeout";
    }>
  | Readonly<{ stage: "pause"; reason: "failed" | "timeout" | "unconfirmed" }>
  | Readonly<{ stage: "resume"; reason: "failed" | "timeout" }>
  | Readonly<{ stage: "release"; reason: "detach_failed" }>;

type DiagnosticBrowserUpdateCheck =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code: Extract<BrowserUpdateCheck, { ok: false }>["code"];
      diagnostic: ChatGptUpdateAdmissionDiagnostic;
    }>;

/** Host-only original Quit budget; never passed to a page or inspector. */
export type ChatGptUpdateIdleEffectGuard = Readonly<{
  deadlineAt: number;
  canStartEffect(): boolean;
}>;

/** Pre-submission evidence; only the allowlisted public model label is text. */
export type ChatGptProfilePreparationDiagnostic = Readonly<{
  stage: "hydrate" | "picker" | "slider" | "selected-model";
  expectedTemporary: boolean;
  logicalDocumentChanged: boolean;
  physicalDocumentChanged: boolean;
  urlChanged: boolean;
  operationChanged: boolean;
  surfaceChanged: boolean;
  probe: Readonly<{
    composerReady: boolean;
    draftPresent: boolean;
    temporary: boolean;
    modelReady: boolean;
    instant: boolean;
    visibleModelLabel: string | null;
    modelControlCount: number;
    labelHasInstant: boolean;
    labelHasThinkingEffort: boolean;
    labelHasFormatMarks: boolean;
  }> | null;
  sliderReady: boolean;
  sliderAtMinimum: boolean;
}>;

export type ChatGptRouteOptions = Readonly<{
  homeUrl: string;
  initialUrl: string;
  e2eOrigin: string | null;
  parent: () => BrowserWindow | null;
  partition?:
    | "persist:farol-app-chatgpt"
    | "persist:farol-dev-chatgpt"
    | "persist:farol-owner-preview-chatgpt";
  requiredAppName?: string;
  // Ordinary manual ChatGPT messages remain under the owner's control.
  // Automated app-bound tasks still check requiredAppName before submission.
  requireAppForManualMessages?: boolean;
  collapseSidebarByDefault?: boolean;
  windowPresentation?: ChatGptWindowPresentation;
  surfaceFactory?: ChatGptRouteSurfaceFactory;
  title?: string;
  onClosed?: (conversationUrl: string | null, taskRunning: boolean) => void;
  onConversationChanged?: (conversationUrl: string | null) => void;
  onTaskActivityChanged?: (
    state: "idle" | "running" | "outcome_unknown",
  ) => void;
  onLoadStateChanged?: (state: "loading" | "loaded" | "failed") => void;
  onDisposed?: () => void;
  // One best-effort notification per refused acquisition/recheck or failed release.
  // Cleanup failures supersede an earlier probe refusal; repeated release shares
  // its original promise and does not notify again. Successful operations are quiet.
  onUpdateAdmissionDiagnostic?: (
    diagnostic: ChatGptUpdateAdmissionDiagnostic,
  ) => void;
  onProfilePreparationDiagnostic?: (
    diagnostic: ChatGptProfilePreparationDiagnostic,
  ) => void;
  // Candidate source profile. Production composition must opt in only after
  // native DOM qualification; callbacks alone never enable unproved selectors.
  publicOutputProfile?: "message-anchors-v1";
  // Independent session snapshot profile; it never grants Go account authority.
  accountObservationProfile?: "provider-session-v1";
  // Synthetic settled units require a separately selected loopback fixture.
  physicalContentProfile?: PhysicalPageContentProfile;
  taskTimeoutMs?: number;
  taskPollMs?: number;
  // Reported exactly once per `openForSignIn` call, when its window closes
  // (native close, the in-page "Return to Farol" control, or programmatic
  // shutdown) — never while it stays open, so a caller cannot race the
  // owner's own manual "Check connection".
  onSignInOutcome?: (
    status: ChatGptSignInStatus,
    diagnostic: ChatGptSignInOutcomeDiagnostic,
  ) => void;
  // Content-free diagnostics for the sign-in surface only (see
  // `ChatGptSignInBlockedDiagnostic`): never a body, a query string, or a
  // full URL.
  onSignInBlocked?: (diagnostic: ChatGptSignInBlockedDiagnostic) => void;
  // Dev-only, content-free page-read diagnostics; never sign-in evidence.
  onSignInStatusDiagnostic?: (
    value: Readonly<{
      reason:
        "admission" | "document-not-current" | "unconfirmed" | "exception";
      opening: boolean;
      taskInFlight: boolean;
      loading: boolean;
      pageState: ChatGptPageObservation["state"] | null;
    }>,
  ) => void;
}>;

export type ChatGptWindowPresentation =
  | Readonly<{ mode: "hidden" }>
  | Readonly<{
      mode: "secondary-visible";
      size?: "exact" | "fit";
      place(
        requested: Readonly<{ width: number; height: number }>,
      ): Readonly<{ x: number; y: number; width: number; height: number }>;
    }>;

type ChatGptWindowBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type ResolvedChatGptWindowPresentation =
  | Readonly<{ bounds: null; reveal: "show"; focus: true }>
  | Readonly<{ bounds: null; reveal: "remain-hidden"; focus: false }>
  | Readonly<{
      bounds: ChatGptWindowBounds;
      reveal: "show-inactive";
      focus: false;
    }>;

export function resolveChatGptWindowPresentation(
  presentation: ChatGptWindowPresentation | undefined,
  requested: Readonly<{ width: number; height: number }>,
): ResolvedChatGptWindowPresentation {
  if (presentation === undefined) {
    return { bounds: null, reveal: "show", focus: true };
  }
  if (presentation.mode === "hidden") {
    return { bounds: null, reveal: "remain-hidden", focus: false };
  }
  const bounds = presentation.place(requested);
  if (
    !Number.isSafeInteger(bounds.x) ||
    !Number.isSafeInteger(bounds.y) ||
    !Number.isSafeInteger(bounds.width) ||
    !Number.isSafeInteger(bounds.height) ||
    (presentation.size === "fit"
      ? bounds.width < 720 ||
        bounds.height < 560 ||
        bounds.width > requested.width ||
        bounds.height > requested.height
      : bounds.width !== requested.width || bounds.height !== requested.height)
  ) {
    throw new Error("CHATGPT_WINDOW_PLACEMENT_INVALID");
  }
  return { bounds, reveal: "show-inactive", focus: false };
}

export type ChatGptOpenResult = Readonly<{
  status: "opened" | "unreachable";
}>;

export type ChatGptRouteSurface = Readonly<{
  kind: "window" | "embedded";
  webContents: WebContents;
  isDestroyed: () => boolean;
  loadURL: (url: string) => Promise<void>;
  hide: () => void;
  reveal: () => void;
  focus: () => void;
  setTitle: (title: string) => void;
  destroy: () => void;
  onPageTitleUpdated: (
    listener: (event: { preventDefault: () => void }) => void,
  ) => void;
  onClosing: (listener: () => void) => void;
  onClosed: (listener: () => void) => void;
  // A real close (fires "close" then "closed", so a caller gets one last
  // chance to read page state before the surface is gone), as opposed to
  // `destroy`'s immediate teardown. Optional: only a real window (not an
  // embedded task view) can offer it, and only the sign-in flow needs it.
  close?: () => void;
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
    | "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT"
    | "CHATGPT_APP_TARGET_INVALID"
    | "CHATGPT_APP_SELECTION_MISSING"
    | "CHATGPT_APP_SELECTION_AMBIGUOUS"
    | "CHATGPT_APP_SELECTION_CONFLICT"
    | "CHATGPT_APP_SELECTION_LOST"
    | "CHATGPT_COMPOSER_DRAFT_PRESENT"
    | "CHATGPT_TEMPORARY_CHAT_REQUIRED"
    | "CHATGPT_INSTANT_MODEL_REQUIRED"
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

export type ChatGptConnectorCheckResult =
  | ChatGptReadonlyTaskResult
  | Readonly<
      Omit<ChatGptReadonlyTaskResult, "state"> & { state: "receipt_confirmed" }
    >;

export type ChatGptTaskTextDelta = Readonly<{
  sequence: number;
  delta: string;
  text: string;
  observedCharacters: number;
}>;

export type ChatGptTaskObserver = Readonly<{
  onTextDelta?: (delta: ChatGptTaskTextDelta) => void | Promise<void>;
  // A source adapter chooses either legacy text deltas or semantic items for
  // one turn, never both. Items describe visible output, not tool execution.
  onVisibleItem?: (item: VisibleOutputItem) => void | Promise<void>;
  onDispatchIntent?: () => void | Promise<void>;
  // Only an app-bound connector check may finish from its exact
  // local receipt. This proves the connector effect, never a model answer.
  readConnectorReceipt?: () => Promise<boolean>;
  onCorrelation?: (
    correlation: Readonly<{
      turnUserId: string;
      turnAssistantId: string | null;
    }>,
  ) => void | Promise<void>;
}>;

// All ChatGPT routes share one Electron session (CHATGPT_PARTITION), so its
// permission handler is hardened once, by whichever route opens first (see
// `hardenSession`'s WeakSet guard) — `this` inside that handler would stay
// bound to that first route forever. This ambient pointer is read at
// request time instead, so a permission denial is always attributed to
// whichever route is currently acting as the sign-in surface, if any.
let activeSignInRoute: ChatGptRoute | null = null;

export class ChatGptRoute {
  private routeWindow: ChatGptRouteSurface | null = null;
  private readonly popupWindows = new Set<BrowserWindow>();
  private readonly readyPopupWindows = new Set<BrowserWindow>();
  private readonly submissionGatedPopupWindows = new Set<BrowserWindow>();
  private readonly popupDocumentGenerations = new WeakMap<
    BrowserWindow,
    number
  >();
  private routeSession: Session | null = null;
  private load: "failed" | "loaded" = "failed";
  private routeDocumentLoadFailed = false;
  private routeDocumentGeneration = 0;
  private disposing = false;
  private taskInFlight = false;
  private taskObservationGeneration = 0;
  private opening: Promise<ChatGptOpenResult> | null = null;
  private entryUrl: string;
  private displayTitle: string;
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  private activityPollInFlight = false;
  private activityProbeStale = false;
  private activityGeneration = 0;
  private observedTaskRunning: boolean | null = null;
  private updateAdmission = false;
  private signInMode = false;
  private signInAttempt = 0;
  private signInReported = false;
  private pendingSignInObservation: Promise<SignInObservation> | null = null;
  private readinessReadSequence = 0;
  private currentReadinessObservation: Readonly<{
    result: ChatGptSignInStatusObservation;
    read: ReadinessRead;
    startedAt: number;
    deadlineAt: number;
  }> | null = null;
  private latestReadiness: Readonly<{
    surface: ChatGptRouteSurface;
    documentGeneration: number;
    url: string;
    sequence: number;
    observation: ChatGptPageObservation;
  }> | null = null;

  constructor(private readonly options: ChatGptRouteOptions) {
    this.entryUrl = options.initialUrl;
    this.displayTitle = options.title ?? "ChatGPT · Farol";
    if (
      !allowedChatGptPageUrl(options.homeUrl, options.e2eOrigin) ||
      !allowedChatGptPageUrl(options.initialUrl, options.e2eOrigin) ||
      (options.e2eOrigin !== null &&
        (new URL(options.initialUrl).origin !== options.e2eOrigin ||
          new URL(options.homeUrl).origin !== options.e2eOrigin))
    ) {
      throw new Error("CHATGPT_INITIAL_URL_INVALID");
    }
    if (
      options.requiredAppName !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u.test(options.requiredAppName)
    ) {
      throw new Error("CHATGPT_REQUIRED_APP_NAME_INVALID");
    }
  }

  /** Current presentation state, also available if a renderer missed the load event. */
  loadState(): "loading" | "loaded" | "failed" {
    return this.opening !== null && this.load !== "loaded"
      ? "loading"
      : this.load;
  }

  /** Open browser documents may contain work outside Farol's task journal. */
  hasOpenUpdateSurface(): boolean {
    return (
      this.opening !== null ||
      this.taskInFlight ||
      (this.routeWindow !== null && !this.routeWindow.isDestroyed()) ||
      [...this.popupWindows].some((popup) => !popup.isDestroyed())
    );
  }

  /** Explicit update consent closes browser work instead of inferring DOM idle. */
  async acquireUpdateClose(): Promise<BrowserUpdateAdmission> {
    // Programmatic tasks retain their own cancellation/journal owner. Browser
    // interruption consent does not invent a terminal result for those tasks.
    if (this.updateAdmission || this.opening || this.taskInFlight)
      return { ok: false, code: "UPDATE_BROWSER_BUSY" };
    this.updateAdmission = true;
    const surface = this.routeWindow;
    const popups = [...this.popupWindows];
    try {
      this.stopTaskActivityWatch();
      if (surface && !surface.isDestroyed()) {
        this.entryUrl =
          this.captureConversationUrl(surface.webContents) ?? this.entryUrl;
      }
      const contents = [
        ...(surface ? [surface.webContents] : []),
        ...popups.map((popup) => popup.webContents),
      ];
      // Suppress ordinary window-close navigation while the update owns input.
      this.disposing = true;
      for (const popup of popups) if (!popup.isDestroyed()) popup.destroy();
      if (surface && !surface.isDestroyed()) surface.destroy();
      // WebContents.close may complete on a later native event-loop turn.
      // Observe the same close; never send it again after a lost result.
      await Promise.all(
        contents.map(async (contents) => {
          if (contents.isDestroyed()) return;
          await new Promise<void>((resolve, reject) => {
            const closed = () => {
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              contents.removeListener("destroyed", closed);
              reject(new Error("UPDATE_BROWSER_CLOSE_UNCONFIRMED"));
            }, 2000);
            contents.once("destroyed", closed);
          });
        }),
      );
      if (
        (surface && !surface.isDestroyed()) ||
        popups.some((popup) => !popup.isDestroyed())
      )
        throw new Error("UPDATE_BROWSER_CLOSE_UNCONFIRMED");
      this.routeWindow = null;
      this.popupWindows.clear();
      this.readyPopupWindows.clear();
      this.submissionGatedPopupWindows.clear();
    } catch {
      // An uncertain native close holds the reservation, never retries destroy.
      return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
    } finally {
      this.disposing = false;
    }
    let released = false;
    return {
      ok: true,
      recheck: async () =>
        released || !this.updateAdmission || this.hasOpenUpdateSurface()
          ? { ok: false, code: "UPDATE_BROWSER_STATE_UNKNOWN" }
          : { ok: true },
      release: async () => {
        if (released) return;
        released = true;
        this.updateAdmission = false;
      },
    };
  }

  async acquireUpdateIdle(
    guard?: ChatGptUpdateIdleEffectGuard,
  ): Promise<BrowserUpdateAdmission> {
    const refuse = (
      code: Extract<BrowserUpdateCheck, { ok: false }>["code"],
      diagnostic: ChatGptUpdateAdmissionDiagnostic,
    ): Extract<DiagnosticBrowserUpdateCheck, { ok: false }> => ({
      ok: false,
      code,
      diagnostic,
    });
    const report = (
      check: Extract<DiagnosticBrowserUpdateCheck, { ok: false }>,
    ): Extract<BrowserUpdateCheck, { ok: false }> => {
      this.reportUpdateAdmissionDiagnostic(check.diagnostic);
      return { ok: false, code: check.code };
    };
    const unknown = (
      diagnostic: ChatGptUpdateAdmissionDiagnostic,
    ): Extract<DiagnosticBrowserUpdateCheck, { ok: false }> =>
      refuse("UPDATE_BROWSER_STATE_UNKNOWN", diagnostic);
    // Capture the original budget once. Mutable caller state cannot extend it.
    let deadlineAt: number | undefined;
    let canStartEffect: (() => boolean) | undefined;
    if (guard !== undefined) {
      try {
        if (guard === null || typeof guard !== "object")
          return report(
            unknown({ stage: "admission", reason: "guard_invalid" }),
          );
        const originalDeadline = guard.deadlineAt;
        const originalAdmission = guard.canStartEffect;
        if (
          typeof originalDeadline !== "number" ||
          !Number.isFinite(originalDeadline) ||
          typeof originalAdmission !== "function"
        )
          return report(
            unknown({ stage: "admission", reason: "guard_invalid" }),
          );
        deadlineAt = originalDeadline;
        canStartEffect = originalAdmission.bind(guard);
      } catch {
        return report(unknown({ stage: "admission", reason: "guard_invalid" }));
      }
    }
    const effectGuard = (): ChatGptUpdateAdmissionDiagnostic | null => {
      if (deadlineAt === undefined) return null;
      if (Date.now() >= deadlineAt)
        return { stage: "admission", reason: "deadline_expired" };
      try {
        if (canStartEffect?.() !== true)
          return { stage: "admission", reason: "reservation_lost" };
      } catch {
        return { stage: "admission", reason: "guard_invalid" };
      }
      // The host callback itself may consume the remaining budget.
      return Date.now() < deadlineAt
        ? null
        : { stage: "admission", reason: "deadline_expired" };
    };
    const initialGuard = effectGuard();
    if (initialGuard) return report(unknown(initialGuard));
    if (
      this.updateAdmission ||
      this.opening ||
      this.taskInFlight ||
      this.signInMode ||
      [...this.popupWindows].some((popup) => !popup.isDestroyed())
    )
      return report(
        refuse("UPDATE_BROWSER_BUSY", { stage: "admission", reason: "busy" }),
      );
    if (!this.hasOpenUpdateSurface()) {
      const invalid = effectGuard();
      if (invalid) return report(unknown(invalid));
      this.updateAdmission = true;
      let released = false;
      return {
        ok: true,
        recheck: async () => {
          const invalid = effectGuard();
          if (invalid) return report(unknown(invalid));
          if (released || !this.updateAdmission || this.hasOpenUpdateSurface())
            return report(
              unknown({ stage: "admission", reason: "reservation_lost" }),
            );
          const changed = effectGuard();
          return changed ? report(unknown(changed)) : { ok: true };
        },
        release: async () => {
          if (released) return;
          released = true;
          this.updateAdmission = false;
        },
      };
    }
    const surface = this.routeWindow;
    if (!surface)
      return report(unknown({ stage: "surface", reason: "unavailable" }));
    if (surface.kind !== "embedded")
      return report(unknown({ stage: "surface", reason: "not_embedded" }));
    if (surface.isDestroyed())
      return report(unknown({ stage: "surface", reason: "destroyed" }));
    if (this.load !== "loaded")
      return report(unknown({ stage: "document", reason: "not_loaded" }));
    const contents = surface.webContents;
    const generation = this.routeDocumentGeneration;
    const url = contents.getURL();
    if (!isChatGptPage(url, this.options.homeUrl))
      return report(unknown({ stage: "document", reason: "url_unrecognized" }));
    this.updateAdmission = true;
    const blockInput = (event: { preventDefault(): void }): void =>
      event.preventDefault();
    contents.on("before-input-event", blockInput);
    contents.on("before-mouse-event", blockInput);
    const debuggerClient = contents.debugger;
    let attached = false;
    let paused = false;
    let pauseRequired = false;
    let confirmPause: (() => void) | undefined;
    let confirmResume: (() => void) | undefined;
    const message = (_event: unknown, method: string): void => {
      if (method === "Debugger.paused") {
        paused = true;
        confirmPause?.();
      } else if (method === "Debugger.resumed") {
        paused = false;
        confirmResume?.();
      }
    };
    const detached = (): void => {
      attached = false;
      paused = false;
    };
    let released = false;
    let effectsStopped = false;
    const effectError = new Error("UPDATE_BROWSER_STATE_UNKNOWN");
    let effectDiagnostic: ChatGptUpdateAdmissionDiagnostic | null = null;
    const assertEffectCurrent = (): void => {
      const invalid = current();
      if (invalid) {
        effectsStopped = true;
        effectDiagnostic = invalid;
        throw effectError;
      }
    };
    // Thunks fence actual invocation, including continuations after a lost reply.
    // Cleanup keeps its own existing timeout, independent of the Quit budget.
    const deadlineError = new Error("UPDATE_BROWSER_STATE_UNKNOWN");
    const bounded = async <T>(
      operation: () => Promise<T>,
      cleanup = false,
    ): Promise<T> => {
      if (!cleanup) assertEffectCurrent();
      const remaining =
        cleanup || deadlineAt === undefined
          ? ACTIVITY_PROBE_DEADLINE_MS
          : Math.min(ACTIVITY_PROBE_DEADLINE_MS, deadlineAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (!cleanup) effectsStopped = true;
            reject(deadlineError);
          }, remaining);
        });
        if (!cleanup) assertEffectCurrent();
        const result = await Promise.race([operation(), timeout]);
        if (!cleanup) assertEffectCurrent();
        return result;
      } catch (error) {
        if (!cleanup) effectsStopped = true;
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    let releasePromise: Promise<void> | null = null;
    const release = (): Promise<void> => {
      if (releasePromise) return releasePromise;
      released = true;
      releasePromise = (async () => {
        // A failed/unconfirmed resume retains admission. Never repeat that
        // native command or expose the page as usable on uncertain state.
        if (!contents.isDestroyed() && attached) {
          if (paused) {
            const resumed = new Promise<void>((resolve) => {
              confirmResume = resolve;
            });
            try {
              await bounded(
                () =>
                  Promise.all([
                    debuggerClient.sendCommand("Debugger.resume"),
                    resumed,
                  ]),
                true,
              );
            } catch (error) {
              this.reportUpdateAdmissionDiagnostic({
                stage: "resume",
                reason: error === deadlineError ? "timeout" : "failed",
              });
              throw new Error("UPDATE_BROWSER_RELEASE_UNCONFIRMED");
            }
          }
          if (attached) {
            try {
              debuggerClient.detach();
            } catch {
              this.reportUpdateAdmissionDiagnostic({
                stage: "release",
                reason: "detach_failed",
              });
              throw new Error("UPDATE_BROWSER_RELEASE_UNCONFIRMED");
            }
            attached = false;
            paused = false;
          }
        }
        debuggerClient.removeListener("message", message);
        debuggerClient.removeListener("detach", detached);
        contents.removeListener("before-input-event", blockInput);
        contents.removeListener("before-mouse-event", blockInput);
        this.updateAdmission = false;
      })();
      return releasePromise;
    };
    const current = (): ChatGptUpdateAdmissionDiagnostic | null => {
      if (effectsStopped)
        return { stage: "admission", reason: "reservation_lost" };
      const invalidGuard = effectGuard();
      if (invalidGuard) return invalidGuard;
      if (released || !this.updateAdmission)
        return { stage: "admission", reason: "reservation_lost" };
      if (this.routeWindow !== surface)
        return { stage: "surface", reason: "changed" };
      if (surface.isDestroyed() || contents.isDestroyed())
        return { stage: "surface", reason: "destroyed" };
      if (this.load !== "loaded")
        return { stage: "document", reason: "not_loaded" };
      if (this.routeDocumentGeneration !== generation)
        return { stage: "document", reason: "changed" };
      if (contents.getURL() !== url)
        return { stage: "document", reason: "url_changed" };
      if (this.taskInFlight || this.opening || this.signInMode)
        return { stage: "admission", reason: "busy" };
      if (pauseRequired && !(attached && paused && debuggerClient.isAttached()))
        return { stage: "pause", reason: "unconfirmed" };
      if ([...this.popupWindows].some((popup) => !popup.isDestroyed()))
        return { stage: "admission", reason: "busy" };
      return deadlineAt !== undefined && Date.now() >= deadlineAt
        ? { stage: "admission", reason: "deadline_expired" }
        : null;
    };
    const recheck = async (): Promise<DiagnosticBrowserUpdateCheck> => {
      const invalid = current();
      if (invalid) return unknown(invalid);
      const stage = pauseRequired ? "paused_probe" : "probe";
      try {
        let raw: unknown;
        if (pauseRequired) {
          // Inspector evaluation remains available while ordinary page scripts
          // are paused. Only this content-free DOM classification is evaluated.
          const reply: unknown = await bounded(() =>
            debuggerClient.sendCommand("Runtime.evaluate", {
              expression: chatGptUpdateIdleProbe,
              returnByValue: true,
            }),
          );
          const evaluated = z
            .object({
              result: z.object({
                type: z.literal("object"),
                value: ChatGptUpdateIdleSchema,
              }),
              exceptionDetails: z.never().optional(),
            })
            .safeParse(reply);
          if (!evaluated.success)
            return unknown({ stage, reason: "parse_failed" });
          raw = evaluated.data.result.value;
        } else {
          raw = await bounded(() =>
            contents.executeJavaScript(chatGptUpdateIdleProbe, true),
          );
        }
        const parsed = ChatGptUpdateIdleSchema.safeParse(raw);
        const changed = current();
        if (changed) return unknown(changed);
        if (!parsed.success) return unknown({ stage, reason: "parse_failed" });
        if (parsed.data.state === "unknown")
          return unknown({ stage, reason: "unknown" });
        if (parsed.data.state === "running")
          return refuse("UPDATE_BROWSER_BUSY", { stage, reason: "running" });
        if (parsed.data.state === "draft")
          return refuse("UPDATE_BROWSER_DRAFT", { stage, reason: "draft" });
        return { ok: true };
      } catch (error) {
        if (error === effectError && effectDiagnostic)
          return unknown(effectDiagnostic);
        return unknown({
          stage,
          reason: error === deadlineError ? "timeout" : "failed",
        });
      }
    };
    const result = await recheck();
    if (!result.ok) {
      await release();
      return report(result);
    }
    let pauseDiagnostic: ChatGptUpdateAdmissionDiagnostic = {
      stage: "debugger",
      reason: "attach_failed",
    };
    try {
      // Input fences do not stop a page timer from invoking its own handlers.
      // Pause only after initial idle proof, then inspect again under the held
      // pause. Never take over an existing debugger or use a lifecycle fallback.
      const alreadyAttached = debuggerClient.isAttached();
      if (alreadyAttached || contents.isDevToolsOpened()) {
        await release();
        return report(
          unknown({
            stage: "debugger",
            reason: alreadyAttached ? "already_attached" : "devtools_open",
          }),
        );
      }
      debuggerClient.on("message", message);
      debuggerClient.on("detach", detached);
      assertEffectCurrent();
      debuggerClient.attach("1.3");
      attached = true;
      pauseDiagnostic = { stage: "debugger", reason: "enable_failed" };
      await bounded(() => debuggerClient.sendCommand("Debugger.enable"));
      assertEffectCurrent();
      pauseDiagnostic = { stage: "pause", reason: "failed" };
      const stopped = new Promise<void>((resolve) => {
        confirmPause = resolve;
      });
      await bounded(async () => {
        assertEffectCurrent();
        await debuggerClient.sendCommand("Debugger.pause");
        assertEffectCurrent();
        if (!paused) {
          // A quiet hidden document has no next statement to acknowledge pause.
          // This no-op supplies one without touching DOM, credentials or tasks.
          // Its reply may wait for resume; only the actual paused event admits.
          assertEffectCurrent();
          void debuggerClient
            .sendCommand("Runtime.evaluate", {
              expression: "void 0",
              returnByValue: true,
            })
            .catch(() => undefined);
        }
        await stopped;
        assertEffectCurrent();
      });
      pauseRequired = true;
    } catch (error) {
      // Close late continuations before cleanup, including failed detach.
      effectsStopped = true;
      if (error === effectError && effectDiagnostic)
        pauseDiagnostic = effectDiagnostic;
      if (error === deadlineError)
        pauseDiagnostic = {
          stage: pauseDiagnostic.stage === "pause" ? "pause" : "debugger",
          reason: "timeout",
        };
      // Detach only this owned session when pause acquisition was unconfirmed.
      // Closing the inspector session also cancels its pending pause request.
      if (attached) {
        try {
          debuggerClient.detach();
        } catch {
          this.reportUpdateAdmissionDiagnostic({
            stage: "release",
            reason: "detach_failed",
          });
          return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
        }
        // Native detach success is sufficient; its event may arrive later.
        attached = false;
        paused = false;
      }
      try {
        await release();
      } catch {
        return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
      }
      return report(unknown(pauseDiagnostic));
    }
    const held = await recheck();
    const finalInvalid = current();
    if (!held.ok || finalInvalid) {
      try {
        await release();
      } catch {
        return { ok: false, code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED" };
      }
      return report(held.ok ? unknown(finalInvalid!) : held);
    }
    return {
      ok: true,
      recheck: async () => {
        const check = await recheck();
        const invalid = current();
        if (check.ok && invalid) return report(unknown(invalid));
        return check.ok ? check : report(check);
      },
      release,
    };
  }

  private reportUpdateAdmissionDiagnostic(
    diagnostic: ChatGptUpdateAdmissionDiagnostic,
  ): void {
    try {
      this.options.onUpdateAdmissionDiagnostic?.(
        Object.freeze({ ...diagnostic }),
      );
    } catch {
      // Observers cannot change admission, cleanup, or public error behavior.
    }
  }

  async toggleSidebar(): Promise<boolean> {
    const candidate = this.routeWindow;
    if (
      !candidate ||
      candidate.isDestroyed() ||
      !isChatGptPage(candidate.webContents.getURL(), this.options.homeUrl)
    )
      return false;
    try {
      return (
        (await candidate.webContents.executeJavaScript(
          toggleChatGptSidebarScript,
          true,
        )) === true
      );
    } catch {
      return false;
    }
  }

  async open(): Promise<ChatGptOpenResult> {
    if (this.updateAdmission) return { status: "unreachable" };
    if (this.opening) {
      // Owner navigation exposes the retained browser immediately while its
      // original preload completes. Protected submission surfaces still wait.
      if (this.options.requireAppForManualMessages !== true) {
        this.routeWindow?.reveal();
        this.routeWindow?.focus();
      }
      const opened = await this.opening;
      return opened.status === "opened" ? this.open() : opened;
    }
    const retained = this.routeWindow;
    if (retained && !retained.isDestroyed()) {
      if (this.options.requireAppForManualMessages === true) {
        if (this.load !== "loaded") return { status: "unreachable" };
        const gate = await this.installCurrentRouteAppSubmissionGate(
          retained.webContents,
        );
        if (gate !== "installed") {
          if (gate === "failed" && this.load === "loaded") {
            this.blockUnsafeManualSurface(retained.webContents);
          }
          return { status: "unreachable" };
        }
      }
      if (
        this.routeWindow !== retained ||
        retained.isDestroyed() ||
        (this.options.requireAppForManualMessages === true &&
          this.load !== "loaded")
      ) {
        return { status: "unreachable" };
      }
      try {
        retained.reveal();
        retained.focus();
        return { status: this.load === "loaded" ? "opened" : "unreachable" };
      } catch {
        return { status: "unreachable" };
      }
    }

    const opening = this.openRouteWindow();
    this.opening = opening;
    try {
      return await opening;
    } finally {
      this.releaseOpening(opening);
    }
  }

  private releaseOpening(opening: Promise<ChatGptOpenResult>): void {
    if (this.opening !== opening) return;
    this.opening = null;
    // A loaded event before this point cannot admit a sign-in read. Publish
    // again only after the original opener releases its admission latch.
    if (
      this.load !== "loaded" ||
      !this.routeWindow ||
      this.routeWindow.isDestroyed()
    )
      return;
    try {
      this.options.onLoadStateChanged?.("loaded");
    } catch {
      // Observers cannot turn a completed browser open into an unknown result.
    }
  }

  /** Load the existing browser profile without revealing, focusing or sending. */
  async preload(): Promise<ChatGptOpenResult> {
    if (this.updateAdmission || this.taskInFlight)
      return { status: "unreachable" };
    if (this.opening) return this.opening;
    if (this.routeWindow && !this.routeWindow.isDestroyed())
      return { status: this.load === "loaded" ? "opened" : "unreachable" };
    const opening = this.openRouteWindow(false);
    this.opening = opening;
    try {
      return await opening;
    } finally {
      this.releaseOpening(opening);
    }
  }

  // A failed navigation leaves a retained surface that open() deliberately
  // refuses. An explicit owner retry may discard only that failed surface;
  // it never repeats a model submission or resets a successful conversation.
  async retryFailedOpen(): Promise<ChatGptOpenResult> {
    if (
      this.updateAdmission ||
      this.taskInFlight ||
      this.signInMode ||
      this.opening
    ) {
      return { status: "unreachable" };
    }
    if (this.load === "failed" && this.routeWindow) {
      const failed = this.routeWindow;
      this.disposing = true;
      try {
        if (!failed.isDestroyed()) failed.destroy();
      } finally {
        if (this.routeWindow === failed) this.routeWindow = null;
        this.disposing = false;
      }
    }
    return this.open();
  }

  // The explicit "Sign in" entry point (UX34-08): opens the same route as
  // `open()`, but titled for sign-in, carrying its own "Return to Farol"
  // banner, and reporting a truthful signed-in/not/unknown status exactly
  // once, when the window closes — see `onSignInOutcome` on the
  // constructor options. It never auto-closes on detecting a signed-in
  // page: a caller that also drives readonly tasks through this same route
  // (see `runReadonlyTask`) may still be mid-flow re-checking sign-in
  // state, and only the owner's own close (native or "Return to Farol")
  // ends the sign-in surface.
  async openForSignIn(title: string): Promise<ChatGptOpenResult> {
    if (this.updateAdmission) return { status: "unreachable" };
    const attempt = ++this.signInAttempt;
    this.pendingSignInObservation = null;
    this.setTitle(title);
    this.signInMode = true;
    this.signInReported = false;
    activeSignInRoute = this;
    const result = await this.open();
    if (attempt === this.signInAttempt && result.status !== "opened") {
      // No window opened, so no page was ever read: the owner's own action
      // is what produced this outcome, and there is nothing to time.
      this.reportSignInOutcome("unknown", unreadSignInOutcome("return"));
    }
    return result;
  }

  returnFromSignIn(): boolean {
    if (!this.signInMode) return false;
    this.requestSignInReturn();
    return true;
  }

  private exitSignInMode(): void {
    if (!this.signInMode) return;
    this.signInMode = false;
    if (activeSignInRoute === this) activeSignInRoute = null;
    this.setTitle(this.options.title ?? "ChatGPT · Farol");
    const candidate = this.routeWindow;
    if (candidate && !candidate.isDestroyed()) {
      void candidate.webContents
        .executeJavaScript(signInBannerRemovalScript(), true)
        .catch(() => undefined);
    }
  }

  private reportSignInOutcome(
    status: ChatGptSignInStatus,
    diagnostic: ChatGptSignInOutcomeDiagnostic,
  ): void {
    if (this.signInReported) return;
    this.signInReported = true;
    this.options.onSignInOutcome?.(status, diagnostic);
  }

  private reportSignInBlocked(
    diagnostic: ChatGptSignInBlockedDiagnostic,
  ): void {
    if (!this.signInMode) return;
    this.options.onSignInBlocked?.(diagnostic);
  }

  private requestSignInReturn(): void {
    const candidate = this.routeWindow;
    // Defensive only: the console-message handler that calls this has
    // already proven the route owns a live window (`ownsRouteContents`).
    // A sign-in attempt that never got a window reports its own outcome in
    // `openForSignIn`, with the `no-window` reason.
    if (!candidate || candidate.isDestroyed()) return;
    const attempt = this.signInAttempt;
    const close = () => {
      if (attempt !== this.signInAttempt || candidate.isDestroyed()) return;
      if (candidate.close) candidate.close();
      else candidate.destroy();
    };
    if (!this.signInMode) {
      close();
      return;
    }
    // Return is Farol's own control, so the page is read while it is still
    // open and the window closes afterwards. A read begun inside the close
    // itself races the teardown and usually ends as "unknown".
    if (this.pendingSignInObservation === null) {
      this.pendingSignInObservation = boundedSignInObservation(
        this.observeForSignIn(),
        "return",
      );
    }
    if (candidate.kind === "embedded") {
      const pending = this.pendingSignInObservation;
      void pending.then((read) => {
        if (
          attempt !== this.signInAttempt ||
          !this.signInMode ||
          this.routeWindow !== candidate
        )
          return;
        this.pendingSignInObservation = null;
        // The shell owns visibility. A bounded return read can settle after
        // explicit navigation has already revealed this retained document again.
        // Retain failed documents too; only an explicit retry may replace one.
        this.exitSignInMode();
        this.reportSignInOutcome(
          read.observation?.state === "authenticated"
            ? "authenticated"
            : read.observation?.state === "signed_out"
              ? "not_authenticated"
              : "unknown",
          read.diagnostic,
        );
      });
      return;
    }
    // A repeated Return joins the read the first one started instead of
    // closing at once: closing now would tear the page down under that read
    // and turn an answer the page was about to give into "unknown". The
    // close is idempotent, so however many clicks join, it happens once.
    void this.pendingSignInObservation.then(close, close);
  }

  private async openRouteWindow(reveal = true): Promise<ChatGptOpenResult> {
    const parent = this.options.parent();
    const restoreParent = parent?.isVisible() ?? false;
    const routeSession = session.fromPartition(
      this.options.partition ?? CHATGPT_PARTITION,
      {
        cache: true,
      },
    );
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
    this.routeDocumentLoadFailed = false;
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
      // The page is still alive here (this fires before teardown); a
      // `destroy()` skips it entirely, which is exactly why
      // `requestSignInReturn` prefers a real `close()`. Reading it now is
      // the only way to report a truthful status rather than "unknown".
      if (this.signInMode && this.pendingSignInObservation === null) {
        this.pendingSignInObservation = boundedSignInObservation(
          this.observeForSignIn(),
          "closing",
        );
      }
    });
    candidate.onClosed(() => {
      this.stopTaskActivityWatch();
      const ownsRoute = this.routeWindow === candidate;
      if (ownsRoute) this.routeWindow = null;
      if (ownsRoute && this.signInMode) {
        const attempt = this.signInAttempt;
        const pending = this.pendingSignInObservation;
        this.pendingSignInObservation = null;
        this.signInMode = false;
        if (activeSignInRoute === this) activeSignInRoute = null;
        void (async () => {
          let status: ChatGptSignInStatus = "unknown";
          // No read at all (a `destroy()` that skipped the closing turn)
          // is itself the explanation, and never a claim about the page.
          let diagnostic = unreadSignInOutcome("closing");
          try {
            // Every read taken around closing is bounded (see
            // boundedSignInObservation); a null observation means it did
            // not answer, and its diagnostic says which bound won.
            if (pending) {
              const read = await pending;
              diagnostic = read.diagnostic;
              if (read.observation?.state === "authenticated")
                status = "authenticated";
              else if (read.observation?.state === "signed_out")
                status = "not_authenticated";
            }
          } catch {
            // Stays "unknown" — a page that could not be read is not the
            // same claim as a page that was read and found signed out.
          }
          if (attempt === this.signInAttempt)
            this.reportSignInOutcome(status, diagnostic);
        })();
      }
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
          this.options.windowPresentation === undefined &&
          restoreParent &&
          parent &&
          !parent.isDestroyed()
        ) {
          parent.show();
          parent.focus();
        }
      }, 100);
    });

    if (reveal && this.options.requireAppForManualMessages !== true) {
      candidate.reveal();
      candidate.focus();
    }
    // An ordinary browser can observe a committed DOM while slow subresources
    // still keep loadURL pending. Protected task surfaces keep their full-load
    // gate; this milestone neither admits submission nor authenticates a page.
    let domReady: (() => void) | undefined;
    const ordinaryReady =
      this.options.requireAppForManualMessages === true
        ? null
        : new Promise<void>((resolve) => {
            domReady = () => {
              if (
                this.ownsRouteContents(candidate.webContents) &&
                !this.routeDocumentLoadFailed &&
                allowedChatGptPageUrl(
                  candidate.webContents.getURL(),
                  this.options.e2eOrigin,
                )
              )
                resolve();
            };
            candidate.webContents.on("dom-ready", domReady);
          });
    const openDeadline = Date.now() + ROUTE_OPEN_DEADLINE_MS;
    try {
      const navigation = candidate.loadURL(this.entryUrl);
      await this.awaitRouteOpenStep(
        candidate,
        ordinaryReady ? Promise.race([navigation, ordinaryReady]) : navigation,
        openDeadline,
      );
      if (this.routeDocumentLoadFailed) {
        if (this.options.requireAppForManualMessages === true) candidate.hide();
        return { status: "unreachable" };
      }
      const gate = await this.awaitRouteOpenStep(
        candidate,
        this.installCurrentRouteAppSubmissionGate(candidate.webContents),
        openDeadline,
      );
      if (gate === "stale") return { status: "unreachable" };
      if (gate === "failed") {
        this.blockUnsafeManualSurface(candidate.webContents);
        return { status: "unreachable" };
      }
      if (this.routeDocumentLoadFailed) {
        if (this.options.requireAppForManualMessages === true) candidate.hide();
        return { status: "unreachable" };
      }
      this.load = "loaded";
      if (
        this.options.requireAppForManualMessages !== true &&
        this.options.collapseSidebarByDefault &&
        isChatGptPage(candidate.webContents.getURL(), this.options.homeUrl)
      ) {
        void candidate.webContents
          .executeJavaScript(collapseChatGptSidebarScript(), true)
          .catch(() => undefined);
      }
      if (reveal && this.options.requireAppForManualMessages === true) {
        candidate.reveal();
        candidate.focus();
      }
      return { status: "opened" };
    } catch (error) {
      this.load = "failed";
      this.options.onLoadStateChanged?.("failed");
      if (error instanceof RouteOpenTimedOut) {
        if (
          this.options.requireAppForManualMessages === true &&
          !candidate.isDestroyed()
        ) {
          try {
            candidate.hide();
          } catch {
            // Never reveal a page whose opening outcome is unknown.
          }
        }
        return { status: "unreachable" };
      }
      return { status: "unreachable" };
    } finally {
      if (domReady) candidate.webContents.removeListener("dom-ready", domReady);
    }
  }

  private async awaitRouteOpenStep<T>(
    candidate: ChatGptRouteSurface,
    work: Promise<T>,
    deadline: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              // Only protected submission surfaces are retired at the gate deadline.
              // A slow ordinary browser keeps its original visible navigation.
              if (
                this.routeWindow === candidate &&
                this.options.requireAppForManualMessages === true
              ) {
                if (this.signInMode) {
                  this.signInMode = false;
                  if (activeSignInRoute === this) activeSignInRoute = null;
                }
                try {
                  if (!candidate.isDestroyed()) candidate.destroy();
                } catch {
                  // The failed surface is hidden in the caller's catch path.
                }
              }
              reject(new RouteOpenTimedOut("CHATGPT_ROUTE_OPEN_TIMEOUT"));
            },
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private createWindowSurface(): ChatGptRouteSurface {
    const requested = { width: 1080, height: 760 } as const;
    const initial = resolveChatGptWindowPresentation(
      this.options.windowPresentation,
      requested,
    );
    const candidate = new BrowserWindow({
      title: this.displayTitle,
      frame: true,
      titleBarStyle: "default",
      width: requested.width,
      height: requested.height,
      ...(initial.bounds ?? {}),
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
      hide: () => candidate.hide(),
      reveal: () => {
        const presentation = resolveChatGptWindowPresentation(
          this.options.windowPresentation,
          requested,
        );
        if (presentation.reveal === "remain-hidden") return;
        if (candidate.isMinimized()) candidate.restore();
        if (presentation.reveal === "show-inactive") {
          candidate.setBounds(presentation.bounds);
          candidate.showInactive();
          return;
        }
        candidate.show();
      },
      focus: () => {
        if (
          resolveChatGptWindowPresentation(
            this.options.windowPresentation,
            requested,
          ).focus
        ) {
          candidate.focus();
        }
      },
      setTitle: (title) => candidate.setTitle(title),
      destroy: () => candidate.destroy(),
      close: () => candidate.close(),
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
    const document = this.captureReadinessRead();
    const { sequence, surface, documentGeneration, url } = document;
    const read = await this.readReadinessPage(true);
    const unknown: ChatGptPageObservation = {
      state: "unsupported",
      code: "CHATGPT_UI_UNRECOGNIZED",
    };
    if (!surface || url === null) return read.observation;
    // A page answer is readiness only for the exact document it read. Closing
    // diagnostics intentionally retain their separate pre-close snapshot path.
    if (!this.isReadinessDocumentCurrent(document)) return unknown;
    const latest = this.latestReadiness;
    const current =
      latest &&
      latest.surface === surface &&
      latest.documentGeneration === documentGeneration &&
      latest.url === url
        ? latest
        : null;
    if (sequence !== this.readinessReadSequence) {
      // A later pending read cannot be authorized by an old positive answer.
      // A later settled read supplies the current state, never the old result.
      return current &&
        (current.sequence === this.readinessReadSequence ||
          current.observation.state === "signed_out")
        ? current.observation
        : unknown;
    }
    const observation =
      read.observation.state !== "authenticated" &&
      read.observation.state !== "signed_out" &&
      current?.observation.state === "signed_out"
        ? current.observation
        : read.observation;
    this.latestReadiness = {
      surface,
      documentGeneration,
      url,
      sequence,
      observation,
    };
    return observation;
  }

  // Observe only an existing loaded document. Both the read and transport
  // currency share this original monotonic budget. Unlike observe(), this
  // method never publishes into latestReadiness: even a late positive probe
  // cannot become readiness for a subsequent task or settle an unknown effect.
  async observeSignInStatus(): Promise<ChatGptSignInStatusObservation> {
    this.currentReadinessObservation = null;
    const unconfirmedReadiness = (
      reason:
        "admission" | "document-not-current" | "unconfirmed" | "exception",
      pageState: ChatGptPageObservation["state"] | null = null,
    ): ChatGptSignInStatusObservation => {
      try {
        this.options.onSignInStatusDiagnostic?.({
          reason,
          opening: this.opening !== null,
          taskInFlight: this.taskInFlight,
          loading: this.load !== "loaded",
          pageState,
        });
      } catch {
        /* Diagnostics cannot change page-read admission. */
      }
      return Object.freeze({ state: "unknown" as const, binding: null });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.readinessObservationAvailable())
        return unconfirmedReadiness("admission");
      const startedAt = performance.now();
      const deadlineAt = startedAt + READINESS_OBSERVATION_MS;
      const read = this.captureReadinessRead();
      if (!this.isReadinessDocumentCurrent(read))
        return unconfirmedReadiness("document-not-current");
      const answer = await Promise.race([
        this.readReadinessPage(false),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), READINESS_OBSERVATION_MS);
        }),
      ]);
      const now = performance.now();
      if (
        !answer ||
        answer.reason !== "answered" ||
        (answer.observation.state !== "authenticated" &&
          answer.observation.state !== "signed_out") ||
        !Number.isFinite(now) ||
        now < startedAt ||
        now >= deadlineAt ||
        !this.readinessObservationAvailable() ||
        read.sequence !== this.readinessReadSequence ||
        !this.isReadinessDocumentCurrent(read)
      )
        return unconfirmedReadiness(
          "unconfirmed",
          answer?.observation.state ?? null,
        );
      const result: ChatGptSignInStatusObservation = Object.freeze({
        state: answer.observation.state,
        binding: Object.freeze({
          sequence: read.sequence,
          documentGeneration: read.documentGeneration,
        }),
      });
      this.currentReadinessObservation = {
        result,
        read,
        startedAt,
        deadlineAt,
      };
      return result;
    } catch {
      // Native exceptions never escape as page content or positive evidence.
      return unconfirmedReadiness("exception");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  isCurrentSignInStatus(result: ChatGptSignInStatusObservation): boolean {
    const retained = this.currentReadinessObservation;
    if (!retained || retained.result !== result) return false;
    try {
      const now = performance.now();
      if (
        Number.isFinite(now) &&
        now >= retained.startedAt &&
        now < retained.deadlineAt &&
        this.readinessObservationAvailable() &&
        retained.read.sequence === this.readinessReadSequence &&
        this.isReadinessDocumentCurrent(retained.read)
      )
        return true;
    } catch {
      // A lost native document is unknown, never a reusable binding.
    }
    this.currentReadinessObservation = null;
    return false;
  }

  private readinessObservationAvailable(): boolean {
    return (
      !this.disposing &&
      !this.opening &&
      !this.taskInFlight &&
      !this.updateAdmission &&
      !this.routeWindow?.webContents.isDestroyed()
    );
  }

  private captureReadinessRead(): ReadinessRead {
    const sequence = ++this.readinessReadSequence;
    const surface = this.routeWindow;
    return {
      sequence,
      surface,
      documentGeneration: this.routeDocumentGeneration,
      url:
        surface && !surface.isDestroyed() ? surface.webContents.getURL() : null,
    };
  }

  private isReadinessDocumentCurrent(read: ReadinessRead): boolean {
    return (
      read.surface !== null &&
      read.url !== null &&
      !this.disposing &&
      this.routeWindow === read.surface &&
      !read.surface.isDestroyed() &&
      this.routeDocumentGeneration === read.documentGeneration &&
      read.surface.webContents.getURL() === read.url &&
      this.load === "loaded"
    );
  }

  /**
   * Diagnostic page snapshot for a sign-in close. Public observe() adds current
   * identity/order checks; a pre-close diagnostic is never Send authority.
   */
  private observeForSignIn(): Promise<SignInRead> {
    return this.readReadinessPage(true);
  }

  private async readReadinessPage(userGesture: boolean): Promise<SignInRead> {
    const unreachable = classifyChatGptPage({
      load: "failed",
      composerVisible: false,
      signInVisible: false,
    });
    const unrecognized: ChatGptPageObservation = {
      state: "unsupported",
      code: "CHATGPT_UI_UNRECOGNIZED",
    };
    const candidate = this.routeWindow;
    if (!candidate || candidate.isDestroyed()) {
      return { observation: unreachable, reason: "no-window" };
    }
    if (this.load === "failed") {
      return { observation: unreachable, reason: "load-failed" };
    }
    const currentUrl = candidate.webContents.getURL();
    if (!allowedChatGptPageUrl(currentUrl, this.options.e2eOrigin)) {
      return { observation: unrecognized, reason: "url-unsupported" };
    }
    let answer: unknown;
    try {
      answer = await candidate.webContents.executeJavaScript(
        readinessProbe,
        userGesture,
      );
    } catch {
      return { observation: unrecognized, reason: "probe-threw" };
    }
    const parsed = probeSchema.safeParse(answer);
    if (!parsed.success) {
      return { observation: unrecognized, reason: "probe-unrecognized" };
    }
    return {
      observation: classifyChatGptPage({ load: "loaded", ...parsed.data }),
      reason: "answered",
    };
  }

  private async prepareTemporaryInstantProfile(
    candidate: ChatGptRouteSurface,
    temporary = true,
  ): Promise<
    | "CHATGPT_COMPOSER_DRAFT_PRESENT"
    | "CHATGPT_TEMPORARY_CHAT_REQUIRED"
    | "CHATGPT_INSTANT_MODEL_REQUIRED"
    | null
  > {
    const contents = candidate.webContents;
    let observed: ChatGptProfilePreparationDiagnostic["probe"] = null;
    const read = async () => {
      try {
        const result = temporaryInstantProfileSchema.safeParse(
          await contents.executeJavaScript(temporaryInstantProfileProbe, true),
        );
        observed = result.success
          ? {
              composerReady: result.data.composerReady,
              draftPresent: result.data.draftPresent,
              temporary: result.data.temporary,
              modelReady: result.data.modelReady,
              instant: result.data.instant,
              visibleModelLabel: result.data.visibleModelLabel ?? null,
              modelControlCount: result.data.modelControlCount ?? 0,
              labelHasInstant: result.data.labelHasInstant ?? false,
              labelHasThinkingEffort:
                result.data.labelHasThinkingEffort ?? false,
              labelHasFormatMarks: result.data.labelHasFormatMarks ?? false,
            }
          : null;
        return result;
      } catch {
        observed = null;
        return temporaryInstantProfileSchema.safeParse(null);
      }
    };
    const initial = await read();
    if (!initial.success || !initial.data.composerReady)
      return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    if (initial.data.draftPresent) return "CHATGPT_COMPOSER_DRAFT_PRESENT";

    const temporaryUrl = new URL(this.options.homeUrl);
    if (temporary) temporaryUrl.searchParams.set("temporary-chat", "true");
    else temporaryUrl.searchParams.delete("temporary-chat");
    try {
      await candidate.loadURL(temporaryUrl.href);
    } catch {
      return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    }
    if (this.routeWindow !== candidate || candidate.isDestroyed())
      return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    const profileUrl = contents.getURL();
    const profileDocumentGeneration = this.routeDocumentGeneration;
    const profilePhysicalDocumentGeneration =
      this.chatPhysicalDocumentGeneration;
    const profileObservationGeneration = this.taskObservationGeneration;
    const profileIdentityLost = () =>
      this.routeWindow !== candidate ||
      candidate.isDestroyed() ||
      this.routeDocumentGeneration !== profileDocumentGeneration ||
      this.taskObservationGeneration !== profileObservationGeneration ||
      contents.getURL() !== profileUrl;
    let stage: ChatGptProfilePreparationDiagnostic["stage"] = "hydrate";
    let sliderReady = false;
    let sliderAtMinimum = false;
    const refuseInstant = (): "CHATGPT_INSTANT_MODEL_REQUIRED" => {
      try {
        this.options.onProfilePreparationDiagnostic?.({
          stage,
          expectedTemporary: temporary,
          logicalDocumentChanged:
            this.routeDocumentGeneration !== profileDocumentGeneration,
          physicalDocumentChanged:
            this.chatPhysicalDocumentGeneration !==
            profilePhysicalDocumentGeneration,
          urlChanged: contents.getURL() !== profileUrl,
          operationChanged:
            this.taskObservationGeneration !== profileObservationGeneration,
          surfaceChanged:
            this.routeWindow !== candidate || candidate.isDestroyed(),
          probe: observed,
          sliderReady,
          sliderAtMinimum,
        });
      } catch {
        // Observers cannot change admission or make a refused action retryable.
      }
      return "CHATGPT_INSTANT_MODEL_REQUIRED";
    };
    const deadline = Date.now() + 12_000;
    let profile = await read();
    while (
      Date.now() < deadline &&
      (!profile.success ||
        !profile.data.composerReady ||
        profile.data.temporary !== temporary ||
        !profile.data.modelReady)
    ) {
      await delay(200);
      if (this.routeWindow !== candidate || candidate.isDestroyed())
        return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
      profile = await read();
    }
    if (
      !profile.success ||
      !profile.data.composerReady ||
      profile.data.temporary !== temporary ||
      !profile.data.modelReady ||
      profile.data.draftPresent
    )
      return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    if (!profile.data.modelReady || profileIdentityLost())
      return refuseInstant();

    stage = "picker";
    try {
      if (
        (await contents.executeJavaScript(
          openInstantPowerPickerScript,
          true,
        )) !== true ||
        profileIdentityLost()
      )
        return refuseInstant();
      // Opening a provider menu does not acknowledge that its controls have
      // rendered. Observe the same opened picker for a bounded interval; never
      // click it again or reinterpret an unrecognized result as readiness.
      stage = "slider";
      const pickerDeadline = Date.now() + 2_000;
      let minimumObserved = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (profileIdentityLost()) return refuseInstant();
        let slider = instantPowerSliderSchema.safeParse(
          await contents.executeJavaScript(focusInstantPowerSliderScript, true),
        );
        while (
          slider.success &&
          !slider.data.ready &&
          Date.now() < pickerDeadline
        ) {
          await delay(100);
          if (profileIdentityLost()) return refuseInstant();
          slider = instantPowerSliderSchema.safeParse(
            await contents.executeJavaScript(
              focusInstantPowerSliderScript,
              true,
            ),
          );
        }
        sliderReady = slider.success && slider.data.ready;
        sliderAtMinimum =
          slider.success && slider.data.ready && slider.data.atMinimum === true;
        if (profileIdentityLost() || !slider.success || !slider.data.ready)
          return refuseInstant();
        if (slider.data.atMinimum) {
          minimumObserved = true;
          break;
        }
        contents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
        contents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
        await delay(80);
      }
      if (!minimumObserved) return refuseInstant();
      contents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    } catch {
      return refuseInstant();
    }
    stage = "selected-model";
    let selected = await read();
    const selectedDeadline = Date.now() + 2_000;
    while (
      selected.success &&
      !selected.data.instant &&
      Date.now() < selectedDeadline
    ) {
      await delay(100);
      if (profileIdentityLost()) return refuseInstant();
      selected = await read();
    }
    if (
      profileIdentityLost() ||
      !selected.success ||
      !selected.data.composerReady ||
      selected.data.draftPresent ||
      selected.data.temporary !== temporary ||
      !selected.data.modelReady ||
      !selected.data.instant
    )
      return refuseInstant();

    // Ordinary connector checks need app access, which Temporary Chat does not
    // provide. Their freshly navigated, empty Instant composer needs no
    // personalization toggle; preserve the owner's account preferences.
    if (!temporary) return null;

    // Personalization controls may depend on the selected provider model.
    // Confirm Instant before waiting for or selecting Personalized; neither
    // state alone authorizes preparation of a message or submission.
    const personalizationDeadline = Date.now() + 2_000;
    profile = selected;
    while (
      profile.success &&
      !profile.data.personalizationReady &&
      Date.now() < personalizationDeadline
    ) {
      await delay(100);
      if (profileIdentityLost()) return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
      profile = await read();
    }
    if (
      profileIdentityLost() ||
      !profile.success ||
      !profile.data.composerReady ||
      profile.data.draftPresent ||
      profile.data.temporary !== temporary ||
      !profile.data.instant ||
      !profile.data.personalizationReady
    )
      return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
    if (!profile.data.personalized) {
      try {
        if (
          (await contents.executeJavaScript(
            openTemporaryPersonalizationScript,
            true,
          )) !== true ||
          profileIdentityLost()
        )
          return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
        let selected = false;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (profileIdentityLost()) return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
          if (
            (await contents.executeJavaScript(
              selectTemporaryPersonalizationScript,
              true,
            )) === true
          ) {
            selected = true;
            break;
          }
          await delay(100);
        }
        if (!selected) return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
        profile = await read();
        if (!profile.success || !profile.data.personalized)
          return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
      } catch {
        return "CHATGPT_TEMPORARY_CHAT_REQUIRED";
      }
    }
    const ready = await read();
    if (ready.success && (!ready.data.modelReady || !ready.data.instant))
      return "CHATGPT_INSTANT_MODEL_REQUIRED";
    return !profileIdentityLost() &&
      ready.success &&
      ready.data.composerReady &&
      !ready.data.draftPresent &&
      ready.data.temporary &&
      ready.data.personalizationReady &&
      ready.data.personalized &&
      ready.data.modelReady &&
      ready.data.instant
      ? null
      : "CHATGPT_TEMPORARY_CHAT_REQUIRED";
  }

  async runReadonlyTask(
    prompt: string,
    attachments: readonly StagedChatGptAttachment[],
    observer: ChatGptTaskObserver & {
      readConnectorReceipt: () => Promise<boolean>;
    },
    profile: "temporary-instant" | "connector-instant",
    appTarget: Readonly<{ name: string }>,
  ): Promise<ChatGptConnectorCheckResult>;
  async runReadonlyTask(
    prompt: string,
    attachments?: readonly StagedChatGptAttachment[],
    observer?: ChatGptTaskObserver,
    profile?: "ordinary" | "temporary-instant" | "connector-instant",
    appTarget?: Readonly<{ name: string }>,
  ): Promise<ChatGptReadonlyTaskResult>;
  async runReadonlyTask(
    prompt: string,
    attachments: readonly StagedChatGptAttachment[] = [],
    observer: ChatGptTaskObserver = {},
    profile:
      "ordinary" | "temporary-instant" | "connector-instant" = "ordinary",
    appTarget?: Readonly<{ name: string }>,
  ): Promise<ChatGptConnectorCheckResult> {
    // Capture this operation's explicit target before any navigation. Never
    // mutate the route's default/manual-message binding for a one-shot check.
    const requiredAppName = appTarget?.name ?? this.options.requiredAppName;
    if (
      requiredAppName !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u.test(requiredAppName)
    ) {
      return {
        state: "failed_before_submit",
        code: "CHATGPT_APP_TARGET_INVALID",
        deltaCount: 0,
        observedCharacters: 0,
        outputText: "",
      };
    }
    // Refuse before changing task/sign-in state, including when no browser is
    // open. An update's final idle proof remains reserved until its release.
    if (this.updateAdmission || this.taskInFlight) {
      return {
        state: "failed_before_submit",
        code: "CHATGPT_TASK_IN_PROGRESS",
        deltaCount: 0,
        observedCharacters: 0,
        outputText: "",
      };
    }
    this.exitSignInMode();
    this.taskInFlight = true;
    const observationGeneration = ++this.taskObservationGeneration;
    let publicTurn: ChatGptPublicTurn | null = null;
    const semanticOutput =
      this.options.publicOutputProfile === "message-anchors-v1";
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
      if (profile === "temporary-instant" || profile === "connector-instant") {
        const running = await candidate.webContents
          .executeJavaScript(activityProbe, true)
          .then((answer) => activityProbeSchema.safeParse(answer))
          .catch(() => activityProbeSchema.safeParse(null));
        if (!running.success || running.data.running) {
          return {
            state: "failed_before_submit",
            code: "CHATGPT_TASK_IN_PROGRESS",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        const profileFailure = await this.prepareTemporaryInstantProfile(
          candidate,
          profile === "temporary-instant",
        );
        if (profileFailure !== null) {
          return {
            state: "failed_before_submit",
            code:
              profile === "connector-instant" &&
              profileFailure === "CHATGPT_TEMPORARY_CHAT_REQUIRED"
                ? "CHATGPT_UI_UNRECOGNIZED"
                : profileFailure,
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
      }
      if (profile === "temporary-instant" || profile === "connector-instant") {
        // Profile preparation may navigate. Its composer/model probes are not
        // authentication evidence for the new document's dispatch.
        const currentReadiness = await this.observe();
        if (currentReadiness.state !== "authenticated") {
          return {
            state:
              currentReadiness.state === "signed_out"
                ? "not_authenticated"
                : "failed_before_submit",
            code:
              currentReadiness.state === "signed_out"
                ? "CHATGPT_SIGN_IN_REQUIRED"
                : "CHATGPT_UI_UNRECOGNIZED",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
      }
      // The page identity `observe()` just validated, checked once before
      // dispatch. Every remaining step before the click that actually
      // submits (the activity read, typing the prompt, an attachment
      // upload, and each retry of the click itself) re-checks this exact
      // identity first: a navigation in between must never let a later step
      // act on a conversation nobody validated. Once the click is
      // acknowledged, the page is already committed and the poll loop below
      // owns tracking it from there.
      const dispatchIdentityUrl = candidate.webContents.getURL();
      const dispatchDocumentGeneration = this.routeDocumentGeneration;
      const dispatchIdentityLost = (): boolean => {
        const active = this.routeWindow;
        return (
          !active ||
          active !== candidate ||
          active.isDestroyed() ||
          observationGeneration !== this.taskObservationGeneration ||
          dispatchDocumentGeneration !== this.routeDocumentGeneration ||
          active.webContents.getURL() !== dispatchIdentityUrl
        );
      };
      const dispatchReadinessRefusal = (): ChatGptReadonlyTaskResult | null => {
        const latest = this.latestReadiness;
        if (dispatchIdentityLost()) return null;
        const current =
          latest &&
          latest.surface === candidate &&
          latest.documentGeneration === dispatchDocumentGeneration &&
          latest.url === dispatchIdentityUrl
            ? latest
            : null;
        if (
          current?.observation.state === "authenticated" &&
          current.sequence === this.readinessReadSequence
        )
          return null;
        return {
          state:
            current?.observation.state === "signed_out"
              ? "not_authenticated"
              : "failed_before_submit",
          code:
            current?.observation.state === "signed_out"
              ? "CHATGPT_SIGN_IN_REQUIRED"
              : "CHATGPT_UI_UNRECOGNIZED",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      };
      let activityCandidate: unknown;
      try {
        activityCandidate = await candidate.webContents.executeJavaScript(
          activityProbe,
          true,
        );
      } catch {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_UI_UNRECOGNIZED",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      const activity = activityProbeSchema.safeParse(activityCandidate);
      if (!activity.success) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_UI_UNRECOGNIZED",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      this.recordTaskActivity(activity.data.running);
      if (activity.data.running) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_TASK_IN_PROGRESS",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      const beforeBinding = dispatchReadinessRefusal();
      if (beforeBinding) return beforeBinding;
      if (dispatchIdentityLost()) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      if (requiredAppName !== undefined) {
        let appBindingCandidate: unknown;
        try {
          appBindingCandidate = await candidate.webContents.executeJavaScript(
            bindChatGptAppScript(requiredAppName, dispatchIdentityUrl),
            true,
          );
        } catch {
          return {
            state: "failed_before_submit",
            code: "CHATGPT_UI_UNRECOGNIZED",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        const appBinding = appBindingSchema.safeParse(appBindingCandidate);
        if (!appBinding.success) {
          return {
            state: "failed_before_submit",
            code: "CHATGPT_UI_UNRECOGNIZED",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        if (appBinding.data.state === "navigated") {
          return {
            state: "failed_before_submit",
            code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        if (appBinding.data.state === "blocked") {
          return {
            state: "failed_before_submit",
            code: appBindingFailureCode(appBinding.data.reason),
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
      }
      const beforePrepare = dispatchReadinessRefusal();
      if (beforePrepare) return beforePrepare;
      if (dispatchIdentityLost()) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      const prepared = preparedTaskSchema.safeParse(
        await candidate.webContents.executeJavaScript(
          prepareTaskScript(prompt, dispatchIdentityUrl, requiredAppName),
          true,
        ),
      );
      if (!prepared.success) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_COMPOSER_UNAVAILABLE",
          deltaCount,
          observedCharacters,
        };
      }
      // The page compared its own location against the validated identity
      // before touching the composer, and found another page: nothing was
      // typed anywhere.
      if ("navigated" in prepared.data) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      if ("appSelectionLost" in prepared.data) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_APP_SELECTION_LOST",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      if ("draftPresent" in prepared.data) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_COMPOSER_DRAFT_PRESENT",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      const preparedTask = prepared.data;
      if (!preparedTask.ready) {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_COMPOSER_UNAVAILABLE",
          deltaCount,
          observedCharacters,
        };
      }
      if (attachments.length > 0) {
        const beforeUpload = dispatchReadinessRefusal();
        if (beforeUpload) return beforeUpload;
        if (dispatchIdentityLost()) {
          return {
            state: "failed_before_submit",
            code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
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
        // The dispatch-intent record is written first (it is a disk write,
        // and anything may happen to the page while it lands), so that the
        // identity check is the last thing before the click script leaves
        // this process: nothing awaits between the check and the dispatch.
        // The script then compares the page's own location once more,
        // in-page, before it clicks.
        await observer.onDispatchIntent?.();
        const beforeAppVerification = dispatchReadinessRefusal();
        if (beforeAppVerification) return beforeAppVerification;
        if (dispatchIdentityLost()) {
          return {
            state: "failed_before_submit",
            code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        if (requiredAppName !== undefined) {
          const selected = appBindingSchema.safeParse(
            await candidate.webContents.executeJavaScript(
              verifyChatGptAppScript(requiredAppName, dispatchIdentityUrl),
              true,
            ),
          );
          if (!selected.success) {
            return {
              state: "failed_before_submit",
              code: "CHATGPT_UI_UNRECOGNIZED",
              deltaCount,
              observedCharacters,
              outputText: observedText,
            };
          }
          if (selected.data.state === "navigated") {
            return {
              state: "failed_before_submit",
              code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
              deltaCount,
              observedCharacters,
              outputText: observedText,
            };
          }
          if (selected.data.state === "blocked") {
            const code =
              selected.data.reason === "missing" ||
              selected.data.reason === "selection_not_observed"
                ? "CHATGPT_APP_SELECTION_LOST"
                : appBindingFailureCode(selected.data.reason);
            return {
              state: "failed_before_submit",
              code,
              deltaCount,
              observedCharacters,
              outputText: observedText,
            };
          }
        }
        // App verification above awaits the browser. Recheck cancellation and
        // identity after that final await, immediately before dispatching Send.
        const beforeSend = dispatchReadinessRefusal();
        if (beforeSend) return beforeSend;
        if (dispatchIdentityLost()) {
          return {
            state: "failed_before_submit",
            code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        submissionPhase = "awaiting_acknowledgement";
        const activated = activatedTaskSchema.safeParse(
          await candidate.webContents.executeJavaScript(
            activateTaskScript(
              dispatchIdentityUrl,
              requiredAppName,
              profile === "temporary-instant",
              profile === "connector-instant",
            ),
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
        // The page refused to click: it was no longer showing the validated
        // identity. That is a positive statement that nothing was submitted.
        if ("navigated" in activated.data) {
          submissionPhase = "not_attempted";
          return {
            state: "failed_before_submit",
            code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        if ("appSelectionLost" in activated.data) {
          submissionPhase = "not_attempted";
          return {
            state: "failed_before_submit",
            code: "CHATGPT_APP_SELECTION_LOST",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        if ("profileLost" in activated.data) {
          submissionPhase = "not_attempted";
          return {
            state: "failed_before_submit",
            code: "CHATGPT_INSTANT_MODEL_REQUIRED",
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
      // The conversation this submission belongs to, once the page shows
      // one. A submission made from the home page is allowed exactly one
      // transition, to the conversation it creates; after that, another
      // conversation -- or the home page again -- is a page this submission
      // does not own, however much its messages resemble the prompt.
      let pinnedConversationUrl = canonicalChatGptConversationUrl(
        dispatchIdentityUrl,
        this.options.e2eOrigin,
      );
      const pollMs = this.options.taskPollMs ?? 250;
      const deadline = Date.now() + (this.options.taskTimeoutMs ?? 180_000);
      while (Date.now() < deadline) {
        if (observationGeneration !== this.taskObservationGeneration)
          throw new Error("CHATGPT_TASK_CANCELLED");
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
        let currentUrl = active.webContents.getURL();
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
        const conversationUrl = canonicalChatGptConversationUrl(
          currentUrl,
          this.options.e2eOrigin,
        );
        if (pinnedConversationUrl === null) {
          pinnedConversationUrl = conversationUrl;
        } else if (conversationUrl !== pinnedConversationUrl) {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_PAGE_LOST",
            deltaCount,
            observedCharacters,
            outputText: observedText,
            ...correlation(),
          };
        }
        if (
          (profile === "temporary-instant" ||
            profile === "connector-instant") &&
          appTarget !== undefined &&
          observer.readConnectorReceipt
        ) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          let invalidation: ReturnType<typeof setInterval> | undefined;
          const receipt = await Promise.race([
            observer.readConnectorReceipt(),
            new Promise<null>((resolve) => {
              timeout = setTimeout(
                () => resolve(null),
                Math.max(0, deadline - Date.now()),
              );
            }),
            new Promise<"invalidated">((resolve) => {
              invalidation = setInterval(() => {
                if (
                  observationGeneration !== this.taskObservationGeneration ||
                  this.routeWindow !== active ||
                  active.isDestroyed()
                )
                  resolve("invalidated");
              }, 25);
            }),
          ]).finally(() => {
            if (timeout !== undefined) clearTimeout(timeout);
            if (invalidation !== undefined) clearInterval(invalidation);
          });
          if (receipt === null || Date.now() >= deadline) break;
          if (
            receipt === "invalidated" ||
            observationGeneration !== this.taskObservationGeneration ||
            this.routeWindow !== active ||
            active.isDestroyed()
          ) {
            return {
              state: "outcome_unknown",
              code: "CHATGPT_TASK_PAGE_LOST",
              deltaCount,
              observedCharacters,
              outputText: observedText,
              ...correlation(),
            };
          }
          const afterReceiptUrl = active.webContents.getURL();
          const createdConversation = canonicalChatGptConversationUrl(
            afterReceiptUrl,
            this.options.e2eOrigin,
          );
          const createdByReceipt =
            pinnedConversationUrl === null &&
            createdConversation !== null &&
            allowedChatGptPageUrl(afterReceiptUrl, this.options.e2eOrigin);
          if (afterReceiptUrl !== currentUrl && !createdByReceipt) {
            return {
              state: "outcome_unknown",
              code: "CHATGPT_TASK_PAGE_LOST",
              deltaCount,
              observedCharacters,
              outputText: observedText,
              ...correlation(),
            };
          }
          if (createdByReceipt) pinnedConversationUrl = createdConversation;
          currentUrl = afterReceiptUrl;
          if (receipt === true) {
            return {
              state: "receipt_confirmed",
              code: null,
              deltaCount,
              observedCharacters,
              outputText: observedText,
              ...correlation(),
            };
          }
        }
        const probe = taskProbeSchema.safeParse(
          await active.webContents.executeJavaScript(
            taskProbeScript(
              prompt,
              preparedTask.baselineMessageIds,
              {
                semantic: semanticOutput,
                userId: correlatedUserId,
                assistantId: correlatedAssistantId,
              },
              requiredAppName,
            ),
            true,
          ),
        );
        const afterProbeUrl = active.webContents.getURL();
        const createdConversation = canonicalChatGptConversationUrl(
          afterProbeUrl,
          this.options.e2eOrigin,
        );
        const createdBySubmission =
          pinnedConversationUrl === null &&
          createdConversation !== null &&
          allowedChatGptPageUrl(afterProbeUrl, this.options.e2eOrigin);
        if (afterProbeUrl !== currentUrl && !createdBySubmission) {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_PAGE_LOST",
            deltaCount,
            observedCharacters,
            outputText: observedText,
            ...correlation(),
          };
        }
        if (createdBySubmission) pinnedConversationUrl = createdConversation;
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
            await observer.onCorrelation?.({
              turnUserId: correlatedUserId,
              turnAssistantId: correlatedAssistantId,
            });
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
            await observer.onCorrelation?.({
              turnUserId: correlatedUserId,
              turnAssistantId: correlatedAssistantId,
            });
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
        if (observationGeneration !== this.taskObservationGeneration)
          throw new Error("CHATGPT_TASK_CANCELLED");
        if (semanticOutput && correlated) {
          publicTurn ??= new ChatGptPublicTurn(
            correlatedUserId!,
            correlatedAssistantId!,
          );
          const next = publicTurn.observe(
            probe.data.publicFrame,
            performance.now(),
          );
          for (const item of next.items) {
            if (observationGeneration !== this.taskObservationGeneration)
              throw new Error("CHATGPT_TASK_CANCELLED");
            await observer.onVisibleItem?.(item);
            deltaCount += 1;
            if (item.channel === "answer") {
              observedText += `${observedText ? "\n\n" : ""}${item.text}`;
              observedCharacters = observedText.length;
            }
          }
          if (observedText !== next.answer)
            throw new Error("CHATGPT_TASK_OUTPUT_CHANGED");
          if (observationGeneration !== this.taskObservationGeneration)
            throw new Error("CHATGPT_TASK_CANCELLED");
          if (next.completed)
            return {
              state: "completed",
              code: null,
              deltaCount,
              observedCharacters,
              outputText: observedText,
              ...correlation(),
            };
          await delay(pollMs);
          continue;
        }
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
    if (
      this.updateAdmission ||
      this.taskInFlight ||
      !input.turnUserId ||
      !input.prompt
    ) {
      return {
        state: "outcome_unknown",
        code:
          this.updateAdmission || this.taskInFlight
            ? "CHATGPT_TASK_IN_PROGRESS"
            : "CHATGPT_TASK_OUTPUT_CHANGED",
        deltaCount: 0,
        observedCharacters: 0,
        outputText: "",
        turnUserId: input.turnUserId || null,
        turnAssistantId: input.turnAssistantId,
      };
    }
    this.exitSignInMode();
    this.taskInFlight = true;
    const observationGeneration = ++this.taskObservationGeneration;
    let publicTurn: ChatGptPublicTurn | null = null;
    const semanticOutput =
      this.options.publicOutputProfile === "message-anchors-v1";
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
      const observationUrl = candidate.webContents.getURL();
      let stablePolls = 0;
      const pollMs = this.options.taskPollMs ?? 250;
      const deadline = Date.now() + (this.options.taskTimeoutMs ?? 180_000);
      while (Date.now() < deadline) {
        if (observationGeneration !== this.taskObservationGeneration)
          throw new Error("CHATGPT_TASK_CANCELLED");
        const active = this.routeWindow;
        if (!active || active !== candidate || active.isDestroyed()) {
          return result("CHATGPT_TASK_PAGE_LOST");
        }
        const currentUrl = active.webContents.getURL();
        if (
          currentUrl !== observationUrl ||
          !allowedChatGptPageUrl(currentUrl, this.options.e2eOrigin)
        ) {
          return result("CHATGPT_TASK_PAGE_LOST");
        }
        const probe = taskProbeSchema.safeParse(
          await active.webContents.executeJavaScript(
            taskProbeScript(
              input.prompt,
              [],
              {
                semantic: semanticOutput,
                userId: input.turnUserId,
                assistantId: correlatedAssistantId,
              },
              this.options.requiredAppName,
            ),
            true,
          ),
        );
        if (active.webContents.getURL() !== currentUrl)
          return result("CHATGPT_TASK_PAGE_LOST");
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
        if (observationGeneration !== this.taskObservationGeneration)
          throw new Error("CHATGPT_TASK_CANCELLED");
        if (semanticOutput) {
          publicTurn ??= new ChatGptPublicTurn(
            input.turnUserId,
            correlatedAssistantId,
          );
          const next = publicTurn.observe(
            probe.data.publicFrame,
            performance.now(),
          );
          for (const item of next.items) {
            if (observationGeneration !== this.taskObservationGeneration)
              throw new Error("CHATGPT_TASK_CANCELLED");
            await observer.onVisibleItem?.(item);
            deltaCount += 1;
            if (item.channel === "answer") {
              observedText += `${observedText ? "\n\n" : ""}${item.text}`;
              observedCharacters = observedText.length;
            }
          }
          if (observedText !== next.answer)
            throw new Error("CHATGPT_TASK_OUTPUT_CHANGED");
          if (observationGeneration !== this.taskObservationGeneration)
            throw new Error("CHATGPT_TASK_CANCELLED");
          if (next.completed)
            return {
              state: "completed",
              code: null,
              deltaCount,
              observedCharacters,
              outputText: observedText,
              turnUserId: input.turnUserId,
              turnAssistantId: correlatedAssistantId,
            };
          await delay(pollMs);
          continue;
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
    ++this.taskObservationGeneration;
    const candidate = this.routeWindow;
    if (!candidate || candidate.isDestroyed() || this.load !== "loaded") {
      return "not_running";
    }
    try {
      const wasObservedRunning = this.observedTaskRunning === true;
      const activationAttempts = wasObservedRunning ? 5 : 1;
      let stopActivated = false;
      for (let attempt = 0; attempt < activationAttempts; attempt += 1) {
        const activated = activatedControlSchema.safeParse(
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

  reconcileWindowPresentation(): void {
    const presentation = this.options.windowPresentation;
    if (presentation === undefined) return;
    const candidate = this.routeWindow;
    if (
      candidate !== null &&
      candidate.kind === "window" &&
      !candidate.isDestroyed()
    ) {
      candidate.hide();
      if (presentation.mode === "secondary-visible") {
        try {
          candidate.reveal();
        } catch {
          // The exact owned window stays hidden until a later display event
          // can satisfy the secondary-display contract without fallback.
        }
      }
    }
    for (const popup of this.popupWindows) {
      if (popup.isDestroyed()) continue;
      this.reconcilePopupWindow(popup);
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
    this.readyPopupWindows.clear();
    this.submissionGatedPopupWindows.clear();
    if (this.routeWindow && !this.routeWindow.isDestroyed()) {
      this.routeWindow.destroy();
    }
    this.routeWindow = null;
    this.load = "failed";
    this.disposing = false;
    this.options.onConversationChanged?.(null);
  }

  // Physical generations only. No queue, turn state, journal or retry decision.
  private savedChatPhysicalView: ChatGptRouteSurface | null = null;
  private savedChatViewGeneration = 0;
  private savedChatMutationInFlight = false;
  private savedChatSubmitFuse: Readonly<{
    operationId: string;
    previousUserId: string;
  }> | null = null;

  private chatPhysicalApi: ChatGptPhysicalApi | null = null;
  // A same-document provider CID adoption is not document replacement. Legacy
  // task counters retain their semantics; this physical epoch tracks documents.
  private chatPhysicalDocumentGeneration = 0;

  private chatPhysicalSnapshot(): PhysicalSurface | null {
    const candidate = this.routeWindow;
    if (
      !candidate ||
      candidate.isDestroyed() ||
      candidate.webContents.isDestroyed() ||
      this.load !== "loaded" ||
      !this.routeSession ||
      candidate.webContents.session !== this.routeSession ||
      !Number.isSafeInteger(candidate.webContents.id) ||
      candidate.webContents.id <= 0
    )
      return null;
    const url = candidate.webContents.getURL();
    const saved = canonicalChatGptConversationUrl(url, this.options.e2eOrigin);
    try {
      if (new URL(url).origin !== new URL(this.options.homeUrl).origin)
        return null;
    } catch {
      return null;
    }
    if (url !== this.options.homeUrl && (!saved || url !== saved)) return null;
    if (this.savedChatPhysicalView !== candidate) {
      this.savedChatPhysicalView = candidate;
      this.savedChatViewGeneration += 1;
    }
    const common = {
      viewId: String(candidate.webContents.id),
      viewGeneration: this.savedChatViewGeneration,
      documentGeneration: this.chatPhysicalDocumentGeneration,
      partition: this.options.partition ?? CHATGPT_PARTITION,
    };
    const binding: PhysicalBinding = saved
      ? {
          ...common,
          phase: "conversation",
          url: saved,
          conversationId: new URL(saved).pathname.split("/").at(-1)!,
        }
      : { ...common, phase: "home", url, conversationId: null };
    return {
      handle: candidate,
      binding,
      isDestroyed: () => candidate.webContents.isDestroyed(),
    };
  }

  // Explicit observation of the existing signed-in surface, without opening,
  // navigating or granting approval. The host retains the returned binding.
  observeAccount() {
    return observeBoundChatGptAccount({
      e2eOrigin: this.options.e2eOrigin,
      snapshot: () => this.chatPhysicalSnapshot(),
      read: async (surface) => {
        const candidate = this.routeWindow;
        if (
          !candidate ||
          candidate !== surface.handle ||
          candidate.webContents.isDestroyed()
        )
          throw new Error("PHYSICAL_BINDING_LOST");
        return candidate.webContents.executeJavaScript(
          chatGptAccountProbeScript(this.options.e2eOrigin),
          false,
        );
      },
    });
  }

  // Internal native adapter seam. Go's caller supplies a full original lease
  // guard on every call; this API never allocates, focuses or runs a Task.
  chatPhysical(): ChatGptPhysicalApi {
    if (this.chatPhysicalApi) return this.chatPhysicalApi;
    const owned = (surface: PhysicalSurface): ChatGptRouteSurface => {
      const candidate = this.routeWindow;
      if (
        !candidate ||
        candidate !== surface.handle ||
        candidate.isDestroyed() ||
        candidate.webContents.isDestroyed()
      )
        throw new Error("PHYSICAL_BINDING_LOST");
      return candidate;
    };
    const contentProfile =
      this.options.physicalContentProfile ?? "message-anchors-v1";
    const pagePolicy = {
      contentProfile,
      e2eOrigin: this.options.e2eOrigin,
      ...(this.options.accountObservationProfile
        ? { accountObservationProfile: this.options.accountObservationProfile }
        : {}),
    };
    this.chatPhysicalApi = new ChatGptPhysical({
      qualified: () =>
        this.options.publicOutputProfile === "message-anchors-v1" &&
        (contentProfile === "message-anchors-v1" ||
          (this.options.e2eOrigin !== null &&
            this.options.partition === "persist:farol-dev-chatgpt")),
      snapshot: () => this.chatPhysicalSnapshot(),
      homeUrl: this.options.homeUrl,
      conversationUrl: (cid) => {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(cid)) return null;
        const page = new URL(this.options.homeUrl);
        page.pathname = `${page.pathname.replace(/\/$/, "")}/c/${cid}`;
        page.search = "";
        page.hash = "";
        return canonicalChatGptConversationUrl(
          page.href,
          this.options.e2eOrigin,
        );
      },
      load: async (surface, url) => {
        await owned(surface).loadURL(url);
      },
      prepareProbe: (surface, binding) =>
        owned(surface).webContents.executeJavaScript(
          physicalPrepareProbeScript(binding, pagePolicy),
          false,
        ),
      verifySend: (surface, input) =>
        owned(surface).webContents.executeJavaScript(
          physicalVerifySendScript(input, pagePolicy),
          false,
        ),
      send: (surface, input) =>
        owned(surface).webContents.executeJavaScript(
          physicalSendScript(input, pagePolicy),
          true,
        ),
      observe: (surface, input) =>
        owned(surface).webContents.executeJavaScript(
          physicalObserveScript(input, contentProfile, pagePolicy),
          false,
        ),
      cancel: (surface, input) =>
        owned(surface).webContents.executeJavaScript(
          physicalCancelScript(input, contentProfile, pagePolicy),
          true,
        ),
      destroy: async (surface, deadline) => {
        const candidate = owned(surface);
        const contents = candidate.webContents;
        // Install the exact native receipt listener before the one disposal.
        await new Promise<void>((resolve, reject) => {
          const finished = () => {
            clearTimeout(timer);
            contents.removeListener("destroyed", finished);
            resolve();
          };
          const timer = setTimeout(
            finished,
            Math.max(1, Math.min(15_000, deadline - Date.now())),
          );
          contents.once("destroyed", finished);
          try {
            this.dispose();
            if (contents.isDestroyed()) finished();
          } catch (error) {
            clearTimeout(timer);
            contents.removeListener("destroyed", finished);
            reject(error);
          }
        });
      },
    });
    return this.chatPhysicalApi;
  }

  savedChatFollowUpBinding(): SavedChatPhysicalBinding | null {
    const candidate = this.routeWindow;
    if (
      !candidate ||
      candidate.isDestroyed() ||
      this.load !== "loaded" ||
      !this.routeSession ||
      candidate.webContents.session !== this.routeSession ||
      !Number.isSafeInteger(candidate.webContents.id) ||
      candidate.webContents.id <= 0
    )
      return null;
    const conversationUrl = this.currentSavedChatUrl();
    if (!conversationUrl || candidate.webContents.getURL() !== conversationUrl)
      return null;
    if (this.savedChatPhysicalView !== candidate) {
      this.savedChatPhysicalView = candidate;
      this.savedChatViewGeneration += 1;
    }
    const parsed = SavedChatPhysicalBindingSchema.safeParse({
      conversationId: new URL(conversationUrl).pathname.split("/").at(-1),
      conversationUrl,
      viewId: String(candidate.webContents.id),
      viewGeneration: this.savedChatViewGeneration,
      documentGeneration: this.routeDocumentGeneration,
      partition: this.options.partition ?? CHATGPT_PARTITION,
    });
    return parsed.success ? parsed.data : null;
  }

  /**
   * Internal adapter seam, never a wire grant. The trusted Chat caller must
   * recheck its original operation, Go lease/profile/partition and authority.
   * Literal selection values and physical DTOs supply evidence only.
   */
  async savedChatFollowUp(
    candidate: unknown,
    action: "prepare" | "submit" | "observe",
    stillBound: (binding: SavedChatPhysicalBinding) => boolean,
  ): Promise<SavedChatFollowUpResult> {
    const parsed = SavedChatFollowUpRequestSchema.safeParse(candidate);
    const refused = (code: SavedChatFollowUpCode): SavedChatFollowUpResult => ({
      state: action === "observe" ? "awaiting-owner" : "not-sent",
      code,
    });
    if (
      !parsed.success ||
      !SavedChatFollowUpActionSchema.safeParse(action).success
    )
      return refused("SAVED_CHAT_INVALID");
    if (this.options.publicOutputProfile !== "message-anchors-v1")
      return {
        state: "awaiting-owner",
        code: "SAVED_CHAT_BINDING_UNQUALIFIED",
      };
    const input = parsed.data;
    const binding = this.savedChatFollowUpBinding();
    const authorized = () => {
      try {
        return (
          typeof stillBound === "function" &&
          stillBound(Object.freeze({ ...input.binding })) === true
        );
      } catch {
        return false;
      }
    };
    if (!binding || JSON.stringify(binding) !== JSON.stringify(input.binding))
      return refused("SAVED_CHAT_BINDING_STALE");
    if (!authorized())
      return {
        state: "awaiting-owner",
        code: "SAVED_CHAT_BINDING_UNQUALIFIED",
      };
    if (
      this.options.requiredAppName &&
      this.options.requiredAppName !== input.selection.connector.label
    )
      return refused("SAVED_CHAT_SELECTION_MISMATCH");
    if (this.savedChatMutationInFlight && action !== "observe")
      return refused("SAVED_CHAT_OPERATION_UNSETTLED");
    if (action !== "observe" && input.operation.state !== "not-sent")
      return refused("SAVED_CHAT_OPERATION_UNSETTLED");
    if (
      action === "submit" &&
      this.savedChatSubmitFuse !== null &&
      (this.savedChatSubmitFuse.operationId === input.operation.id ||
        this.savedChatSubmitFuse.previousUserId === input.previous.userId)
    )
      return refused("SAVED_CHAT_OPERATION_UNSETTLED");
    const surface = this.routeWindow!;
    if (action !== "observe") this.savedChatMutationInFlight = true;
    const lost = () =>
      this.routeWindow !== surface ||
      JSON.stringify(this.savedChatFollowUpBinding()) !==
        JSON.stringify(binding) ||
      !authorized();
    // One in-memory physical dispatch fuse survives transport loss. The Go caller
    // still owns durable settlement; a new route/process cannot recover it here.
    if (action === "submit")
      this.savedChatSubmitFuse = {
        operationId: input.operation.id,
        previousUserId: input.previous.userId,
      };
    try {
      const result: unknown = await surface.webContents.executeJavaScript(
        savedChatFollowUpScript(input, action),
        true,
      );
      if (lost())
        return action === "submit"
          ? { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" }
          : refused("SAVED_CHAT_BINDING_STALE");
      const response = SavedChatFollowUpResultSchema.safeParse(result);
      if (!response.success)
        return action === "submit"
          ? { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" }
          : { state: "awaiting-owner", code: "SAVED_CHAT_SOURCE_UNSUPPORTED" };
      const responseState = response.data.state;
      const expectedState =
        action === "prepare"
          ? "prepared"
          : action === "submit"
            ? "submitted"
            : "observed";
      if (
        ["prepared", "submitted", "observed"].includes(responseState) &&
        responseState !== expectedState
      )
        return action === "submit"
          ? { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" }
          : { state: "awaiting-owner", code: "SAVED_CHAT_SOURCE_UNSUPPORTED" };
      if (
        (response.data.state === "prepared" ||
          response.data.state === "submitted") &&
        JSON.stringify(response.data.selection) !==
          JSON.stringify(input.selection)
      )
        return action === "submit"
          ? { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" }
          : { state: "awaiting-owner", code: "SAVED_CHAT_SOURCE_UNSUPPORTED" };
      if (
        response.data.state === "submitted" &&
        response.data.evidenceId !== input.evidenceId
      )
        return { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" };
      if (
        response.data.state === "observed" &&
        (response.data.frame.userId !== response.data.userId ||
          response.data.userId === input.previous.userId ||
          response.data.assistantId === input.previous.assistantId ||
          response.data.frame.messages.some(
            (message) => message.id === input.previous.assistantId,
          ) ||
          (input.correlation !== null &&
            (input.correlation.userId !== response.data.userId ||
              (input.correlation.assistantId !== null &&
                input.correlation.assistantId !== response.data.assistantId))))
      )
        return {
          state: "awaiting-owner",
          code: "SAVED_CHAT_CORRELATION_UNAVAILABLE",
        };
      if (action === "submit" && response.data.state === "not-sent")
        this.savedChatSubmitFuse = null;
      return response.data;
    } catch {
      return action === "submit"
        ? { state: "unknown", code: "SAVED_CHAT_SEND_UNKNOWN" }
        : { state: "awaiting-owner", code: "SAVED_CHAT_SOURCE_UNSUPPORTED" };
    } finally {
      if (action !== "observe") this.savedChatMutationInFlight = false;
    }
  }

  /** Restricted saved-chat probes on this route's own isolated page only. */
  async savedChatReady(homeUrl: string): Promise<unknown> {
    return this.savedChatScript(savedChatReadinessScript(homeUrl), homeUrl);
  }

  async savedChatInsert(homeUrl: string, message: string): Promise<unknown> {
    return this.savedChatScript(
      savedChatInsertScript(homeUrl, message),
      homeUrl,
    );
  }

  async savedChatSubmit(homeUrl: string, digest: string): Promise<unknown> {
    return this.savedChatScript(
      savedChatSubmitScript(homeUrl, digest),
      homeUrl,
      true,
    );
  }

  async savedChatProof(
    conversationUrl: string,
    firstMessageDigest: string,
    titleDigest: string,
    requireHistory: boolean,
  ): Promise<unknown> {
    return this.savedChatScript(
      savedChatProofScript(
        conversationUrl,
        firstMessageDigest,
        titleDigest,
        requireHistory,
      ),
      conversationUrl,
    );
  }

  async savedChatLoad(conversationUrl: string): Promise<boolean> {
    if (
      canonicalChatGptConversationUrl(
        conversationUrl,
        this.options.e2eOrigin,
      ) !== conversationUrl
    )
      return false;
    const candidate = this.routeWindow;
    if (!candidate || candidate.isDestroyed() || this.load !== "loaded")
      return false;
    try {
      await candidate.loadURL(conversationUrl);
      return (
        this.routeWindow === candidate &&
        !candidate.isDestroyed() &&
        this.load === "loaded" &&
        candidate.webContents.getURL() === conversationUrl
      );
    } catch {
      return false;
    }
  }

  currentSavedChatUrl(): string | null {
    const candidate = this.routeWindow;
    if (!candidate || candidate.isDestroyed()) return null;
    return canonicalChatGptConversationUrl(
      candidate.webContents.getURL(),
      this.options.e2eOrigin,
    );
  }

  private async savedChatScript(
    script: string,
    expectedUrl: string,
    allowNavigation = false,
  ): Promise<unknown> {
    const candidate = this.routeWindow;
    const documentGeneration = this.routeDocumentGeneration;
    if (
      !candidate ||
      candidate.isDestroyed() ||
      this.load !== "loaded" ||
      candidate.webContents.getURL() !== expectedUrl
    )
      return null;
    try {
      const result: unknown = await candidate.webContents.executeJavaScript(
        script,
        true,
      );
      if (this.routeWindow !== candidate || candidate.isDestroyed())
        return null;
      if (
        !allowNavigation &&
        (candidate.webContents.getURL() !== expectedUrl ||
          this.routeDocumentGeneration !== documentGeneration ||
          this.load !== "loaded")
      )
        return null;
      return result;
    } catch {
      return null;
    }
  }

  dispose(): void {
    this.disposing = true;
    this.stopTaskActivityWatch();
    for (const popup of this.popupWindows) {
      if (!popup.isDestroyed()) popup.destroy();
    }
    this.popupWindows.clear();
    this.readyPopupWindows.clear();
    this.submissionGatedPopupWindows.clear();
    if (this.routeWindow && !this.routeWindow.isDestroyed()) {
      this.routeWindow.destroy();
    }
    this.routeWindow = null;
    this.routeSession = null;
    this.options.onDisposed?.();
  }

  private hardenSession(routeSession: Session): void {
    if (hardenedRouteSessions.has(routeSession)) return;
    routeSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        if (
          routeClipboardWriteAllowed(
            contents,
            permission,
            details?.requestingUrl ?? "",
            details?.isMainFrame === true,
          )
        ) {
          callback(true);
          return;
        }
        activeSignInRoute?.reportSignInBlocked({
          kind: "permission-denied",
          permission,
        });
        callback(false);
      },
    );
    routeSession.setPermissionCheckHandler(
      (contents, permission, requestingOrigin, details) =>
        routeClipboardWriteAllowed(
          contents,
          permission,
          requestingOrigin,
          details?.isMainFrame === true,
        ),
    );
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
    if (tracksRouteReadiness)
      clipboardRouteOwners.set(
        contents,
        () =>
          this.ownsRouteContents(contents) &&
          new URL(contents.getURL()).origin ===
            new URL(this.options.homeUrl).origin,
      );
    const allowed = (url: string) =>
      allowedChatGptPageUrl(url, this.options.e2eOrigin);
    contents.on("will-navigate", (event, url) => {
      if (!allowed(url)) {
        event.preventDefault();
        this.reportSignInBlocked({
          kind: "navigation-blocked",
          host: hostOf(url),
        });
      }
    });
    contents.on("will-redirect", (event, url) => {
      if (!allowed(url)) {
        event.preventDefault();
        this.reportSignInBlocked({
          kind: "navigation-blocked",
          host: hostOf(url),
        });
      }
    });
    if (tracksRouteReadiness) {
      contents.on(
        "did-start-navigation",
        (_event, url, inPlace, isMainFrame) => {
          if (!isMainFrame || !this.ownsRouteContents(contents)) return;
          // A navigation the policy refuses (will-navigate/will-redirect)
          // never finishes and the current page stays: it must not leave
          // the route believing that page failed. A refused navigation
          // that commits or fails anyway is caught by did-navigate and
          // did-fail-load.
          if (!allowed(url)) return;
          this.routeDocumentGeneration += 1;
          if (!inPlace) this.chatPhysicalDocumentGeneration += 1;
          if (!inPlace) this.routeDocumentLoadFailed = false;
          if (!inPlace && this.options.requireAppForManualMessages === true) {
            this.routeWindow?.hide();
          }
          this.load = inPlace ? "loaded" : "failed";
          this.options.onLoadStateChanged?.(inPlace ? "loaded" : "loading");
        },
      );
      contents.on(
        "did-fail-load",
        (_event, code, _description, _url, isMainFrame) => {
          if (isMainFrame && this.ownsRouteContents(contents)) {
            this.routeDocumentGeneration += 1;
            this.routeDocumentLoadFailed = true;
            this.load = "failed";
            this.options.onLoadStateChanged?.("failed");
            this.reportSignInBlocked({ kind: "load-failed", code });
          }
        },
      );
      contents.on("did-finish-load", () => {
        if (!this.ownsRouteContents(contents)) return;
        if (this.routeDocumentLoadFailed) return;
        void (async () => {
          const gate =
            await this.installCurrentRouteAppSubmissionGate(contents);
          if (gate === "stale") return;
          if (gate === "failed") {
            this.blockUnsafeManualSurface(contents);
            return;
          }
          if (!this.ownsRouteContents(contents)) return;
          if (
            this.options.collapseSidebarByDefault &&
            isChatGptPage(contents.getURL(), this.options.homeUrl)
          ) {
            void contents
              .executeJavaScript(collapseChatGptSidebarScript(), true)
              .catch(() => undefined);
          }
          this.load = "loaded";
          this.options.onLoadStateChanged?.("loaded");
          this.reportConversationUrl(contents);
          this.routeWindow?.reveal();
          if (this.options.onTaskActivityChanged) {
            this.startTaskActivityWatch(contents);
          }
          if (
            this.signInMode &&
            this.routeWindow?.kind === "window" &&
            isChatGptPage(contents.getURL(), this.options.homeUrl)
          ) {
            void contents
              .executeJavaScript(signInBannerScript(this.displayTitle), true)
              .catch(() => undefined);
          }
        })();
      });
      contents.on("console-message", (details) => {
        // Only the page's own top-level frame may send the return signal: an
        // embedded frame of another origin on a ChatGPT page must not be able
        // to close the sign-in window.
        const frame = details.frame;
        if (
          this.signInMode &&
          details.message === SIGN_IN_RETURN_SENTINEL &&
          frame !== null &&
          frame !== undefined &&
          frame.processId === contents.mainFrame.processId &&
          frame.routingId === contents.mainFrame.routingId &&
          isChatGptPage(frame.url, this.options.homeUrl) &&
          this.ownsRouteContents(contents)
        ) {
          this.requestSignInReturn();
        }
      });
      contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
        if (!isMainFrame || !this.ownsRouteContents(contents)) return;
        this.routeDocumentGeneration += 1;
        this.options.onLoadStateChanged?.(this.load);
        this.reportConversationUrl(contents);
        void this.installCurrentRouteAppSubmissionGate(contents).then(
          (gate) => {
            if (gate === "failed") this.blockUnsafeManualSurface(contents);
          },
        );
      });
      contents.on("render-process-gone", () => {
        if (!this.ownsRouteContents(contents)) return;
        if (this.observedTaskRunning === true) {
          this.options.onTaskActivityChanged?.("outcome_unknown");
        }
        this.stopTaskActivityWatch();
        this.chatPhysicalDocumentGeneration += 1;
        this.routeDocumentGeneration += 1;
        this.load = "failed";
        this.options.onLoadStateChanged?.("failed");
        this.routeWindow?.hide();
      });
    }
    contents.setWindowOpenHandler(({ url }) => {
      if (!allowed(url)) {
        this.reportSignInBlocked({ kind: "popup-blocked", host: hostOf(url) });
        return { action: "deny" };
      }
      const requested = { width: 720, height: 760 } as const;
      let presentation: ResolvedChatGptWindowPresentation;
      try {
        presentation = resolveChatGptWindowPresentation(
          this.options.windowPresentation,
          requested,
        );
      } catch {
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          title: `Sign in · ${this.displayTitle}`,
          frame: true,
          titleBarStyle: "default",
          width: requested.width,
          height: requested.height,
          ...(presentation.bounds ?? {}),
          ...(this.options.windowPresentation === undefined &&
          this.options.requiredAppName === undefined
            ? {}
            : { show: false }),
          backgroundColor: "#111216",
          webPreferences: this.remoteWebPreferences(),
        },
      };
    });
    contents.on("did-create-window", (popup) => {
      this.popupWindows.add(popup);
      this.popupDocumentGenerations.set(popup, 0);
      this.hardenContents(popup.webContents, false);
      popup.on("closed", () => {
        this.popupWindows.delete(popup);
        this.readyPopupWindows.delete(popup);
        this.submissionGatedPopupWindows.delete(popup);
      });
      const presentation = this.options.windowPresentation;
      if (
        presentation !== undefined ||
        this.options.requiredAppName !== undefined
      ) {
        popup.hide();
        popup.once("ready-to-show", () => {
          if (popup.isDestroyed()) return;
          this.readyPopupWindows.add(popup);
          this.reconcilePopupWindow(popup);
        });
      }
      if (this.options.requireAppForManualMessages === true) {
        popup.webContents.on(
          "did-start-navigation",
          (_event, _url, inPlace, isMainFrame) => {
            if (!isMainFrame || inPlace || popup.isDestroyed()) return;
            this.popupDocumentGenerations.set(
              popup,
              (this.popupDocumentGenerations.get(popup) ?? 0) + 1,
            );
            this.submissionGatedPopupWindows.delete(popup);
            popup.hide();
          },
        );
        popup.webContents.on("did-finish-load", () => {
          void this.installCurrentPopupAppSubmissionGate(popup).then((gate) => {
            if (gate === "stale") return;
            if (gate === "failed") {
              if (!popup.isDestroyed()) popup.destroy();
              return;
            }
            this.submissionGatedPopupWindows.add(popup);
            this.reconcilePopupWindow(popup);
          });
        });
        popup.webContents.on(
          "did-navigate-in-page",
          (_event, _url, isMainFrame) => {
            if (!isMainFrame) return;
            this.popupDocumentGenerations.set(
              popup,
              (this.popupDocumentGenerations.get(popup) ?? 0) + 1,
            );
            void this.installCurrentPopupAppSubmissionGate(popup).then(
              (gate) => {
                if (gate === "failed" && !popup.isDestroyed()) popup.destroy();
              },
            );
          },
        );
      }
    });
  }

  private reconcilePopupWindow(popup: BrowserWindow): void {
    popup.hide();
    const presentation = this.options.windowPresentation;
    if (!this.readyPopupWindows.has(popup)) {
      return;
    }
    if (
      this.options.requireAppForManualMessages === true &&
      !this.submissionGatedPopupWindows.has(popup)
    ) {
      return;
    }
    if (presentation === undefined) {
      popup.show();
      return;
    }
    if (presentation.mode !== "secondary-visible") return;
    try {
      const resolved = resolveChatGptWindowPresentation(presentation, {
        width: 720,
        height: 760,
      });
      if (resolved.reveal !== "show-inactive") return;
      popup.setBounds(resolved.bounds);
      popup.showInactive();
    } catch {
      // No primary-display fallback and no reduced viewport. The popup stays
      // hidden until another display event makes exact placement possible.
    }
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

  private async installAppSubmissionGate(
    contents: WebContents,
  ): Promise<boolean> {
    if (this.options.requireAppForManualMessages !== true) {
      return this.ownsRouteContents(contents);
    }
    const appName = this.options.requiredAppName;
    if (
      appName === undefined ||
      (this.ownsRouteContents(contents) &&
        !isChatGptPage(contents.getURL(), this.options.homeUrl))
    ) {
      return true;
    }
    if (!this.ownsRouteContents(contents)) return false;
    try {
      return (
        (await contents.executeJavaScript(
          installManualAppGateScript(appName),
          true,
        )) === true
      );
    } catch {
      return false;
    }
  }

  private async installCurrentRouteAppSubmissionGate(
    contents: WebContents,
  ): Promise<"installed" | "failed" | "stale"> {
    const generation = this.routeDocumentGeneration;
    const url = contents.getURL();
    const installed = await this.installAppSubmissionGate(contents);
    if (
      !this.ownsRouteContents(contents) ||
      this.routeDocumentGeneration !== generation ||
      contents.getURL() !== url
    ) {
      return "stale";
    }
    return installed ? "installed" : "failed";
  }

  private async installPopupAppSubmissionGate(
    popup: BrowserWindow,
  ): Promise<boolean> {
    if (this.options.requireAppForManualMessages !== true) {
      return this.popupWindows.has(popup) && !popup.isDestroyed();
    }
    const appName = this.options.requiredAppName;
    if (
      appName === undefined ||
      !this.popupWindows.has(popup) ||
      popup.isDestroyed()
    ) {
      return appName === undefined;
    }
    const contents = popup.webContents;
    // Identity-provider and MFA pages are never modified. If that popup
    // returns to a ChatGPT-owned page, the full-navigation hide above keeps
    // it invisible until this exact gate has been installed there.
    if (!isChatGptPage(contents.getURL(), this.options.homeUrl)) return true;
    try {
      return (
        (await contents.executeJavaScript(
          installManualAppGateScript(appName),
          true,
        )) === true &&
        this.popupWindows.has(popup) &&
        !popup.isDestroyed()
      );
    } catch {
      return false;
    }
  }

  private async installCurrentPopupAppSubmissionGate(
    popup: BrowserWindow,
  ): Promise<"installed" | "failed" | "stale"> {
    const generation = this.popupDocumentGenerations.get(popup) ?? 0;
    const contents = popup.webContents;
    const url = contents.getURL();
    const installed = await this.installPopupAppSubmissionGate(popup);
    if (
      !this.popupWindows.has(popup) ||
      popup.isDestroyed() ||
      this.popupDocumentGenerations.get(popup) !== generation ||
      contents.getURL() !== url
    ) {
      return "stale";
    }
    return installed ? "installed" : "failed";
  }

  private blockUnsafeManualSurface(contents: WebContents): void {
    if (!this.ownsRouteContents(contents)) return;
    this.load = "failed";
    this.options.onLoadStateChanged?.("failed");
    this.stopTaskActivityWatch();
    const candidate = this.routeWindow;
    if (candidate && !candidate.isDestroyed()) candidate.destroy();
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
    this.activityProbeStale = false;
    this.observedTaskRunning = null;
  }

  private async pollTaskActivity(
    contents: WebContents,
    generation: number,
  ): Promise<void> {
    if (
      this.updateAdmission ||
      generation !== this.activityGeneration ||
      this.activityPollInFlight ||
      contents.isDestroyed() ||
      this.load !== "loaded"
    ) {
      return;
    }
    this.activityPollInFlight = true;
    // A probe that never settles must not silence the watcher: past its
    // deadline the task's activity is reported unknown once, no further
    // probe starts while this one hangs, and its late answer is discarded.
    // When it finally settles, the next poll measures afresh.
    let late = false;
    const deadline = setTimeout(() => {
      if (generation !== this.activityGeneration || this.updateAdmission)
        return;
      late = true;
      if (!this.activityProbeStale) {
        this.activityProbeStale = true;
        this.observedTaskRunning = null;
        this.options.onTaskActivityChanged?.("outcome_unknown");
      }
    }, ACTIVITY_PROBE_DEADLINE_MS);
    deadline.unref?.();
    try {
      const observed = activityProbeSchema.safeParse(
        await contents.executeJavaScript(activityProbe, true),
      );
      if (
        !late &&
        !this.updateAdmission &&
        generation === this.activityGeneration &&
        !contents.isDestroyed() &&
        this.load === "loaded" &&
        observed.success
      ) {
        this.activityProbeStale = false;
        this.reportConversationUrl(contents);
        this.recordTaskActivity(observed.data.running);
      }
    } catch {
      // A navigation can invalidate an in-flight probe. Navigation lifecycle
      // events own readiness and the next bounded poll remeasures activity.
    } finally {
      clearTimeout(deadline);
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
      partition: this.options.partition ?? CHATGPT_PARTITION,
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
