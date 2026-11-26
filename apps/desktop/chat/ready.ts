import { isChatGptPage } from "./policy";
import type { ChatGptSignInBlockedDiagnostic } from "./signin";
import {
  SIGN_IN_RETURN_SENTINEL,
  collapseChatGptSidebarScript,
  signInBannerScript,
} from "../../../src/apps/desktop/chatgpt/scripts";

// How the ChatGPT route learns that its page is ready, and the same for the
// popups a page opens. The route keeps every field these listeners write (the
// load state, the document generations, the awaiting-commit and load-failed
// flags, the popup books) and each write goes through a setter port at the
// point the original code wrote it; the listeners are registered in the same
// order on the same events. Nothing here retries or widens a refusal: the
// submission gate that cannot be installed leaves the surface blocked, and a
// document that failed to commit never becomes ready.

// The route's contents ------------------------------------------------------

type FrameIdentity = Readonly<{
  processId: number;
  routingId: number;
}>;

type ConsoleMessage = Readonly<{
  message: string;
  frame: (FrameIdentity & Readonly<{ url: string }>) | null | undefined;
}>;

// The part of an Electron `WebContents` the readiness listeners use.
// Structural, so a test can lend a fake that emits the events by hand.
export type ReadinessContents = Readonly<{
  getURL: () => string;
  mainFrame: FrameIdentity;
  executeJavaScript: (script: string, gesture?: boolean) => Promise<unknown>;
  on(
    event: "did-redirect-navigation",
    listener: (
      event: unknown,
      url: string,
      inPlace: boolean,
      isMainFrame: boolean,
    ) => void,
  ): unknown;
  on(
    event: "did-start-navigation",
    listener: (
      event: unknown,
      url: string,
      inPlace: boolean,
      isMainFrame: boolean,
    ) => void,
  ): unknown;
  on(
    event: "did-navigate",
    listener: (event: unknown, url: string) => void,
  ): unknown;
  on(
    event: "did-fail-load",
    listener: (
      event: unknown,
      code: number,
      description: string,
      url: string,
      isMainFrame: boolean,
    ) => void,
  ): unknown;
  on(
    event: "did-navigate-in-page",
    listener: (event: unknown, url: string, isMainFrame: boolean) => void,
  ): unknown;
  on(
    event: "dom-ready" | "did-finish-load" | "render-process-gone",
    listener: () => void,
  ): unknown;
  on(
    event: "console-message",
    listener: (details: ConsoleMessage) => void,
  ): unknown;
}>;

export type ReadinessLoad = "failed" | "loaded";

// The route's fields, read and written one at a time.
export type ReadinessRouteState = Readonly<{
  load: () => ReadinessLoad;
  setLoad: (load: ReadinessLoad) => void;
  loadFailed: () => boolean;
  setLoadFailed: (failed: boolean) => void;
  awaitingCommit: () => boolean;
  setAwaitingCommit: (awaiting: boolean) => void;
  // `routeDocumentGeneration += 1`.
  advanceDocument: () => void;
  // `chatPhysicalDocumentGeneration += 1`.
  advancePhysicalDocument: () => void;
}>;

// The route's own window, which may be absent: each call is a no-op then.
export type ReadinessSurface = Readonly<{
  hide: () => void;
  reveal: () => void;
  isWindow: () => boolean;
}>;

// Read when the original code read them.
export type ReadinessOptions = Readonly<{
  // Protected task surface: no ordinary-browser readiness, no manual messages.
  requireApp: () => boolean;
  collapseSidebar: () => boolean;
  homeUrl: () => string;
  signInMode: () => boolean;
  title: () => string;
  // Someone listens for task activity.
  observesTaskActivity: () => boolean;
}>;

export type ReadinessEvents = Readonly<{
  loadState: (state: "loading" | "loaded" | "failed") => void;
  conversationUrl: () => void;
  blocked: (diagnostic: ChatGptSignInBlockedDiagnostic) => void;
  signInReturn: () => void;
  // The page died while the task was running: the outcome is unknown.
  taskOutcomeUnknown: () => void;
}>;

export type ReadinessGate = Readonly<{
  install: () => Promise<"installed" | "failed" | "stale">;
  // The gate could not be installed: the manual surface is made unusable.
  blockUnsafe: () => void;
}>;

export type ReadinessActivity = Readonly<{
  start: () => void;
  running: () => boolean | null;
  stop: () => void;
}>;

