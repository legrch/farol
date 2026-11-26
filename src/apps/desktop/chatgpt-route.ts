import {
  BrowserWindow,
  session,
  systemPreferences,
  type Session,
  type WebContents,
} from "electron";
import {
  activateTaskScript,
  activityProbe,
  bindChatGptAppScript,
  collapseChatGptSidebarScript,
  installManualAppGateScript,
  prepareTaskScript,
  signInBannerRemovalScript,
  taskProbeScript,
  toggleChatGptSidebarScript,
  verifyChatGptAppScript,
} from "./chatgpt/scripts";
import { setTimeout as delay } from "node:timers/promises";
import {
  CHATGPT_PARTITION,
  allowedChatGptPageUrl,
  canonicalChatGptConversationUrl,
  type ChatGptPageObservation,
} from "./chatgpt-page-policy";
import type { StagedChatGptAttachment } from "./chatgpt-attachment-staging";
import { uploadChatGptAttachments } from "./chatgpt-attachment-upload";
import type { VisibleOutputItem } from "./chatgpt-visible-output";
import { type BrowserUpdateAdmission } from "./chatgpt-update-idle";
import { ChatGptPublicTurn } from "./chatgpt-public-turn";
import {
  SavedChatPhysicalBindingSchema,
  type SavedChatPhysicalBinding,
  type SavedChatFollowUpResult,
  savedChatInsertScript,
  savedChatProofScript,
  savedChatReadinessScript,
  savedChatSubmitScript,
} from "./saved-chat-page-scripts";

import {
  activityProbeSchema,
  activatedTaskSchema,
  appBindingSchema,
  preparedTaskSchema,
  taskProbeSchema,
} from "../../../apps/desktop/chat/probe";
import { createActivityWatch } from "../../../apps/desktop/chat/activity";
import {
  createUpdateAdmission,
  type ChatGptUpdateAdmissionDiagnostic,
  type ChatGptUpdateIdleEffectGuard,
  type UpdateAdmission,
  type UpdateClosing,
} from "../../../apps/desktop/chat/admission";
import {
  createRoutePermissions,
  isChatGptPage,
  resolveChatGptWindowPresentation,
  type ChatGptWindowPresentation,
} from "../../../apps/desktop/chat/policy";
import {
  DEFAULT_TASK_POLL_MS,
  SUBMIT_WINDOW_MS,
  activationDecision,
  appBindingRefusal,
  appVerificationRefusal,
  appendAnswerItem,
  assistantCorrelation,
  connectorTimingElapsed,
  conversationCreatedBySubmission,
  initialReadinessRefusal,
  instantProfileFailureCode,
  isTaskDocumentUnavailable,
  isValidAppTargetName,
  nextStablePolls,
  observationAdmissionRefusal,
  observedProbeFailureCode,
  observedReadinessCode,
  observedTurnDecision,
  pageLostAcrossAwait,
  pinnedConversationAfter,
  preparedTaskDecision,
  readinessRefusal,
  remainingMs,
  submittedProbeFailureCode,
  taskCallRefusal,
  taskDeadline,
  taskInProgressRefusal,
  taskThrowOutcome,
  textGrowth,
  textTurnCompleted,
  userCorrelation,
} from "../../../apps/desktop/chat/task";
import {
  hardenRouteContents,
  hardenRouteSession,
} from "../../../apps/desktop/chat/harden";
import {
  adoptPopupWindow,
  trackRouteReadiness,
} from "../../../apps/desktop/chat/ready";
import {
  createInstantProfilePreparer,
  type ChatGptProfilePreparationDiagnostic,
  type InstantProfileRefusal,
} from "../../../apps/desktop/chat/instant";
import {
  createBoundedSignInObservation,
  unreadSignInOutcome,
  type ChatGptSignInBlockedDiagnostic,
  type ChatGptSignInOutcomeDiagnostic,
  type SignInObservation,
  type SignInRead,
} from "../../../apps/desktop/chat/signin";
import {
  boundedProbe,
  type BoundedProbe,
} from "../../../apps/desktop/chat/bounded";
import { atDeadline, raceDeadline } from "../../../apps/desktop/chat/deadline";
import {
  createReadinessObserver,
  createTaskScriptRunner,
  READINESS_OBSERVATION_MS,
  type ChatGptSignInStatusObservation,
} from "../../../apps/desktop/chat/observe";
import {
  ROUTE_OPEN_DEADLINE_MS,
  createOpenStepRace,
  createOrdinaryReady,
  decideRetryAfterJoin,
  decideRetryFailedOpen,
  decideSignInExit,
  decideSignInReturn,
  hideAfterOpenTimeout,
  shouldReportUnopenedSignIn,
  signInReturnStillCurrent,
  signInStatusFromObservation,
  temporaryChatUrl,
} from "../../../apps/desktop/chat/open";
import {
  applyRouteTitle,
  createConnectionCheckOpener,
  createConversationUrls,
  createManualTargets,
  createRouteReset,
  createTaskCanceller,
  routeOwnsContents,
  routeTitle,
  type ConnectionCheckDocument,
  type ConversationUrls,
  type ManualTargets,
} from "../../../apps/desktop/chat/conversation";
import {
  createSavedChatFollowUp,
  createSavedChatProbes,
} from "../../../apps/desktop/chat/saved";
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

// The pure policy and sign-in observation now live under apps/desktop/chat;
// what other files import from here keeps resolving.
export {
  classifyChatGptProviderError,
  resolveChatGptWindowPresentation,
  type ChatGptProviderErrorKind,
  type ChatGptWindowPresentation,
  type ResolvedChatGptWindowPresentation,
} from "../../../apps/desktop/chat/policy";

export type { ChatGptProfilePreparationDiagnostic } from "../../../apps/desktop/chat/instant";
export type {
  ChatGptUpdateAdmissionDiagnostic,
  ChatGptUpdateIdleEffectGuard,
} from "../../../apps/desktop/chat/admission";

export {
  ChatGptSignInBlockLedger,
  type ChatGptSignInBlockedDiagnostic,
  type ChatGptSignInOutcomeDiagnostic,
} from "../../../apps/desktop/chat/signin";

export type {
  ChatGptSignInStatusBinding,
  ChatGptSignInStatusObservation,
} from "../../../apps/desktop/chat/observe";

// The window a saved-chat send polls for its proof; a proof is bounded by it.
const SAVED_CHAT_WINDOW_MS = 30_000;

const hardenedRouteSessions = new WeakSet<Session>();
const routePermissionOwners = new WeakMap<WebContents, () => number | null>();
const routePermissions = createRoutePermissions(routePermissionOwners);
export const routeDownloadAllowed = routePermissions.downloadAllowed;

// Every elapsed-time deadline of a task, an open step or a saved-chat probe is
// an absolute reading of this monotonic clock, so a wall-clock step or
// adjustment can neither extend nor shorten a window, and a runner's deadline
// rejection is judged against the same clock that raised it.
const monotonicNow = (): number => performance.now();

