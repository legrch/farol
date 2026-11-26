import type { ChatGptPageObservation } from "../../../src/apps/desktop/chatgpt-page-policy";

// What the ChatGPT sign-in surface reports: why an outcome came out the way it
// did, which block is current for the attempt, and the bounded page read taken
// around closing the window. Everything is content-free: a fixed token, a host
// name, a permission name, a numeric code or a duration, never a URL path, a
// query or anything the page rendered.

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

// How long the sign-in window's closing page read may take before the
// outcome is reported as unknown instead of not at all.
export const SIGN_IN_CLOSE_OBSERVATION_MS = 2_000;

// What one sign-in page read produced: the observation when it answered in
// time, null when the bound won, and — either way — the content-free
// diagnostic that says which of the two happened and why.
export type SignInRead = Readonly<{
  observation: ChatGptPageObservation;
  reason: Exclude<ChatGptSignInOutcomeDiagnostic["reason"], "timeout">;
}>;

export type SignInObservation = Readonly<{
  observation: ChatGptPageObservation | null;
  diagnostic: ChatGptSignInOutcomeDiagnostic;
}>;

// The clock and the timer the bound is measured with, lent by the route:
// the real ones in the product, fakes in a test. `after` arms one timer and
// is never cancelled, exactly as before.
export type SignInObservationPorts = Readonly<{
  now: () => number;
  after: (callback: () => void, ms: number) => void;
}>;

export type BoundedSignInObservation = (
  read: Promise<SignInRead>,
  readStartedBy: ChatGptSignInOutcomeDiagnostic["readStartedBy"],
) => Promise<SignInObservation>;

// A page read taken around closing the sign-in window, bounded so that
// neither the close nor the reported outcome can wait on it forever: after
// the bound it yields null, which is reported as "unknown". The bound is
// deliberately unchanged; what is new is that the outcome now carries how
// long the read ran and which side of the race won, so an "unknown" under
// load can be told from an "unknown" the page itself caused.
export function createBoundedSignInObservation(
  ports: SignInObservationPorts,
): BoundedSignInObservation {
  return (read, readStartedBy) => {
    const startedAt = ports.now();
    return Promise.race([
      read.then(({ observation, reason }) => ({
        observation,
        diagnostic: {
          reason,
          state: observation.state,
          elapsedMs: ports.now() - startedAt,
          readStartedBy,
        },
      })),
      new Promise<SignInObservation>((resolve) =>
        ports.after(
          () =>
            resolve({
              observation: null,
              diagnostic: {
                reason: "timeout",
                state: null,
                elapsedMs: ports.now() - startedAt,
                readStartedBy,
              },
            }),
          SIGN_IN_CLOSE_OBSERVATION_MS,
        ),
      ),
    ]);
  };
}

// The outcome reported when no page read was taken at all: the window was
// never opened, was already gone, or was destroyed without a closing turn.
export function unreadSignInOutcome(
  readStartedBy: ChatGptSignInOutcomeDiagnostic["readStartedBy"],
): ChatGptSignInOutcomeDiagnostic {
  return { reason: "no-window", state: null, elapsedMs: 0, readStartedBy };
}