export type RouteReadinessPorts = Readonly<{
  allowed: (url: string) => boolean;
  // The route still owns these contents.
  owns: () => boolean;
  state: ReadinessRouteState;
  surface: ReadinessSurface;
  options: ReadinessOptions;
  events: ReadinessEvents;
  gate: ReadinessGate;
  activity: ReadinessActivity;
}>;

/**
 * Registers the readiness, load-state and submission-gate listeners on the
 * route's contents, in this order: redirect, navigate, dom-ready, start,
 * fail, finish, console, in-page navigation, renderer gone. A full navigation
 * waits for its commit; a failure or a cancelled earlier navigation never
 * describes the successor's document; the submission gate is installed before
 * a finished load is trusted, and a gate that fails blocks the surface.
 */
export function trackRouteReadiness(
  contents: ReadinessContents,
  ports: RouteReadinessPorts,
): void {
  const { allowed, owns, state, surface, options, events, gate, activity } =
    ports;
  let currentNavigationUrl: string | null = null;
  const trackNavigationUrl = (
    _event: unknown,
    url: string,
    _inPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && owns() && allowed(url)) currentNavigationUrl = url;
  };
  contents.on("did-redirect-navigation", trackNavigationUrl);
  contents.on("did-navigate", (_event, url) => {
    if (
      !owns() ||
      !allowed(url) ||
      (currentNavigationUrl !== null && url !== currentNavigationUrl)
    )
      return;
    currentNavigationUrl = url;
    // Electron emits did-navigate only for a committed non-error page.
    // Its commit supersedes failures from an earlier same-URL navigation.
    state.setLoadFailed(false);
    state.setAwaitingCommit(false);
  });
  contents.on("dom-ready", () => {
    // Ordinary browser readiness belongs to every committed document, not
    // just the initial loadURL promise. This permits a read of the current
    // DOM while slow subresources load; it never authorizes submission.
    if (
      options.requireApp() ||
      !owns() ||
      state.loadFailed() ||
      state.awaitingCommit() ||
      !allowed(contents.getURL()) ||
      state.load() === "loaded"
    )
      return;
    state.setLoad("loaded");
    events.loadState("loaded");
    events.conversationUrl();
  });
  contents.on("did-start-navigation", (_event, url, inPlace, isMainFrame) => {
    if (!isMainFrame || !owns()) return;
    // A navigation the policy refuses (will-navigate/will-redirect)
    // never finishes and the current page stays: it must not leave
    // the route believing that page failed. A refused navigation
    // that commits or fails anyway is caught by did-navigate and
    // did-fail-load.
    if (!allowed(url)) return;
    if (!inPlace) {
      currentNavigationUrl = url;
      state.setAwaitingCommit(true);
    }
    state.advanceDocument();
    if (!inPlace) state.advancePhysicalDocument();
    if (!inPlace) state.setLoadFailed(false);
    if (!inPlace && options.requireApp()) {
      surface.hide();
    }
    state.setLoad(inPlace ? "loaded" : "failed");
    events.loadState(inPlace ? "loaded" : "loading");
  });
  contents.on(
    "did-fail-load",
    (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame && owns()) {
        // Cancellation does not describe the successor's document. This
        // grants no readiness: a full navigation still needs its commit.
        if (code === -3) return;
        // A cancelled earlier auth navigation can fail after its successor
        // has begun. It must not poison that successor's readiness.
        if (currentNavigationUrl !== null && url !== currentNavigationUrl)
          return;
        state.advanceDocument();
        state.setLoadFailed(true);
        state.setLoad("failed");
        events.loadState("failed");
        events.blocked({ kind: "load-failed", code });
      }
    },
  );
  contents.on("did-finish-load", () => {
    if (!owns()) return;
    if (state.loadFailed() || state.awaitingCommit()) return;
    void (async () => {
      const installed = await gate.install();
      if (installed === "stale") return;
      if (installed === "failed") {
        gate.blockUnsafe();
        return;
      }
      if (!owns()) return;
      if (
        options.collapseSidebar() &&
        isChatGptPage(contents.getURL(), options.homeUrl())
      ) {
        void contents
          .executeJavaScript(collapseChatGptSidebarScript(), true)
          .catch(() => undefined);
      }
      state.setLoad("loaded");
      events.loadState("loaded");
      events.conversationUrl();
      surface.reveal();
      if (options.observesTaskActivity()) {
        activity.start();
      }
      if (
        options.signInMode() &&
        surface.isWindow() &&
        isChatGptPage(contents.getURL(), options.homeUrl())
      ) {
        void contents
          .executeJavaScript(signInBannerScript(options.title()), true)
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
      options.signInMode() &&
      details.message === SIGN_IN_RETURN_SENTINEL &&
      frame !== null &&
      frame !== undefined &&
      frame.processId === contents.mainFrame.processId &&
      frame.routingId === contents.mainFrame.routingId &&
      isChatGptPage(frame.url, options.homeUrl()) &&
      owns()
    ) {
      events.signInReturn();
    }
  });
  contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
    if (!isMainFrame || !owns()) return;
    if (!state.awaitingCommit()) currentNavigationUrl = _url;
    state.advanceDocument();
    events.loadState(state.load());
    events.conversationUrl();
    void gate.install().then((installed) => {
      if (installed === "failed") gate.blockUnsafe();
    });
  });
  contents.on("render-process-gone", () => {
    if (!owns()) return;
    if (activity.running() === true) {
      events.taskOutcomeUnknown();
    }
    activity.stop();
    state.advancePhysicalDocument();
    state.advanceDocument();
    state.setLoad("failed");
    events.loadState("failed");
    surface.hide();
  });
}

