import {
  allowedChatGptPageUrl,
  canonicalChatGptConversationUrl,
} from "../../../src/apps/desktop/chatgpt-page-policy";
import {
  cancelBindScript,
  cancelBindingPath,
  cancelConfirmationProbe,
  cancelTaskScript,
} from "../../../src/apps/desktop/chatgpt/scripts";
import {
  cancelActivationSchema,
  cancelBoundSchema,
  cancelConfirmationSchema,
} from "./probe";

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
// Cancel started on, there is no turn of Farol's on a Route B route to bind,
// or the page refused a click that reached it too late; nothing was clicked,
// superseded or recorded.
// `not_yet_bound`: a sent Route B turn's own message has not been seen on the
// conversation it names, so that conversation may only be the first one the
// page happened to show; nothing was touched, and the owner can ask again.
export type TaskCancelOutcome =
  | "cancelled"
  | "not_running"
  | "outcome_unknown"
  | "page_changed"
  | "not_yet_bound";

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
  // The address on which the turn's latest probe saw the turn's own user
  // message (the one matching its prompt, then its id), on a page that did not
  // move during the probe; null while no probe has. A pin alone is only the
  // first conversation the page showed after the Send, which may be one the
  // owner moved to: this is what correlates it to the turn.
  correlatedConversationUrl: string | null;
  // The turn's Send script has been issued: from there on the Send click may
  // have happened, and the page may show this turn's Stop. Before it, the turn
  // has sent nothing (its dispatch intent included) and any Stop the page
  // shows is an older generation's.
  dispatched: boolean;
  // The turn runs as the epoch a Codex host thread's admission advanced: it
  // is the Route B task's own turn. A summary or a check Farol runs on the
  // same route has an epoch of its own and is not the task's.
  admitted: boolean;
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
 * task stopped. `outcome_unknown` means exactly that a click script was sent
 * and what it did is not confirmed: its answer was unreadable, lost or late,
 * the page went, the identity changed after it, or the stop it activated was
 * never confirmed. It is never `cancelled`. A Cancel that sent no click, or
 * whose every click answered that it clicked nothing (a failed or stalled
 * bind, a page that went between attempts, no Stop found), is a refusal.
 *
 * Everything a Cancel binds to is captured, synchronously, when it starts: the
 * main-frame path of the page shown (read on the main side, not by a script
 * that runs later), the route's observation generation, the route's page-turn
 * epoch and, on a route a Codex host thread (Route B) was admitted on, the
 * turn in flight. That turn binds the path of the conversation it pinned,
 * otherwise the address it was sent from, otherwise the page shown while it
 * still prepares: the identity the turn relies on for its own answer, so the
 * Cancel is never weaker than the turn. On such a route with no turn of
 * Farol's in flight (the last one ended, unknown or not, or none has begun)
 * there is nothing of the task's to stop: the Cancel is refused before any
 * effect. A task on any other route (an owner Browser task) binds the page
 * shown at the start.
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
 * A sent Route B turn's Stop is only clicked on a correlated pin: the
 * conversation the turn names must be the one on which its latest probe saw
 * the turn's own user message. The first conversation the page shows after the
 * Send is adopted as the pin before any message is seen there, and may be one
 * the owner moved the task view to; a Cancel of a turn whose pin is not yet
 * correlated is `not_yet_bound`, with nothing touched. The correlation is part
 * of the identity read again before every click and after it.
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
 * is `outcome_unknown`: nothing is recorded and nothing is `cancelled`. The
 * exception is a click answer that proves nothing was clicked (no Stop found,
 * a refusal by the page, an expired script): it clears that doubt first, so a
 * mismatch after it is `page_changed`.
 *
 * The observation of a sent turn is superseded only after the page answered
 * that the stop was activated on the verified identity, on every route. A
 * Cancel that did not get there, whatever it answered, moves no generation and
 * ends no turn. A click or confirmation call that stalls past its deadline is
 * `outcome_unknown`; a bind that does is a refusal.
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
    const routeB = ports.admittedAsRouteB();
    // On a Route B route only the turn a thread's admission began is the
    // task's: a summary run there is not, and is never ended or bound.
    const active =
      live !== null && live.epoch === epoch && (!routeB || live.admitted)
        ? live
        : null;
    const turn = routeB ? active : null;
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
      // Farol submits this task's turns, and none is in flight: the last one
      // has ended (one that lost its page and ended unknown included) and the
      // page shown is not a turn of this task. Its Stop belongs to whatever
      // the page now shows, so nothing is touched and nothing is recorded.
      if (routeB && turn === null) return "page_changed";
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
      // The turn's own message was seen on the conversation it names.
      const correlated = (live: TaskCancelTurn): boolean =>
        live.correlatedConversationUrl !== null &&
        cancelBindingPath(live.correlatedConversationUrl) === expectedPath;
      const identityCurrent = (
        afterClick = false,
        requireCorrelation = true,
      ): boolean => {
        if (!current() || !alive()) return false;
        if (turn !== null) {
          const live = ports.turn();
          if (live === null) {
            if (!afterClick) return false;
          } else if (
            live.epoch !== epoch ||
            bindingOf(live) !== expectedPath ||
            (requireCorrelation && !correlated(live))
          ) {
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
      // `outcome_unknown` means one thing: a click script was issued and what
      // it did is not confirmed. Set right before each click is sent, and
      // cleared only by a verified answer that it clicked nothing; every
      // other way this Cancel ends is a refusal.
      let clickUnconfirmed = false;
      try {
        // Nothing is stamped on a document that is not the one the Cancel
        // started on: a reload or a return to the same address since then is
        // a replacement, whatever its path says.
        if (!identityCurrent(false, false)) return "page_changed";
        // The page, the document and the turn are the ones captured, and only
        // the correlation is missing: the turn's own message has not been seen
        // on its conversation, which may then be one the owner moved to.
        // Nothing is touched, and the owner can ask again.
        if (!identityCurrent()) return "not_yet_bound";
        const documentToken = ports.newToken();
        const bound = cancelBoundSchema.safeParse(
          await pageCall(cancelBindScript(expectedPath, documentToken, epoch)),
        );
        // A bind that failed, stalled or lost its page clicked nothing: it only
        // stamps, and no click script was sent.
        if (!bound.success || !alive()) return "page_changed";
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
          // Every click sent so far answered that it clicked nothing.
          if (!alive()) return "page_changed";
          // Any part of the identity changed since: nothing is clicked.
          if (!identityCurrent()) return "page_changed";
          // Built before the flag is set: a script that cannot be built is
          // never sent, so its failure is a refusal, not an unknown click.
          const clickScript = cancelTaskScript(
            path,
            documentToken,
            ports.newToken(),
            epoch,
            ports.now() + STOP_SCRIPT_EXPIRY_MS,
          );
          clickUnconfirmed = true;
          const activated = cancelActivationSchema.safeParse(
            await pageCall(clickScript),
          );
          // An unreadable or unanswered click may have happened.
          if (!activated.success || !alive()) return "outcome_unknown";
          // A readable answer that says nothing was clicked (no Stop found, a
          // refusal by the page, an expired script) proves it: the script
          // answers from the bound document and epoch, and `stop.click()` ran
          // only on `activated: true`. That settles the click before the
          // identity is read, so an identity that moved since is a refusal.
          if (!("activated" in activated.data) || !activated.data.activated)
            clickUnconfirmed = false;
          // The click may have happened, and what the page answered may be
          // about another turn or document: only an unchanged identity can be
          // taken at its word.
          if (!identityCurrent(true)) {
            return clickUnconfirmed ? "outcome_unknown" : "page_changed";
          }
          // The page itself refused: no click happened on another page.
          if ("navigated" in activated.data) return "page_changed";
          // The script refused before it spent its token or looked for the
          // Stop: nothing was clicked by it, and every earlier attempt
          // answered that it found no Stop to click.
          if ("expired" in activated.data) return "page_changed";
          if (activated.data.activated) {
            stopActivated = true;
            supersede();
            break;
          }
          if (!wasObservedRunning) return "not_running";
          await ports.delay(STOP_ACTIVATION_GAP_MS);
        }
        // Every attempt answered that the page showed no Stop to click:
        // nothing was clicked, and nothing of this task is running there.
        if (!stopActivated) return "not_running";
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
        return clickUnconfirmed ? "outcome_unknown" : "page_changed";
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
