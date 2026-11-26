import {
  allowedChatGptPageUrl,
  canonicalChatGptConversationUrl,
} from "../../../src/apps/desktop/chatgpt-page-policy";
import {
  cancelBindScript,
  cancelBindingPath,
  cancelConfirmationProbe,
  cancelTaskScript,
  connectionCheckDocumentProbe,
} from "../../../src/apps/desktop/chatgpt/scripts";
import {
  cancelActivationSchema,
  cancelBoundSchema,
  cancelConfirmationSchema,
} from "./probe";
import { temporaryChatUrl } from "./open";

// What the ChatGPT route says about the conversation it holds: which address
// it reports and retains, how a running task is cancelled, what the window is
// titled, how the route is reset, and how a connection check pins the exact
// document it observed. The route keeps the window, the load slot, the entry
// address, the title and the document generation, and writes every one of
// them; here they are read through a port at the point the original code read
// them, and written only through a setter port. A cancellation that cannot
// prove its outcome stays outcome-unknown, and nothing here retries it.

// Ownership and the address ------------------------------------------------

export type ConversationContents = Readonly<{
  getURL: () => string;
  isDestroyed: () => boolean;
}>;

export type ConversationSurface<Contents> = Readonly<{
  webContents: Contents;
  isDestroyed: () => boolean;
}>;

/**
 * The route still holds these contents as its own live window: not closing,
 * not replaced, not destroyed.
 */
export function routeOwnsContents<Contents>(
  disposing: boolean,
  surface: ConversationSurface<Contents> | null,
  contents: Contents,
): boolean {
  return (
    !disposing &&
    surface !== null &&
    !surface.isDestroyed() &&
    surface.webContents === contents
  );
}

export type ConversationUrlPorts<Contents> = Readonly<{
  surface: () => ConversationSurface<Contents> | null;
  disposing: () => boolean;
  loaded: () => boolean;
  entryUrl: () => string;
  // The route's own write: the conversation the route will reopen.
  setEntryUrl: (url: string) => void;
  e2eOrigin: () => string | null;
  homeUrl: string;
  // The owner's conversation listener, if the route was given one.
  changed: () => ((conversationUrl: string | null) => void) | undefined;
}>;

export type ConversationUrls<Contents> = Readonly<{
  // The canonical address of the contents; remembered when the route owns them.
  capture: (contents: Contents) => string | null;
  // Tells the owner which conversation the route is now on.
  report: (contents: Contents) => void;
  // The address of the loaded window, or null.
  current: () => string | null;
  // The address the route would reopen.
  retained: () => string | null;
}>;

export function createConversationUrls<Contents extends ConversationContents>(
  ports: ConversationUrlPorts<Contents>,
): ConversationUrls<Contents> {
  const capture = (contents: Contents): string | null => {
    if (contents.isDestroyed()) return null;
    const canonical = canonicalChatGptConversationUrl(
      contents.getURL(),
      ports.e2eOrigin(),
    );
    if (
      canonical !== null &&
      !ports.disposing() &&
      ports.surface()?.webContents === contents
    ) {
      ports.setEntryUrl(canonical);
    }
    return canonical;
  };
  return {
    capture,
    report: (contents) => {
      const changed = ports.changed();
      if (
        !changed ||
        !routeOwnsContents(ports.disposing(), ports.surface(), contents)
      ) {
        return;
      }
      const canonical = capture(contents);
      if (canonical !== null) {
        changed(canonical);
        return;
      }
      try {
        const current = new URL(contents.getURL());
        const home = new URL(ports.homeUrl);
        const currentPath = current.pathname.replace(/\/$/u, "") || "/";
        const homePath = home.pathname.replace(/\/$/u, "") || "/";
        if (current.origin === home.origin && currentPath === homePath) {
          ports.setEntryUrl(ports.homeUrl);
          changed(null);
        }
      } catch {
        // Navigation policy owns malformed or unsupported URLs. They never
        // alter a retained conversation binding.
      }
    },
    current: () => {
      const candidate = ports.surface();
      if (!candidate || candidate.isDestroyed() || !ports.loaded()) {
        return null;
      }
      return capture(candidate.webContents);
    },
    retained: () =>
      canonicalChatGptConversationUrl(ports.entryUrl(), ports.e2eOrigin()),
  };
}

