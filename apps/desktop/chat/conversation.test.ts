import vm from "node:vm";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  CONNECTION_CHECK_READ_MS,
  DEFAULT_ROUTE_TITLE,
  STOP_SCRIPT_EXPIRY_MS,
  applyRouteTitle,
  createConnectionCheckOpener,
  createConversationUrls,
  createManualTargets,
  createRouteReset,
  createTaskCanceller,
  routeOwnsContents,
  routeTitle,
} from "./conversation";

const CONVERSATION = "https://chatgpt.com/c/abcdef123456";
const HOME = "https://chatgpt.com/";

type Contents = {
  id: number;
  url: string;
  destroyed: boolean;
  getURL: () => string;
  isDestroyed: () => boolean;
  executeJavaScript: Mock<
    (script: string, gesture?: boolean) => Promise<unknown>
  >;
};

function contents(url: string, id = 7): Contents {
  const state: Contents = {
    id,
    url,
    destroyed: false,
    getURL: () => state.url,
    isDestroyed: () => state.destroyed,
    executeJavaScript: vi.fn(),
  };
  return state;
}

type Surface = {
  webContents: Contents;
  destroyed: boolean;
  title: string | null;
  isDestroyed: () => boolean;
  setTitle: (title: string) => void;
  destroy: () => void;
};

function surface(webContents: Contents): Surface {
  const state: Surface = {
    webContents,
    destroyed: false,
    title: null,
    isDestroyed: () => state.destroyed,
    setTitle: (title) => {
      state.title = title;
    },
    destroy: () => {
      state.destroyed = true;
    },
  };
  return state;
}

function urlsHarness(
  input: {
    surface?: Surface | null;
    disposing?: boolean;
    loaded?: boolean;
    entryUrl?: string;
    listener?: boolean;
    e2eOrigin?: string | null;
  } = {},
) {
  const state = {
    surface: input.surface ?? null,
    disposing: input.disposing ?? false,
    loaded: input.loaded ?? true,
    entryUrl: input.entryUrl ?? HOME,
  };
  const changed = vi.fn();
  const urls = createConversationUrls<Contents>({
    surface: () => state.surface,
    disposing: () => state.disposing,
    loaded: () => state.loaded,
    entryUrl: () => state.entryUrl,
    setEntryUrl: (url) => {
      state.entryUrl = url;
    },
    e2eOrigin: () => input.e2eOrigin ?? null,
    homeUrl: HOME,
    changed: () => (input.listener === false ? undefined : changed),
  });
  return { state, changed, urls };
}

describe("route ownership", () => {
  it("owns only the live window's own contents while not closing", () => {
    const own = contents(CONVERSATION);
    const live = surface(own);
    expect(routeOwnsContents(false, live, own)).toBe(true);
    expect(routeOwnsContents(true, live, own)).toBe(false);
    expect(routeOwnsContents(false, null, own)).toBe(false);
    expect(routeOwnsContents(false, live, contents(CONVERSATION, 8))).toBe(
      false,
    );
    live.destroy();
    expect(routeOwnsContents(false, live, own)).toBe(false);
  });
});