// The popups -----------------------------------------------------------------

export type PopupContents = Readonly<{
  on(
    event: "did-start-navigation",
    listener: (
      event: unknown,
      url: string,
      inPlace: boolean,
      isMainFrame: boolean,
    ) => void,
  ): unknown;
  on(event: "did-finish-load", listener: () => void): unknown;
  on(
    event: "did-navigate-in-page",
    listener: (event: unknown, url: string, isMainFrame: boolean) => void,
  ): unknown;
}>;

// The part of an Electron `BrowserWindow` the adoption uses.
export type AdoptedPopup = Readonly<{
  webContents: PopupContents;
  isDestroyed: () => boolean;
  hide: () => void;
  destroy: () => void;
  on(event: "closed", listener: () => void): unknown;
  once(event: "ready-to-show", listener: () => void): unknown;
}>;

// The route's popup books, one write at a time.
export type PopupBooks<Popup> = Readonly<{
  add: (popup: Popup) => void;
  resetGeneration: (popup: Popup) => void;
  // The popup closed: forgotten by the window, ready and gate books.
  release: (popup: Popup) => void;
  markReady: (popup: Popup) => void;
  advanceGeneration: (popup: Popup) => void;
  ungate: (popup: Popup) => void;
  gate: (popup: Popup) => void;
}>;

export type PopupAdoptionPorts<Popup> = Readonly<{
  books: PopupBooks<Popup>;
  // The popup's own hardening.
  harden: (popup: Popup) => void;
  // A window presentation or a required app asks for a hidden first show.
  hiddenFirst: () => boolean;
  requireApp: () => boolean;
  reconcile: (popup: Popup) => void;
  installGate: (popup: Popup) => Promise<"installed" | "failed" | "stale">;
}>;

/**
 * Takes a popup the page opened into the route's books and hardens it. With a
 * window presentation or a required app it is hidden until it is ready to
 * show; on a protected surface every full navigation hides it again and drops
 * its gate, and it is destroyed when its submission gate cannot be installed.
 */
export function adoptPopupWindow<Popup extends AdoptedPopup>(
  popup: Popup,
  ports: PopupAdoptionPorts<Popup>,
): void {
  const { books } = ports;
  books.add(popup);
  books.resetGeneration(popup);
  ports.harden(popup);
  popup.on("closed", () => {
    books.release(popup);
  });
  if (ports.hiddenFirst()) {
    popup.hide();
    popup.once("ready-to-show", () => {
      if (popup.isDestroyed()) return;
      books.markReady(popup);
      ports.reconcile(popup);
    });
  }
  if (ports.requireApp()) {
    popup.webContents.on(
      "did-start-navigation",
      (_event, _url, inPlace, isMainFrame) => {
        if (!isMainFrame || inPlace || popup.isDestroyed()) return;
        books.advanceGeneration(popup);
        books.ungate(popup);
        popup.hide();
      },
    );
    popup.webContents.on("did-finish-load", () => {
      void ports.installGate(popup).then((gate) => {
        if (gate === "stale") return;
        if (gate === "failed") {
          if (!popup.isDestroyed()) popup.destroy();
          return;
        }
        books.gate(popup);
        ports.reconcile(popup);
      });
    });
    popup.webContents.on(
      "did-navigate-in-page",
      (_event, _url, isMainFrame) => {
        if (!isMainFrame) return;
        books.advanceGeneration(popup);
        void ports.installGate(popup).then((gate) => {
          if (gate === "failed" && !popup.isDestroyed()) popup.destroy();
        });
      },
    );
  }
}