// Cancelling a task --------------------------------------------------------

// `page_changed`: the page shown is not the one this Cancel is bound to, and
// nothing was clicked, superseded or recorded.
export type TaskCancelOutcome =
  "cancelled" | "not_running" | "outcome_unknown" | "page_changed";

export type TaskCancelContents = Readonly<{
  executeJavaScript: (script: string, gesture?: boolean) => Promise<unknown>;
}>;

export type TaskCancelSurface<Contents extends TaskCancelContents> = Readonly<{
  webContents: Contents;
  isDestroyed: () => boolean;
}>;

// The identity a Route B turn in flight relies on for its own answer: the
// address it was sent from, and the conversation it pinned once the page showed
// the one it created.
export type TaskCancelTurn = Readonly<{
  dispatchIdentityUrl: string;
  pinnedConversationUrl: string | null;
}>;

export type TaskCancelPorts<
  Contents extends TaskCancelContents,
  Surface extends TaskCancelSurface<Contents>,
> = Readonly<{
  surface: () => Surface | null;
  loaded: () => boolean;
  // The route's own write: any observation under way is no longer current.
  supersedeObservation: () => void;
  // The activity watch last saw the task running.
  observedRunning: () => boolean;
  // Farol submitted this task's turns: it was admitted as a Codex host thread.
  // A restored task and a Browser task the owner typed into are not.
  admittedAsRouteB: () => boolean;
  // The turn Farol itself has in flight on this route, if any.
  turn: () => TaskCancelTurn | null;
  // The wall clock the page shares: click scripts carry an absolute expiry.
  now: () => number;
  // A fresh, unpredictable token, for the document and for each click.
  newToken: () => string;
  // Arms one timer and returns what cancels it.
  after: (callback: () => void, ms: number) => () => void;
  delay: (ms: number) => Promise<void>;
  // The route's own write: the task is observed stopped on these contents.
  recordStopped: (contents: Contents) => void;
}>;

// The stop control gets this many clicks, this far apart, for a task that was
// seen running; a task never seen running gets one.
const STOP_ACTIVATION_ATTEMPTS = 5;
const STOP_ACTIVATION_GAP_MS = 100;
// After the stop, the page is asked this many times, this far apart.
const STOP_CONFIRMATION_POLLS = 20;
const STOP_CONFIRMATION_GAP_MS = 100;
// Every call into the page may take this long. A call that stalls past it is
// outcome-unknown, so a stuck renderer cannot hold the route's task gate.
export const STOP_PAGE_CALL_DEADLINE_MS = 5_000;
// A click script stops being valid this long after it was issued, strictly
// before the deadline above, so a script that was queued behind a stalled
// call and runs after the canceller gave up refuses to click.
export const STOP_SCRIPT_EXPIRY_MS = 4_000;
const PAGE_CALL_TIMED_OUT = Symbol("page-call-timed-out");

/**
 * Activates the page's own stop control and then waits for the page to say the
 * task stopped. An unreadable answer, a lost page or a control that never
 * activated for a running task is `outcome_unknown`, never `cancelled`.
 *
 * A Cancel is bound to one document, and its binding key is the page's whole
 * main-frame path. A turn Farol itself has in flight on a Codex host thread
 * (Route B) binds the path of the conversation the turn pinned, otherwise the
 * address it was sent from: the identity the turn relies on for its own
 * answer, so the Cancel is never weaker than the turn. Every other task (an
 * owner Browser task, a restored task, a turn the owner typed) binds the page
 * shown when the Cancel starts. One script reads that path and stamps the
 * window together; every click and every confirmation then requires both in
 * the page, so a page that moved (the path) or was replaced (the stamp) is
 * never clicked and never answers for the task. Each click is a script of its
 * own with a token it spends first and an expiry before the page-call
 * deadline.
 *
 * A page that moved before any click is `page_changed`: nothing was clicked,
 * and the observation is not superseded. After a click may have happened, a
 * moved page is `outcome_unknown`. A call that stalls past its deadline is
 * `outcome_unknown` too. Cancel is single-flight: a second call while one runs
 * is that one's result.
 */