describe("conversation address", () => {
  it("canonicalizes a conversation and remembers it for the owning window", () => {
    const own = contents(`${CONVERSATION}/`);
    const { state, urls } = urlsHarness({ surface: surface(own) });
    expect(urls.capture(own)).toBe(CONVERSATION);
    expect(state.entryUrl).toBe(CONVERSATION);
  });

  it("returns the address without remembering it for foreign contents", () => {
    const own = contents(CONVERSATION);
    const other = contents("https://chatgpt.com/c/zzzzzzzz9999", 9);
    const { state, urls } = urlsHarness({ surface: surface(own) });
    expect(urls.capture(other)).toBe("https://chatgpt.com/c/zzzzzzzz9999");
    expect(state.entryUrl).toBe(HOME);
  });

  it("does not remember an address while the route is closing", () => {
    const own = contents(CONVERSATION);
    const { state, urls } = urlsHarness({
      surface: surface(own),
      disposing: true,
    });
    expect(urls.capture(own)).toBe(CONVERSATION);
    expect(state.entryUrl).toBe(HOME);
  });

  it("reads null for destroyed contents and for a non-conversation page", () => {
    const own = contents(CONVERSATION);
    const { state, urls } = urlsHarness({ surface: surface(own) });
    own.destroyed = true;
    expect(urls.capture(own)).toBeNull();
    own.destroyed = false;
    own.url = HOME;
    expect(urls.capture(own)).toBeNull();
    expect(state.entryUrl).toBe(HOME);
  });

  it("accepts the fixture origin only when configured", () => {
    const own = contents("http://127.0.0.1:9/chatgpt/c/abcdef123456");
    const open = urlsHarness({
      surface: surface(own),
      e2eOrigin: "http://127.0.0.1:9",
    });
    expect(open.urls.capture(own)).toBe(
      "http://127.0.0.1:9/chatgpt/c/abcdef123456",
    );
    expect(urlsHarness({ surface: surface(own) }).urls.capture(own)).toBeNull();
  });

  it("reports the canonical conversation to the owner", () => {
    const own = contents(CONVERSATION);
    const { changed, urls } = urlsHarness({ surface: surface(own) });
    urls.report(own);
    expect(changed).toHaveBeenCalledExactlyOnceWith(CONVERSATION);
  });

  it("reports nothing without a listener, for foreign contents or while closing", () => {
    const own = contents(CONVERSATION);
    const noListener = urlsHarness({ surface: surface(own), listener: false });
    noListener.urls.report(own);
    expect(noListener.state.entryUrl).toBe(HOME);

    const foreign = urlsHarness({ surface: surface(own) });
    foreign.urls.report(contents(CONVERSATION, 9));
    expect(foreign.changed).not.toHaveBeenCalled();

    const closing = urlsHarness({ surface: surface(own), disposing: true });
    closing.urls.report(own);
    expect(closing.changed).not.toHaveBeenCalled();
    expect(closing.state.entryUrl).toBe(HOME);
  });

  it("clears the conversation when the window returns to the home page", () => {
    const own = contents(`${HOME}?x=1`);
    const { state, changed, urls } = urlsHarness({
      surface: surface(own),
      entryUrl: CONVERSATION,
    });
    urls.report(own);
    expect(state.entryUrl).toBe(HOME);
    expect(changed).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("leaves the binding alone on another page, another origin or a bad URL", () => {
    const own = contents("https://chatgpt.com/gpts");
    const { state, changed, urls } = urlsHarness({
      surface: surface(own),
      entryUrl: CONVERSATION,
    });
    urls.report(own);
    own.url = "https://example.com/";
    urls.report(own);
    own.url = "not a url";
    urls.report(own);
    expect(state.entryUrl).toBe(CONVERSATION);
    expect(changed).not.toHaveBeenCalled();
  });

  it("reads the current address only from a live, loaded window", () => {
    const own = contents(CONVERSATION);
    const live = surface(own);
    const harness = urlsHarness({ surface: live });
    expect(harness.urls.current()).toBe(CONVERSATION);
    harness.state.loaded = false;
    expect(harness.urls.current()).toBeNull();
    harness.state.loaded = true;
    live.destroy();
    expect(harness.urls.current()).toBeNull();
    harness.state.surface = null;
    expect(harness.urls.current()).toBeNull();
  });

  it("retains the entry address only when it is a conversation", () => {
    expect(urlsHarness({ entryUrl: `${CONVERSATION}/` }).urls.retained()).toBe(
      CONVERSATION,
    );
    expect(urlsHarness({ entryUrl: HOME }).urls.retained()).toBeNull();
  });
});

// A fake renderer for the cancellation scripts. One `Doc` is one document: its
// window object (where the page keeps its stamps) and the path it shows. A
// single-page navigation changes the path and keeps the window; a reload is a
// new document. The real script text runs, so what is asserted is what the page
// would do.
const ORIGIN = "https://chatgpt.com";
const A = "/c/aaaaaaaa-0000";
const B = "/c/bbbbbbbb-0000";
const GPT_A = "/g/g-example/c/aaaaaaaa-0000";
const GPT_B = "/g/g-example/c/bbbbbbbb-0000";
const clock = { now: 5_000_000 };
// The page-turn epoch a Route B turn leaves in its page. Nothing clears it: a
// document that was never marked (or was reloaded) simply has none, which the
// page reads as 0.
const TURN_KEY = Symbol.for("farol.cancel.turn");
const markTurn = (doc: Doc, epoch: number): void => {
  Object.defineProperty(doc.win, TURN_KEY, {
    value: epoch,
    configurable: true,
  });
};
const pageEpoch = (doc: Doc): unknown => doc.win[TURN_KEY];
const HOLD = Symbol("hold");

type Doc = {
  path: string;
  stop: boolean;
  win: Record<PropertyKey, unknown>;
};

function newDoc(path: string, options: { stop?: boolean } = {}): Doc {
  return { path, stop: options.stop ?? false, win: {} };
}

// Runs one page script against a document; `onClick` sees every Stop click.
function runInPage(script: string, doc: Doc, onClick: () => void): unknown {
  class FakeElement {}
  class FakeButton extends FakeElement {
    disabled = false;
    click(): void {
      onClick();
    }
    getBoundingClientRect() {
      return { width: 10, height: 10 };
    }
  }
  const stop = new FakeButton();
  const answer = vm.runInNewContext(script, {
    location: {
      origin: ORIGIN,
      pathname: doc.path,
      href: `${ORIGIN}${doc.path}`,
    },
    window: doc.win,
    Date: { now: () => clock.now },
    document: {
      querySelector: (selector: string) =>
        doc.stop && selector === '[data-testid="stop-button"]' ? stop : null,
    },
    HTMLElement: FakeElement,
    HTMLButtonElement: FakeButton,
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  }) as unknown;
  return JSON.parse(JSON.stringify(answer)) as unknown;
}

// Which of the canceller's page scripts a call carries.
const kindOf = (script: string): "bind" | "click" | "probe" =>
  script.includes("stop.click()")
    ? "click"
    : script.includes("bound: true")
      ? "bind"
      : "probe";

type CancelTurn = {
  epoch: number;
  dispatchIdentityUrl: string | null;
  pinnedConversationUrl: string | null;
  // Whether the turn reached its dispatch intent; sent unless a test says not.
  dispatched?: boolean;
  // Where the turn's own message was last seen; on the conversation the turn
  // names unless a test says otherwise.
  correlatedConversationUrl?: string | null;
  // Whether a thread's admission began the turn; the task's own unless a test
  // says otherwise.
  admitted?: boolean;
};

type CancelInput = {
  doc?: Doc;
  observedRunning?: boolean;
  loaded?: boolean;
  noSurface?: boolean;
  routeB?: boolean;
  turn?: CancelTurn | null;
  // The route's page-turn epoch when the Cancel starts; the turn's own, or 0.
  epoch?: number;
  // A turn was admitted on the route and has not begun running.
  admitting?: boolean;
  // Replaces the route's document generation read.
  documentGeneration?: () => number;
  // Answers a page call instead of the page; `undefined` lets the page run it.
  // It may also move the page first.
  answer?: (script: string, call: number) => unknown;
  onDelay?: (count: number) => void;
};

type CancelState = {
  surface: Surface | null;
  doc: Doc;
  loaded: boolean;
  // The route's observation generation, and how often it was ended.
  observation: number;
  generation: number;
  // The route's page-turn epoch: only ever advanced by a turn's admission.
  epoch: number;
  // The route's document generation: advanced by every full navigation and
  // reload of the window.
  document: number;
  admitting: boolean;
  turn: CancelTurn | null;
  stopped: number;
  clicks: number;
};

function cancelHarness(input: CancelInput = {}) {
  const state: CancelState = {
    surface: null,
    doc: input.doc ?? newDoc(A),
    loaded: input.loaded ?? true,
    observation: input.turn?.epoch ?? 0,
    generation: 0,
    epoch: input.epoch ?? input.turn?.epoch ?? 0,
    document: 1,
    admitting: input.admitting ?? false,
    turn: input.turn ?? null,
    stopped: 0,
    clicks: 0,
  };
  const page = contents(`${ORIGIN}${state.doc.path}`);
  page.getURL = () => `${ORIGIN}${state.doc.path}`;
  state.surface = input.noSurface ? null : surface(page);
  // A Route B turn marks its page when it starts.
  if (input.routeB && input.turn) markTurn(state.doc, input.turn.epoch);
  else if (input.routeB && state.epoch > 0) markTurn(state.doc, state.epoch);
  clock.now = 5_000_000;
  const scripts: string[] = [];
  page.executeJavaScript.mockImplementation((script: string) => {
    scripts.push(script);
    const forced = input.answer?.(script, scripts.length);
    if (forced === HOLD) return new Promise(() => undefined);
    if (forced instanceof Error) return Promise.reject(forced);
    if (forced !== undefined) return Promise.resolve(forced);
    return Promise.resolve(
      runInPage(script, state.doc, () => {
        state.clicks += 1;
      }),
    );
  });
  const delays: number[] = [];
  const timers: { ms: number; cleared: boolean; fire: () => void }[] = [];
  let tokens = 0;
  const cancel = createTaskCanceller<Contents, Surface>({
    surface: () => state.surface,
    loaded: () => state.loaded,
    observation: () => state.observation,
    supersedeObservation: (generation) => {
      // As the route does: only the observation the Cancel started on.
      if (generation !== state.observation) return;
      state.observation += 1;
      state.generation += 1;
    },
    observedRunning: () => input.observedRunning ?? false,
    admittedAsRouteB: () => input.routeB ?? false,
    epoch: () => state.epoch,
    documentGeneration: input.documentGeneration ?? (() => state.document),
    admitting: () => state.admitting,
    turn: () =>
      state.turn === null
        ? null
        : {
            dispatched: true,
            admitted: true,
            correlatedConversationUrl:
              state.turn.pinnedConversationUrl ??
              state.turn.dispatchIdentityUrl,
            ...state.turn,
          },
    now: () => clock.now,
    newToken: () => {
      tokens += 1;
      return `token-${tokens}`;
    },
    after: (callback, ms) => {
      const timer = { ms, cleared: false, fire: callback };
      timers.push(timer);
      return () => {
        timer.cleared = true;
      };
    },
    delay: (ms) => {
      delays.push(ms);
      input.onDelay?.(delays.length);
      return Promise.resolve();
    },
    recordStopped: () => {
      state.stopped += 1;
    },
  });
  return { cancel, state, scripts, delays, timers, page };
}

// A running document whose Stop control goes away after the first wait.
function stopping(path: string): {
  doc: Doc;
  onDelay: (count: number) => void;
} {
  const doc = newDoc(path, { stop: true });
  return {
    doc,
    onDelay: (count) => {
      if (count === 1) doc.stop = false;
    },
  };
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};
const clickScripts = (scripts: string[]): string[] =>
  scripts.filter((script) => kindOf(script) === "click");
const kinds = (scripts: string[]): string[] => scripts.map(kindOf);
const stamped = (doc: Doc): boolean =>
  Object.getOwnPropertySymbols(doc.win).some(
    (key) => key.description === "farol.cancel.document",
  );

describe("cancelling a task", () => {
  it("leaves the observation of a route that is not Route B alone when there is no page to cancel", async () => {
    // Nothing was verified and nothing clicked: no effect on any generation.
    for (const input of [{ noSurface: true }, { loaded: false }] as const) {
      const harness = cancelHarness(input);
      expect(await harness.cancel()).toBe("not_running");
      expect(harness.state.generation).toBe(0);
      expect(harness.scripts).toEqual([]);
    }
    const destroyed = cancelHarness();
    destroyed.state.surface?.destroy();
    expect(await destroyed.cancel()).toBe("not_running");
    expect(destroyed.state.generation).toBe(0);
  });

  it("leaves the observation of a Route B route alone when there is no page to cancel", async () => {
    // No turn of Farol's is in flight: refused before anything, so nothing
    // was bound or clicked and no turn is ended.
    for (const input of [{ noSurface: true }, { loaded: false }] as const) {
      const harness = cancelHarness({ ...input, routeB: true, epoch: 1 });
      expect(await harness.cancel()).toBe("page_changed");
      expect(harness.state.generation).toBe(0);
      expect(harness.scripts).toEqual([]);
    }
  });

  it("is not running when the stop control is absent for a task never seen running", async () => {
    const harness = cancelHarness();
    expect(await harness.cancel()).toBe("not_running");
    expect(kinds(harness.scripts)).toEqual(["bind", "click"]);
    expect(harness.delays).toEqual([]);
    expect(harness.state.stopped).toBe(0);
    // No Stop was activated, so no observation was ended.
    expect(harness.state.generation).toBe(0);
  });

  it("clicks stop, waits for the page to stop and records it", async () => {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      onDelay: (count) => {
        if (count === 2) doc.stop = false;
      },
    });
    expect(await harness.cancel()).toBe("cancelled");
    expect(kinds(harness.scripts)).toEqual(["bind", "click", "probe", "probe"]);
    expect(harness.state.clicks).toBe(1);
    expect(harness.delays).toEqual([100, 100]);
    expect(harness.state.stopped).toBe(1);
    expect(harness.state.generation).toBe(1);
  });

  it("retries the stop control five times for a task seen running, each with its own token, and refuses when none found a Stop", async () => {
    const harness = cancelHarness({ observedRunning: true });
    // Every attempt answered that it clicked nothing.
    expect(await harness.cancel()).toBe("not_running");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
    const clicks = clickScripts(harness.scripts);
    expect(clicks).toHaveLength(5);
    expect(new Set(clicks).size).toBe(5);
    for (const token of ["token-2", "token-3", "token-4", "token-5"])
      expect(clicks.filter((script) => script.includes(token))).toHaveLength(1);
    expect(harness.delays).toEqual([100, 100, 100, 100, 100]);
    expect(harness.state.stopped).toBe(0);
  });

  it("stops retrying once the control activates", async () => {
    const doc = newDoc(A);
    const harness = cancelHarness({
      doc,
      observedRunning: true,
      onDelay: (count) => {
        if (count === 2) doc.stop = true;
        if (count === 3) doc.stop = false;
      },
    });
    expect(await harness.cancel()).toBe("cancelled");
    expect(clickScripts(harness.scripts)).toHaveLength(3);
    expect(harness.state.clicks).toBe(1);
  });

  it("stays outcome-unknown when the page keeps running after the stop", async () => {
    const harness = cancelHarness({ doc: newDoc(A, { stop: true }) });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.scripts.filter((s) => kindOf(s) === "probe")).toHaveLength(
      20,
    );
    expect(harness.state.stopped).toBe(0);
  });

  it("refuses when the bind fails, throws or loses its page, which no click follows", async () => {
    const unreadableBind = cancelHarness({ answer: () => ({ nope: true }) });
    expect(await unreadableBind.cancel()).toBe("page_changed");
    expect(clickScripts(unreadableBind.scripts)).toEqual([]);

    const throwingBind = cancelHarness({
      answer: () => new Error("page gone"),
    });
    expect(await throwingBind.cancel()).toBe("page_changed");
    expect(clickScripts(throwingBind.scripts)).toEqual([]);

    const lostBind = cancelHarness({
      doc: newDoc(A, { stop: true }),
      answer: (script) => {
        if (kindOf(script) !== "bind") return undefined;
        lostBind.state.surface?.destroy();
        return undefined;
      },
    });
    expect(await lostBind.cancel()).toBe("page_changed");
    expect(clickScripts(lostBind.scripts)).toEqual([]);
    expect(lostBind.state.generation).toBe(0);
  });

  it("refuses when the page goes after attempts that all clicked nothing, and is unknown once a later click's answer is lost", async () => {
    // Attempt one answers that it found no Stop; the page goes before the
    // next: nothing was clicked by this Cancel.
    const gone = cancelHarness({
      observedRunning: true,
      onDelay: (count) => {
        if (count === 1) gone.state.surface?.destroy();
      },
    });
    expect(await gone.cancel()).toBe("page_changed");
    expect(clickScripts(gone.scripts)).toHaveLength(1);

    // The same, ended by a throw between the attempts.
    const thrown = cancelHarness({
      observedRunning: true,
      onDelay: () => {
        throw new Error("delay failed");
      },
    });
    expect(await thrown.cancel()).toBe("page_changed");
    expect(clickScripts(thrown.scripts)).toHaveLength(1);

    // Attempt one clicks nothing; attempt two's answer is lost.
    let clicks = 0;
    const lost = cancelHarness({
      observedRunning: true,
      answer: (script) => {
        if (kindOf(script) !== "click") return undefined;
        clicks += 1;
        return clicks === 2 ? HOLD : undefined;
      },
    });
    const running = lost.cancel();
    await flush();
    lost.timers.at(-1)!.fire();
    expect(await running).toBe("outcome_unknown");
    expect(lost.state.generation).toBe(0);
  });

  it("is outcome-unknown for an unreadable answer, a throw or a lost page once a click was sent", async () => {
    const unreadableStop = cancelHarness({
      answer: (script) => (kindOf(script) === "click" ? "garbage" : undefined),
    });
    expect(await unreadableStop.cancel()).toBe("outcome_unknown");

    const unreadableProbe = cancelHarness({
      doc: newDoc(A, { stop: true }),
      answer: (script) => (kindOf(script) === "probe" ? "garbage" : undefined),
    });
    expect(await unreadableProbe.cancel()).toBe("outcome_unknown");
    expect(unreadableProbe.state.stopped).toBe(0);

    const throwing = cancelHarness({
      answer: (script) =>
        kindOf(script) === "click" ? new Error("page gone") : undefined,
    });
    expect(await throwing.cancel()).toBe("outcome_unknown");

    const lost = cancelHarness({
      doc: newDoc(A, { stop: true }),
      answer: (script) => {
        if (kindOf(script) !== "click") return undefined;
        lost.state.surface?.destroy();
        return { activated: true };
      },
    });
    expect(await lost.cancel()).toBe("outcome_unknown");
    expect(lost.state.stopped).toBe(0);
  });
});