// Probes are bounded against such a deadline with a real timer.
const monotonicClock = {
  now: monotonicNow,
  after: (callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

// The sign-in close read is bounded by the real clock and a real timer.
const boundedSignInObservation = createBoundedSignInObservation({
  now: () => Date.now(),
  after: (callback, ms) => {
    setTimeout(callback, ms);
  },
});

// A dedicated sign-in surface (see `openForSignIn`) is distinct from the
// same route being reused to run a task: it carries a title of its own, a
// "Return to Farol" banner, and a truthful signed-in/not/unknown status
// reported once on return. DEV embeds the surface in its main window;
// Preview retains the separate-window presentation (UX34-08).
export type ChatGptSignInStatus =
  "authenticated" | "not_authenticated" | "unknown";

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
  // Production must not enable this until the route keeps every surface and
  // popup in custody until confirmed destruction (Brain decision 31; backlog
  // item 7). tests/architecture/protected-route-option.test.ts enforces it.
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
  onNavigationHistoryChanged?: (
    state: Readonly<{ back: boolean; forward: boolean }>,
  ) => void;
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
  // Waits between task polls. Defaults to a real timer; tests drive it with a
  // fake clock so no ordering depends on host load.
  taskPollDelay?: (ms: number) => Promise<void>;
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

export type ChatGptSubmissionResult = Readonly<
  Omit<ChatGptReadonlyTaskResult, "state"> & { state: "send_requested" }
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
  // Explicit Go-owned check: one activation attempt, exact prepared text fence.
  // This flag is supplied only by trusted Main, never a page or renderer.
  connectionCheck?: boolean;
  // Original document/owner fence before any explicit-check preparation.
  beforePrepare?: () => boolean;
  onSendAcknowledged?: () => void | Promise<void>;
  // Synchronous owner fence after the final awaited page verification.
  beforeSend?: () => boolean;
  manualDeepTest?: boolean;
  // Manual diagnostics end at the original click acknowledgement. This is not
  // evidence that the provider accepted the turn or completed a test.
  manualSubmissionOnly?: boolean;
  // Only an app-bound connector check may finish from its exact
  // local receipt. This proves the connector effect, never a model answer.
  readConnectorReceipt?: () => Promise<boolean>;
  // Content-free elapsed times for the one app-bound check; diagnostic only.
  onConnectorTiming?: (
    event: Readonly<{
      stage:
        | "started"
        | "profile_ready"
        | "send_requested"
        | "send_acknowledged"
        | "receipt_confirmed"
        | "finished";
      elapsedMs: number;
    }>,
  ) => void;
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
  private routeDocumentAwaitingCommit = false;
  private routeDocumentGeneration = 0;
  private disposing = false;
  private taskInFlight = false;
  private taskObservationGeneration = 0;
  private opening: Promise<ChatGptOpenResult> | null = null;
  private entryUrl: string;
  private displayTitle: string;
  // The task-activity poll and what it last observed live in the watch; every
  // callback reads the route's state when it runs, not when it is built.
  private readonly activity = createActivityWatch<WebContents>({
    timers: {
      every: (callback, ms) => {
        const timer = setInterval(callback, ms);
        timer.unref?.();
        return () => clearInterval(timer);
      },
      after: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      },
    },
    page: {
      isDestroyed: (contents) => contents.isDestroyed(),
      probe: (contents) => contents.executeJavaScript(activityProbe, true),
    },
    route: {
      updateAdmitted: () => this.updateAdmission,
      loaded: () => this.load === "loaded",
    },
    report: {
      activity: (state) => this.options.onTaskActivityChanged?.(state),
      conversation: (contents) => this.reportConversationUrl(contents),
    },
  });
  private updateAdmission = false;
  private readonly admission: UpdateAdmission;
  private readonly conversationUrls: ConversationUrls<WebContents>;
  private readonly manualTargets: ManualTargets;
  private readonly cancelTask: ReturnType<typeof createTaskCanceller>;
  private readonly resetRoute: () => void;
  private readonly connectionCheckOpener: ReturnType<
    typeof createConnectionCheckOpener<ChatGptRouteSurface>
  >;
  private signInMode = false;
  private signInAttempt = 0;
  private signInReported = false;
  private pendingSignInObservation: Promise<SignInObservation> | null = null;
  private readonly readiness = createReadinessObserver<ChatGptRouteSurface>({
    route: {
      surface: () => this.routeWindow,
      documentGeneration: () => this.routeDocumentGeneration,
      loaded: () => this.load === "loaded",
      awaitingCommit: () => this.routeDocumentAwaitingCommit,
      disposing: () => this.disposing,
      blocked: () =>
        this.opening !== null || this.taskInFlight || this.updateAdmission,
    },
    e2eOrigin: () => this.options.e2eOrigin,
    clock: {
      now: () => performance.now(),
      after: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    diagnose: (reason, pageState) =>
      this.options.onSignInStatusDiagnostic?.({
        reason,
        opening: this.opening !== null,
        taskInFlight: this.taskInFlight,
        loading: this.load !== "loaded",
        pageState,
      }),
  });
  private readonly awaitRouteOpenStep = createOpenStepRace<ChatGptRouteSurface>(
    {
      now: () => monotonicNow(),
      after: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
      owned: (candidate) => this.routeWindow === candidate,
      protectedSurface: () => this.options.requireAppForManualMessages === true,
      leaveSignIn: () => {
        if (this.signInMode) {
          this.signInMode = false;
          if (activeSignInRoute === this) activeSignInRoute = null;
        }
      },
    },
  );
  private readonly runTaskScript = createTaskScriptRunner<WebContents>({
    route: {
      surface: () => this.routeWindow,
      disposing: () => this.disposing,
      observationGeneration: () => this.taskObservationGeneration,
      physicalDocumentGeneration: () => this.chatPhysicalDocumentGeneration,
      documentLoadFailed: () => this.routeDocumentLoadFailed,
      documentAwaitingCommit: () => this.routeDocumentAwaitingCommit,
    },
    clock: {
      now: () => monotonicNow(),
      after: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
  });

  constructor(private readonly options: ChatGptRouteOptions) {
    this.admission = createUpdateAdmission<ChatGptRouteSurface>({
      homeUrl: options.homeUrl,
      route: {
        reserved: () => this.updateAdmission,
        setReserved: (reserved) => {
          this.updateAdmission = reserved;
        },
        opening: () => this.opening !== null,
        taskInFlight: () => this.taskInFlight,
        signInMode: () => this.signInMode,
        hasLivePopup: () =>
          [...this.popupWindows].some((popup) => !popup.isDestroyed()),
        hasOpenSurface: () => this.hasOpenUpdateSurface(),
        surface: () => this.routeWindow,
        loaded: () => this.load === "loaded",
        documentGeneration: () => this.routeDocumentGeneration,
        beginClose: () => this.beginUpdateClose(),
        endClose: () => {
          this.disposing = false;
        },
      },
      clock: {
        now: () => Date.now(),
        after: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
      },
      report: (diagnostic) => this.reportUpdateAdmissionDiagnostic(diagnostic),
    });
    this.conversationUrls = createConversationUrls<WebContents>({
      surface: () => this.routeWindow,
      disposing: () => this.disposing,
      loaded: () => this.load === "loaded",
      entryUrl: () => this.entryUrl,
      setEntryUrl: (url) => {
        this.entryUrl = url;
      },
      e2eOrigin: () => this.options.e2eOrigin,
      homeUrl: options.homeUrl,
      changed: () => this.options.onConversationChanged,
    });
    this.manualTargets = createManualTargets<ChatGptRouteSurface>({
      surface: () => this.routeWindow,
      loaded: () => this.load === "loaded",
      documentGeneration: () => this.routeDocumentGeneration,
      e2eOrigin: () => this.options.e2eOrigin,
    });
    this.cancelTask = createTaskCanceller<WebContents, ChatGptRouteSurface>({
      surface: () => this.routeWindow,
      loaded: () => this.load === "loaded",
      supersedeObservation: () => {
        ++this.taskObservationGeneration;
      },
      observedRunning: () => this.activity.running() === true,
      delay: (ms) => delay(ms),
      recordStopped: (contents) => {
        if (this.options.onTaskActivityChanged) {
          this.activity.start(contents);
        }
        this.activity.record(false);
      },
    });
    this.resetRoute = createRouteReset(options.homeUrl, {
      setEntryUrl: (url) => {
        this.entryUrl = url;
      },
      setDisposing: (disposing) => {
        this.disposing = disposing;
      },
      stopActivity: () => this.activity.stop(),
      popups: () => this.popupWindows,
      forgetPopups: () => {
        this.popupWindows.clear();
        this.readyPopupWindows.clear();
        this.submissionGatedPopupWindows.clear();
      },
      surface: () => this.routeWindow,
      release: () => {
        this.routeWindow = null;
        this.load = "failed";
      },
      changed: () => this.options.onConversationChanged,
    });
    this.connectionCheckOpener =
      createConnectionCheckOpener<ChatGptRouteSurface>(options.homeUrl, {
        capture: () => this.captureManualTaskTarget(),
        surface: () => this.routeWindow,
        taskInFlight: () => this.taskInFlight,
        setTaskInFlight: (inFlight) => {
          this.taskInFlight = inFlight;
        },
        updateAdmitted: () => this.updateAdmission,
        navigate: (surface, url) =>
          this.navigateRouteDocument(
            surface,
            url,
            monotonicNow() + ROUTE_OPEN_DEADLINE_MS,
          ),
        announce: () =>
          this.options.onNavigationHistoryChanged?.(this.navigationHistory()),
        after: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          return () => clearTimeout(timer);
        },
      });
    this.entryUrl = options.initialUrl;
    this.displayTitle = routeTitle(options.title);
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
  acquireUpdateClose(): Promise<BrowserUpdateAdmission> {
    return this.admission.close();
  }

  acquireUpdateIdle(
    guard?: ChatGptUpdateIdleEffectGuard,
  ): Promise<BrowserUpdateAdmission> {
    return this.admission.idle(guard);
  }

  // The route's half of closing for an update: everything that mutates its own
  // fields. Admission owns the sequence, the confirmation and the reservation.
  private beginUpdateClose(): UpdateClosing {
    const surface = this.routeWindow;
    const popups = [...this.popupWindows];
    this.activity.stop();
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
    return {
      contents,
      settled: () =>
        !(
          (surface && !surface.isDestroyed()) ||
          popups.some((popup) => !popup.isDestroyed())
        ),
      forget: () => {
        this.routeWindow = null;
        this.popupWindows.clear();
        this.readyPopupWindows.clear();
        this.submissionGatedPopupWindows.clear();
      },
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

  navigationHistory(): Readonly<{ back: boolean; forward: boolean }> {
    const current = this.routeWindow;
    if (!current || current.isDestroyed())
      return { back: false, forward: false };
    const history = current.webContents.navigationHistory;
    return {
      back: history?.canGoBack() ?? false,
      forward: history?.canGoForward() ?? false,
    };
  }

  travelHistory(direction: -1 | 1): boolean {
    const current = this.routeWindow;
    if (!current || current.isDestroyed()) return false;
    const history = current.webContents.navigationHistory;
    if (
      !history ||
      !(direction === -1 ? history.canGoBack() : history.canGoForward())
    )
      return false;
    if (direction === -1) history.goBack();
    else history.goForward();
    return true;
  }

  /** Ordinary browser navigation. It preserves Chromium's Back/Forward stack
   * and never submits, retries a task, or edits a retained provider message. */
  async openTemporaryChat(): Promise<ChatGptOpenResult> {
    if (this.taskInFlight || (await this.open()).status !== "opened")
      return { status: "unreachable" };
    const current = this.routeWindow;
    if (!current || current.isDestroyed()) return { status: "unreachable" };
    const url = temporaryChatUrl(this.options.homeUrl);
    try {
      await this.navigateRouteDocument(
        current,
        url,
        monotonicNow() + ROUTE_OPEN_DEADLINE_MS,
      );
      this.options.onNavigationHistoryChanged?.(this.navigationHistory());
      return { status: "opened" };
    } catch {
      return { status: "unreachable" };
    }
  }

  private async navigateRouteDocument(
    current: ChatGptRouteSurface,
    url: string,
    deadline: number,
  ): Promise<void> {
    const beforeDocument = this.chatPhysicalDocumentGeneration;
    let readyDocument: number | null = null;
    // The same ordinary-browser milestone used by initial opening also applies
    // here. Slow subresources must not turn a usable new document into a timeout.
    // An event from the retained document cannot complete this navigation.
    const { ready: ordinaryReady, release } = createOrdinaryReady(
      current.webContents,
      {
        protectedSurface: () =>
          this.options.requireAppForManualMessages === true,
        owned: () => this.ownsRouteContents(current.webContents),
        advanced: () => this.chatPhysicalDocumentGeneration > beforeDocument,
        loadFailed: () => this.routeDocumentLoadFailed,
        awaitingCommit: () => this.routeDocumentAwaitingCommit,
        allowedUrl: () =>
          allowedChatGptPageUrl(
            current.webContents.getURL(),
            this.options.e2eOrigin,
          ),
        onReady: () => {
          readyDocument = this.chatPhysicalDocumentGeneration;
        },
      },
    );
    try {
      const navigation = current.loadURL(url);
      await this.awaitRouteOpenStep(
        current,
        ordinaryReady ? Promise.race([navigation, ordinaryReady]) : navigation,
        deadline,
      );
      if (
        this.routeWindow !== current ||
        current.isDestroyed() ||
        this.routeDocumentLoadFailed ||
        this.routeDocumentAwaitingCommit ||
        (readyDocument !== null &&
          readyDocument !== this.chatPhysicalDocumentGeneration)
      )
        throw new Error("ChatGPT document changed");
    } finally {
      release();
    }
  }

  // A failed navigation leaves a retained surface that open() deliberately
  // refuses. An explicit owner retry may discard only that failed surface;
  // it never repeats a model submission or resets a successful conversation.
  async retryFailedOpen(): Promise<ChatGptOpenResult> {
    const plan = decideRetryFailedOpen({
      updateAdmission: this.updateAdmission,
      taskInFlight: this.taskInFlight,
      signInMode: this.signInMode,
      opening: this.opening !== null,
      failedSurface: this.load === "failed" && Boolean(this.routeWindow),
    });
    if (plan === "refuse") return { status: "unreachable" };
    const joined = this.opening;
    if (plan === "join" && joined) {
      // Join the original cold preload. A navigation request is not a failed
      // page retry, and must not create another surface or repeat its load.
      const opened = await joined;
      if (
        decideRetryAfterJoin(opened.status, {
          updateAdmission: this.updateAdmission,
          taskInFlight: this.taskInFlight,
          signInMode: this.signInMode,
        }) === "refuse"
      )
        return { status: "unreachable" };
      return this.open();
    }
    if (plan === "discard-failed" && this.routeWindow) {
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
    if (
      shouldReportUnopenedSignIn(attempt, this.signInAttempt, result.status)
    ) {
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
    const plan = decideSignInExit(this.signInMode, activeSignInRoute === this);
    if (!plan.exit) return;
    this.signInMode = false;
    if (plan.releaseActive) activeSignInRoute = null;
    this.setTitle(routeTitle(this.options.title));
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
    const returnPlan = decideSignInReturn(this.signInMode, candidate.kind);
    if (returnPlan === "close") {
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
    if (returnPlan === "exit-after-read") {
      const pending = this.pendingSignInObservation;
      void pending.then((read) => {
        if (
          !signInReturnStillCurrent({
            attempt,
            latestAttempt: this.signInAttempt,
            signInMode: this.signInMode,
            sameSurface: this.routeWindow === candidate,
          })
        )
          return;
        this.pendingSignInObservation = null;
        // The shell owns visibility. A bounded return read can settle after
        // explicit navigation has already revealed this retained document again.
        // Retain failed documents too; only an explicit retry may replace one.
        this.exitSignInMode();
        this.reportSignInOutcome(
          signInStatusFromObservation(read.observation?.state),
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
    this.routeDocumentAwaitingCommit = false;
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
      closingTaskRunning = this.activity.running() === true;
      this.activity.stop();
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
      this.activity.stop();
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
              status = signInStatusFromObservation(read.observation?.state);
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
    const { ready: ordinaryReady, release } = createOrdinaryReady(
      candidate.webContents,
      {
        protectedSurface: () =>
          this.options.requireAppForManualMessages === true,
        owned: () => this.ownsRouteContents(candidate.webContents),
        advanced: () => true,
        loadFailed: () => this.routeDocumentLoadFailed,
        awaitingCommit: () => this.routeDocumentAwaitingCommit,
        allowedUrl: () =>
          allowedChatGptPageUrl(
            candidate.webContents.getURL(),
            this.options.e2eOrigin,
          ),
      },
    );
    const openDeadline = monotonicNow() + ROUTE_OPEN_DEADLINE_MS;
    try {
      const navigation = candidate.loadURL(this.entryUrl);
      await this.awaitRouteOpenStep(
        candidate,
        ordinaryReady ? Promise.race([navigation, ordinaryReady]) : navigation,
        openDeadline,
      );
      if (this.routeDocumentLoadFailed || this.routeDocumentAwaitingCommit) {
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
      if (this.routeDocumentLoadFailed || this.routeDocumentAwaitingCommit) {
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
      hideAfterOpenTimeout(
        error,
        candidate,
        this.options.requireAppForManualMessages === true,
      );
      return { status: "unreachable" };
    } finally {
      release();
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

  observe(): Promise<ChatGptPageObservation> {
    return this.readiness.observe();
  }

  // Observe only an existing loaded document; the read lives in chat/observe.
  observeSignInStatus(): Promise<ChatGptSignInStatusObservation> {
    return this.readiness.observeSignInStatus();
  }

  isCurrentSignInStatus(result: ChatGptSignInStatusObservation): boolean {
    return this.readiness.isCurrentSignInStatus(result);
  }

  // This is permission to keep observing a loading ordinary browser, never
  // authentication or permission to retry a failed/protected opener. The load
  // slot stays "failed" until DOM readiness; terminal load errors have a separate flag.
  hasPendingReadinessDocument(): boolean {
    return (
      this.options.requireAppForManualMessages !== true &&
      !this.disposing &&
      !this.taskInFlight &&
      !this.updateAdmission &&
      this.load === "failed" &&
      this.chatPhysicalDocumentGeneration > 0 &&
      !this.routeDocumentLoadFailed &&
      this.routeWindow !== null &&
      !this.routeWindow.isDestroyed()
    );
  }

  /**
   * Diagnostic page snapshot for a sign-in close. Public observe() adds current
   * identity/order checks; a pre-close diagnostic is never Send authority.
   */
  private observeForSignIn(): Promise<SignInRead> {
    return this.readiness.readPage(true);
  }

  private prepareTemporaryInstantProfile(
    candidate: ChatGptRouteSurface,
    temporary = true,
    taskDeadline = monotonicNow() + 180_000,
    operationGeneration = this.taskObservationGeneration,
    originalDocumentCurrent?: () => boolean,
  ): Promise<InstantProfileRefusal | null> {
    const contents = candidate.webContents;
    return createInstantProfilePreparer({
      execute: (script, gesture, deadline) =>
        this.runTaskScript(
          contents,
          script,
          gesture,
          deadline,
          operationGeneration,
        ),
      navigate: (url, deadline) =>
        this.navigateRouteDocument(
          candidate,
          url,
          Math.min(deadline, monotonicNow() + ROUTE_OPEN_DEADLINE_MS),
        ),
      snapshot: () => ({
        surfaceCurrent:
          this.routeWindow === candidate && !candidate.isDestroyed(),
        disposing: this.disposing,
        documentLoadFailed: this.routeDocumentLoadFailed,
        documentAwaitingCommit: this.routeDocumentAwaitingCommit,
        documentGeneration: this.routeDocumentGeneration,
        physicalDocumentGeneration: this.chatPhysicalDocumentGeneration,
        operationGeneration: this.taskObservationGeneration,
        // Read only when asked: a destroyed window or frame may throw.
        url: () => contents.getURL(),
        frame: () => {
          const frame = contents.mainFrame;
          return frame
            ? {
                identity: frame,
                isDestroyed: () => frame.isDestroyed(),
                url: () => frame.url,
              }
            : null;
        },
      }),
      now: monotonicNow,
      delay: (ms) => delay(ms),
      report: this.options.onProfilePreparationDiagnostic,
    })({
      homeUrl: this.options.homeUrl,
      temporary,
      taskDeadline,
      originalDocumentCurrent,
    });
  }

  async runReadonlyTask(
    prompt: string,
    attachments: readonly StagedChatGptAttachment[],
    observer: ChatGptTaskObserver & {
      manualDeepTest: true;
      manualSubmissionOnly: true;
    },
    profile: "ordinary",
    appTarget: Readonly<{ name: string }>,
  ): Promise<ChatGptReadonlyTaskResult | ChatGptSubmissionResult>;
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
  ): Promise<ChatGptConnectorCheckResult | ChatGptSubmissionResult> {
    // Capture this operation's explicit target before any navigation. Never
    // mutate the route's default/manual-message binding for a one-shot check.
    const requiredAppName = appTarget?.name ?? this.options.requiredAppName;
    const callRefusal = taskCallRefusal({
      profile,
      hasAppTarget: Boolean(appTarget),
      attachmentCount: attachments.length,
      connectionCheck: Boolean(observer.connectionCheck),
      manualDeepTest: Boolean(observer.manualDeepTest),
      manualSubmissionOnly: Boolean(observer.manualSubmissionOnly),
      hasConnectorReceipt: Boolean(observer.readConnectorReceipt),
    });
    if (callRefusal !== null) {
      return {
        state: "failed_before_submit",
        code: callRefusal,
        deltaCount: 0,
        observedCharacters: 0,
      };
    }
    if (
      requiredAppName !== undefined &&
      !isValidAppTargetName(requiredAppName)
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
    const inProgressRefusal = taskInProgressRefusal({
      updateAdmission: Boolean(this.updateAdmission),
      taskInFlight: this.taskInFlight,
    });
    if (inProgressRefusal !== null) {
      return {
        state: "failed_before_submit",
        code: inProgressRefusal,
        deltaCount: 0,
        observedCharacters: 0,
        outputText: "",
      };
    }
    this.exitSignInMode();
    this.taskInFlight = true;
    const timingStart = performance.now();
    const timing = (
      stage:
        | "started"
        | "profile_ready"
        | "send_requested"
        | "send_acknowledged"
        | "receipt_confirmed"
        | "finished",
    ) => {
      if (
        !appTarget ||
        !observer.readConnectorReceipt ||
        !observer.onConnectorTiming
      )
        return;
      const elapsedMs = connectorTimingElapsed(timingStart, performance.now());
      if (elapsedMs === null) return;
      try {
        observer.onConnectorTiming({ stage, elapsedMs });
      } catch {
        /* Diagnostics cannot affect the original check. */
      }
    };
    timing("started");
    const observationGeneration = ++this.taskObservationGeneration;
    const deadline = taskDeadline(
      monotonicNow(),
      Boolean(observer.manualSubmissionOnly),
      this.options.taskTimeoutMs,
    );
    const requireOriginalDocument = () => {
      if (observer.connectionCheck && observer.beforePrepare?.() !== true)
        throw new Error("ChatGPT preparation document changed");
    };
    let preparing = true;
    const execute = (
      contents: WebContents,
      script: string,
      gesture: boolean,
      allowNavigationAfter: boolean | "response" = false,
    ) => {
      if (preparing) requireOriginalDocument();
      return this.runTaskScript(
        contents,
        script,
        gesture,
        deadline,
        observationGeneration,
        allowNavigationAfter,
      );
    };
    const observeTaskReadiness = async () => {
      if (monotonicNow() >= deadline)
        throw new Error("ChatGPT task deadline exceeded");
      return raceDeadline(this.observe(), deadline, monotonicClock, () => {
        this.readiness.invalidate();
        throw new Error("ChatGPT task deadline exceeded");
      });
    };
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
      requireOriginalDocument();
      const opened = await this.open();
      requireOriginalDocument();
      if (opened.status !== "opened") {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_PAGE_UNREACHABLE",
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      const readiness = await observeTaskReadiness();
      requireOriginalDocument();
      const readinessFailure = initialReadinessRefusal(readiness);
      if (readinessFailure !== null) {
        return {
          ...readinessFailure,
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
        const running = await execute(
          candidate.webContents,
          activityProbe,
          true,
        )
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
          deadline,
          observationGeneration,
          observer.connectionCheck ? observer.beforePrepare : undefined,
        );
        requireOriginalDocument();
        if (profileFailure !== null) {
          return {
            state: "failed_before_submit",
            code: instantProfileFailureCode(profile, profileFailure),
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
      }
      timing("profile_ready");
      if (profile === "temporary-instant" || profile === "connector-instant") {
        // Profile preparation may navigate. Its composer/model probes are not
        // authentication evidence for the new document's dispatch.
        const currentReadiness = await observeTaskReadiness();
        requireOriginalDocument();
        if (currentReadiness.state !== "authenticated") {
          return {
            ...readinessRefusal(currentReadiness.state),
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
        const latest = this.readiness.latest();
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
          current.sequence === this.readiness.sequence()
        )
          return null;
        return {
          ...readinessRefusal(current?.observation.state),
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      };
      let activityCandidate: unknown;
      try {
        activityCandidate = await execute(
          candidate.webContents,
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
      this.activity.record(activity.data.running);
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
          appBindingCandidate = await execute(
            candidate.webContents,
            bindChatGptAppScript(
              requiredAppName,
              dispatchIdentityUrl,
              observer.manualDeepTest === true,
            ),
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
        const bindingRefusal = appBindingRefusal(appBinding.data);
        if (bindingRefusal !== null) {
          return {
            state: "failed_before_submit",
            code: bindingRefusal,
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
        await execute(
          candidate.webContents,
          prepareTaskScript(
            prompt,
            dispatchIdentityUrl,
            requiredAppName,
            // The page has no access to this clock. It checks the instant
            // it runs, a moment after this reading, against the time left.
            Date.now() + remainingMs(deadline, monotonicNow()),
            observer.manualDeepTest === true ||
              observer.connectionCheck === true,
            observer.connectionCheck === true,
          ),
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
      const preparedDecision = preparedTaskDecision(prepared.data, {
        requiresComposerText: Boolean(
          observer.manualDeepTest || observer.connectionCheck,
        ),
      });
      if (preparedDecision.kind === "refused") {
        return {
          state: "failed_before_submit",
          code: preparedDecision.code,
          deltaCount,
          observedCharacters,
          outputText: observedText,
        };
      }
      if (preparedDecision.kind === "unavailable") {
        return {
          state: "failed_before_submit",
          code: "CHATGPT_COMPOSER_UNAVAILABLE",
          deltaCount,
          observedCharacters,
        };
      }
      const preparedTask = preparedDecision.task;
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
      const submitDeadline = monotonicNow() + SUBMIT_WINDOW_MS;
      let connectionActivationAttempted = false;
      while (monotonicNow() < submitDeadline) {
        if (observer.connectionCheck && connectionActivationAttempted) break;
        connectionActivationAttempted = true;
        // The dispatch-intent record is written first (it is a disk write,
        // and anything may happen to the page while it lands), so that the
        // identity check is the last thing before the click script leaves
        // this process: nothing awaits between the check and the dispatch.
        // The script then compares the page's own location once more,
        // in-page, before it clicks.
        requireOriginalDocument();
        preparing = false;
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
            await execute(
              candidate.webContents,
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
          const verificationRefusal = appVerificationRefusal(selected.data);
          if (verificationRefusal !== null) {
            return {
              state: "failed_before_submit",
              code: verificationRefusal,
              deltaCount,
              observedCharacters,
              outputText: observedText,
            };
          }
        }
        // App verification above awaits the browser. Recheck cancellation and
        // identity after that final await, immediately before dispatching Send.
        timing("send_requested");
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
        if (observer.beforeSend && !observer.beforeSend()) {
          return {
            state: "failed_before_submit",
            code: "CHATGPT_SUBMIT_UNAVAILABLE",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        submissionPhase = "awaiting_acknowledgement";
        const activated = activatedTaskSchema.safeParse(
          await raceDeadline<unknown, null>(
            execute(
              candidate.webContents,
              activateTaskScript(
                dispatchIdentityUrl,
                requiredAppName,
                profile === "temporary-instant",
                profile === "connector-instant",
                observer.manualDeepTest || observer.connectionCheck
                  ? preparedTask.preparedComposerText
                  : undefined,
                observer.connectionCheck === true,
              ),
              true,
              true,
            ),
            submitDeadline,
            monotonicClock,
            () => null,
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
        const activation = activationDecision(activated.data);
        if (activation.kind === "refused") {
          submissionPhase = "not_attempted";
          return {
            state: "failed_before_submit",
            code: activation.code,
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        if (activation.kind === "activated") {
          submissionPhase = "submitted";
          timing("send_acknowledged");
          await observer.onSendAcknowledged?.();
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

      if (observer.manualSubmissionOnly) {
        return {
          state: "send_requested",
          code: null,
          deltaCount: 0,
          observedCharacters: 0,
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
      const pollMs = this.options.taskPollMs ?? DEFAULT_TASK_POLL_MS;
      const probePending = Symbol("probe pending");
      let connectorProbe: Promise<BoundedProbe<unknown>> | null = null;
      while (monotonicNow() < deadline) {
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
        const pinning = pinnedConversationAfter(
          pinnedConversationUrl,
          conversationUrl,
        );
        if (pinning.lost) {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_PAGE_LOST",
            deltaCount,
            observedCharacters,
            outputText: observedText,
            ...correlation(),
          };
        }
        pinnedConversationUrl = pinning.pinned;
        if (
          (profile === "temporary-instant" ||
            profile === "connector-instant") &&
          appTarget !== undefined &&
          observer.readConnectorReceipt
        ) {
          let invalidation: ReturnType<typeof setInterval> | undefined;
          const receipt = await Promise.race([
            raceDeadline(
              observer.readConnectorReceipt(),
              deadline,
              monotonicClock,
              () => null,
            ),
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
            if (invalidation !== undefined) clearInterval(invalidation);
          });
          if (receipt === null || monotonicNow() >= deadline) break;
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
          const createdByReceipt = conversationCreatedBySubmission(
            pinnedConversationUrl,
            createdConversation,
            allowedChatGptPageUrl(afterReceiptUrl, this.options.e2eOrigin),
          );
          if (
            pageLostAcrossAwait(currentUrl, afterReceiptUrl, createdByReceipt)
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
          if (createdByReceipt) pinnedConversationUrl = createdConversation;
          currentUrl = afterReceiptUrl;
          if (receipt === true) {
            timing("receipt_confirmed");
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
        // A probe that stalls, or fails at or after the observation deadline,
        // is a timeout whatever the page script did: the submission's outcome
        // stays unknown and Send is never replayed. A failure before the
        // deadline keeps its own classification.
        const readProbe = () =>
          boundedProbe(
            monotonicClock,
            () =>
              execute(
                active.webContents,
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
                "response",
              ),
            deadline,
          );
        let probed: BoundedProbe<unknown>;
        if (appTarget !== undefined && observer.readConnectorReceipt) {
          // A stuck, read-only page probe must not hide a subsequently arrived
          // connector receipt. Keep only one outstanding probe and never retry
          // the effectful Send.
          connectorProbe ??= readProbe();
          let cancelPollWait: (() => void) | undefined;
          const raced = await Promise.race([
            connectorProbe,
            new Promise<typeof probePending>((resolve) => {
              cancelPollWait = atDeadline(
                Math.min(deadline, monotonicNow() + pollMs),
                monotonicClock,
                () => resolve(probePending),
              );
            }),
          ]).finally(() => {
            cancelPollWait?.();
          });
          if (raced === probePending) continue;
          connectorProbe = null;
          probed = raced;
        } else {
          probed = await readProbe();
        }
        // The loop's closing return reports the timeout as unknown.
        if (probed.status === "timeout") break;
        const probe = taskProbeSchema.safeParse(probed.value);
        const afterProbeUrl = active.webContents.getURL();
        const createdConversation = canonicalChatGptConversationUrl(
          afterProbeUrl,
          this.options.e2eOrigin,
        );
        const createdBySubmission = conversationCreatedBySubmission(
          pinnedConversationUrl,
          createdConversation,
          allowedChatGptPageUrl(afterProbeUrl, this.options.e2eOrigin),
        );
        if (
          pageLostAcrossAwait(currentUrl, afterProbeUrl, createdBySubmission)
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
        const probeFailure = submittedProbeFailureCode(probe.data);
        if (probeFailure !== null) {
          return {
            state: "outcome_unknown",
            code: probeFailure,
            deltaCount,
            observedCharacters,
            outputText: observedText,
            ...correlation(),
          };
        }
        const userStep = userCorrelation(
          probe.data.turnUserId,
          correlatedUserId,
        );
        if (userStep.kind === "adopt") {
          correlatedUserId = userStep.id;
          await observer.onCorrelation?.({
            turnUserId: correlatedUserId,
            turnAssistantId: correlatedAssistantId,
          });
        } else if (userStep.kind === "changed") {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_OUTPUT_CHANGED",
            deltaCount,
            observedCharacters,
            outputText: observedText,
            ...correlation(),
          };
        }
        const assistantStep = assistantCorrelation(
          probe.data.turnUserId,
          probe.data.turnAssistantId,
          correlatedUserId,
          correlatedAssistantId,
        );
        if (assistantStep.kind === "adopt") {
          correlatedAssistantId = assistantStep.id;
          await observer.onCorrelation?.({
            turnUserId: assistantStep.userId,
            turnAssistantId: correlatedAssistantId,
          });
        } else if (assistantStep.kind === "changed") {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_OUTPUT_CHANGED",
            deltaCount,
            observedCharacters,
            outputText: observedText,
            ...correlation(),
          };
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
              observedText = appendAnswerItem(observedText, item.text);
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
          await this.pollDelay(pollMs);
          continue;
        }
        const growth = correlated
          ? textGrowth(observedText, probe.data.assistantText)
          : "unchanged";
        if (growth === "regressed") {
          stablePolls = 0;
          await this.pollDelay(pollMs);
          continue;
        }
        if (growth === "diverged") {
          return {
            state: "outcome_unknown",
            code: "CHATGPT_TASK_OUTPUT_CHANGED",
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        if (growth === "grew") {
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
        }
        stablePolls = nextStablePolls({
          grew: growth === "grew",
          correlated,
          observedCharacters,
          busy: probe.data.busy,
          sendVisible: probe.data.sendVisible,
          stablePolls,
        });
        if (
          textTurnCompleted({
            accepted,
            correlated,
            observedCharacters,
            sendVisible: probe.data.sendVisible,
            stablePolls,
          })
        ) {
          return {
            state: "completed",
            code: null,
            deltaCount,
            observedCharacters,
            outputText: observedText,
          };
        }
        await this.pollDelay(pollMs);
      }
      return {
        state: "outcome_unknown",
        code: "CHATGPT_TASK_TIMEOUT",
        deltaCount,
        observedCharacters,
        outputText: observedText,
        ...correlation(),
      };
    } catch (error) {
      const outcome = taskThrowOutcome({
        phase: submissionPhase,
        documentChanged: isTaskDocumentUnavailable(error),
      });
      return {
        ...outcome,
        deltaCount,
        observedCharacters,
        outputText: observedText,
        ...correlation(),
      };
    } finally {
      timing("finished");
      this.taskInFlight = false;
    }
  }

  private pollDelay(ms: number): Promise<void> {
    return (this.options.taskPollDelay ?? delay)(ms);
  }

  async observeReadonlyTask(
    input: Readonly<{
      prompt: string;
      turnUserId: string;
      turnAssistantId: string | null;
    }>,
    observer: ChatGptTaskObserver = {},
  ): Promise<ChatGptReadonlyTaskResult> {
    const admissionRefusal = observationAdmissionRefusal({
      updateAdmission: Boolean(this.updateAdmission),
      taskInFlight: this.taskInFlight,
      turnUserId: input.turnUserId,
      prompt: input.prompt,
    });
    if (admissionRefusal !== null) {
      return {
        state: "outcome_unknown",
        code: admissionRefusal,
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
        return result(observedReadinessCode(readiness.state));
      }
      const candidate = this.routeWindow;
      if (!candidate || candidate.isDestroyed()) {
        return result("CHATGPT_TASK_PAGE_LOST");
      }
      const observationUrl = candidate.webContents.getURL();
      let stablePolls = 0;
      const pollMs = this.options.taskPollMs ?? DEFAULT_TASK_POLL_MS;
      const deadline = taskDeadline(
        monotonicNow(),
        false,
        this.options.taskTimeoutMs,
      );
      while (monotonicNow() < deadline) {
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
        // Each probe gets only the time left to the task deadline; a probe
        // that stalls or answers after it ends the observation unknown.
        const probeScript = taskProbeScript(
          input.prompt,
          [],
          {
            semantic: semanticOutput,
            userId: input.turnUserId,
            assistantId: correlatedAssistantId,
          },
          this.options.requiredAppName,
        );
        const answered = await boundedProbe(
          monotonicClock,
          () => active.webContents.executeJavaScript(probeScript, true),
          deadline,
        );
        if (answered.status === "timeout")
          return result("CHATGPT_TASK_TIMEOUT");
        const probe = taskProbeSchema.safeParse(answered.value);
        if (active.webContents.getURL() !== currentUrl)
          return result("CHATGPT_TASK_PAGE_LOST");
        if (!probe.success) return result("CHATGPT_TASK_ERROR");
        const probeFailure = observedProbeFailureCode(probe.data);
        if (probeFailure !== null) return result(probeFailure);
        const turn = observedTurnDecision(
          probe.data.turnUserId,
          probe.data.turnAssistantId,
          input.turnUserId,
          correlatedAssistantId,
        );
        if (turn.kind === "wait") {
          stablePolls = 0;
          await this.pollDelay(pollMs);
          continue;
        }
        if (turn.kind === "changed") {
          return result("CHATGPT_TASK_OUTPUT_CHANGED");
        }
        correlatedAssistantId = turn.assistantId;
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
              observedText = appendAnswerItem(observedText, item.text);
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
          await this.pollDelay(pollMs);
          continue;
        }
        const growth = textGrowth(observedText, probe.data.assistantText);
        if (growth === "regressed" || growth === "diverged") {
          return result("CHATGPT_TASK_OUTPUT_CHANGED");
        }
        if (growth === "grew") {
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
        }
        stablePolls = nextStablePolls({
          grew: growth === "grew",
          correlated: true,
          observedCharacters,
          busy: probe.data.busy,
          sendVisible: probe.data.sendVisible,
          stablePolls,
        });
        if (
          textTurnCompleted({
            accepted: true,
            correlated: true,
            observedCharacters,
            sendVisible: probe.data.sendVisible,
            stablePolls,
          })
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
        await this.pollDelay(pollMs);
      }
      return result("CHATGPT_TASK_TIMEOUT");
    } catch {
      return result("CHATGPT_TASK_ERROR");
    } finally {
      this.taskInFlight = false;
    }
  }

  currentConversationUrl(): string | null {
    return this.conversationUrls.current();
  }

  retainedConversationUrl(): string | null {
    return this.conversationUrls.retained();
  }

  cancelActiveTask(): Promise<"cancelled" | "not_running" | "outcome_unknown"> {
    return this.cancelTask();
  }

  setTitle(title: string): void {
    applyRouteTitle(title, {
      remember: (next) => {
        this.displayTitle = next;
      },
      surface: () => this.routeWindow,
    });
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
    this.resetRoute();
  }

  /** No draft copying, fallback chat or guessed layout. Observe the original
   * twice and recheck its physical owner immediately before one navigation. */
  openConnectionCheckChat(
    appName: string,
    current: () => boolean,
  ): Promise<ChatGptOpenResult> {
    return this.connectionCheckOpener(appName, current);
  }

  // The host hashes this content-free physical reference; no draft or URL is
  // persisted in the Go attempt. The original closure remains the final fence.
  captureConnectionCheckDocument(): ConnectionCheckDocument | null {
    return this.manualTargets.captureDocument();
  }

  // Pin the exact existing manual document before an asynchronous UI transition.
  captureManualTaskTarget(): (() => boolean) | null {
    return this.manualTargets.captureTarget();
  }

  // Physical generations only. No queue, turn state, journal or retry decision.
  private savedChatPhysicalView: ChatGptRouteSurface | null = null;
  private savedChatViewGeneration = 0;

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

  // The guarded follow-up; its dispatch fuse and in-flight flag live in it.
  private readonly savedChatFollowUpRun = createSavedChatFollowUp({
    qualified: () => this.options.publicOutputProfile === "message-anchors-v1",
    requiredAppName: () => this.options.requiredAppName,
    binding: () => this.savedChatFollowUpBinding(),
    acquire: () => {
      const surface = this.routeWindow;
      return {
        execute: (script, gesture) => {
          if (!surface) throw new Error("Saved chat surface unavailable");
          return surface.webContents.executeJavaScript(script, gesture);
        },
        isCurrent: () => this.routeWindow === surface,
      };
    },
  });

  /** Internal adapter seam, never a wire grant; see `chat/saved`. */
  savedChatFollowUp(
    candidate: unknown,
    action: "prepare" | "submit" | "observe",
    stillBound: (binding: SavedChatPhysicalBinding) => boolean,
  ): Promise<SavedChatFollowUpResult> {
    return this.savedChatFollowUpRun(candidate, action, stillBound);
  }

  /** Restricted saved-chat probes on this route's own isolated page only. */
  async savedChatReady(homeUrl: string): Promise<unknown> {
    return this.savedChatScript(
      savedChatReadinessScript(homeUrl),
      homeUrl,
      false,
      READINESS_OBSERVATION_MS,
    );
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
    // What the caller has left of its own window. A proof that finishes inside
    // it is never cut short; the default is the saved-chat send window.
    budgetMs: number = SAVED_CHAT_WINDOW_MS,
  ): Promise<unknown> {
    return this.savedChatScript(
      savedChatProofScript(
        conversationUrl,
        firstMessageDigest,
        titleDigest,
        requireHistory,
      ),
      conversationUrl,
      false,
      budgetMs,
    );
  }

  savedChatLoad(conversationUrl: string): Promise<boolean> {
    return this.savedChatProbes.load(conversationUrl);
  }

  currentSavedChatUrl(): string | null {
    const candidate = this.routeWindow;
    if (!candidate || candidate.isDestroyed()) return null;
    return canonicalChatGptConversationUrl(
      candidate.webContents.getURL(),
      this.options.e2eOrigin,
    );
  }

  private readonly savedChatProbes = createSavedChatProbes({
    snapshot: () => {
      const surface = this.routeWindow;
      if (!surface) return null;
      return {
        surface,
        destroyed: surface.isDestroyed(),
        loaded: this.load === "loaded",
        // Read only when asked: a destroyed window may throw.
        url: () => surface.webContents.getURL(),
        documentGeneration: this.routeDocumentGeneration,
        execute: (script, gesture) =>
          surface.webContents.executeJavaScript(script, gesture),
        load: (url) => surface.loadURL(url),
      };
    },
    canonicalConversationUrl: (url) =>
      canonicalChatGptConversationUrl(url, this.options.e2eOrigin),
    clock: monotonicClock,
  });

  private savedChatScript(
    script: string,
    expectedUrl: string,
    allowNavigation = false,
    budgetMs?: number,
  ): Promise<unknown> {
    return this.savedChatProbes.run(
      script,
      expectedUrl,
      allowNavigation,
      budgetMs,
    );
  }

  dispose(): void {
    this.disposing = true;
    this.activity.stop();
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
    hardenRouteSession(routeSession, {
      permissions: routePermissions,
      hardened: hardenedRouteSessions,
      askForMicrophoneAccess: () =>
        systemPreferences.askForMediaAccess("microphone"),
      microphoneAccessStatus: () =>
        systemPreferences.getMediaAccessStatus("microphone"),
      permissionDenied: (permission) =>
        activeSignInRoute?.reportSignInBlocked({
          kind: "permission-denied",
          permission,
        }),
    });
  }

  private captureConversationUrl(contents: WebContents): string | null {
    return this.conversationUrls.capture(contents);
  }

  private ownsRouteContents(contents: WebContents): boolean {
    return routeOwnsContents(this.disposing, this.routeWindow, contents);
  }

  private hardenContents(
    contents: WebContents,
    tracksRouteReadiness: boolean,
  ): void {
    const allowed = (url: string) =>
      allowedChatGptPageUrl(url, this.options.e2eOrigin);
    hardenRouteContents(contents, {
      allowedUrl: allowed,
      blocked: (diagnostic) => this.reportSignInBlocked(diagnostic),
      tracking: tracksRouteReadiness
        ? {
            owns: (candidate) => this.ownsRouteContents(candidate),
            publishHistory: () =>
              this.options.onNavigationHistoryChanged?.(
                this.navigationHistory(),
              ),
            homeUrl: () => this.options.homeUrl,
            documentGeneration: () => this.routeDocumentGeneration,
            owners: routePermissionOwners,
            trackReadiness: () => this.trackRouteReadiness(contents, allowed),
          }
        : null,
      popups: {
        presentation: () => this.options.windowPresentation,
        requiredAppName: () => this.options.requiredAppName,
        title: () => this.displayTitle,
        webPreferences: () => this.remoteWebPreferences(),
        adopt: (popup) => this.adoptPopupWindow(popup),
      },
    });
  }

  private trackRouteReadiness(
    contents: WebContents,
    allowed: (url: string) => boolean,
  ): void {
    trackRouteReadiness(contents, {
      allowed,
      owns: () => this.ownsRouteContents(contents),
      state: {
        load: () => this.load,
        setLoad: (load) => {
          this.load = load;
        },
        loadFailed: () => this.routeDocumentLoadFailed,
        setLoadFailed: (failed) => {
          this.routeDocumentLoadFailed = failed;
        },
        awaitingCommit: () => this.routeDocumentAwaitingCommit,
        setAwaitingCommit: (awaiting) => {
          this.routeDocumentAwaitingCommit = awaiting;
        },
        advanceDocument: () => {
          this.routeDocumentGeneration += 1;
        },
        advancePhysicalDocument: () => {
          this.chatPhysicalDocumentGeneration += 1;
        },
      },
      surface: {
        hide: () => this.routeWindow?.hide(),
        reveal: () => this.routeWindow?.reveal(),
        isWindow: () => this.routeWindow?.kind === "window",
      },
      options: {
        requireApp: () => this.options.requireAppForManualMessages === true,
        collapseSidebar: () => Boolean(this.options.collapseSidebarByDefault),
        homeUrl: () => this.options.homeUrl,
        signInMode: () => this.signInMode,
        title: () => this.displayTitle,
        observesTaskActivity: () => Boolean(this.options.onTaskActivityChanged),
      },
      events: {
        loadState: (state) => this.options.onLoadStateChanged?.(state),
        conversationUrl: () => this.reportConversationUrl(contents),
        blocked: (diagnostic) => this.reportSignInBlocked(diagnostic),
        signInReturn: () => this.requestSignInReturn(),
        taskOutcomeUnknown: () =>
          this.options.onTaskActivityChanged?.("outcome_unknown"),
      },
      gate: {
        install: () => this.installCurrentRouteAppSubmissionGate(contents),
        blockUnsafe: () => this.blockUnsafeManualSurface(contents),
      },
      activity: {
        start: () => this.activity.start(contents),
        running: () => this.activity.running(),
        stop: () => this.activity.stop(),
      },
    });
  }

  private adoptPopupWindow(popup: BrowserWindow): void {
    adoptPopupWindow(popup, {
      books: {
        add: (candidate) => {
          this.popupWindows.add(candidate);
        },
        resetGeneration: (candidate) => {
          this.popupDocumentGenerations.set(candidate, 0);
        },
        release: (candidate) => {
          this.popupWindows.delete(candidate);
          this.readyPopupWindows.delete(candidate);
          this.submissionGatedPopupWindows.delete(candidate);
        },
        markReady: (candidate) => {
          this.readyPopupWindows.add(candidate);
        },
        advanceGeneration: (candidate) => {
          this.popupDocumentGenerations.set(
            candidate,
            (this.popupDocumentGenerations.get(candidate) ?? 0) + 1,
          );
        },
        ungate: (candidate) => {
          this.submissionGatedPopupWindows.delete(candidate);
        },
        gate: (candidate) => {
          this.submissionGatedPopupWindows.add(candidate);
        },
      },
      harden: (candidate) => this.hardenContents(candidate.webContents, false),
      hiddenFirst: () =>
        this.options.windowPresentation !== undefined ||
        this.options.requiredAppName !== undefined,
      requireApp: () => this.options.requireAppForManualMessages === true,
      reconcile: (candidate) => this.reconcilePopupWindow(candidate),
      installGate: (candidate) =>
        this.installCurrentPopupAppSubmissionGate(candidate),
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
    this.conversationUrls.report(contents);
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
    this.activity.stop();
    const candidate = this.routeWindow;
    if (candidate && !candidate.isDestroyed()) candidate.destroy();
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
