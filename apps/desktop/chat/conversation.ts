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

// `page_changed`: the page shown, or the turn in flight, is not the one this
// Cancel started on, and nothing was clicked, superseded or recorded.
export type TaskCancelOutcome =
  "cancelled" | "not_running" | "outcome_unknown" | "page_changed";

export type TaskCancelContents = Readonly<{
  getURL: () => string;
  executeJavaScript: (script: string, gesture?: boolean) => Promise<unknown>;
}>;

export type TaskCancelSurface<Contents extends TaskCancelContents> = Readonly<{
  webContents: Contents;
  isDestroyed: () => boolean;
}>;

// The conversation a Route B turn in flight relies on for its own answer. The
// address it was sent from is not known while the turn still prepares, and
// no conversation is pinned until the page shows the one the turn created.
// The turn itself is identified by its epoch, never by this.
export type TaskCancelTurn = Readonly<{
  // The page-turn epoch this turn was admitted as.
  epoch: number;
  dispatchIdentityUrl: string | null;
  pinnedConversationUrl: string | null;
  // The turn's Send script has been issued: from there on the Send click may
  // have happened, and the page may show this turn's Stop. Before it, the turn
  // has sent nothing (its dispatch intent included) and any Stop the page
  // shows is an older generation's.
  dispatched: boolean;
}>;

export type TaskCancelPorts<
  Contents extends TaskCancelContents,
  Surface extends TaskCancelSurface<Contents>,
