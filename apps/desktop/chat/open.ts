// How the ChatGPT route opens its window and enters or leaves sign-in mode,
// as far as that can be decided without owning the route's state. The route
// keeps the `opening` promise, the window, the sign-in flags and the document
// generations, and writes every one of them; everything here either reads
// through a port at the point the original code read it, or decides from
// values it is handed. Nothing retries, and a timed-out open stays an unknown
// outcome that is never reported as a failure of the page.

// A whole open, or one navigation, may take this long on the wall clock.
export const ROUTE_OPEN_DEADLINE_MS = 30_000;

export class RouteOpenTimedOut extends Error {}

// The deadline race ------------------------------------------------------------

export type OpenStepSurface = Readonly<{
  isDestroyed: () => boolean;
  destroy: () => void;
}>;

export type OpenStepRacePorts<Surface extends OpenStepSurface> = Readonly<{
  now: () => number;
  // Arms one timer and returns the way to cancel it.
  after: (callback: () => void, ms: number) => () => void;
  // The route still owns this surface as its own window.
  owned: (candidate: Surface) => boolean;
  // Only protected submission surfaces are retired at the deadline.
  protectedSurface: () => boolean;
  // The route's own write: sign-in mode ends because its surface is retired.
  leaveSignIn: () => void;
  // The teardown attempt begins: the route holds back close notifications the
  // attempt itself provokes, because they do not prove a destruction.
  teardownStarted: (candidate: Surface) => void;
  // The attempt is over. Only a confirmed destruction lets the route treat the
  // surface as closed; otherwise the route revokes it and keeps custody until
  // `isDestroyed()` confirms, whether destroy threw, returned or notified.
  teardownSettled: (candidate: Surface, confirmed: boolean) => void;
}>;

export type OpenStepRace<Surface> = <T>(
  candidate: Surface,
  work: Promise<T>,
  deadline: number,
) => Promise<T>;

/**
 * Races one open step against the absolute `deadline`. At the deadline a
 * protected surface that is still the route's own is taken out of sign-in mode
 * and destroyed (or, when destruction is not confirmed, revoked and held); a slow ordinary browser keeps its original visible
 * navigation. Either way the step rejects with `RouteOpenTimedOut`, and the
 * timer is cleared whichever side wins.
 */
export function createOpenStepRace<Surface extends OpenStepSurface>(
  ports: OpenStepRacePorts<Surface>,
): OpenStepRace<Surface> {
  return async <T>(
    candidate: Surface,
    work: Promise<T>,
    deadline: number,
  ): Promise<T> => {
    let cancel: (() => void) | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          cancel = ports.after(
            () => {
              if (ports.owned(candidate) && ports.protectedSurface()) {
                ports.leaveSignIn();
                ports.teardownStarted(candidate);
                try {
                  if (!candidate.isDestroyed()) candidate.destroy();
                } catch {
                  // Whether it worked is decided by the confirmation below,
                  // never by whether this threw.
                }
                let confirmed = false;
                try {
                  confirmed = candidate.isDestroyed();
                } catch {
                  // An unreadable state is not a confirmation.
                }
                ports.teardownSettled(candidate, confirmed);
              }
              reject(new RouteOpenTimedOut("CHATGPT_ROUTE_OPEN_TIMEOUT"));
            },
            Math.max(0, deadline - ports.now()),
          );
        }),
      ]);
    } finally {
      if (cancel !== undefined) cancel();
    }
  };
}

/** A timed-out protected open is hidden, never revealed, whatever it loaded. */
export function hideAfterOpenTimeout(
  error: unknown,
  candidate: Readonly<{ isDestroyed: () => boolean; hide: () => void }>,
  protectedSurface: boolean,
): void {
  if (!(error instanceof RouteOpenTimedOut)) return;
  if (protectedSurface && !candidate.isDestroyed()) {
    try {
      candidate.hide();
    } catch {
      // Never reveal a page whose opening outcome is unknown.
    }
  }
}

// The ordinary-browser milestone ----------------------------------------------

export type DomReadyContents = Readonly<{
  on: (event: "dom-ready", listener: () => void) => unknown;
  removeListener: (event: "dom-ready", listener: () => void) => unknown;
}>;

export type OrdinaryReadyPorts = Readonly<{
  // Protected task surfaces keep their full-load gate and have no milestone.
  protectedSurface: () => boolean;
  // The route still owns these contents.
  owned: () => boolean;
  // The committed document is a new one, not an event from the retained one.
  advanced: () => boolean;
  loadFailed: () => boolean;
  awaitingCommit: () => boolean;
  // The committed address is an allowed ChatGPT page.
  allowedUrl: () => boolean;
  // Runs just before the milestone resolves.
  onReady?: () => void;
}>;