export function createTaskCanceller<
  Contents extends TaskCancelContents,
  Surface extends TaskCancelSurface<Contents>,
>(ports: TaskCancelPorts<Contents, Surface>): () => Promise<TaskCancelOutcome> {
  const cancelBound = async (
    supersede: () => void,
  ): Promise<TaskCancelOutcome> => {
    const candidate = ports.surface();
    if (!candidate || candidate.isDestroyed() || !ports.loaded()) {
      return "not_running";
    }
    const turn = ports.admittedAsRouteB() ? ports.turn() : null;
    let expectedPath: string | null = null;
    if (turn !== null) {
      expectedPath = cancelBindingPath(
        turn.pinnedConversationUrl ?? turn.dispatchIdentityUrl,
      );
      if (expectedPath === null) return "page_changed";
    }
    const alive = (): boolean =>
      ports.surface() === candidate && !candidate.isDestroyed();
    const pageCall = async (script: string): Promise<unknown> => {
      let cancelTimer: (() => void) | undefined;
      try {
        return await Promise.race([
          candidate.webContents.executeJavaScript(script, true),
          new Promise<typeof PAGE_CALL_TIMED_OUT>((resolve) => {
            cancelTimer = ports.after(
              () => resolve(PAGE_CALL_TIMED_OUT),
              STOP_PAGE_CALL_DEADLINE_MS,
            );
          }),
        ]);
      } finally {
        cancelTimer?.();
      }
    };
    try {
      const documentToken = ports.newToken();
      const bound = cancelBoundSchema.safeParse(
        await pageCall(cancelBindScript(expectedPath, documentToken)),
      );
      if (!bound.success || !alive()) return "outcome_unknown";
      // The page is not the one the turn relies on: nothing was touched.
      if ("navigated" in bound.data) return "page_changed";
      const path = bound.data.path;
      const wasObservedRunning = ports.observedRunning();
      const activationAttempts = wasObservedRunning
        ? STOP_ACTIVATION_ATTEMPTS
        : 1;
      let stopActivated = false;
      for (let attempt = 0; attempt < activationAttempts; attempt += 1) {
        if (!alive()) return "outcome_unknown";
        const activated = cancelActivationSchema.safeParse(
          await pageCall(
            cancelTaskScript(
              path,
              documentToken,
              ports.newToken(),
              ports.now() + STOP_SCRIPT_EXPIRY_MS,
            ),
          ),
        );
        // An unreadable or unanswered click may have happened.
        if (!activated.success || !alive()) return "outcome_unknown";
        // The page itself refused: no click happened on another page.
        if ("navigated" in activated.data) return "page_changed";
        if ("expired" in activated.data) return "outcome_unknown";
        if (activated.data.activated) {
          stopActivated = true;
          // The click is verified and spent: only now is the turn's
          // observation ended.
          supersede();
          break;
        }
        if (!wasObservedRunning) return "not_running";
        await ports.delay(STOP_ACTIVATION_GAP_MS);
      }
      if (!stopActivated) return "outcome_unknown";
      for (let attempt = 0; attempt < STOP_CONFIRMATION_POLLS; attempt += 1) {
        await ports.delay(STOP_CONFIRMATION_GAP_MS);
        if (!alive()) return "outcome_unknown";
        const observed = cancelConfirmationSchema.safeParse(
          await pageCall(cancelConfirmationProbe(path, documentToken)),
        );
        if (!observed.success || !alive()) return "outcome_unknown";
        // Another document is never an answer about this task.
        if ("navigated" in observed.data) return "outcome_unknown";
        if (!observed.data.running) {
          ports.recordStopped(candidate.webContents);
          return "cancelled";
        }
      }
      return "outcome_unknown";
    } catch {
      return "outcome_unknown";
    }
  };

  const run = async (): Promise<TaskCancelOutcome> => {
    let superseded = false;
    const supersede = (): void => {
      if (superseded) return;
      superseded = true;
      ports.supersedeObservation();
    };
    const outcome = await cancelBound(supersede);
    // A refusal leaves a turn in flight observed; every other answer ends it.
    if (outcome !== "page_changed") supersede();
    return outcome;
  };

  let inFlight: Promise<TaskCancelOutcome> | null = null;
  return () => {
    if (inFlight !== null) return inFlight;
    const started = run().finally(() => {
      inFlight = null;
    });
    inFlight = started;
    return started;
  };
}