> = Readonly<{
  surface: () => Surface | null;
  loaded: () => boolean;
  // The route's observation generation, read at call time.
  observation: () => number;
  // The route's own write: the observation of `generation` is no longer
  // current. It moves the route only while the route is still at `generation`,
  // so a turn that began since is never ended by this.
  supersedeObservation: (generation: number) => void;
  // The activity watch last saw the task running.
  observedRunning: () => boolean;
  // Farol submits this task's turns: a Codex host thread was admitted on its
  // route, however the route came to be (a restored route included). A
  // Browser task the owner typed into is not.
  admittedAsRouteB: () => boolean;
  // The route's page-turn epoch, read at call time: a counter that only
  // increases, advanced by every Route B turn when it is admitted. A Cancel
  // takes its value when it starts; "no turn in flight" is just a value no
  // turn has advanced yet, so a successor that started and ended since is a
  // different epoch. A route nothing was admitted on stays at 0.
  epoch: () => number;
  // The route's document generation, read at call time: it advances on every
  // full navigation and every reload of the window, so a replacement document
  // at the very same address is a different one.
  documentGeneration: () => number;
  // A turn was admitted on the route and has not begun running: the route is
  // Route B and a Cancel has no turn to bind yet.
  admitting: () => boolean;
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
 * Everything a Cancel binds to is captured, synchronously, when it starts: the
 * main-frame path of the page shown (read on the main side, not by a script
 * that runs later), the route's observation generation, the route's page-turn
 * epoch and, on a route a Codex host thread (Route B) was admitted on, the
 * turn in flight. That turn binds the path of the conversation it pinned,
 * otherwise the address it was sent from, otherwise the page shown while it
 * still prepares: the identity the turn relies on for its own answer, so the
 * Cancel is never weaker than the turn. Every other task (an owner Browser
 * task, a turn the owner typed) binds the page shown at the start.
 *
 * The document is captured the same way: the route's document generation is
 * read when the Cancel starts, and the bind is only sent, and only accepted,
 * while it is unchanged. A reload, or a navigation away and back to the same
 * address, before the bind is another document that merely has the same path,
 * and is never stamped or clicked; every later effect is checked against it
 * on the main side as well. A Cancel that starts while a turn is being
 * admitted, before it runs, has nothing yet to bind and is refused before any
 * effect.
 *
 * The epoch is the one identity every effect is checked against. It only
 * increases: each Route B turn advances it when it is admitted, before its
 * first effect on any page, and stamps the value into the page. A Cancel with
 * no turn in flight holds the epoch of the last one, so a successor that
 * started and ended since is a different epoch, never "none" again. The only
 * thing that may happen to the captured turn without changing the epoch is
 * this Cancel's own supersede ending it.
 *
 * One script stamps the window while the page is still on the bound path and
 * not yet marked with a later epoch; every click and every confirmation then
 * requires path, stamp and epoch in the page, so a page that moved, was
 * replaced or belongs to a later turn is never clicked and never answers for
 * the task. Each click is a script of its own with a token it spends first and
 * an expiry before the page-call deadline. The same epoch is required on the
 * main side at the moment of every effect: before the bind and every click,
 * on every answer, before the observation is superseded, and before each
 * confirmation is accepted and the stop recorded.
 *
 * Stop is only ever clicked for a turn that has been sent. A turn in flight
 * that has not issued its Send script (preparing, waiting for readiness, for
 * the pre-Send activity check, for its attachments, or past its dispatch
 * intent but before the Send leaves) has sent nothing, and the Stop the page
 * may show belongs to an older generation: the page is not touched, the turn
 * is ended locally in the tick the Cancel started (every one of those steps
 * reads the observation generation, and the last check precedes the Send with
 * nothing awaited between), and it is `cancelled`. From the issue of the Send
 * script to its confirmation the click may have happened, so such a turn is
 * cancelled through the page like any sent one.
 *
 * Before the bind and before every click the whole captured identity is read
 * again from the live route and page, never from a copy: epoch, document
 * generation, the path shown and, on Route B, the live turn, which must still
 * be in flight and must still name the captured conversation (its pin can
 * become stronger while the same turn and epoch stay in flight). A page,
 * document or turn that changed before any click is `page_changed`. After a
 * click may have happened, the same identity is read after every await (the
 * click answer and each confirmation poll; the turn may have ended by then,
 * but one still in flight must name the captured conversation) and a mismatch
 * is `outcome_unknown`: nothing is recorded and nothing is `cancelled`.
 *
 * The observation of a sent turn is superseded only after the page answered
 * that the stop was activated on the verified identity, on every route. A
 * Cancel that did not get there, whatever it answered, moves no generation and
 * ends no turn. A call that stalls past its deadline is `outcome_unknown`.
 * Cancel is single-flight per epoch: a second call for the same turn while one
 * runs is that one's result, and a call after another turn was admitted is its
 * own attempt.
 */
export function createTaskCanceller<
  Contents extends TaskCancelContents,
  Surface extends TaskCancelSurface<Contents>,
>(ports: TaskCancelPorts<Contents, Surface>): () => Promise<TaskCancelOutcome> {
  const run = async (): Promise<TaskCancelOutcome> => {
    // The start of this Cancel. Nothing is awaited before it is captured.
    const startGeneration = ports.observation();
    const epoch = ports.epoch();
    const startDocument = ports.documentGeneration();
    const admitting = ports.admitting();
    const candidate = ports.surface();
    const startUrl =
      candidate && !candidate.isDestroyed()
        ? candidate.webContents.getURL()
        : null;
    // The turn of this epoch that was in flight when the Cancel started, which
    // names the conversation it relies on; none when no turn was.
    const live = ports.turn();
    const active = live !== null && live.epoch === epoch ? live : null;
    const turn = ports.admittedAsRouteB() ? active : null;
    // The identity every effect of this Cancel is checked against.
    const epochCurrent = (): boolean => ports.epoch() === epoch;
    // The document the Cancel started on, as far as the main side can tell.
    const documentCurrent = (): boolean =>
      ports.documentGeneration() === startDocument;
    const current = (): boolean => epochCurrent() && documentCurrent();
    let superseded = false;
    // Ends the observation of the epoch this Cancel started on, once, and never
    // after another turn was admitted or the document was replaced.
    const supersede = (): void => {
      if (superseded || !current()) return;
      superseded = true;
      ports.supersedeObservation(startGeneration);
    };
    // A turn that has not been sent (still preparing, waiting for readiness,
    // for the pre-Send activity check or for its attachments) has no Stop
    // control of its own: the one the page may show belongs to an older
    // generation. The page is never touched for it. Its preparation is ended
    // here, in the tick the Cancel started, before it can reach its dispatch
    // intent, and the turn ends cancelled.
    if (active !== null && !active.dispatched) {
      supersede();
      return "cancelled";
    }

    const cancelBound = async (): Promise<TaskCancelOutcome> => {
      // A turn is being admitted and has not begun: there is no turn to bind
      // and the page shown is not its page, so nothing is touched.
      if (admitting) return "page_changed";
      if (
        !candidate ||
        startUrl === null ||
        candidate.isDestroyed() ||
        !ports.loaded()
      ) {
        return "not_running";
      }
      const expectedPath = cancelBindingPath(
        turn === null
          ? startUrl
          : (turn.pinnedConversationUrl ??
              turn.dispatchIdentityUrl ??
              startUrl),
      );
      if (expectedPath === null) return "page_changed";
      const alive = (): boolean =>
        ports.surface() === candidate && !candidate.isDestroyed();
      // Everything the Cancel captured when it started, read again from the
      // live page and route: the page-turn epoch, the document, the path shown
      // and the turn in flight. It is checked before the bind and before every
      // click, so none of them can be authorized by an identity that an await
      // has since replaced. Nothing is stored here: each read is live.
      //
      // The turn is read live, never from the copy taken at the start: the
      // conversation it relies on can become stronger (a pin) while the same
      // turn and epoch stay in flight. Before a click it must still be in
      // flight and must still name the captured binding. After a click it may
      // have ended (the stop itself ends it), but a turn still in flight must
      // still name the captured binding.
      const bindingOf = (live: TaskCancelTurn): string | null =>
        cancelBindingPath(
          live.pinnedConversationUrl ?? live.dispatchIdentityUrl ?? "",
        );
      const identityCurrent = (afterClick = false): boolean => {
        if (!current() || !alive()) return false;
        if (turn !== null) {
          const live = ports.turn();
          if (live === null) {
            if (!afterClick) return false;
          } else if (live.epoch !== epoch || bindingOf(live) !== expectedPath) {
            return false;
          }
        }
        return (
          cancelBindingPath(candidate.webContents.getURL()) === expectedPath
        );
      };
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
        // Nothing is stamped on a document that is not the one the Cancel
        // started on: a reload or a return to the same address since then is
        // a replacement, whatever its path says.
        if (!identityCurrent()) return "page_changed";
        const documentToken = ports.newToken();
        const bound = cancelBoundSchema.safeParse(
          await pageCall(cancelBindScript(expectedPath, documentToken, epoch)),
        );
        if (!bound.success || !alive()) return "outcome_unknown";
        // The page is not the one this Cancel started on: nothing was touched.
        if ("navigated" in bound.data) return "page_changed";
        // Another turn was admitted, the document was replaced, the turn ended
        // or the page moved while it was bound: nothing was clicked.
        if (!identityCurrent()) return "page_changed";
        const path = bound.data.path;
        const wasObservedRunning = ports.observedRunning();
        const activationAttempts = wasObservedRunning
          ? STOP_ACTIVATION_ATTEMPTS
          : 1;
        let stopActivated = false;
        for (let attempt = 0; attempt < activationAttempts; attempt += 1) {
          if (!alive()) return "outcome_unknown";
          // Any part of the identity changed since: nothing is clicked.
          if (!identityCurrent()) return "page_changed";
          const activated = cancelActivationSchema.safeParse(
            await pageCall(
              cancelTaskScript(
                path,
                documentToken,
                ports.newToken(),
                epoch,
                ports.now() + STOP_SCRIPT_EXPIRY_MS,
              ),
            ),
          );
          // An unreadable or unanswered click may have happened.
          if (!activated.success || !alive()) return "outcome_unknown";
          // The click may have happened, and what the page answered, of any
          // shape, may be about another turn or document: only an unchanged
          // identity can be taken at its word, and only then is the answer
          // read at all.
          if (!identityCurrent(true)) return "outcome_unknown";
          // The page itself refused: no click happened on another page.
          if ("navigated" in activated.data) return "page_changed";
          if ("expired" in activated.data) return "outcome_unknown";
          if (activated.data.activated) {
            stopActivated = true;
            supersede();
            break;
          }
          if (!wasObservedRunning) return "not_running";
          await ports.delay(STOP_ACTIVATION_GAP_MS);
        }
        if (!stopActivated) return "outcome_unknown";
        for (let attempt = 0; attempt < STOP_CONFIRMATION_POLLS; attempt += 1) {
          await ports.delay(STOP_CONFIRMATION_GAP_MS);
          if (!identityCurrent(true)) return "outcome_unknown";
          const observed = cancelConfirmationSchema.safeParse(
            await pageCall(cancelConfirmationProbe(path, documentToken, epoch)),
          );
          if (!observed.success || !alive()) return "outcome_unknown";
          // Another document is never an answer about this task.
          if ("navigated" in observed.data) return "outcome_unknown";
          // Nor is an answer once another turn was admitted, even one that has
          // already ended: what the page shows is not the stop of this one,
          // and recording it would end the other.
          if (!identityCurrent(true)) return "outcome_unknown";
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

    // The observation is superseded only inside, once the page answered that
    // the stop was activated on the verified identity. A Cancel that did not
    // get there, whatever it answered, ends no turn and moves no generation.
    return cancelBound();
  };

  // Single-flight per page-turn epoch: a second call for the same turn is the
  // first one's result, and a call after another turn was admitted is a
  // Cancel of that turn and starts its own attempt at once. The older attempt
  // is bound to its own epoch, so every effect it still has pending is
  // refused and it ends without a click, a supersede or a record; waiting for
  // it would only delay the Cancel of the turn that now runs.
  const inFlight = new Map<number, Promise<TaskCancelOutcome>>();
  return () => {
    const epoch = ports.epoch();
    const held = inFlight.get(epoch);
    if (held !== undefined) return held;
    const started = run().finally(() => {
      if (inFlight.get(epoch) === started) inFlight.delete(epoch);
    });
    inFlight.set(epoch, started);
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
