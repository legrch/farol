import { describe, expect, it, vi, type Mock } from "vitest";
import {
  activityProbe,
  cancelTaskScript,
} from "../../../src/apps/desktop/chatgpt/scripts";
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

type CancelState = {
  surface: Surface | null;
  loaded: boolean;
  running: boolean;
  generation: number;
  stopped: number;
};

function cancelHarness(
  answers: (script: string, call: number) => unknown,
  input: { running?: boolean; loaded?: boolean; noSurface?: boolean } = {},
) {
  const page = contents(CONVERSATION);
  const state: CancelState = {
    surface: input.noSurface ? null : surface(page),
    loaded: input.loaded ?? true,
    running: input.running ?? false,
    generation: 0,
    stopped: 0,
  };
  const scripts: string[] = [];
  let calls = 0;
  page.executeJavaScript.mockImplementation((script: string) => {
    scripts.push(script);
    calls += 1;
    const answer = answers(script, calls);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  });
  const delays: number[] = [];
  const cancel = createTaskCanceller<Contents, Surface>({
    surface: () => state.surface,
    loaded: () => state.loaded,
    supersedeObservation: () => {
      state.generation += 1;
    },
    observedRunning: () => state.running,
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    recordStopped: () => {
      state.stopped += 1;
    },
  });
  return { cancel, state, scripts, delays, page };
}

describe("cancelling a task", () => {
  it("supersedes the observation even when there is no page to cancel", async () => {
    for (const input of [{ noSurface: true }, { loaded: false }] as const) {
      const harness = cancelHarness(() => ({ activated: true }), input);
      expect(await harness.cancel()).toBe("not_running");
      expect(harness.state.generation).toBe(1);
      expect(harness.scripts).toEqual([]);
    }
    const destroyed = cancelHarness(() => ({ activated: true }));
    destroyed.state.surface?.destroy();
    expect(await destroyed.cancel()).toBe("not_running");
    expect(destroyed.state.generation).toBe(1);
  });

  it("is not running when the stop control is absent for a task never seen running", async () => {
    const harness = cancelHarness(() => ({ activated: false }));
    expect(await harness.cancel()).toBe("not_running");
    expect(harness.scripts).toEqual([cancelTaskScript]);
    expect(harness.delays).toEqual([]);
    expect(harness.state.stopped).toBe(0);
  });

  it("clicks stop, waits for the page to stop and records it", async () => {
    const harness = cancelHarness((script, call) =>
      script === cancelTaskScript ? { activated: true } : { running: call < 3 },
    );
    expect(await harness.cancel()).toBe("cancelled");
    expect(harness.scripts).toEqual([
      cancelTaskScript,
      activityProbe,
      activityProbe,
    ]);
    expect(harness.delays).toEqual([100, 100]);
    expect(harness.state.stopped).toBe(1);
  });

  it("retries the stop control five times for a task seen running", async () => {
    const harness = cancelHarness(() => ({ activated: false }), {
      running: true,
    });
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.scripts).toHaveLength(5);
    expect(harness.delays).toEqual([100, 100, 100, 100, 100]);
    expect(harness.state.stopped).toBe(0);
  });

  it("stops retrying once the control activates", async () => {
    const harness = cancelHarness(
      (script, call) =>
        script === cancelTaskScript
          ? { activated: call === 3 }
          : { running: false },
      { running: true },
    );
    expect(await harness.cancel()).toBe("cancelled");
    expect(
      harness.scripts.filter((script) => script === cancelTaskScript),
    ).toHaveLength(3);
  });

  it("stays outcome-unknown when the page keeps running after the stop", async () => {
    const harness = cancelHarness((script) =>
      script === cancelTaskScript ? { activated: true } : { running: true },
    );
    expect(await harness.cancel()).toBe("outcome_unknown");
    expect(harness.scripts.filter((s) => s === activityProbe)).toHaveLength(20);
    expect(harness.state.stopped).toBe(0);
  });

  it("is outcome-unknown for an unreadable answer, a throw or a lost page", async () => {
    const unreadableStop = cancelHarness(() => ({ nope: true }));
    expect(await unreadableStop.cancel()).toBe("outcome_unknown");

    const unreadableProbe = cancelHarness((script) =>
      script === cancelTaskScript ? { activated: true } : "garbage",
    );
    expect(await unreadableProbe.cancel()).toBe("outcome_unknown");

    const throwing = cancelHarness(() => new Error("page gone"));
    expect(await throwing.cancel()).toBe("outcome_unknown");

    const lost = cancelHarness((script) => {
      if (script === cancelTaskScript) return { activated: true };
      return { running: false };
    });
    lost.page.executeJavaScript.mockImplementationOnce(() => {
      lost.state.surface?.destroy();
      return Promise.resolve({ activated: true });
    });
    expect(await lost.cancel()).toBe("outcome_unknown");
    expect(lost.state.stopped).toBe(0);
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
