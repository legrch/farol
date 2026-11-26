import {
  allowedChatGptPageUrl,
  classifyChatGptPage,
  type ChatGptPageObservation,
} from "../../../src/apps/desktop/chatgpt-page-policy";
import { readinessProbe } from "../../../src/apps/desktop/chatgpt/scripts";
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

  const readPage = async (userGesture: boolean): Promise<SignInRead> => {
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
      answer = frame
        ? await frame.executeJavaScript(readinessProbe, userGesture)
        : await candidate.webContents.executeJavaScript(
            readinessProbe,
            userGesture,
          );
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

  const observe = async (): Promise<ChatGptPageObservation> => {
    const document = capture();
    const { sequence, surface, documentGeneration, url } = document;
    const read = await readPage(true);
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

export type TaskScriptRunner<Contents> = (
  contents: Contents,
  script: string,
  gesture: boolean,
  deadline: number,
  operationGeneration: number,
  allowNavigationAfter?: boolean | "response",
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
  ) => {
    const surface = ports.route.surface();
    const documentGeneration = ports.route.physicalDocumentGeneration();
    const url = contents.getURL();
    const frame = contents.mainFrame;
    const sameOperation = () =>
      surface !== null &&
      ports.route.surface() === surface &&
      !surface.isDestroyed() &&
      !ports.route.disposing() &&
      surface.webContents === contents &&
      ports.route.observationGeneration() === operationGeneration;
    const samePhysicalDocument = () =>
      sameOperation() &&
      !ports.route.documentLoadFailed() &&
      !ports.route.documentAwaitingCommit() &&
      ports.route.physicalDocumentGeneration() === documentGeneration &&
      (!frame || (contents.mainFrame === frame && !frame.isDestroyed()));
    const sameDocument = () =>
      samePhysicalDocument() &&
      contents.getURL() === url &&
      (!frame || frame.url === url);
    if (!sameDocument() || ports.clock.now() >= deadline)
      throw new Error("ChatGPT task document unavailable");
    let cancel: (() => void) | undefined;
    try {
      const value: unknown = await Promise.race([
        frame
          ? frame.executeJavaScript(script, gesture)
          : contents.executeJavaScript(script, gesture),
        new Promise<never>((_resolve, reject) => {
          cancel = ports.clock.after(
            () => reject(new Error("ChatGPT task deadline exceeded")),
            Math.max(0, deadline - ports.clock.now()),
          );
        }),
      ]);
      if (ports.clock.now() >= deadline)
        throw new Error("ChatGPT task deadline exceeded");
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
    } finally {
      cancel?.();
    }
  };
}
