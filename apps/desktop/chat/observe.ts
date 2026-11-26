import {
  allowedChatGptPageUrl,
  classifyChatGptPage,
  type ChatGptPageObservation,
} from "../../../src/apps/desktop/chatgpt-page-policy";
import { readinessProbe } from "../../../src/apps/desktop/chatgpt/scripts";
import { boundedProbe } from "./bounded";
import { raceDeadline } from "./deadline";
import { probeSchema } from "./probe";
import type { SignInRead } from "./signin";

// What the ChatGPT route reads from its page without acting on it: the
// readiness observation behind every task and the sign-in status, and the
// one place a task script runs against the captured document. The route keeps
// the window, the load slot and the document generations; every live read of
// them happens through a port, at the point the original code read it, so a
// destroyed or replaced window is seen exactly as before. Nothing here
// retries, and nothing turns an unknown reading into a known one.

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

// The whole sign-in status read, from one fresh read to its answer, may take
// this long on the monotonic clock.
export const READINESS_OBSERVATION_MS = 2_000;

// The parts of an Electron frame and contents the reads use. Structural, so a
// test can lend a fake that throws once it is "destroyed".
export type ObservedFrame = Readonly<{
  isDestroyed: () => boolean;
  url: string;
  executeJavaScript: (script: string, gesture?: boolean) => Promise<unknown>;
}>;

export type ObservedContents = Readonly<{
  getURL: () => string;
  isDestroyed: () => boolean;
  mainFrame: ObservedFrame | null | undefined;
  executeJavaScript: (script: string, gesture?: boolean) => Promise<unknown>;
}>;

export type ObservedSurface<
  Contents extends ObservedContents = ObservedContents,
> = Readonly<{
  isDestroyed: () => boolean;
  webContents: Contents;
}>;

type ReadinessRead<Surface> = Readonly<{
  surface: Surface | null;
  documentGeneration: number;
  url: string | null;
  sequence: number;
}>;

export type LatestReadiness<Surface> = Readonly<{
  surface: Surface;
  documentGeneration: number;
  url: string;
  sequence: number;
  observation: ChatGptPageObservation;
}>;

export type SignInStatusReason =
  "admission" | "document-not-current" | "unconfirmed" | "exception";

export type ReadinessObserverPorts<Surface> = Readonly<{
  route: Readonly<{
    // The route's own window, or null.
    surface: () => Surface | null;
    documentGeneration: () => number;
    loaded: () => boolean;
    awaitingCommit: () => boolean;
    disposing: () => boolean;
    // Opening, running a task or an update admission: any of them keeps a
    // status read from starting.
    blocked: () => boolean;
  }>;
  e2eOrigin: () => string | null;
  clock: Readonly<{
    // The monotonic clock the status read's budget is measured with.
    now: () => number;
    // Arms one timer; the returned function cancels it.
    after: (callback: () => void, ms: number) => () => void;
  }>;
  // One notification for a status that could not be confirmed. It reads the
  // route's own flags when called; a throw never changes the outcome.
  diagnose: (
    reason: SignInStatusReason,
    pageState: ChatGptPageObservation["state"] | null,
  ) => void;
}>;

export type ReadinessObserver<Surface> = Readonly<{
  observe: () => Promise<ChatGptPageObservation>;
  observeSignInStatus: () => Promise<ChatGptSignInStatusObservation>;
  isCurrentSignInStatus: (result: ChatGptSignInStatusObservation) => boolean;
  // One page read, without the identity and order checks `observe` adds. A
  // sign-in close takes it as a diagnostic, never as Send authority.
  readPage: (userGesture: boolean) => Promise<SignInRead>;
  // Makes every read begun so far stale: none of them can authorize anything.
  invalidate: () => void;
  // The sequence of the newest read, and the newest settled observation.
  sequence: () => number;
  latest: () => LatestReadiness<Surface> | null;
}>;