describe("cancelling a task is bound to the document it starts on", () => {
  it("captures the address and stamps the document in one script before any click", async () => {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({ doc });
    await harness.cancel();
    expect(kinds(harness.scripts).slice(0, 2)).toEqual(["bind", "click"]);
    expect(harness.scripts.filter((s) => kindOf(s) === "bind")).toHaveLength(1);
    expect(stamped(doc)).toBe(true);
  });

  it("never reports cancelled when the owner moves to an idle conversation during the confirmation wait", async () => {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      onDelay: (count) => {
        if (count === 1) {
          doc.path = B;
          doc.stop = false;
        }
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.stopped).toBe(0);
    expect(harness.state.generation).toBe(1);
  });

  it("refuses without a click when the owner moves to an idle conversation during the activation wait", async () => {
    const doc = newDoc(A);
    const harness = cancelHarness({
      doc,
      observedRunning: true,
      onDelay: (count) => {
        if (count === 1) doc.path = B;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.stopped).toBe(0);
    expect(harness.state.generation).toBe(0);
  });

  it("never clicks the Stop of another conversation during an activation retry", async () => {
    const doc = newDoc(A);
    const harness = cancelHarness({
      doc,
      observedRunning: true,
      onDelay: (count) => {
        if (count === 2) {
          doc.path = B;
          doc.stop = true;
        }
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
  });

  it("binds a custom GPT or project conversation, whose canonical address is null", async () => {
    const duringActivation = newDoc(GPT_A);
    const before = cancelHarness({
      doc: duringActivation,
      observedRunning: true,
      onDelay: (count) => {
        if (count === 1) {
          duringActivation.path = GPT_B;
          duringActivation.stop = true;
        }
      },
    });
    expect(await before.cancel()).toBe("page_changed");
    expect(before.state.clicks).toBe(0);

    const duringWait = newDoc(GPT_A, { stop: true });
    const after = cancelHarness({
      doc: duringWait,
      onDelay: (count) => {
        if (count === 1) {
          duringWait.path = GPT_B;
          duringWait.stop = false;
        }
      },
    });
    expect(await after.cancel()).toBe("outcome_unknown");
    expect(after.state.stopped).toBe(0);
  });

  it("treats the conversation assigned to a new chat during the cancel as another page", async () => {
    const before = newDoc("/");
    const refused = cancelHarness({
      doc: before,
      observedRunning: true,
      onDelay: (count) => {
        if (count === 1) {
          before.path = A;
          before.stop = true;
        }
      },
    });
    expect(await refused.cancel()).toBe("page_changed");
    expect(refused.state.clicks).toBe(0);

    const clicked = newDoc("/", { stop: true });
    const unknown = cancelHarness({
      doc: clicked,
      onDelay: (count) => {
        if (count === 1) {
          clicked.path = A;
          clicked.stop = false;
        }
      },
    });
    expect(await unknown.cancel()).toBe("outcome_unknown");
    expect(unknown.state.stopped).toBe(0);
  });

  it("never accepts a probe from a document that replaced the stamped one at the same address", async () => {
    const harness = cancelHarness({
      doc: newDoc(A, { stop: true }),
      onDelay: (count) => {
        if (count === 1) harness.state.doc = newDoc(A);
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.stopped).toBe(0);
  });

  it("answers a stalled click as outcome-unknown, and a stalled bind, which no click follows, as a refusal", async () => {
    const stalledBind = cancelHarness({
      answer: (script) => (kindOf(script) === "bind" ? HOLD : undefined),
    });
    const bind = stalledBind.cancel();
    await flush();
    expect(stalledBind.timers.map((timer) => timer.ms)).toEqual([5_000]);
    stalledBind.timers[0]!.fire();
    expect(await bind).toBe("page_changed");
    expect(clickScripts(stalledBind.scripts)).toEqual([]);

    const stalledClick = cancelHarness({
      doc: newDoc(A, { stop: true }),
      answer: (script) => (kindOf(script) === "click" ? HOLD : undefined),
    });
    const click = stalledClick.cancel();
    await flush();
    stalledClick.timers.at(-1)!.fire();
    expect(await click).toBe("outcome_unknown");
    // The page never answered that Stop was activated: nothing was ended.
    expect(stalledClick.state.generation).toBe(0);
    expect(
      stalledClick.scripts.filter((s) => kindOf(s) === "click"),
    ).toHaveLength(1);
  });

  it("clears its deadline timer once a call answers", async () => {
    const harness = cancelHarness({ doc: newDoc(A, { stop: true }) });
    await harness.cancel();
    expect(harness.timers.length).toBeGreaterThan(0);
    expect(harness.timers.every((timer) => timer.cleared)).toBe(true);
  });
});

describe("a click script is single-use, short-lived and tied to its document", () => {
  // The script text of the first click, kept from a cancel that never ran it.
  async function heldClick(): Promise<{
    script: string;
    doc: Doc;
    harness: ReturnType<typeof cancelHarness>;
  }> {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      answer: (script) => (kindOf(script) === "click" ? HOLD : undefined),
    });
    const running = harness.cancel();
    await flush();
    harness.timers.at(-1)!.fire();
    await running;
    return { script: clickScripts(harness.scripts)[0]!, doc, harness };
  }

  it("clicks nothing in a new generation of the document", async () => {
    const { script } = await heldClick();
    const reloaded = newDoc(A, { stop: true });
    let clicks = 0;
    const answer = runInPage(script, reloaded, () => (clicks += 1));
    expect(clicks).toBe(0);
    expect(answer).toEqual({ navigated: true });
  });

  it("clicks nothing once it has expired, before the page-call deadline", async () => {
    const { script, doc } = await heldClick();
    let clicks = 0;
    clock.now += 5_000;
    runInPage(script, doc, () => (clicks += 1));
    expect(clicks).toBe(0);
    // The same script, unexpired, is what would have clicked.
    clock.now -= 4_000;
    runInPage(script, doc, () => (clicks += 1));
    expect(clicks).toBe(1);
  });

  it("clicks at most once, however often it is run", async () => {
    const { script, doc } = await heldClick();
    let clicks = 0;
    runInPage(script, doc, () => (clicks += 1));
    runInPage(script, doc, () => (clicks += 1));
    expect(clicks).toBe(1);
  });
});

describe("a click script that arrived too late", () => {
  it("is a refusal, with nothing clicked, superseded or recorded", async () => {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      observedRunning: true,
      answer: (script) =>
        kindOf(script) === "click" ? { expired: true } : undefined,
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
    expect(kinds(harness.scripts)).toEqual(["bind", "click"]);
  });

  it("is a refusal when it is the page's own answer after its expiry", async () => {
    // The script itself runs past its expiry and answers without a click.
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      answer: (script) => {
        if (kindOf(script) !== "click") return undefined;
        clock.now += STOP_SCRIPT_EXPIRY_MS + 1;
        return undefined;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
  });
});

describe("cancelling a task is single-flight", () => {
  it("answers a second Cancel with the first one's result and clicks once", async () => {
    const gate: { release: (answer: unknown) => void } = {
      release: () => undefined,
    };
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      answer: (_script, call) =>
        call === 1
          ? new Promise((resolve) => {
              gate.release = resolve;
            })
          : undefined,
    });
    const first = harness.cancel();
    await flush();
    const second = harness.cancel();
    await flush();
    expect(harness.scripts).toHaveLength(1);
    gate.release(
      runInPage(harness.scripts[0]!, harness.state.doc, () => undefined),
    );
    expect(await first).toBe("cancelled");
    expect(await second).toBe("cancelled");
    expect(harness.state.clicks).toBe(1);
    expect(harness.state.generation).toBe(1);
    expect(harness.state.stopped).toBe(1);
  });

  it("starts afresh once the first Cancel has finished", async () => {
    const harness = cancelHarness();
    expect(await harness.cancel()).toBe("not_running");
    expect(await harness.cancel()).toBe("not_running");
    expect(kinds(harness.scripts)).toEqual(["bind", "click", "bind", "click"]);
  });
});

describe("cancelling a task chooses its binding by how the task started", () => {
  const home = `${ORIGIN}/`;
  const pinned = (
    url: string | null,
    dispatch: string | null = home,
    epoch = 1,
  ): CancelTurn => ({
    epoch,
    dispatchIdentityUrl: dispatch,
    pinnedConversationUrl: url,
  });

  it("binds a Route B turn to the conversation it pinned", async () => {
    const harness = cancelHarness({
      ...stopping(A),
      routeB: true,
      turn: pinned(`${ORIGIN}${A}`),
    });
    expect(await harness.cancel()).toBe("cancelled");
    expect(kinds(harness.scripts)[0]).toBe("bind");
    expect(harness.state.clicks).toBe(1);
  });

  it("refuses a Route B cancel whose pinned conversation is no longer shown, before superseding the turn", async () => {
    const doc = newDoc(B, { stop: true });
    const harness = cancelHarness({
      doc,
      routeB: true,
      turn: pinned(`${ORIGIN}${A}`),
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
    // The page shown is read again on the main side before the bind: it is not
    // the conversation the turn relies on, so no script is even sent.
    expect(harness.scripts).toEqual([]);
    expect(stamped(doc)).toBe(false);
  });

  it("falls back to the address the turn was dispatched from while nothing is pinned", async () => {
    const same = cancelHarness({
      ...stopping(GPT_A),
      routeB: true,
      turn: pinned(null, `${ORIGIN}${GPT_A}`),
    });
    expect(await same.cancel()).toBe("cancelled");

    const moved = cancelHarness({
      doc: newDoc(GPT_B, { stop: true }),
      routeB: true,
      turn: pinned(null, `${ORIGIN}${GPT_A}`),
    });
    expect(await moved.cancel()).toBe("page_changed");
    expect(moved.state.clicks).toBe(0);
    expect(moved.state.generation).toBe(0);
  });

  it("refuses a Route B cancel before the turn's own new-chat address is pinned", async () => {
    const harness = cancelHarness({
      doc: newDoc(A, { stop: true }),
      routeB: true,
      turn: pinned(null),
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
  });

  it("binds the page shown at Cancel for a route nothing was admitted on, whatever its turn says", async () => {
    const running = stopping(B);
    const harness = cancelHarness({
      ...running,
      routeB: false,
      turn: pinned(`${ORIGIN}${A}`),
    });
    expect(await harness.cancel()).toBe("cancelled");
    expect(kinds(harness.scripts)[0]).toBe("bind");
    expect(stamped(running.doc)).toBe(true);
  });

  it("refuses, touching nothing, on a Route B route with no turn of Farol's in flight", async () => {
    // The last turn ended (lost its page, say) and the page shown runs
    // something else: its Stop is not this task's.
    const running = stopping(B);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: null,
      epoch: 1,
      observedRunning: true,
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.scripts).toEqual([]);
    expect(harness.state.clicks).toBe(0);
    expect(stamped(running.doc)).toBe(false);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
  });

  it("never ends or binds a turn on a Route B route that no thread's admission began", async () => {
    // A summary Farol runs on the task's own route, before and after it sent.
    for (const dispatched of [false, true]) {
      const running = stopping(A);
      const harness = cancelHarness({
        ...running,
        routeB: true,
        observedRunning: true,
        turn: { ...pinned(`${ORIGIN}${A}`), admitted: false, dispatched },
      });
      expect(await harness.cancel()).toBe("page_changed");
      expect(harness.scripts).toEqual([]);
      expect(harness.state.clicks).toBe(0);
      expect(harness.state.generation).toBe(0);
      expect(harness.state.stopped).toBe(0);
    }
  });

  it("refuses on a Route B route once its turn of this epoch has ended, whatever a later turn says", async () => {
    // A turn of another epoch is not this Cancel's turn either.
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      epoch: 2,
      turn: pinned(`${ORIGIN}${A}`, home, 1),
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.scripts).toEqual([]);
    expect(harness.state.clicks).toBe(0);
  });

  it("binds the page shown at Cancel for an owner Browser task", async () => {
    const running = stopping(A);
    const harness = cancelHarness(running);
    expect(await harness.cancel()).toBe("cancelled");
    expect(stamped(running.doc)).toBe(true);
  });
});

describe("a Stop click needs a pin the turn's own message was seen on", () => {
  const home = `${ORIGIN}/`;
  // Sent from the home page. The pin is the first conversation the page
  // showed; `correlated` is where a probe last saw the turn's own message.
  const sent = (pinned: string, correlated: string | null): CancelTurn => ({
    epoch: 1,
    dispatchIdentityUrl: home,
    pinnedConversationUrl: pinned,
    correlatedConversationUrl: correlated,
  });

  it("refuses as not yet bound, touching nothing, when the owner moved to another conversation before the turn's message was seen", async () => {
    // B is running a turn of its own, and the provisional pin names it.
    const doc = newDoc(B, { stop: true });
    const harness = cancelHarness({
      doc,
      routeB: true,
      observedRunning: true,
      turn: sent(`${ORIGIN}${B}`, null),
    });
    expect(await harness.cancel()).toBe("not_yet_bound");
    expect(harness.scripts).toEqual([]);
    expect(harness.state.clicks).toBe(0);
    expect(stamped(doc)).toBe(false);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
  });

  it("refuses as not yet bound while the turn's message was seen only on another address than its pin", async () => {
    const doc = newDoc(B, { stop: true });
    const harness = cancelHarness({
      doc,
      routeB: true,
      observedRunning: true,
      turn: sent(`${ORIGIN}${B}`, home),
    });
    expect(await harness.cancel()).toBe("not_yet_bound");
    expect(harness.scripts).toEqual([]);
    expect(harness.state.generation).toBe(0);
  });

  it("cancels on the pin once the turn's message was seen there, and a refused Cancel can be asked again", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: sent(`${ORIGIN}${A}`, null),
    });
    expect(await harness.cancel()).toBe("not_yet_bound");
    expect(harness.scripts).toEqual([]);
    harness.state.turn = sent(`${ORIGIN}${A}`, `${ORIGIN}${A}`);
    expect(await harness.cancel()).toBe("cancelled");
    expect(harness.scripts[0]).toContain(JSON.stringify(`${ORIGIN}${A}`));
    expect(harness.state.clicks).toBe(1);
    expect(harness.state.generation).toBe(1);
    expect(harness.state.stopped).toBe(1);
  });

  it("never clicks once the turn's message is no longer seen on its pin, after the bind", async () => {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      routeB: true,
      observedRunning: true,
      turn: sent(`${ORIGIN}${A}`, `${ORIGIN}${A}`),
      answer: (script) => {
        if (kindOf(script) === "bind")
          harness.state.turn = sent(`${ORIGIN}${A}`, null);
        return undefined;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(kinds(harness.scripts)).toEqual(["bind"]);
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
  });

  it("asks no correlation on a route Farol does not submit for", async () => {
    const running = stopping(B);
    const harness = cancelHarness({ ...running, routeB: false, turn: null });
    expect(await harness.cancel()).toBe("cancelled");
  });
});

describe("cancelling a task is bound when it starts, not when a script runs", () => {
  const home = `${ORIGIN}/`;
  const turnOf = (
    epoch: number,
    pinned: string | null,
    dispatch: string | null = home,
  ): CancelTurn => ({
    epoch,
    dispatchIdentityUrl: dispatch,
    pinnedConversationUrl: pinned,
  });

  const cases: [string, CancelInput][] = [
    ["an owner Browser task", {}],
    [
      "a route nothing was admitted on",
      { routeB: false, turn: turnOf(1, `${ORIGIN}${B}`) },
    ],
  ];
  it.each(cases)(
    "never clicks a page the owner navigated to before the bind script ran: %s",
    async (_name, input) => {
      const doc = newDoc(A, { stop: true });
      let moved = false;
      const harness = cancelHarness({
        ...input,
        doc,
        answer: (script) => {
          if (kindOf(script) === "bind" && !moved) {
            moved = true;
            doc.path = B;
          }
          return undefined;
        },
      });
      expect(await harness.cancel()).toBe("page_changed");
      expect(harness.state.clicks).toBe(0);
      expect(stamped(doc)).toBe(false);
      expect(kinds(harness.scripts)).toEqual(["bind"]);
      // A refusal ends no turn, on any route.
      expect(harness.state.generation).toBe(0);
      expect(harness.state.stopped).toBe(0);
    },
  );

  it("binds the page shown when Cancel starts even if the script runs on the same page again later", async () => {
    const running = stopping(A);
    const harness = cancelHarness(running);
    expect(await harness.cancel()).toBe("cancelled");
    expect(harness.scripts[0]).toContain(JSON.stringify(`${ORIGIN}${A}`));
  });
});

describe("cancelling a task never ends a turn it did not start on", () => {
  const home = `${ORIGIN}/`;
  const turnOf = (epoch: number): CancelTurn => ({
    epoch,
    dispatchIdentityUrl: home,
    pinnedConversationUrl: `${ORIGIN}${A}`,
  });
  // The old turn settles and the next one is admitted on the same
  // conversation: the route's epoch advances and the page is marked with it.
  const successor = (harness: ReturnType<typeof cancelHarness>): void => {
    harness.state.observation += 1;
    harness.state.epoch += 1;
    harness.state.turn = turnOf(harness.state.epoch);
    markTurn(harness.state.doc, harness.state.epoch);
  };

  it("refuses, without a click or a supersede, when a successor starts while the bind is pending", async () => {
    const running = stopping(A);
    let started = false;
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: turnOf(1),
      answer: (script) => {
        if (kindOf(script) === "bind" && !started) {
          started = true;
          successor(harness);
        }
        return undefined;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.observation).toBe(2);
    expect(harness.state.turn?.epoch).toBe(2);
  });

  it("clicks nothing when the turn ended on its own while the page was bound, even though no turn was admitted since", async () => {
    // A turn's end does not advance the epoch, so the epoch alone cannot say
    // that the page still belongs to the turn this Cancel was asked for. The
    // turn is captured when the Cancel starts and read again before the click.
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: turnOf(1),
      answer: (script) => {
        if (kindOf(script) === "bind") harness.state.turn = null;
        return undefined;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(kinds(harness.scripts)).toEqual(["bind"]);
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
  });

  it("is unknown, with no click, when a successor turn has marked the page while the script was queued", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: turnOf(1),
      answer: (script) => {
        if (kindOf(script) === "click") successor(harness);
        return undefined;
      },
    });
    // The page refuses, but its answer is read only after the epoch check,
    // and the epoch moved: nothing is taken at the page's word.
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.observation).toBe(2);
    expect(harness.state.stopped).toBe(0);
  });

  it("is unknown and supersedes nothing when the turn is replaced right after the click ran", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: turnOf(1),
      answer: (script) => {
        if (kindOf(script) !== "click") return undefined;
        const answer = runInPage(script, running.doc, () => {
          harness.state.clicks += 1;
        });
        successor(harness);
        return answer;
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.clicks).toBe(1);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.observation).toBe(2);
    expect(harness.state.stopped).toBe(0);
  });

  it("ends the observation of the turn it started on, once the click is verified", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: turnOf(1),
    });
    expect(await harness.cancel()).toBe("cancelled");
    expect(harness.state.generation).toBe(1);
    expect(harness.state.observation).toBe(2);
  });

  it("does not wait on the turn it just ended while it confirms the stop", async () => {
    // Ending the observation makes the turn finish, which clears it; the
    // confirmation must still be able to answer.
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: turnOf(1),
      onDelay: (count) => {
        if (count === 1) {
          running.doc.stop = false;
          harness.state.turn = null;
        }
      },
    });
    expect(await harness.cancel()).toBe("cancelled");
  });

  it("never ends an observation that began since the Cancel started", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      answer: (script) => {
        if (kindOf(script) === "click") harness.state.observation += 1;
        return undefined;
      },
    });
    await harness.cancel();
    expect(harness.state.generation).toBe(0);
    expect(harness.state.observation).toBe(1);
  });

  it("never touches the page for a Route B turn that has not been sent, and ends its preparation", async () => {
    // Turn A timed out locally but its Stop is still on the page; B is
    // admitted and is still preparing when it is cancelled. The visible Stop
    // is A's, so no script of any kind is sent.
    const doc = newDoc(A, { stop: true });
    const preparing: CancelTurn = {
      epoch: 2,
      dispatchIdentityUrl: null,
      pinnedConversationUrl: null,
      dispatched: false,
    };
    const harness = cancelHarness({
      doc,
      routeB: true,
      turn: preparing,
      observedRunning: true,
    });
    expect(await harness.cancel()).toBe("cancelled");
    expect(harness.scripts).toEqual([]);
    expect(harness.state.clicks).toBe(0);
    expect(stamped(doc)).toBe(false);
    // Its preparation is ended locally, once, and nothing else is recorded.
    expect(harness.state.generation).toBe(1);
    expect(harness.state.stopped).toBe(0);
  });

  it("ends an unsent turn's preparation locally on a route that is not Route B too", async () => {
    const harness = cancelHarness({
      doc: newDoc(A, { stop: true }),
      turn: {
        epoch: 0,
        dispatchIdentityUrl: null,
        pinnedConversationUrl: null,
        dispatched: false,
      },
    });
    expect(await harness.cancel()).toBe("cancelled");
    expect(harness.scripts).toEqual([]);
    expect(harness.state.generation).toBe(1);
  });

  it("goes through the page once the turn reached its dispatch intent", async () => {
    // From the dispatch intent to the confirmed Send the click may have
    // happened, so the turn is cancelled through the page like any sent one.
    const harness = cancelHarness({
      ...stopping(A),
      routeB: true,
      turn: {
        epoch: 1,
        dispatchIdentityUrl: `${ORIGIN}${A}`,
        pinnedConversationUrl: `${ORIGIN}${A}`,
        dispatched: true,
      },
    });
    expect(await harness.cancel()).toBe("cancelled");
    expect(clickScripts(harness.scripts)).toHaveLength(1);
    expect(harness.state.generation).toBe(1);
  });
});