// The window title ---------------------------------------------------------

export const DEFAULT_ROUTE_TITLE = "ChatGPT · Farol";

/** The title a route shows unless it was given its own. */
export function routeTitle(configured: string | undefined): string {
  return configured ?? DEFAULT_ROUTE_TITLE;
}

export type RouteTitlePorts = Readonly<{
  // The route's own write: the title it shows from now on.
  remember: (title: string) => void;
  surface: () => Readonly<{
    isDestroyed: () => boolean;
    setTitle: (title: string) => void;
  }> | null;
}>;

/** Remembers the title, and shows it on the window if one is still alive. */
export function applyRouteTitle(title: string, ports: RouteTitlePorts): void {
  ports.remember(title);
  const surface = ports.surface();
  if (surface && !surface.isDestroyed()) {
    surface.setTitle(title);
  }
}

// Resetting the route ------------------------------------------------------

export type RouteResetPorts = Readonly<{
  setEntryUrl: (url: string) => void;
  setDisposing: (disposing: boolean) => void;
  stopActivity: () => void;
  popups: () => Iterable<
    Readonly<{ isDestroyed: () => boolean; destroy: () => void }>
  >;
  // The route's own write: no popup is tracked any more.
  forgetPopups: () => void;
  surface: () => Readonly<{
    isDestroyed: () => boolean;
    destroy: () => void;
  }> | null;
  // The route's own write: no window, and the load is failed.
  release: () => void;
  changed: () => ((conversationUrl: string | null) => void) | undefined;
}>;

/**
 * Forgets the conversation: back to the home address, every popup and the
 * window destroyed while the route is marked as closing, and the owner told
 * there is no conversation.
 */
export function createRouteReset(
  homeUrl: string,
  ports: RouteResetPorts,
): () => void {
  return () => {
    ports.setEntryUrl(homeUrl);
    ports.setDisposing(true);
    ports.stopActivity();
    for (const popup of ports.popups()) {
      if (!popup.isDestroyed()) popup.destroy();
    }
    ports.forgetPopups();
    const surface = ports.surface();
    if (surface && !surface.isDestroyed()) {
      surface.destroy();
    }
    ports.release();
    ports.setDisposing(false);
    ports.changed()?.(null);
  };
}

// Pinning a document for a connection check ------------------------------------

export type ManualTargetContents = Readonly<{
  id: number;
  getURL: () => string;
  isDestroyed: () => boolean;
}>;

export type ManualTargetSurface = Readonly<{
  webContents: ManualTargetContents;
  isDestroyed: () => boolean;
}>;

export type ManualTargetPorts<Surface extends ManualTargetSurface> = Readonly<{
  surface: () => Surface | null;
  loaded: () => boolean;
  documentGeneration: () => number;
  e2eOrigin: () => string | null;
}>;

export type ConnectionCheckDocument = Readonly<{
  identity: string;
  current: () => boolean;
}>;

export type ManualTargets = Readonly<{
  // Pins the exact existing document; the closure rechecks every fact live.
  captureTarget: () => (() => boolean) | null;
  // The host hashes this content-free physical reference; no draft or URL is
  // persisted in the Go attempt. The original closure remains the final fence.
  captureDocument: () => ConnectionCheckDocument | null;
}>;