export type OrdinaryReady = Readonly<{
  // Null when the surface is protected.
  ready: Promise<void> | null;
  release: () => void;
}>;

/**
 * An ordinary browser can observe a committed DOM while slow subresources
 * still keep loadURL pending. This milestone neither admits submission nor
 * authenticates a page. The listener is attached when the gate is created and
 * `release` detaches it, so a caller creates it before `loadURL` and releases
 * it in a `finally`.
 */
export function createOrdinaryReady(
  contents: DomReadyContents,
  ports: OrdinaryReadyPorts,
): OrdinaryReady {
  if (ports.protectedSurface()) return { ready: null, release: () => {} };
  let domReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    domReady = () => {
      if (
        ports.owned() &&
        ports.advanced() &&
        !ports.loadFailed() &&
        !ports.awaitingCommit() &&
        ports.allowedUrl()
      ) {
        ports.onReady?.();
        resolve();
      }
    };
    contents.on("dom-ready", domReady);
  });
  return {
    ready,
    release: () => {
      if (domReady) contents.removeListener("dom-ready", domReady);
    },
  };
}

// Navigation -------------------------------------------------------------------

/** The temporary-chat address: the home page with the temporary flag set. */
export function temporaryChatUrl(homeUrl: string): string {
  const url = new URL(homeUrl);
  url.searchParams.set("temporary-chat", "true");
  return url.href;
}

// Retrying a failed open ------------------------------------------------------

export type RetryOpenState = Readonly<{
  updateAdmission: boolean;
  taskInFlight: boolean;
  signInMode: boolean;
  opening: boolean;
  // The route holds a window whose load failed.
  failedSurface: boolean;
}>;

export type RetryOpenPlan = "refuse" | "join" | "discard-failed" | "open";

/**
 * An explicit owner retry never repeats a model submission. It joins an open
 * already under way, or discards only a failed surface, or opens afresh.
 */
export function decideRetryFailedOpen(state: RetryOpenState): RetryOpenPlan {
  if (state.updateAdmission || state.taskInFlight || state.signInMode)
    return "refuse";
  if (state.opening) return "join";
  if (state.failedSurface) return "discard-failed";
  return "open";
}

/** After joining the original open, the same refusals are checked again. */
export function decideRetryAfterJoin(
  openedStatus: string,
  state: Pick<
    RetryOpenState,
    "updateAdmission" | "taskInFlight" | "signInMode"
  >,
): "refuse" | "open" {
  if (
    openedStatus !== "opened" ||
    state.updateAdmission ||
    state.taskInFlight ||
    state.signInMode
  )
    return "refuse";
  return "open";
}

// Sign-in mode -------------------------------------------------------------------

export type SignInStatus = "authenticated" | "not_authenticated" | "unknown";

/** What one read of the page says about sign-in; anything else is unknown. */
export function signInStatusFromObservation(
  state: string | undefined,
): SignInStatus {
  if (state === "authenticated") return "authenticated";
  if (state === "signed_out") return "not_authenticated";
  return "unknown";
}

/**
 * A sign-in attempt that never got a window reports its own outcome, but only
 * while it is still the latest attempt.
 */
export function shouldReportUnopenedSignIn(
  attempt: number,
  latestAttempt: number,
  openStatus: string,
): boolean {
  return attempt === latestAttempt && openStatus !== "opened";
}

export type SignInReturnPlan =
  // Not in sign-in mode: only close the window.
  | "close"
  // An embedded surface is left after the bounded read, not closed.
  | "exit-after-read"
  // A window is closed after the bounded read settles.
  | "close-after-read";

export function decideSignInReturn(
  signInMode: boolean,
  kind: "window" | "embedded",
): SignInReturnPlan {
  if (!signInMode) return "close";
  return kind === "embedded" ? "exit-after-read" : "close-after-read";
}

/** A late return read may leave sign-in mode only if nothing moved meanwhile. */
export function signInReturnStillCurrent(input: {
  attempt: number;
  latestAttempt: number;
  signInMode: boolean;
  sameSurface: boolean;
}): boolean {
  return (
    input.attempt === input.latestAttempt &&
    input.signInMode &&
    input.sameSurface
  );
}

export type SignInExitPlan = Readonly<{
  // Sign-in mode was on, so it ends and the banner is removed.
  exit: boolean;
  // The route was the active sign-in route and releases that claim.
  releaseActive: boolean;
}>;

export function decideSignInExit(
  signInMode: boolean,
  isActiveRoute: boolean,
): SignInExitPlan {
  if (!signInMode) return { exit: false, releaseActive: false };
  return { exit: true, releaseActive: isActiveRoute };
}