describe("every effect of a cancel is guarded by the page-turn epoch it started on", () => {
  const home = `${ORIGIN}/`;
  const turnOf = (epoch: number): CancelTurn => ({
    epoch,
    dispatchIdentityUrl: home,
    pinnedConversationUrl: `${ORIGIN}${A}`,
  });
  // A turn is admitted: the epoch advances, and the turn marks its page.
  const startTurn = (
    harness: ReturnType<typeof cancelHarness>,
    epoch: number,
    markPage = true,
  ): void => {
    harness.state.observation = epoch;
    harness.state.epoch = epoch;
    harness.state.turn = turnOf(epoch);
    if (markPage) markTurn(harness.state.doc, epoch);
  };
  // The turn ends. Nothing about the epoch or the page's mark changes.
  const endTurn = (harness: ReturnType<typeof cancelHarness>): void => {
    harness.state.turn = null;
  };

  // The click script of a Cancel that never ran it, with the document it was
  // sent to.
  async function heldClick(input: CancelInput): Promise<{
    script: string;
    doc: Doc;
  }> {
    const doc = input.doc ?? newDoc(A, { stop: true });
    const harness = cancelHarness({
      ...input,
      doc,
      answer: (script) => (kindOf(script) === "click" ? HOLD : undefined),
    });
    const running = harness.cancel();
    await flush();
    harness.timers.at(-1)!.fire();
    await running;
    return { script: clickScripts(harness.scripts)[0]!, doc };
  }

  it("clicks nothing in the page once a successor turn has started, however late the script runs", async () => {
    const { script, doc } = await heldClick({
      routeB: true,
      turn: turnOf(1),
    });
    let clicks = 0;
    markTurn(doc, 2);
    expect(runInPage(script, doc, () => (clicks += 1))).toEqual({
      navigated: true,
    });
    expect(clicks).toBe(0);
    // The epoch it was sent for, still there, is what would have clicked.
    markTurn(doc, 1);
    runInPage(script, doc, () => (clicks += 1));
    expect(clicks).toBe(1);
  });

  // A Cancel with no turn in flight touches a page only on a route Farol does
  // not submit for (an owner Browser task); its turns, a summary say, still
  // advance the epoch, so the no-turn cases below run there.
  it("clicks nothing for a Cancel that started with no turn once a successor has come and gone", async () => {
    // The Cancel started after turn 1 ended, holding epoch 1. Turn 2 is then
    // admitted, marks the page, runs and ends: its end leaves the mark as it
    // is, so the queued click still finds a different epoch and refuses.
    const { script, doc } = await heldClick({
      routeB: false,
      turn: null,
      epoch: 1,
    });
    expect(pageEpoch(doc)).toBe(1);
    let clicks = 0;
    markTurn(doc, 2);
    expect(runInPage(script, doc, () => (clicks += 1))).toEqual({
      navigated: true,
    });
    expect(clicks).toBe(0);
    expect(pageEpoch(doc)).toBe(2);
  });

  it("refuses a Cancel that started with no turn when one starts during the bind", async () => {
    const running = stopping(A);
    let started = false;
    const harness = cancelHarness({
      ...running,
      routeB: false,
      turn: null,
      answer: (script) => {
        if (kindOf(script) === "bind" && !started) {
          started = true;
          startTurn(harness, 1);
          endTurn(harness);
        }
        return undefined;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.observation).toBe(1);
  });

  it("is unknown, and supersedes nothing, when a turn starts right after a no-turn Cancel's click", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: false,
      turn: null,
      answer: (script) => {
        if (kindOf(script) !== "click") return undefined;
        const answer = runInPage(script, running.doc, () => {
          harness.state.clicks += 1;
        });
        startTurn(harness, 1, false);
        return answer;
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.clicks).toBe(1);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
  });

  it("does not record a stop, or answer cancelled, for a page whose turn was replaced during the confirmation", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: turnOf(1),
      onDelay: (count) => {
        if (count === 1) {
          // The cancelled turn ended and another started on the same page.
          running.doc.stop = false;
          startTurn(harness, 3);
        }
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.stopped).toBe(0);
    expect(harness.state.generation).toBe(1);
  });

  it("does not record a stop for a no-turn Cancel when a turn starts during the confirmation", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: false,
      turn: null,
      onDelay: (count) => {
        if (count === 1) {
          running.doc.stop = false;
          startTurn(harness, 1);
        }
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.stopped).toBe(0);
  });

  it("does not record a stop for a no-turn Cancel when a successor starts and ends between confirmation checks", async () => {
    // Epoch 1 was the last turn; the Cancel holds it. Turn 2 is admitted,
    // marks the page and ends before the next check, so that check finds no
    // turn in flight again, exactly as at the start. It is not the same epoch.
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: false,
      turn: null,
      epoch: 1,
      onDelay: (count) => {
        if (count === 1) {
          running.doc.stop = false;
          startTurn(harness, 2);
          endTurn(harness);
        }
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.stopped).toBe(0);
    expect(harness.state.turn).toBeNull();
    // The click happened before the successor; it did not end the successor.
    expect(harness.state.clicks).toBe(1);
    expect(harness.state.generation).toBe(1);
  });

  it("does not record a stop when a successor starts and ends while a confirmation probe is pending", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: false,
      turn: null,
      epoch: 1,
      answer: (script) => {
        if (kindOf(script) !== "probe") return undefined;
        running.doc.stop = false;
        const answer = runInPage(script, running.doc, () => undefined);
        startTurn(harness, 2);
        endTurn(harness);
        return answer;
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.stopped).toBe(0);
  });

  it("does not click, and records nothing, when the held click meets a successor that has come and gone", async () => {
    // The round-3 sequence: a no-turn Cancel, a successor that is admitted,
    // runs and ends, and only then the held click.
    const doc = newDoc(A, { stop: true });
    let held = true;
    const harness = cancelHarness({
      doc,
      routeB: false,
      turn: null,
      epoch: 1,
      answer: (script) => {
        if (kindOf(script) === "click" && held) {
          held = false;
          startTurn(harness, 2);
          endTurn(harness);
        }
        return undefined;
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.stopped).toBe(0);
    expect(harness.state.generation).toBe(0);
    expect(clickScripts(harness.scripts)).toHaveLength(1);
    expect(kinds(harness.scripts)).toEqual(["bind", "click"]);
  });

  it("refuses to bind a page already marked with a later epoch, and leaves it untouched", async () => {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({ doc, routeB: false, turn: null, epoch: 2 });
    // A later turn marked the page after this Cancel took its epoch.
    markTurn(doc, 3);
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(pageEpoch(doc)).toBe(3);
    expect(stamped(doc)).toBe(false);
    expect(kinds(harness.scripts)).toEqual(["bind"]);
  });

  it("marks a page that carries an earlier epoch with the one it starts on, which every later script then requires", async () => {
    // The page lost track (a reload reads 0, an old turn 1): the Cancel's
    // epoch becomes its mark, and only that one passes from here.
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: false,
      turn: null,
      epoch: 4,
    });
    markTurn(running.doc, 1);
    expect(await harness.cancel()).toBe("cancelled");
    expect(pageEpoch(running.doc)).toBe(4);
    expect(harness.state.clicks).toBe(1);
    expect(harness.state.stopped).toBe(1);
  });

  it("does not accept a probe read after the turn was replaced, even one that says not running", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: turnOf(1),
      answer: (script) => {
        if (kindOf(script) !== "probe") return undefined;
        running.doc.stop = false;
        const answer = runInPage(script, running.doc, () => undefined);
        startTurn(harness, 3);
        return answer;
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.stopped).toBe(0);
  });

  it("still confirms when only its own turn ended because it was superseded", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn: turnOf(1),
      onDelay: (count) => {
        if (count === 1) {
          running.doc.stop = false;
          harness.state.turn = null;
        }
      },
    });
    expect(await harness.cancel()).toBe("cancelled");
    expect(harness.state.stopped).toBe(1);
  });
});

