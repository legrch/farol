import vm from "node:vm";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  CONNECTION_CHECK_READ_MS,
  DEFAULT_ROUTE_TITLE,
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
    turn: () => state.turn,
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
  it("supersedes the observation even when there is no page to cancel", async () => {
    for (const input of [{ noSurface: true }, { loaded: false }] as const) {
      const harness = cancelHarness(input);
      expect(await harness.cancel()).toBe("not_running");
      expect(harness.state.generation).toBe(1);
      expect(harness.scripts).toEqual([]);
    }
    const destroyed = cancelHarness();
    destroyed.state.surface?.destroy();
    expect(await destroyed.cancel()).toBe("not_running");
    expect(destroyed.state.generation).toBe(1);
  });

  it("is not running when the stop control is absent for a task never seen running", async () => {
    const harness = cancelHarness();
    expect(await harness.cancel()).toBe("not_running");
    expect(kinds(harness.scripts)).toEqual(["bind", "click"]);
    expect(harness.delays).toEqual([]);
    expect(harness.state.stopped).toBe(0);
    expect(harness.state.generation).toBe(1);
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

  it("retries the stop control five times for a task seen running, each with its own token", async () => {
    const harness = cancelHarness({ observedRunning: true });
    expect(await harness.cancel()).toBe("outcome_unknown");
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

  it("is outcome-unknown for an unreadable answer, a throw or a lost page", async () => {
    const unreadableBind = cancelHarness({ answer: () => ({ nope: true }) });
    expect(await unreadableBind.cancel()).toBe("outcome_unknown");
    expect(clickScripts(unreadableBind.scripts)).toEqual([]);

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

    const throwing = cancelHarness({ answer: () => new Error("page gone") });
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

  it("answers a page call that stalls as outcome-unknown, and never as a refusal", async () => {
    const stalledBind = cancelHarness({
      answer: (script) => (kindOf(script) === "bind" ? HOLD : undefined),
    });
    const bind = stalledBind.cancel();
    await flush();
    expect(stalledBind.timers.map((timer) => timer.ms)).toEqual([5_000]);
    stalledBind.timers[0]!.fire();
    expect(await bind).toBe("outcome_unknown");
    expect(clickScripts(stalledBind.scripts)).toEqual([]);

    const stalledClick = cancelHarness({
      doc: newDoc(A, { stop: true }),
      answer: (script) => (kindOf(script) === "click" ? HOLD : undefined),
    });
    const click = stalledClick.cancel();
    await flush();
    stalledClick.timers.at(-1)!.fire();
    expect(await click).toBe("outcome_unknown");
    expect(stalledClick.state.generation).toBe(1);
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
    expect(kinds(harness.scripts)).toEqual(["bind"]);
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

  it("binds the page shown at Cancel for an owner-typed turn in a Route B window", async () => {
    const running = stopping(B);
    const harness = cancelHarness({ ...running, routeB: true, turn: null });
    expect(await harness.cancel()).toBe("cancelled");
    expect(kinds(harness.scripts)[0]).toBe("bind");
    expect(stamped(running.doc)).toBe(true);
  });

  it("binds the page shown at Cancel for an owner Browser task", async () => {
    const running = stopping(A);
    const harness = cancelHarness(running);
    expect(await harness.cancel()).toBe("cancelled");
    expect(stamped(running.doc)).toBe(true);
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
    ["an owner-typed turn in a Route B window", { routeB: true, turn: null }],
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

  it("still cancels when the turn ended on its own and none was admitted since", async () => {
    // The epoch is what names the turn: its ending changes nothing, so the
    // provider's work it left running is still this Cancel's to stop.
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
    expect(await harness.cancel()).toBe("cancelled");
    expect(harness.state.clicks).toBe(1);
    expect(harness.state.stopped).toBe(1);
  });

  it("is refused by the page, with no click, when a successor turn has marked it while the script was queued", async () => {
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
    expect(await harness.cancel()).toBe("page_changed");
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

  it("treats a Route B turn still preparing as the turn in flight", async () => {
    const preparing: CancelTurn = {
      epoch: 1,
      dispatchIdentityUrl: null,
      pinnedConversationUrl: null,
    };
    // Bound to the page shown at Cancel, since no address was recorded yet...
    const same = cancelHarness({
      ...stopping(B),
      routeB: true,
      turn: preparing,
    });
    expect(await same.cancel()).toBe("cancelled");
    expect(same.scripts[0]).toContain(JSON.stringify(`${ORIGIN}${B}`));
    expect(same.state.generation).toBe(1);

    // ...and a Cancel for a turn that is replaced is refused, which only a
    // turn-bound Cancel does.
    const replaced = cancelHarness({
      ...stopping(B),
      routeB: true,
      turn: preparing,
      answer: (script) => {
        if (kindOf(script) === "bind") {
          replaced.state.epoch = 2;
          replaced.state.turn = turnOf(2);
        }
        return undefined;
      },
    });
    expect(await replaced.cancel()).toBe("page_changed");
    expect(replaced.state.clicks).toBe(0);
    expect(replaced.state.generation).toBe(0);
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

  it("clicks nothing for a Cancel that started with no turn once a successor has come and gone", async () => {
    // The Cancel started after turn 1 ended, holding epoch 1. Turn 2 is then
    // admitted, marks the page, runs and ends: its end leaves the mark as it
    // is, so the queued click still finds a different epoch and refuses.
    const { script, doc } = await heldClick({
      routeB: true,
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
      routeB: true,
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
      routeB: true,
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
      routeB: true,
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
      routeB: true,
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
      routeB: true,
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
      routeB: true,
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
    expect(await harness.cancel()).toBe("page_changed");
    expect(harness.state.clicks).toBe(0);
    expect(harness.state.stopped).toBe(0);
    expect(harness.state.generation).toBe(0);
    expect(clickScripts(harness.scripts)).toHaveLength(1);
    expect(kinds(harness.scripts)).toEqual(["bind", "click"]);
  });

  it("refuses to bind a page already marked with a later epoch, and leaves it untouched", async () => {
    const doc = newDoc(A, { stop: true });
    const harness = cancelHarness({ doc, routeB: true, turn: null, epoch: 2 });
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
      routeB: true,
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