export function createManualTargets<Surface extends ManualTargetSurface>(
  ports: ManualTargetPorts<Surface>,
): ManualTargets {
  const captureTarget = (): (() => boolean) | null => {
    const surface = ports.surface();
    if (
      !surface ||
      surface.isDestroyed() ||
      surface.webContents.isDestroyed() ||
      !ports.loaded()
    )
      return null;
    const url = surface.webContents.getURL();
    if (!allowedChatGptPageUrl(url, ports.e2eOrigin())) return null;
    const generation = ports.documentGeneration();
    return () =>
      ports.surface() === surface &&
      !surface.isDestroyed() &&
      !surface.webContents.isDestroyed() &&
      ports.loaded() &&
      ports.documentGeneration() === generation &&
      surface.webContents.getURL() === url;
  };
  return {
    captureTarget,
    captureDocument: () => {
      const current = captureTarget();
      const surface = ports.surface();
      if (!current || !surface) return null;
      return Object.freeze({
        identity: JSON.stringify([
          surface.webContents.id,
          ports.documentGeneration(),
          surface.webContents.getURL(),
        ]),
        current,
      });
    },
  };
}

// Opening the connection-check chat ------------------------------------------

// One read of the page for the connection check may take this long.
export const CONNECTION_CHECK_READ_MS = 5_000;

export type ConnectionCheckSurface = Readonly<{
  webContents: Readonly<{
    getURL: () => string;
    executeJavaScript: (script: string, gesture?: boolean) => Promise<unknown>;
  }>;
  isDestroyed: () => boolean;
}>;

export type ConnectionCheckOpenPorts<Surface extends ConnectionCheckSurface> =
  Readonly<{
    capture: () => (() => boolean) | null;
    surface: () => Surface | null;
    taskInFlight: () => boolean;
    // The route's own write: the check holds the route while it runs.
    setTaskInFlight: (inFlight: boolean) => void;
    updateAdmitted: () => boolean;
    // One navigation of the route's document, under the route's deadline.
    navigate: (surface: Surface, url: string) => Promise<void>;
    // Tells the owner the navigation history moved.
    announce: () => void;
    // Arms one timer and returns what cancels it.
    after: (callback: () => void, ms: number) => () => void;
  }>;

/**
 * No draft copying, fallback chat or guessed layout. Observe the original
 * twice and recheck its physical owner immediately before one navigation.
 */
export function createConnectionCheckOpener<
  Surface extends ConnectionCheckSurface,
>(
  homeUrl: string,
  ports: ConnectionCheckOpenPorts<Surface>,
): (
  appName: string,
  current: () => boolean,
) => Promise<{ status: "opened" | "unreachable" }> {
  return async (appName, current) => {
    if (!current() || ports.taskInFlight() || ports.updateAdmitted())
      return { status: "unreachable" };
    const original = ports.capture();
    const surface = ports.surface();
    if (!original || !surface) return { status: "unreachable" };
    const script = connectionCheckDocumentProbe(
      appName,
      surface.webContents.getURL(),
    );
    ports.setTaskInFlight(true);
    let cancel: (() => void) | undefined;
    const observe = async () => {
      try {
        const safe: unknown = await Promise.race([
          surface.webContents.executeJavaScript(script, false),
          new Promise<false>((resolve) => {
            cancel = ports.after(
              () => resolve(false),
              CONNECTION_CHECK_READ_MS,
            );
          }),
        ]);
        return safe === true && current() && original();
      } finally {
        if (cancel !== undefined) cancel();
      }
    };
    try {
      if (!(await observe()) || !(await observe()))
        return { status: "unreachable" };
      if (!current() || !original()) return { status: "unreachable" };
      await ports.navigate(surface, temporaryChatUrl(homeUrl));
      if (!current() || ports.surface() !== surface || surface.isDestroyed())
        return { status: "unreachable" };
      ports.announce();
      return { status: "opened" };
    } catch {
      return { status: "unreachable" };
    } finally {
      ports.setTaskInFlight(false);
    }
  };
}