describe("a cancel is bound to the document it started on and to a turn that is running", () => {
  // A reload, or a navigation away and back to the same address.
  const replaceDocument = (harness: ReturnType<typeof cancelHarness>): void => {
    harness.state.document += 1;
  };

  it("never clicks a document that replaced the one the Cancel started on at the same path before the bind ran", async () => {
    // The bind script is queued behind a reload: it runs in the replacement,
    // finds the same path, stamps it and answers `bound`. Only the main side's
    // document generation can tell that this is not the document it started on.
    const doc = newDoc(A, { stop: true });
    let replaced = false;
    const harness = cancelHarness({
      doc,
      observedRunning: true,
      answer: (script) => {
        if (kindOf(script) === "bind" && !replaced) {
          replaced = true;
          replaceDocument(harness);
        }
        return undefined;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(kinds(harness.scripts)).toEqual(["bind"]);
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
  });

  it("sends no script at all when the document generation moved between the start and the bind", async () => {
    // Read at the start, moved on by the time the bind would be sent.
    let reads = 0;
    const harness = cancelHarness({
      doc: newDoc(A, { stop: true }),
      observedRunning: true,
      documentGeneration: () => {
        reads += 1;
        return reads === 1 ? 1 : 2;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.scripts).toEqual([]);
    expect(stamped(harness.state.doc)).toBe(false);
  });

  it("refuses to accept a bind answered after the document was replaced, and clicks nothing", async () => {
    const doc = newDoc(A, { stop: true });
    let replaced = false;
    const harness = cancelHarness({
      doc,
      observedRunning: true,
      answer: (script) => {
        if (kindOf(script) === "bind" && !replaced) {
          replaced = true;
          // The bind ran in the old document; the window reloads right after.
          const answer = runInPage(script, doc, () => undefined);
          replaceDocument(harness);
          return answer;
        }
        return undefined;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(kinds(harness.scripts)).toEqual(["bind"]);
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.generation).toBe(0);
  });

  it("is unknown, and ends no turn, when the document is replaced right after the click ran", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      answer: (script) => {
        if (kindOf(script) !== "click") return undefined;
        const answer = runInPage(script, running.doc, () => {
          harness.state.clicks += 1;
        });
        replaceDocument(harness);
        return answer;
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.clicks).toBe(1);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
  });

  it("records no stop when the document is replaced during the confirmation", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      onDelay: (count) => {
        if (count === 1) {
          running.doc.stop = false;
          replaceDocument(harness);
        }
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.stopped).toBe(0);
  });

  it("refuses before any effect when a turn is admitted and has not begun running", async () => {
    // The route is Route B with a turn being admitted: the page shown is not
    // that turn's page, and the older task's Stop must not be clicked.
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      routeB: true,
      turn: null,
      epoch: 2,
      admitting: true,
      observedRunning: true,
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.scripts).toEqual([]);
    expect(harness.state.clicks).toBe(0);
    expect(stamped(doc)).toBe(false);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
  });

  it("ends no Route B turn on a path that did not verify a bind and a click", async () => {
    // An unreadable bind answer, a refused bind, a bind that stalls, a click
    // that stalls and a page with no Stop control.
    const answers: [string, NonNullable<CancelInput["answer"]>][] = [
      [
        "unreadable bind",
        (s) => (kindOf(s) === "bind" ? { garbage: 1 } : undefined),
      ],
      [
        "refused bind",
        (s) => (kindOf(s) === "bind" ? { navigated: true } : undefined),
      ],
      ["stalled bind", (s) => (kindOf(s) === "bind" ? HOLD : undefined)],
      ["stalled click", (s) => (kindOf(s) === "click" ? HOLD : undefined)],
    ];
    for (const [, answer] of answers) {
      const harness = cancelHarness({
        doc: newDoc(A, { stop: true }),
        routeB: true,
        turn: {
          epoch: 1,
          dispatchIdentityUrl: `${ORIGIN}/`,
          pinnedConversationUrl: `${ORIGIN}${A}`,
        },
        answer,
      });
      const running = harness.cancel();
      await flush();
      for (const timer of harness.timers) timer.fire();
      await running;
      expect(harness.state.generation).toBe(0);
    }
    const idle = cancelHarness({
      doc: newDoc(A),
      routeB: true,
      turn: {
        epoch: 1,
        dispatchIdentityUrl: `${ORIGIN}/`,
        pinnedConversationUrl: `${ORIGIN}${A}`,
      },
    });
    expect(await idle.cancel()).toBe("not_running");
    expect(idle.state.generation).toBe(0);
  });

  it("does not take a negative click answer as not-running once the turn was replaced", async () => {
    // No Stop control is shown: the page itself says nothing runs. But a
    // successor was admitted while the click was in the page, so that reading
    // may be about it, and is not this Cancel's to report.
    const doc = newDoc(A);
    const harness = cancelHarness({
      doc,
      routeB: false,
      turn: null,
      epoch: 1,
      answer: (script) => {
        if (kindOf(script) !== "click") return undefined;
        const answer = runInPage(script, doc, () => undefined);
        harness.state.epoch = 2;
        return answer;
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.stopped).toBe(0);
    expect(harness.state.generation).toBe(0);
  });

  it("does not take a negative click answer as not-running once the document was replaced", async () => {
    const doc = newDoc(A);
    const harness = cancelHarness({
      doc,
      answer: (script) => {
        if (kindOf(script) !== "click") return undefined;
        const answer = runInPage(script, doc, () => undefined);
        replaceDocument(harness);
        return answer;
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
  });

  it("is unknown, and ends no turn, for a click that ran after a successor was admitted but before it stamped the page", async () => {
    // The page still carries the earlier epoch, so its script lets the click
    // through; the main side, which knows the successor was admitted, does not
    // take the answer as this Cancel's.
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: false,
      turn: null,
      epoch: 1,
      answer: (script) => {
        if (kindOf(script) !== "click") return undefined;
        const answer = runInPage(script, running.doc, () => {
          harness.state.clicks += 1;
        });
        // Admitted, not yet stamped: the page still reads epoch 1.
        harness.state.epoch = 2;
        harness.state.turn = {
          epoch: 2,
          dispatchIdentityUrl: null,
          pinnedConversationUrl: null,
        };
        return answer;
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.clicks).toBe(1);
    expect(pageEpoch(running.doc)).toBe(1);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.stopped).toBe(0);
  });
});

describe("a cancel of a turn Farol sends on a route that is not Route B", () => {
  const sending = (): CancelTurn => ({
    epoch: 0,
    dispatchIdentityUrl: null,
    pinnedConversationUrl: null,
  });

  it("ends nothing before any page call, however slow the bind is", async () => {
    // The turn may be about to Send: the bind that never answers must not
    // decide whether it does.
    const harness = cancelHarness({
      doc: newDoc(A, { stop: true }),
      turn: sending(),
      answer: (script) => (kindOf(script) === "bind" ? HOLD : undefined),
    });
    const running = harness.cancel();
    expect(harness.state.generation).toBe(0);
    await flush();
    expect(kinds(harness.scripts)).toEqual(["bind"]);
    harness.timers.at(-1)!.fire();
    // The bind never answered and no click was sent: a refusal.
    expect(await running).toBe("page_changed");
    // Nothing was verified, so nothing was ended.
    expect(harness.state.generation).toBe(0);
  });

  it("ends nothing until the click answered, however slow it is", async () => {
    const harness = cancelHarness({
      doc: newDoc(A, { stop: true }),
      turn: sending(),
      answer: (script) => (kindOf(script) === "click" ? HOLD : undefined),
    });
    const running = harness.cancel();
    expect(harness.state.generation).toBe(0);
    await flush();
    harness.timers.at(-1)!.fire();
    expect(await running).toBe("outcome_unknown");
    // The click never answered that Stop was activated: nothing was ended.
    expect(harness.state.generation).toBe(0);
  });

  it("ends a turn only once the Stop was activated, and a refusal ends none", async () => {
    const doc = newDoc(B, { stop: true });
    const harness = cancelHarness({
      doc,
      turn: { ...sending(), pinnedConversationUrl: `${ORIGIN}${A}` },
    });
    // Bound to the page shown at Cancel (not Route B), which is B: fine, and
    // the observation is ended only once the Stop was activated.
    expect(harness.state.generation).toBe(0);
    await harness.cancel();
    expect(harness.state.generation).toBe(1);
    // A document replaced before the bind answer still clicks nothing.
    let replaced = false;
    const second = cancelHarness({
      doc: newDoc(A, { stop: true }),
      turn: sending(),
      answer: (script) => {
        if (kindOf(script) === "bind" && !replaced) {
          replaced = true;
          second.state.document += 1;
        }
        return undefined;
      },
    });
    expect(await second.cancel()).toBe("page_changed");
    expect(second.state.clicks).toBe(0);
    expect(second.state.generation).toBe(0);
  });

  it("does not click, and is unknown, when a successor turn starts on the same document while the click is pending", async () => {
    // Every turn has an epoch, Route B or not: the successor marks the page
    // and advances the route's epoch, so the first Cancel's queued click is
    // refused by the page and its answer is not taken.
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      turn: sending(),
      epoch: 1,
      answer: (script) => {
        if (kindOf(script) === "click") {
          harness.state.epoch = 2;
          markTurn(doc, 2);
        }
        return undefined;
      },
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.stopped).toBe(0);
  });

  it("clicks nothing when a successor turn starts on the same document while the bind is pending", async () => {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      turn: sending(),
      epoch: 1,
      answer: (script) => {
        if (kindOf(script) === "bind") {
          harness.state.epoch = 2;
          markTurn(doc, 2);
        }
        return undefined;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(kinds(harness.scripts)).toEqual(["bind"]);
    expect(harness.state.clicks).toBe(0);
  });

  it("starts its own Cancel for a turn admitted while an older Cancel is still pending", async () => {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      routeB: true,
      turn: { ...sending(), epoch: 1, pinnedConversationUrl: `${ORIGIN}${A}` },
      answer: (_script, call) => (call === 1 ? HOLD : undefined),
      onDelay: (count) => {
        if (count === 1) doc.stop = false;
      },
    });
    const older = harness.cancel();
    await flush();
    expect(kinds(harness.scripts)).toEqual(["bind"]);
    // The same turn: the second call is the first's result, with no new call.
    expect(harness.cancel()).toBe(older);
    // A successor is admitted and marks the page; its Cancel is its own.
    harness.state.epoch = 2;
    harness.state.turn = {
      epoch: 2,
      dispatchIdentityUrl: null,
      pinnedConversationUrl: `${ORIGIN}${A}`,
    };
    markTurn(doc, 2);
    const newer = harness.cancel();
    expect(newer).not.toBe(older);
    await flush();
    expect(kinds(harness.scripts).slice(0, 2)).toEqual(["bind", "bind"]);
    // The newer Cancel was sent for the successor's epoch.
    expect(harness.scripts[1]).toContain("pageEpoch > 2");
    expect(await newer).toBe("cancelled");
    harness.timers[0]!.fire();
    // Its bind stalled and it sent no click.
    expect(await older).toBe("page_changed");
    // Only the newer Cancel clicked and recorded; the older one touched nothing.
    expect(harness.state.clicks).toBe(1);
    expect(harness.state.stopped).toBe(1);
  });

  it("leaves a Route B turn observed until its stop was clicked", async () => {
    const harness = cancelHarness({
      doc: newDoc(A, { stop: true }),
      routeB: true,
      turn: { ...sending(), epoch: 1, pinnedConversationUrl: `${ORIGIN}${A}` },
      answer: (script) => (kindOf(script) === "bind" ? HOLD : undefined),
    });
    const running = harness.cancel();
    await flush();
    expect(harness.state.generation).toBe(0);
    harness.timers.at(-1)!.fire();
    await running;
    expect(harness.state.generation).toBe(0);
  });
});

describe("every click answer is read only against an unchanged epoch and document", () => {
  const shapes: [string, unknown][] = [
    ["a click", { activated: true }],
    ["no stop control", { activated: false }],
    ["a refusal by the page", { navigated: true }],
    ["an expired script", { expired: true }],
  ];
  it.each(shapes)(
    "is unknown, whatever the page answered, when the epoch moved meanwhile: %s",
    async (_name, answer) => {
      const harness = cancelHarness({
        doc: newDoc(A, { stop: true }),
        routeB: false,
        turn: null,
        epoch: 1,
        observedRunning: true,
        answer: (script) => {
          if (kindOf(script) !== "click") return undefined;
          harness.state.epoch = 2;
          return answer;
        },
      });
      expect(await harness.cancel()).toBe("outcome_unknown");
      expect(harness.state.stopped).toBe(0);
      expect(harness.state.generation).toBe(0);
      expect(clickScripts(harness.scripts)).toHaveLength(1);
    },
  );
  it.each(shapes)(
    "is unknown, whatever the page answered, when the document was replaced meanwhile: %s",
    async (_name, answer) => {
      const harness = cancelHarness({
        doc: newDoc(A, { stop: true }),
        observedRunning: true,
        answer: (script) => {
          if (kindOf(script) !== "click") return undefined;
          harness.state.document += 1;
          return answer;
        },
      });
      expect(await harness.cancel()).toBe("outcome_unknown");
      expect(harness.state.stopped).toBe(0);
      expect(clickScripts(harness.scripts)).toHaveLength(1);
    },
  );
});

describe("every await between a cancel's admission and its click re-verifies the identity captured at admission", () => {
  const turn: CancelTurn = {
    epoch: 1,
    dispatchIdentityUrl: `${ORIGIN}/`,
    pinnedConversationUrl: `${ORIGIN}${A}`,
  };
  type Harness = ReturnType<typeof cancelHarness>;
  // What changes about the identity the Cancel captured, at the awaited step.
  const changes: [string, (harness: Harness) => void][] = [
    [
      "the turn settled (the epoch did not move)",
      (harness) => {
        harness.state.turn = null;
      },
    ],
    [
      "the page shows another conversation",
      (harness) => {
        harness.state.doc.path = B;
      },
    ],
    [
      "the turn pinned another conversation (the page is back where it was)",
      (harness) => {
        harness.state.turn = {
          ...harness.state.turn!,
          pinnedConversationUrl: `${ORIGIN}${B}`,
        };
      },
    ],
    [
      "the document was replaced",
      (harness) => {
        harness.state.document += 1;
      },
    ],
    [
      "another turn was admitted (the epoch advanced)",
      (harness) => {
        harness.state.epoch += 1;
      },
    ],
  ];
  // The awaited steps a click can follow: the bind, and the wait between two
  // activation attempts. The click and the confirmation come after a click may
  // have happened and are covered by their own tests.
  const steps = ["the bind answer", "the wait between activation attempts"];

  describe.each(steps)("while waiting for %s", (step) => {
    it.each(changes)(
      "ends page_changed, with no click, when %s",
      async (_name, change) => {
        const doc = newDoc(A, { stop: step === "the bind answer" });
        let harness: Harness;
        harness = cancelHarness({
          doc,
          routeB: true,
          turn,
          observedRunning: true,
          answer: (script) => {
            if (step !== "the bind answer" || kindOf(script) !== "bind") {
              return undefined;
            }
            // The bind ran on the document the Cancel started on, then the
            // identity moved before its answer was read.
            const answer = runInPage(script, doc, () => undefined);
            change(harness);
            return answer;
          },
          onDelay: (count) => {
            if (step === "the bind answer" || count !== 1) return;
            // The first activation found no Stop control. By the time the page
            // is asked again one exists, and the identity has moved.
            doc.stop = true;
            change(harness);
          },
        });
        expect(await harness.cancel()).toBe("page_changed");
        expect(harness.state.clicks).toBe(0);
        expect(clickScripts(harness.scripts)).toHaveLength(
          step === "the bind answer" ? 0 : 1,
        );
        // No click was ever delivered to a Stop control, the observation of the
        // turn is not superseded and no stop is recorded.
        expect(harness.state.generation).toBe(0);
        expect(harness.state.stopped).toBe(0);
      },
    );
  });

  // After a click may have happened, the same identity is read after every
  // await: the click answer and each confirmation poll. A mismatch is unknown,
  // and nothing is recorded, superseded or called cancelled.
  const afterClick: [string, (harness: Harness) => void][] = [
    ...changes.filter(([name]) => !name.startsWith("the turn settled")),
  ];
  describe.each(["the click answer", "a confirmation poll"])(
    "after a click, while waiting for %s",
    (step) => {
      it.each(afterClick)(
        "ends outcome_unknown, recording nothing, when %s",
        async (_name, change) => {
          const doc = newDoc(A, { stop: true });
          let harness: Harness;
          harness = cancelHarness({
            doc,
            routeB: true,
            turn,
            observedRunning: true,
            answer: (script) => {
              const kind = kindOf(script);
              if (step === "the click answer" && kind === "click") {
                // The page clicked on the document it was bound to, then the
                // identity moved before the answer was handled.
                const answer = runInPage(script, doc, () => {
                  harness.state.clicks += 1;
                });
                change(harness);
                return answer;
              }
              if (step === "a confirmation poll" && kind === "probe") {
                const answer = runInPage(script, doc, () => undefined);
                change(harness);
                return answer;
              }
              return undefined;
            },
            onDelay: () => {
              // The page reports the stop as soon as it is asked.
              doc.stop = false;
            },
          });
          expect(await harness.cancel()).toBe("outcome_unknown");
          expect(harness.state.stopped).toBe(0);
          if (step === "the click answer") {
            // The answer was not taken at its word: no observation was ended.
            expect(harness.state.generation).toBe(0);
          }
        },
      );
    },
  );

  it("ends an unsent turn locally in the tick of the request, whatever the page shows", async () => {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      routeB: true,
      turn: { ...turn, dispatched: false },
      observedRunning: true,
    });
    const running = harness.cancel();
    // Ended before anything is awaited, and the page is never touched.
    expect(harness.state.generation).toBe(1);
    expect(await running).toBe("cancelled");
    expect(harness.scripts).toEqual([]);
    expect(harness.state.clicks).toBe(0);
  });

  it("refuses when the turn pins another conversation during the bind and the owner navigates back, and leaves everything as it was", async () => {
    // A turn sent from the home page is unpinned: the Cancel binds the home
    // page. While the bind is pending the turn pins its new conversation, and
    // the owner returns to the home page in the same document: path, epoch and
    // document all match the capture again, but the turn names another
    // conversation, so the Stop on this page is not its Stop.
    const home = newDoc("/", { stop: true });
    const unpinned: CancelTurn = {
      epoch: 1,
      dispatchIdentityUrl: `${ORIGIN}/`,
      pinnedConversationUrl: null,
    };
    let harness: Harness;
    harness = cancelHarness({
      doc: home,
      routeB: true,
      turn: unpinned,
      observedRunning: true,
      answer: (script) => {
        if (kindOf(script) !== "bind") return undefined;
        const answer = runInPage(script, home, () => undefined);
        harness.state.turn = {
          ...unpinned,
          pinnedConversationUrl: `${ORIGIN}${B}`,
        };
        return answer;
      },
    });
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(clickScripts(harness.scripts)).toEqual([]);
    expect(harness.state.generation).toBe(0);
    expect(harness.state.observation).toBe(1);
    expect(harness.state.stopped).toBe(0);
  });

  it("clicks when nothing changed, so the table above is not vacuous", async () => {
    const running = stopping(A);
    const harness = cancelHarness({
      ...running,
      routeB: true,
      turn,
      observedRunning: true,
    });
    expect(await harness.cancel()).toBe("cancelled");
    expect(harness.state.clicks).toBe(1);
  });

  it("refuses a Cancel that starts on a page that was navigated away from before the request was handled", async () => {
    // The identity is captured in the tick of admission: a request that is
    // refused or deferred never sees a later page as its own.
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({
      doc,
      routeB: true,
      turn,
      observedRunning: true,
    });
    const running = harness.cancel();
    doc.path = B;
    expect(await running).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
  });
});

describe("window title", () => {
  it("falls back to the product title", () => {
    expect(DEFAULT_ROUTE_TITLE).toBe("ChatGPT · Farol");
    expect(routeTitle(undefined)).toBe("ChatGPT · Farol");
    expect(routeTitle("Sign in to ChatGPT")).toBe("Sign in to ChatGPT");
  });

  it("remembers the title and shows it on a live window", () => {
    const live = surface(contents(CONVERSATION));
    const remembered: string[] = [];
    applyRouteTitle("A title", {
      remember: (title) => remembered.push(title),
      surface: () => live,
    });
    expect(remembered).toEqual(["A title"]);
    expect(live.title).toBe("A title");
  });

  it("remembers the title without touching a missing or destroyed window", () => {
    const remembered: string[] = [];
    const ports = (current: Surface | null) => ({
      remember: (title: string) => remembered.push(title),
      surface: () => current,
    });
    applyRouteTitle("one", ports(null));
    const gone = surface(contents(CONVERSATION));
    gone.destroy();
    applyRouteTitle("two", ports(gone));
    expect(remembered).toEqual(["one", "two"]);
    expect(gone.title).toBeNull();
  });
});

describe("resetting the route", () => {
  it("forgets the conversation in order and tells the owner", () => {
    const log: string[] = [];
    const livePopup = {
      isDestroyed: () => false,
      destroy: () => log.push("destroy live popup"),
    };
    const deadPopup = {
      isDestroyed: () => true,
      destroy: () => log.push("destroy dead popup"),
    };
    const window = {
      isDestroyed: () => false,
      destroy: () => log.push("destroy window"),
    };
    const reset = createRouteReset(HOME, {
      setEntryUrl: (url) => log.push(`entry ${url}`),
      setDisposing: (value) => log.push(`disposing ${value}`),
      stopActivity: () => log.push("stop activity"),
      popups: () => [livePopup, deadPopup],
      forgetPopups: () => log.push("forget popups"),
      surface: () => window,
      release: () => log.push("release"),
      changed: () => (url) => log.push(`changed ${String(url)}`),
    });
    reset();
    expect(log).toEqual([
      `entry ${HOME}`,
      "disposing true",
      "stop activity",
      "destroy live popup",
      "forget popups",
      "destroy window",
      "release",
      "disposing false",
      "changed null",
    ]);
  });

  it("copes with no window and no listener, and leaves a destroyed window", () => {
    const log: string[] = [];
    const base = {
      setEntryUrl: () => undefined,
      setDisposing: () => undefined,
      stopActivity: () => undefined,
      popups: () => [],
      forgetPopups: () => undefined,
      release: () => log.push("release"),
      changed: () => undefined,
    };
    createRouteReset(HOME, { ...base, surface: () => null })();
    createRouteReset(HOME, {
      ...base,
      surface: () => ({
        isDestroyed: () => true,
        destroy: () => log.push("destroy"),
      }),
    })();
    expect(log).toEqual(["release", "release"]);
  });
});

function targetsHarness(input: { e2eOrigin?: string | null } = {}) {
  const page = contents(CONVERSATION, 11);
  const state = {
    surface: surface(page) as Surface | null,
    loaded: true,
    generation: 4,
  };
  const targets = createManualTargets<Surface>({
    surface: () => state.surface,
    loaded: () => state.loaded,
    documentGeneration: () => state.generation,
    e2eOrigin: () => input.e2eOrigin ?? null,
  });
  return { page, state, targets };
}

describe("manual task target", () => {
  it("pins a loaded allowed document and stays current until anything moves", () => {
    const { page, state, targets } = targetsHarness();
    const current = targets.captureTarget();
    expect(current).not.toBeNull();
    expect(current?.()).toBe(true);

    state.generation = 5;
    expect(current?.()).toBe(false);
    state.generation = 4;
    expect(current?.()).toBe(true);

    page.url = `${CONVERSATION}2`;
    expect(current?.()).toBe(false);
    page.url = CONVERSATION;

    state.loaded = false;
    expect(current?.()).toBe(false);
    state.loaded = true;

    page.destroyed = true;
    expect(current?.()).toBe(false);
    page.destroyed = false;

    const original = state.surface;
    state.surface = surface(page);
    expect(current?.()).toBe(false);
    state.surface = original;
    expect(current?.()).toBe(true);

    original?.destroy();
    expect(current?.()).toBe(false);
  });

  it("pins nothing without a live, loaded, allowed document", () => {
    const missing = targetsHarness();
    missing.state.surface = null;
    expect(missing.targets.captureTarget()).toBeNull();

    const notLoaded = targetsHarness();
    notLoaded.state.loaded = false;
    expect(notLoaded.targets.captureTarget()).toBeNull();

    const surfaceGone = targetsHarness();
    surfaceGone.state.surface?.destroy();
    expect(surfaceGone.targets.captureTarget()).toBeNull();

    const contentsGone = targetsHarness();
    contentsGone.page.destroyed = true;
    expect(contentsGone.targets.captureTarget()).toBeNull();

    const foreign = targetsHarness();
    foreign.page.url = "https://example.com/";
    expect(foreign.targets.captureTarget()).toBeNull();
  });

  it("describes the document by contents id, generation and address", () => {
    const { state, targets } = targetsHarness();
    const document = targets.captureDocument();
    expect(document?.identity).toBe(JSON.stringify([11, 4, CONVERSATION]));
    expect(Object.isFrozen(document)).toBe(true);
    expect(document?.current()).toBe(true);
    state.generation = 5;
    expect(document?.current()).toBe(false);
  });

  it("describes no document when none can be pinned", () => {
    const { state, targets } = targetsHarness();
    state.loaded = false;
    expect(targets.captureDocument()).toBeNull();
  });
});

type CheckState = {
  surface: Surface | null;
  taskInFlight: boolean;
  updateAdmitted: boolean;
  capture: (() => boolean) | null;
  timers: { callback: () => void; ms: number; cancelled: boolean }[];
};

function openerHarness(
  input: {
    read?: () => Promise<unknown>;
    navigate?: (surface: Surface, url: string) => Promise<void>;
  } = {},
) {
  const page = contents(CONVERSATION);
  const state: CheckState = {
    surface: surface(page),
    taskInFlight: false,
    updateAdmitted: false,
    capture: () => true,
    timers: [],
  };
  page.executeJavaScript.mockImplementation(
    input.read ?? (() => Promise.resolve(true)),
  );
  const navigated: string[] = [];
  const inFlight: boolean[] = [];
  let announced = 0;
  const open = createConnectionCheckOpener<Surface>(HOME, {
    capture: () => state.capture,
    surface: () => state.surface,
    taskInFlight: () => state.taskInFlight,
    setTaskInFlight: (value) => {
      inFlight.push(value);
      state.taskInFlight = value;
    },
    updateAdmitted: () => state.updateAdmitted,
    navigate: (target, url) => {
      navigated.push(url);
      return input.navigate ? input.navigate(target, url) : Promise.resolve();
    },
    announce: () => {
      announced += 1;
    },
    after: (callback, ms) => {
      const timer = { callback, ms, cancelled: false };
      state.timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  return {
    open,
    page,
    state,
    navigated,
    inFlight,
    announced: () => announced,
  };
}

describe("connection check chat", () => {
  it("observes the original twice, then opens one temporary chat", async () => {
    const harness = openerHarness();
    expect(await harness.open("Farol", () => true)).toEqual({
      status: "opened",
    });
    expect(harness.page.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(harness.navigated).toEqual([`${HOME}?temporary-chat=true`]);
    expect(harness.announced()).toBe(1);
    expect(harness.inFlight).toEqual([true, false]);
    expect(harness.state.timers.every((timer) => timer.cancelled)).toBe(true);
    expect(harness.state.timers.map((timer) => timer.ms)).toEqual([
      CONNECTION_CHECK_READ_MS,
      CONNECTION_CHECK_READ_MS,
    ]);
  });

  it("refuses before touching the page while the route is busy", async () => {
    for (const patch of [
      { taskInFlight: true },
      { updateAdmitted: true },
      { capture: null },
      { surface: null },
    ] as const) {
      const harness = openerHarness();
      Object.assign(harness.state, patch);
      expect(await harness.open("Farol", () => true)).toEqual({
        status: "unreachable",
      });
      expect(harness.page.executeJavaScript).not.toHaveBeenCalled();
      expect(harness.inFlight).toEqual([]);
    }
    const stale = openerHarness();
    expect(await stale.open("Farol", () => false)).toEqual({
      status: "unreachable",
    });
    expect(stale.inFlight).toEqual([]);
  });

  it("does not navigate when the page does not confirm twice", async () => {
    for (const answers of [[false], [true, false], ["yes"]]) {
      let call = 0;
      const harness = openerHarness({
        read: () => Promise.resolve(answers[Math.min(call++, 1)]),
      });
      expect(await harness.open("Farol", () => true)).toEqual({
        status: "unreachable",
      });
      expect(harness.navigated).toEqual([]);
      expect(harness.inFlight).toEqual([true, false]);
    }
  });

  it("treats a read that takes too long as unconfirmed", async () => {
    const harness = openerHarness({ read: () => new Promise(() => undefined) });
    const result = harness.open("Farol", () => true);
    await Promise.resolve();
    harness.state.timers[0]?.callback();
    expect(await result).toEqual({ status: "unreachable" });
    expect(harness.navigated).toEqual([]);
    expect(harness.state.timers[0]?.cancelled).toBe(true);
  });

  it("does not navigate when the original moved during the reads", async () => {
    let calls = 0;
    const harness = openerHarness();
    harness.state.capture = () => {
      calls += 1;
      return calls <= 2;
    };
    expect(await harness.open("Farol", () => true)).toEqual({
      status: "unreachable",
    });
    expect(harness.navigated).toEqual([]);
  });

  it("is unreachable when the navigation fails, and releases the route", async () => {
    const harness = openerHarness({
      navigate: () => Promise.reject(new Error("blocked")),
    });
    expect(await harness.open("Farol", () => true)).toEqual({
      status: "unreachable",
    });
    expect(harness.announced()).toBe(0);
    expect(harness.inFlight).toEqual([true, false]);
  });

  it("is unreachable when the window changed or died during the navigation", async () => {
    const replaced = openerHarness({
      navigate: () => {
        replaced.state.surface = surface(contents(CONVERSATION, 9));
        return Promise.resolve();
      },
    });
    expect(await replaced.open("Farol", () => true)).toEqual({
      status: "unreachable",
    });
    expect(replaced.announced()).toBe(0);

    const destroyed = openerHarness({
      navigate: () => {
        destroyed.state.surface?.destroy();
        return Promise.resolve();
      },
    });
    expect(await destroyed.open("Farol", () => true)).toEqual({
      status: "unreachable",
    });

    let valid = true;
    const stale = openerHarness({
      navigate: () => {
        valid = false;
        return Promise.resolve();
      },
    });
    expect(await stale.open("Farol", () => valid)).toEqual({
      status: "unreachable",
    });
    expect(stale.announced()).toBe(0);
  });
});