export function createReadinessObserver<Surface extends ObservedSurface>(
  ports: ReadinessObserverPorts<Surface>,
): ReadinessObserver<Surface> {
  let readSequence = 0;
  let currentObservation: Readonly<{
    result: ChatGptSignInStatusObservation;
    read: ReadinessRead<Surface>;
    startedAt: number;
    deadlineAt: number;
  }> | null = null;
  let latestReadiness: LatestReadiness<Surface> | null = null;

  const available = (): boolean =>
    !ports.route.disposing() &&
    !ports.route.blocked() &&
    !ports.route.awaitingCommit() &&
    !ports.route.surface()?.webContents.isDestroyed();

  const capture = (): ReadinessRead<Surface> => {
    const sequence = ++readSequence;
    const surface = ports.route.surface();
    return {
      sequence,
      surface,
      documentGeneration: ports.route.documentGeneration(),
      url:
        surface && !surface.isDestroyed() ? surface.webContents.getURL() : null,
    };
  };

  const documentCurrent = (read: ReadinessRead<Surface>): boolean =>
    read.surface !== null &&
    read.url !== null &&
    !ports.route.disposing() &&
    ports.route.surface() === read.surface &&
    !read.surface.isDestroyed() &&
    ports.route.documentGeneration() === read.documentGeneration &&
    !ports.route.awaitingCommit() &&
    read.surface.webContents.getURL() === read.url &&
    ports.route.loaded();

  // `deadlineAt` bounds the page script itself. The sign-in status read and
  // the sign-in close already race this read against their own timers, so they
  // pass none; `observe` has no other bound and always passes one.
  const readPageUntil = async (
    userGesture: boolean,
    deadlineAt: number | null,
  ): Promise<SignInRead> => {
    const unreachable = classifyChatGptPage({
      load: "failed",
      composerVisible: false,
      signInVisible: false,
    });
    const unrecognized: ChatGptPageObservation = {
      state: "unsupported",
      code: "CHATGPT_UI_UNRECOGNIZED",
    };
    const candidate = ports.route.surface();
    if (!candidate || candidate.isDestroyed()) {
      return { observation: unreachable, reason: "no-window" };
    }
    if (!ports.route.loaded() || ports.route.awaitingCommit()) {
      return { observation: unreachable, reason: "load-failed" };
    }
    const currentUrl = candidate.webContents.getURL();
    if (!allowedChatGptPageUrl(currentUrl, ports.e2eOrigin())) {
      return { observation: unrecognized, reason: "url-unsupported" };
    }
    let answer: unknown;
    try {
      // Read the exact current frame directly. WebContents execution can queue
      // behind did-stop-loading while a remote page still loads other resources.
      // This remains a bounded pure read, with document checks before and after.
      const frame = candidate.webContents.mainFrame;
      if (frame && (frame.isDestroyed() || frame.url !== currentUrl))
        return { observation: unrecognized, reason: "probe-threw" };
      const run = () =>
        frame
          ? frame.executeJavaScript(readinessProbe, userGesture)
          : candidate.webContents.executeJavaScript(
              readinessProbe,
              userGesture,
            );
      if (deadlineAt === null) {
        answer = await run();
      } else {
        // A page that never answers, or answers late, is an unreadable page.
        const read = await boundedProbe(ports.clock, run, deadlineAt);
        if (read.status === "timeout")
          return { observation: unrecognized, reason: "probe-threw" };
        answer = read.value;
      }
      if (
        frame &&
        (candidate.webContents.mainFrame !== frame ||
          frame.isDestroyed() ||
          frame.url !== currentUrl)
      )
        return { observation: unrecognized, reason: "probe-threw" };
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
  };

  const readPage = (userGesture: boolean): Promise<SignInRead> =>
    readPageUntil(userGesture, null);

  const observe = async (): Promise<ChatGptPageObservation> => {
    const document = capture();
    const { sequence, surface, documentGeneration, url } = document;
    const read = await readPageUntil(
      true,
      ports.clock.now() + READINESS_OBSERVATION_MS,
    );
    const unknown: ChatGptPageObservation = {
      state: "unsupported",
      code: "CHATGPT_UI_UNRECOGNIZED",
    };
    if (!surface || url === null) return read.observation;
    // A page answer is readiness only for the exact document it read. Closing
    // diagnostics intentionally retain their separate pre-close snapshot path.
    if (!documentCurrent(document)) return unknown;
    const latest = latestReadiness;
    const current =
      latest &&
      latest.surface === surface &&
      latest.documentGeneration === documentGeneration &&
      latest.url === url
        ? latest
        : null;
    if (sequence !== readSequence) {
      // A later pending read cannot be authorized by an old positive answer.
      // A later settled read supplies the current state, never the old result.
      return current &&
        (current.sequence === readSequence ||
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
    latestReadiness = {
      surface,
      documentGeneration,
      url,
      sequence,
      observation,
    };
    return observation;
  };

  // Observe only an existing loaded document. Both the read and transport
  // currency share this original monotonic budget. Unlike observe(), this
  // method never publishes into latestReadiness: even a late positive probe
  // cannot become readiness for a subsequent task or settle an unknown effect.
  const observeSignInStatus =
    async (): Promise<ChatGptSignInStatusObservation> => {
      currentObservation = null;
      const unconfirmedReadiness = (
        reason: SignInStatusReason,
        pageState: ChatGptPageObservation["state"] | null = null,
      ): ChatGptSignInStatusObservation => {
        try {
          ports.diagnose(reason, pageState);
        } catch {
          /* Diagnostics cannot change page-read admission. */
        }
        return Object.freeze({ state: "unknown" as const, binding: null });
      };
      let cancel: (() => void) | undefined;
      try {
        if (!available()) return unconfirmedReadiness("admission", null);
        const startedAt = ports.clock.now();
        const deadlineAt = startedAt + READINESS_OBSERVATION_MS;
        const read = capture();
        if (!documentCurrent(read))
          return unconfirmedReadiness("document-not-current", null);
        const answer = await Promise.race([
          readPage(false),
          new Promise<null>((resolve) => {
            cancel = ports.clock.after(
              () => resolve(null),
              READINESS_OBSERVATION_MS,
            );
          }),
        ]);
        const now = ports.clock.now();
        if (
          !answer ||
          answer.reason !== "answered" ||
          (answer.observation.state !== "authenticated" &&
            answer.observation.state !== "signed_out") ||
          !Number.isFinite(now) ||
          now < startedAt ||
          now >= deadlineAt ||
          !available() ||
          read.sequence !== readSequence ||
          !documentCurrent(read)
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
        currentObservation = { result, read, startedAt, deadlineAt };
        return result;
      } catch {
        // Native exceptions never escape as page content or positive evidence.
        return unconfirmedReadiness("exception", null);
      } finally {
        cancel?.();
      }
    };

  const isCurrentSignInStatus = (
    result: ChatGptSignInStatusObservation,
  ): boolean => {
    const retained = currentObservation;
    if (!retained || retained.result !== result) return false;
    try {
      const now = ports.clock.now();
      if (
        Number.isFinite(now) &&
        now >= retained.startedAt &&
        now < retained.deadlineAt &&
        available() &&
        retained.read.sequence === readSequence &&
        documentCurrent(retained.read)
      )
        return true;
    } catch {
      // A lost native document is unknown, never a reusable binding.
    }
    currentObservation = null;
    return false;
  };

  return {
    observe,
    observeSignInStatus,
    isCurrentSignInStatus,
    readPage,
    invalidate: () => {
      ++readSequence;
    },
    sequence: () => readSequence,
    latest: () => latestReadiness,
  };
}

// The task script runner ------------------------------------------------------

export type TaskScriptSurface<Contents> = Readonly<{
  isDestroyed: () => boolean;
  webContents: Contents;
}>;

export type TaskScriptPorts<Contents extends ObservedContents> = Readonly<{
  route: Readonly<{
    surface: () => TaskScriptSurface<Contents> | null;
    disposing: () => boolean;
    observationGeneration: () => number;
    physicalDocumentGeneration: () => number;
    documentLoadFailed: () => boolean;
    documentAwaitingCommit: () => boolean;
  }>;
  clock: Readonly<{
    now: () => number;
    after: (callback: () => void, ms: number) => () => void;
  }>;
}>;

export type TaskScriptRefusalReason = "document" | "deadline";

// The runner declined to hand the script to either JavaScript executor, so
// nothing ran in the page. Every other rejection happens once the script was
// issued and says nothing about what the page did with it.
export class TaskScriptNotDispatchedError extends Error {
  readonly reason: TaskScriptRefusalReason;
  constructor(reason: TaskScriptRefusalReason) {
    super(
      reason === "deadline"
        ? "ChatGPT task deadline exceeded"
        : "ChatGPT task document unavailable",
    );
    this.name = "TaskScriptNotDispatchedError";
    this.reason = reason;
  }
}

export function taskScriptRefusalReason(
  error: unknown,
): TaskScriptRefusalReason | null {
  return error instanceof TaskScriptNotDispatchedError ? error.reason : null;
}

// One caller's claim on one script. The caller revokes it when it gives up
// waiting; the runner checks it in the same synchronous step that hands the
// script to an executor and then records the hand-off. Both run on one thread,
// so exactly one side wins: a revoked gate never reaches the page, and a
// dispatched one is the caller's to treat as unknown.
export type TaskScriptDispatchGate = {
  revoked: boolean;
  dispatched: boolean;
};

export type TaskScriptRunner<Contents> = (
  contents: Contents,
  script: string,
  gesture: boolean,
  deadline: number,
  operationGeneration: number,
  allowNavigationAfter?: boolean | "response",
  gate?: TaskScriptDispatchGate,
) => Promise<unknown>;

// Execute against the captured frame rather than WebContents' full-load queue.
// The caller retains one deadline and its dispatch/UNKNOWN custody. Send alone
// may navigate before its original acknowledgement returns; it proves no auth.
export function createTaskScriptRunner<Contents extends ObservedContents>(
  ports: TaskScriptPorts<Contents>,
): TaskScriptRunner<Contents> {
  return async (
    contents,
    script,
    gesture,
    deadline,
    operationGeneration,
    allowNavigationAfter = false,
    gate,
  ) => {
    // Everything up to the executor call reads native objects, which throw once
    // destroyed. Whatever refuses here, nothing was issued to the page.
    let surface: TaskScriptSurface<Contents> | null;
    let documentGeneration: number;
    let url: string;
    let frame: ObservedContents["mainFrame"];
    let sameOperation: () => boolean;
    let samePhysicalDocument: () => boolean;
    let sameDocument: () => boolean;
    try {
      surface = ports.route.surface();
      documentGeneration = ports.route.physicalDocumentGeneration();
      url = contents.getURL();
      frame = contents.mainFrame;
      sameOperation = () =>
        surface !== null &&
        ports.route.surface() === surface &&
        !surface.isDestroyed() &&
        !ports.route.disposing() &&
        surface.webContents === contents &&
        ports.route.observationGeneration() === operationGeneration;
      samePhysicalDocument = () =>
        sameOperation() &&
        !ports.route.documentLoadFailed() &&
        !ports.route.documentAwaitingCommit() &&
        ports.route.physicalDocumentGeneration() === documentGeneration &&
        (!frame || (contents.mainFrame === frame && !frame.isDestroyed()));
      sameDocument = () =>
        samePhysicalDocument() &&
        contents.getURL() === url &&
        (!frame || frame.url === url);
      if (!sameDocument()) throw new TaskScriptNotDispatchedError("document");
    } catch {
      throw new TaskScriptNotDispatchedError("document");
    }
    if (ports.clock.now() >= deadline)
      throw new TaskScriptNotDispatchedError("deadline");
    // The last check before the executor, with nothing awaited after it.
    if (gate) {
      if (gate.revoked) throw new TaskScriptNotDispatchedError("deadline");
      gate.dispatched = true;
    }
    {
      const value: unknown = await raceDeadline<unknown, never>(
        frame
          ? frame.executeJavaScript(script, gesture)
          : contents.executeJavaScript(script, gesture),
        deadline,
        ports.clock,
        () => {
          throw new Error("ChatGPT task deadline exceeded");
        },
      );
      // Response polling owns the allowed first in-place conversation transition.
      // It still cannot adopt a replaced physical document or retired task.
      if (
        frame &&
        (allowNavigationAfter === "response"
          ? !samePhysicalDocument()
          : !allowNavigationAfter && !sameDocument())
      )
        throw new Error("ChatGPT task document unavailable");
      return value;
    }
  };
}
