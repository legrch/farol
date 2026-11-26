import { describe, expect, it } from "vitest";
import {
  SIGN_IN_RETURN_SENTINEL,
  collapseChatGptSidebarScript,
  signInBannerScript,
} from "../../../src/apps/desktop/chatgpt/scripts";
import {
  adoptPopupWindow,
  trackRouteReadiness,
  type AdoptedPopup,
  type PopupAdoptionPorts,
  type ReadinessContents,
  type ReadinessLoad,
  type RouteReadinessPorts,
} from "./ready";

const HOME = "https://chatgpt.com/";
const PAGE = "https://chatgpt.com/c/1";
const NEXT = "https://chatgpt.com/c/2";
const FOREIGN = "https://evil.example/";

type Listener = (...args: never[]) => unknown;
type Gate = "installed" | "failed" | "stale";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A gate install the test settles by hand, so an in-page change can land
// while an earlier install is still pending.
function pendingInstalls() {
  const resolvers: Array<(result: Gate) => void> = [];
  const next = () =>
    new Promise<Gate>((resolve) => {
      resolvers.push(resolve);
    });
  return {
    next,
    settle: (index: number, result: Gate) => resolvers[index]?.(result),
  };
}

// One route: every field the listeners write is a plain value, and every
// write, read of a port and report lands in `log` in the order it happened.
function routeHarness(
  options: {
    owned?: boolean;
    requireApp?: boolean;
    collapseSidebar?: boolean;
    signInMode?: boolean;
    windowKind?: boolean;
    observesActivity?: boolean;
    running?: boolean | null;
    gate?: Gate | (() => Promise<Gate>);
    url?: string;
    load?: ReadinessLoad;
  } = {},
) {
  const log: string[] = [];
  const route = {
    owned: options.owned ?? true,
    load: options.load ?? ("failed" as ReadinessLoad),
    loadFailed: false,
    awaitingCommit: false,
    generation: 0,
    physical: 0,
    url: options.url ?? PAGE,
    signInMode: options.signInMode ?? false,
    running: options.running ?? null,
    gate: options.gate ?? ("installed" as Gate),
  };
  const registrations: string[] = [];
  const listeners = new Map<string, Listener[]>();
  const executed: Array<[string, boolean | undefined]> = [];
  const contents: ReadinessContents = {
    getURL: () => route.url,
    mainFrame: { processId: 7, routingId: 3 },
    executeJavaScript: (script, gesture) => {
      executed.push([script, gesture]);
      return Promise.resolve(undefined);
    },
    on: ((event: string, listener: Listener) => {
      registrations.push(event);
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }) as ReadinessContents["on"],
  };
  const gateCalls = { install: 0, block: 0 };
  const ports: RouteReadinessPorts = {
    allowed: (url) => url.startsWith("https://chatgpt.com/"),
    owns: () => route.owned,
    state: {
      load: () => route.load,
      setLoad: (load) => {
        route.load = load;
        log.push(`load=${load}`);
      },
      loadFailed: () => route.loadFailed,
      setLoadFailed: (failed) => {
        route.loadFailed = failed;
        log.push(`loadFailed=${failed}`);
      },
      awaitingCommit: () => route.awaitingCommit,
      setAwaitingCommit: (awaiting) => {
        route.awaitingCommit = awaiting;
        log.push(`awaitingCommit=${awaiting}`);
      },
      advanceDocument: () => {
        route.generation += 1;
        log.push(`generation=${route.generation}`);
      },
      advancePhysicalDocument: () => {
        route.physical += 1;
        log.push(`physical=${route.physical}`);
      },
    },
    surface: {
      hide: () => log.push("hide"),
      reveal: () => log.push("reveal"),
      isWindow: () => options.windowKind ?? false,
    },
    options: {
      requireApp: () => options.requireApp ?? false,
      collapseSidebar: () => options.collapseSidebar ?? false,
      homeUrl: () => HOME,
      signInMode: () => route.signInMode,
      title: () => "Farol",
      observesTaskActivity: () => options.observesActivity ?? false,
    },
    events: {
      loadState: (state) => log.push(`state:${state}`),
      conversationUrl: () => log.push("conversation"),
      blocked: (diagnostic) =>
        log.push(`blocked:${JSON.stringify(diagnostic)}`),
      signInReturn: () => log.push("sign-in-return"),
      taskOutcomeUnknown: () => log.push("outcome-unknown"),
    },
    gate: {
      install: () => {
        gateCalls.install += 1;
        log.push("gate");
        return typeof route.gate === "function"
          ? route.gate()
          : Promise.resolve(route.gate);
      },
      blockUnsafe: () => {
        gateCalls.block += 1;
        log.push("block-unsafe");
      },
    },
    activity: {
      start: () => log.push("activity-start"),
      running: () => route.running,
      stop: () => log.push("activity-stop"),
    },
  };
  trackRouteReadiness(contents, ports);
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? [])
      (listener as (...rest: unknown[]) => unknown)(...args);
  };
  return { route, log, registrations, executed, gateCalls, emit };
}

const start = (url: string, inPlace = false, isMainFrame = true) =>
  [{}, url, inPlace, isMainFrame] as const;
const failLoad = (code: number, url: string, isMainFrame = true) =>
  [{}, code, "ERR", url, isMainFrame] as const;

describe("the readiness listeners", () => {
  it("are registered in the original order on the original events", () => {
    const { registrations } = routeHarness();
    expect(registrations).toEqual([
      "did-redirect-navigation",
      "did-navigate",
      "dom-ready",
      "did-start-navigation",
      "did-fail-load",
      "did-finish-load",
      "console-message",
      "did-navigate-in-page",
      "render-process-gone",
    ]);
  });
});

describe("did-start-navigation", () => {
  it("opens a full navigation: awaiting commit, both generations, not loaded", () => {
    const h = routeHarness({ load: "loaded" });
    h.route.loadFailed = true;
    h.emit("did-start-navigation", ...start(NEXT));
    expect(h.log).toEqual([
      "awaitingCommit=true",
      "generation=1",
      "physical=1",
      "loadFailed=false",
      "load=failed",
      "state:loading",
    ]);
  });

  it("hides a protected surface before it reports loading", () => {
    const h = routeHarness({ requireApp: true });
    h.emit("did-start-navigation", ...start(NEXT));
    expect(h.log).toEqual([
      "awaitingCommit=true",
      "generation=1",
      "physical=1",
      "loadFailed=false",
      "hide",
      "load=failed",
      "state:loading",
    ]);
  });

  it("keeps an in-page navigation loaded and leaves the physical document alone", () => {
    const h = routeHarness();
    h.emit("did-start-navigation", ...start(NEXT, true));
    expect(h.log).toEqual(["generation=1", "load=loaded", "state:loaded"]);
    expect(h.route.awaitingCommit).toBe(false);
  });

  it("does not hide a protected surface for an in-page navigation", () => {
    const h = routeHarness({ requireApp: true });
    h.emit("did-start-navigation", ...start(NEXT, true));
    expect(h.log).not.toContain("hide");
  });

  it("ignores a refused URL, a subframe and a contents the route no longer owns", () => {
    const h = routeHarness();
    h.emit("did-start-navigation", ...start(FOREIGN));
    h.emit("did-start-navigation", ...start(NEXT, false, false));
    h.route.owned = false;
    h.emit("did-start-navigation", ...start(NEXT));
    expect(h.log).toEqual([]);
    expect(h.route.generation).toBe(0);
  });
});

describe("did-navigate", () => {
  it("commits a full navigation: clears the failure and the wait", () => {
    const h = routeHarness();
    h.emit("did-start-navigation", ...start(NEXT));
    h.log.length = 0;
    h.emit("did-navigate", {}, NEXT);
    expect(h.log).toEqual(["loadFailed=false", "awaitingCommit=false"]);
  });

  it("commits any allowed URL while no navigation is being followed", () => {
    const h = routeHarness();
    h.emit("did-navigate", {}, PAGE);
    expect(h.log).toEqual(["loadFailed=false", "awaitingCommit=false"]);
  });

  it("ignores a commit that is not the navigation being followed", () => {
    const h = routeHarness();
    h.emit("did-start-navigation", ...start(NEXT));
    h.log.length = 0;
    h.emit("did-navigate", {}, PAGE);
    expect(h.log).toEqual([]);
    expect(h.route.awaitingCommit).toBe(true);
  });

  it("follows a redirect to the commit, but only an allowed main-frame one", () => {
    const h = routeHarness();
    h.emit("did-start-navigation", ...start(NEXT));
    h.emit("did-redirect-navigation", {}, FOREIGN, false, true);
    h.emit("did-redirect-navigation", {}, PAGE, false, false);
    h.emit("did-navigate", {}, NEXT);
    expect(h.route.awaitingCommit).toBe(false);
    h.emit("did-redirect-navigation", {}, PAGE, false, true);
    h.log.length = 0;
    h.emit("did-navigate", {}, NEXT);
    expect(h.log).toEqual([]);
    h.emit("did-navigate", {}, PAGE);
    expect(h.log).toEqual(["loadFailed=false", "awaitingCommit=false"]);
  });

  it("ignores a refused URL and a contents the route no longer owns", () => {
    const h = routeHarness();
    h.emit("did-navigate", {}, FOREIGN);
    h.route.owned = false;
    h.emit("did-navigate", {}, PAGE);
    expect(h.log).toEqual([]);
  });
});

describe("dom-ready", () => {
  it("marks an ordinary browser loaded and reports the conversation", () => {
    const h = routeHarness();
    h.emit("dom-ready");
    expect(h.log).toEqual(["load=loaded", "state:loaded", "conversation"]);
  });

  it.each([
    ["a protected surface", { requireApp: true }, () => undefined],
    ["a contents the route lost", { owned: false }, () => undefined],
    [
      "a failed document",
      {},
      (h: ReturnType<typeof routeHarness>) => (h.route.loadFailed = true),
    ],
    [
      "a document awaiting its commit",
      {},
      (h: ReturnType<typeof routeHarness>) => (h.route.awaitingCommit = true),
    ],
    ["a refused URL", { url: FOREIGN }, () => undefined],
    ["an already loaded route", { load: "loaded" as const }, () => undefined],
  ])("grants no readiness to %s", (_name, options, prepare) => {
    const h = routeHarness(options);
    prepare(h);
    h.emit("dom-ready");
    expect(h.log).toEqual([]);
  });
});

describe("did-fail-load", () => {
  it("records a failed main-frame document and reports it blocked", () => {
    const h = routeHarness({ load: "loaded" });
    h.emit("did-fail-load", ...failLoad(-105, PAGE));
    expect(h.log).toEqual([
      "generation=1",
      "loadFailed=true",
      "load=failed",
      "state:failed",
      `blocked:${JSON.stringify({ kind: "load-failed", code: -105 })}`,
    ]);
  });

  it("ignores a cancellation, which describes no document", () => {
    const h = routeHarness();
    h.emit("did-fail-load", ...failLoad(-3, PAGE));
    expect(h.log).toEqual([]);
  });

  it("ignores a cancelled earlier navigation failing after its successor began", () => {
    const h = routeHarness();
    h.emit("did-start-navigation", ...start(NEXT));
    h.log.length = 0;
    h.emit("did-fail-load", ...failLoad(-105, PAGE));
    expect(h.log).toEqual([]);
    expect(h.route.loadFailed).toBe(false);
    h.emit("did-fail-load", ...failLoad(-105, NEXT));
    expect(h.route.loadFailed).toBe(true);
  });

  it("ignores a subframe and a contents the route no longer owns", () => {
    const h = routeHarness();
    h.emit("did-fail-load", ...failLoad(-105, PAGE, false));
    h.route.owned = false;
    h.emit("did-fail-load", ...failLoad(-105, PAGE));
    expect(h.log).toEqual([]);
  });
});

describe("did-finish-load", () => {
  it("installs the gate, then marks loaded, reports, reveals and starts activity", async () => {
    const h = routeHarness({ observesActivity: true });
    h.emit("did-finish-load");
    expect(h.log).toEqual(["gate"]);
    await flush();
    expect(h.log).toEqual([
      "gate",
      "load=loaded",
      "state:loaded",
      "conversation",
      "reveal",
      "activity-start",
    ]);
    expect(h.executed).toEqual([]);
  });

  it("does not start activity when nobody observes it", async () => {
    const h = routeHarness();
    h.emit("did-finish-load");
    await flush();
    expect(h.log).not.toContain("activity-start");
    expect(h.log).toContain("reveal");
  });

  it("collapses the sidebar before it marks the route loaded", async () => {
    const h = routeHarness({ collapseSidebar: true });
    h.emit("did-finish-load");
    await flush();
    expect(h.executed).toEqual([[collapseChatGptSidebarScript(), true]]);
  });

  it("does not collapse the sidebar on a page that is not ChatGPT's", async () => {
    const h = routeHarness({ collapseSidebar: true, url: FOREIGN });
    h.emit("did-finish-load");
    await flush();
    expect(h.executed).toEqual([]);
  });

  it("shows the sign-in banner only in a sign-in window on a ChatGPT page", async () => {
    const shown = routeHarness({ signInMode: true, windowKind: true });
    shown.emit("did-finish-load");
    await flush();
    expect(shown.executed).toEqual([[signInBannerScript("Farol"), true]]);
    const notWindow = routeHarness({ signInMode: true });
    notWindow.emit("did-finish-load");
    await flush();
    expect(notWindow.executed).toEqual([]);
    const notSignIn = routeHarness({ windowKind: true });
    notSignIn.emit("did-finish-load");
    await flush();
    expect(notSignIn.executed).toEqual([]);
  });

  it("fails closed: a gate that cannot be installed blocks the surface and loads nothing", async () => {
    const h = routeHarness({ gate: "failed", observesActivity: true });
    h.emit("did-finish-load");
    await flush();
    expect(h.log).toEqual(["gate", "block-unsafe"]);
    expect(h.route.load).toBe("failed");
  });

  it("does nothing for a stale gate", async () => {
    const h = routeHarness({ gate: "stale" });
    h.emit("did-finish-load");
    await flush();
    expect(h.log).toEqual(["gate"]);
  });

  it("does not ask for the gate while the document failed or awaits its commit", async () => {
    const h = routeHarness();
    h.route.loadFailed = true;
    h.emit("did-finish-load");
    h.route.loadFailed = false;
    h.route.awaitingCommit = true;
    h.emit("did-finish-load");
    h.route.awaitingCommit = false;
    h.route.owned = false;
    h.emit("did-finish-load");
    await flush();
    expect(h.gateCalls.install).toBe(0);
  });

  it("writes nothing when the route lost the contents during the gate", async () => {
    let release: (gate: Gate) => void = () => undefined;
    const h = routeHarness({
      gate: () => new Promise<Gate>((resolve) => (release = resolve)),
    });
    h.emit("did-finish-load");
    h.route.owned = false;
    release("installed");
    await flush();
    expect(h.log).toEqual(["gate"]);
  });
});

describe("console-message", () => {
  const frame = { processId: 7, routingId: 3, url: PAGE };
  const message = (message: string, frame: unknown) => ({ message, frame });

  it("asks for the sign-in return from the page's own top-level frame", () => {
    const h = routeHarness({ signInMode: true });
    h.emit("console-message", message(SIGN_IN_RETURN_SENTINEL, frame));
    expect(h.log).toEqual(["sign-in-return"]);
  });

  it.each([
    ["another message", { message: "hello", frame }, { signInMode: true }],
    [
      "an embedded frame",
      message(SIGN_IN_RETURN_SENTINEL, { ...frame, routingId: 4 }),
      { signInMode: true },
    ],
    [
      "another process",
      message(SIGN_IN_RETURN_SENTINEL, { ...frame, processId: 8 }),
      { signInMode: true },
    ],
    [
      "a foreign origin",
      message(SIGN_IN_RETURN_SENTINEL, { ...frame, url: FOREIGN }),
      { signInMode: true },
    ],
    ["no frame", message(SIGN_IN_RETURN_SENTINEL, null), { signInMode: true }],
    [
      "an undefined frame",
      message(SIGN_IN_RETURN_SENTINEL, undefined),
      { signInMode: true },
    ],
    [
      "a route outside sign-in mode",
      message(SIGN_IN_RETURN_SENTINEL, frame),
      { signInMode: false },
    ],
    [
      "a contents the route lost",
      message(SIGN_IN_RETURN_SENTINEL, frame),
      { signInMode: true, owned: false },
    ],
  ])("never closes the sign-in window for %s", (_name, details, options) => {
    const h = routeHarness(options);
    h.emit("console-message", details);
    expect(h.log).toEqual([]);
  });
});

describe("did-navigate-in-page", () => {
  it("advances the document, reports the current load state and installs the gate", async () => {
    const h = routeHarness({ load: "loaded" });
    h.emit("did-navigate-in-page", {}, NEXT, true);
    expect(h.log).toEqual([
      "generation=1",
      "state:loaded",
      "conversation",
      "gate",
    ]);
    await flush();
    expect(h.log).not.toContain("block-unsafe");
  });

  it("reports the failed state as it is, without granting readiness", () => {
    const h = routeHarness({ load: "failed" });
    h.emit("did-navigate-in-page", {}, NEXT, true);
    expect(h.log.slice(0, 2)).toEqual(["generation=1", "state:failed"]);
    expect(h.route.load).toBe("failed");
  });

  it("blocks the surface when the gate fails", async () => {
    const h = routeHarness({ gate: "failed" });
    h.emit("did-navigate-in-page", {}, NEXT, true);
    await flush();
    expect(h.log.at(-1)).toBe("block-unsafe");
  });

  it("does not block the surface for a stale gate", async () => {
    const h = routeHarness({ gate: "stale" });
    h.emit("did-navigate-in-page", {}, NEXT, true);
    await flush();
    expect(h.gateCalls.block).toBe(0);
  });

  it("honors the replacement install when an in-page change supersedes a pending one", async () => {
    const installs = pendingInstalls();
    const h = routeHarness({ observesActivity: true, gate: installs.next });
    h.emit("did-finish-load");
    h.emit("did-navigate-in-page", {}, NEXT, true);
    expect(h.gateCalls.install).toBe(2);
    // The first install belongs to the document before the in-page change.
    installs.settle(0, "stale");
    await flush();
    expect(h.log).not.toContain("reveal");
    installs.settle(1, "installed");
    await flush();
    expect(h.route.load).toBe("loaded");
    expect(h.log.filter((entry) => entry === "reveal")).toHaveLength(1);
    expect(h.log.filter((entry) => entry === "activity-start")).toHaveLength(1);
    expect(h.log.at(-1)).toBe("activity-start");
  });

  it("honors only the last install when several in-page changes arrive", async () => {
    const installs = pendingInstalls();
    const h = routeHarness({ observesActivity: true, gate: installs.next });
    h.emit("did-finish-load");
    h.emit("did-navigate-in-page", {}, NEXT, true);
    h.emit("did-navigate-in-page", {}, PAGE, true);
    installs.settle(0, "stale");
    installs.settle(1, "stale");
    await flush();
    expect(h.log).not.toContain("reveal");
    installs.settle(2, "installed");
    await flush();
    expect(h.log.filter((entry) => entry === "reveal")).toHaveLength(1);
    expect(h.log.filter((entry) => entry === "activity-start")).toHaveLength(1);
  });

  it("lets only the latest install complete the load, whichever order they resolve in", async () => {
    const completions = (log: string[]) =>
      log.filter((entry) => entry === "reveal").length;
    // An in-page install that started before the load finished.
    const early = pendingInstalls();
    const a = routeHarness({ observesActivity: true, gate: early.next });
    a.emit("did-navigate-in-page", {}, NEXT, true);
    a.emit("did-finish-load");
    early.settle(0, "installed");
    await flush();
    expect(completions(a.log)).toBe(0);
    early.settle(1, "installed");
    await flush();
    expect(completions(a.log)).toBe(1);
    expect(a.log.filter((entry) => entry === "activity-start")).toHaveLength(1);

    const late = pendingInstalls();
    const b = routeHarness({ observesActivity: true, gate: late.next });
    b.emit("did-navigate-in-page", {}, NEXT, true);
    b.emit("did-finish-load");
    late.settle(1, "installed");
    await flush();
    late.settle(0, "installed");
    await flush();
    expect(completions(b.log)).toBe(1);
    expect(b.log.filter((entry) => entry === "activity-start")).toHaveLength(1);
  });

  it("ignores a superseded install that succeeds while its replacement is pending", async () => {
    const installs = pendingInstalls();
    const h = routeHarness({ observesActivity: true, gate: installs.next });
    h.emit("did-finish-load");
    h.emit("did-navigate-in-page", {}, NEXT, true);
    installs.settle(0, "installed");
    await flush();
    expect(h.log).not.toContain("reveal");
    expect(h.log).not.toContain("activity-start");
    expect(h.route.load).toBe("failed");
    installs.settle(1, "installed");
    await flush();
    expect(h.log.filter((entry) => entry === "reveal")).toHaveLength(1);
    expect(h.log.filter((entry) => entry === "activity-start")).toHaveLength(1);
  });

  it("ignores an older install that fails while the newer one is pending", async () => {
    const installs = pendingInstalls();
    const h = routeHarness({ observesActivity: true, gate: installs.next });
    h.emit("did-navigate-in-page", {}, NEXT, true);
    h.emit("did-finish-load");
    installs.settle(0, "failed");
    await flush();
    expect(h.gateCalls.block).toBe(0);
    expect(h.log).not.toContain("block-unsafe");
    installs.settle(1, "installed");
    await flush();
    expect(h.log.filter((entry) => entry === "reveal")).toHaveLength(1);
    expect(h.gateCalls.block).toBe(0);
  });

  it("ignores a failure that arrives after the wait ended, and still fails closed for the latest", async () => {
    const installs = pendingInstalls();
    const h = routeHarness({ observesActivity: true, gate: installs.next });
    h.emit("did-finish-load");
    h.emit("render-process-gone");
    installs.settle(0, "failed");
    await flush();
    expect(h.gateCalls.block).toBe(0);

    const latest = pendingInstalls();
    const b = routeHarness({ gate: latest.next });
    b.emit("did-finish-load");
    b.emit("did-navigate-in-page", {}, NEXT, true);
    latest.settle(1, "failed");
    await flush();
    expect(b.gateCalls.block).toBe(1);
    latest.settle(0, "failed");
    await flush();
    expect(b.gateCalls.block).toBe(1);
  });

  it("reveals nothing when the replacement install is stale or fails", async () => {
    const stale = pendingInstalls();
    const a = routeHarness({ observesActivity: true, gate: stale.next });
    a.emit("did-finish-load");
    a.emit("did-navigate-in-page", {}, NEXT, true);
    stale.settle(0, "stale");
    stale.settle(1, "stale");
    await flush();
    expect(a.log).not.toContain("reveal");
    expect(a.log).not.toContain("activity-start");
    expect(a.route.load).toBe("failed");

    const failing = pendingInstalls();
    const b = routeHarness({ observesActivity: true, gate: failing.next });
    b.emit("did-finish-load");
    b.emit("did-navigate-in-page", {}, NEXT, true);
    failing.settle(0, "stale");
    failing.settle(1, "failed");
    await flush();
    expect(b.log).not.toContain("reveal");
    expect(b.log).not.toContain("activity-start");
    expect(b.log.at(-1)).toBe("block-unsafe");
  });

  it("does not reveal again for an in-page change after the load completed", async () => {
    const h = routeHarness({ observesActivity: true });
    h.emit("did-finish-load");
    await flush();
    h.log.length = 0;
    h.emit("did-navigate-in-page", {}, NEXT, true);
    await flush();
    expect(h.log).not.toContain("reveal");
    expect(h.log).not.toContain("activity-start");
  });

  it("does not let a superseded install reveal a document a full navigation replaced", async () => {
    const installs = pendingInstalls();
    const h = routeHarness({ observesActivity: true, gate: installs.next });
    h.emit("did-finish-load");
    h.emit("did-navigate-in-page", {}, NEXT, true);
    h.emit("did-start-navigation", ...start(PAGE));
    installs.settle(0, "stale");
    installs.settle(1, "installed");
    await flush();
    expect(h.log).not.toContain("reveal");
    expect(h.log).not.toContain("activity-start");
  });

  it("ignores a subframe and a contents the route no longer owns", () => {
    const h = routeHarness();
    h.emit("did-navigate-in-page", {}, NEXT, false);
    h.route.owned = false;
    h.emit("did-navigate-in-page", {}, NEXT, true);
    expect(h.log).toEqual([]);
  });

  it("does not replace the navigation being followed while it awaits its commit", () => {
    const h = routeHarness();
    h.emit("did-start-navigation", ...start(NEXT));
    h.emit("did-navigate-in-page", {}, PAGE, true);
    h.log.length = 0;
    // The followed navigation is still NEXT: a commit of PAGE is not it.
    h.emit("did-navigate", {}, PAGE);
    expect(h.log).toEqual([]);
    h.emit("did-navigate", {}, NEXT);
    expect(h.log).toEqual(["loadFailed=false", "awaitingCommit=false"]);
  });

  it("follows the in-page URL once the document is committed", () => {
    const h = routeHarness();
    h.emit("did-navigate-in-page", {}, NEXT, true);
    h.log.length = 0;
    h.emit("did-navigate", {}, PAGE);
    expect(h.log).toEqual([]);
    h.emit("did-navigate", {}, NEXT);
    expect(h.log).toEqual(["loadFailed=false", "awaitingCommit=false"]);
  });
});

describe("render-process-gone", () => {
  it("fails the route, hides it and ends activity in the original order", () => {
    const h = routeHarness({ load: "loaded", running: false });
    h.emit("render-process-gone");
    expect(h.log).toEqual([
      "activity-stop",
      "physical=1",
      "generation=1",
      "load=failed",
      "state:failed",
      "hide",
    ]);
  });

  it("reports an unknown outcome first when a task was running", () => {
    const h = routeHarness({ load: "loaded", running: true });
    h.emit("render-process-gone");
    expect(h.log.slice(0, 2)).toEqual(["outcome-unknown", "activity-stop"]);
  });

  it("does not claim an unknown outcome when the activity was never observed", () => {
    const h = routeHarness({ running: null });
    h.emit("render-process-gone");
    expect(h.log).not.toContain("outcome-unknown");
  });

  it("ignores a contents the route no longer owns", () => {
    const h = routeHarness({ owned: false, running: true });
    h.emit("render-process-gone");
    expect(h.log).toEqual([]);
  });
});

describe("a realistic load", () => {
  it("goes start, redirect, commit, dom-ready, finish, then an in-page change", async () => {
    const h = routeHarness({ observesActivity: true });
    h.emit("did-start-navigation", ...start(PAGE));
    h.emit("did-redirect-navigation", {}, NEXT, false, true);
    h.emit("did-navigate", {}, NEXT);
    h.emit("dom-ready");
    h.emit("did-finish-load");
    await flush();
    h.emit("did-navigate-in-page", {}, PAGE, true);
    await flush();
    expect(h.log).toEqual([
      "awaitingCommit=true",
      "generation=1",
      "physical=1",
      "loadFailed=false",
      "load=failed",
      "state:loading",
      "loadFailed=false",
      "awaitingCommit=false",
      "load=loaded",
      "state:loaded",
      "conversation",
      "gate",
      "load=loaded",
      "state:loaded",
      "conversation",
      "reveal",
      "activity-start",
      "generation=2",
      "state:loaded",
      "conversation",
      "gate",
    ]);
  });

  it("never becomes ready after a failed navigation that did not commit", async () => {
    const h = routeHarness();
    h.emit("did-start-navigation", ...start(PAGE));
    h.emit("did-fail-load", ...failLoad(-105, PAGE));
    h.emit("dom-ready");
    h.emit("did-finish-load");
    await flush();
    expect(h.route.load).toBe("failed");
    expect(h.gateCalls.install).toBe(0);
  });
});

// The popups ---------------------------------------------------------------

type PopupListener = (...args: never[]) => unknown;

function popupHarness(
  options: {
    hiddenFirst?: boolean;
    requireApp?: boolean;
    gate?: Gate | (() => Promise<Gate>);
    destroyed?: boolean;
  } = {},
) {
  const log: string[] = [];
  const state = { destroyed: options.destroyed ?? false, gate: options.gate };
  const popupListeners = new Map<string, PopupListener[]>();
  const contentsListeners = new Map<string, PopupListener[]>();
  const record = (
    into: Map<string, PopupListener[]>,
    event: string,
    listener: PopupListener,
  ) => into.set(event, [...(into.get(event) ?? []), listener]);
  const popup: AdoptedPopup = {
    webContents: {
      on: ((event: string, listener: PopupListener) => {
        log.push(`contents.on:${event}`);
        record(contentsListeners, event, listener);
      }) as AdoptedPopup["webContents"]["on"],
    },
    isDestroyed: () => state.destroyed,
    hide: () => log.push("popup.hide"),
    destroy: () => {
      state.destroyed = true;
      log.push("popup.destroy");
    },
    on: ((event: string, listener: PopupListener) => {
      log.push(`popup.on:${event}`);
      record(popupListeners, event, listener);
    }) as AdoptedPopup["on"],
    once: ((event: string, listener: PopupListener) => {
      log.push(`popup.once:${event}`);
      record(popupListeners, event, listener);
    }) as AdoptedPopup["once"],
  };
  const ports: PopupAdoptionPorts<AdoptedPopup> = {
    books: {
      add: () => log.push("books.add"),
      resetGeneration: () => log.push("books.reset"),
      release: () => log.push("books.release"),
      markReady: () => log.push("books.ready"),
      advanceGeneration: () => log.push("books.advance"),
      ungate: () => log.push("books.ungate"),
      gate: () => log.push("books.gate"),
    },
    harden: () => log.push("harden"),
    hiddenFirst: () => options.hiddenFirst ?? false,
    requireApp: () => options.requireApp ?? false,
    reconcile: () => log.push("reconcile"),
    installGate: () => {
      log.push("install-gate");
      return typeof state.gate === "function"
        ? state.gate()
        : Promise.resolve(state.gate ?? "installed");
    },
  };
  adoptPopupWindow(popup, ports);
  const emit = (
    from: Map<string, PopupListener[]>,
    event: string,
    ...args: unknown[]
  ) => {
    for (const listener of from.get(event) ?? [])
      (listener as (...rest: unknown[]) => unknown)(...args);
  };
  return {
    log,
    state,
    popupEvent: (event: string) => emit(popupListeners, event),
    contentsEvent: (event: string, ...args: unknown[]) =>
      emit(contentsListeners, event, ...args),
  };
}

describe("adopting a popup", () => {
  it("books it, hardens it and listens for its close, in that order", () => {
    const h = popupHarness();
    expect(h.log).toEqual([
      "books.add",
      "books.reset",
      "harden",
      "popup.on:closed",
    ]);
    h.popupEvent("closed");
    expect(h.log.at(-1)).toBe("books.release");
  });

  it("hides a popup that waits for a presentation and shows it once ready", () => {
    const h = popupHarness({ hiddenFirst: true });
    expect(h.log.slice(-2)).toEqual(["popup.hide", "popup.once:ready-to-show"]);
    h.log.length = 0;
    h.popupEvent("ready-to-show");
    expect(h.log).toEqual(["books.ready", "reconcile"]);
  });

  it("ignores ready-to-show of a destroyed popup", () => {
    const h = popupHarness({ hiddenFirst: true, destroyed: true });
    h.log.length = 0;
    h.popupEvent("ready-to-show");
    expect(h.log).toEqual([]);
  });

  it("registers no navigation listener on an ordinary surface", () => {
    const h = popupHarness();
    expect(h.log.filter((entry) => entry.startsWith("contents.on"))).toEqual(
      [],
    );
  });

  it("on a protected surface listens to navigation, load and in-page change in that order", () => {
    const h = popupHarness({ requireApp: true });
    expect(h.log.slice(4)).toEqual([
      "contents.on:did-redirect-navigation",
      "contents.on:did-start-navigation",
      "contents.on:did-finish-load",
      "contents.on:did-navigate-in-page",
      "contents.on:did-fail-load",
      "contents.on:render-process-gone",
    ]);
  });

  it("hides a protected popup at every full main-frame navigation and drops its gate", () => {
    const h = popupHarness({ requireApp: true });
    h.log.length = 0;
    h.contentsEvent("did-start-navigation", {}, NEXT, false, true);
    expect(h.log).toEqual(["books.advance", "books.ungate", "popup.hide"]);
    h.log.length = 0;
    h.contentsEvent("did-start-navigation", {}, NEXT, true, true);
    h.contentsEvent("did-start-navigation", {}, NEXT, false, false);
    expect(h.log).toEqual([]);
    h.state.destroyed = true;
    h.contentsEvent("did-start-navigation", {}, NEXT, false, true);
    expect(h.log).toEqual([]);
  });

  it("gates and reconciles a protected popup once its gate is installed", async () => {
    const h = popupHarness({ requireApp: true });
    h.log.length = 0;
    h.contentsEvent("did-finish-load");
    expect(h.log).toEqual(["install-gate"]);
    await flush();
    expect(h.log).toEqual(["install-gate", "books.gate", "reconcile"]);
  });

  it("fails closed: a popup whose gate cannot be installed is destroyed, never gated", async () => {
    const h = popupHarness({ requireApp: true, gate: "failed" });
    h.log.length = 0;
    h.contentsEvent("did-finish-load");
    await flush();
    expect(h.log).toEqual(["install-gate", "popup.destroy"]);
  });

  it("does not destroy a popup that is already gone", async () => {
    const h = popupHarness({ requireApp: true, gate: "failed" });
    h.state.destroyed = true;
    h.log.length = 0;
    h.contentsEvent("did-finish-load");
    await flush();
    expect(h.log).toEqual(["install-gate"]);
  });

  it("does nothing for a stale gate", async () => {
    const h = popupHarness({ requireApp: true, gate: "stale" });
    h.log.length = 0;
    h.contentsEvent("did-finish-load");
    await flush();
    expect(h.log).toEqual(["install-gate"]);
  });

  it("advances the popup generation and rechecks the gate on an in-page change", async () => {
    const h = popupHarness({ requireApp: true, gate: "failed" });
    h.log.length = 0;
    h.contentsEvent("did-navigate-in-page", {}, NEXT, false);
    expect(h.log).toEqual([]);
    h.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    expect(h.log).toEqual(["books.advance", "install-gate"]);
    await flush();
    expect(h.log.at(-1)).toBe("popup.destroy");
  });

  it("keeps a popup whose in-page gate check is stale", async () => {
    const h = popupHarness({ requireApp: true, gate: "stale" });
    h.log.length = 0;
    h.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    await flush();
    expect(h.log).toEqual(["books.advance", "install-gate"]);
  });

  it("gates and reconciles once when an in-page change supersedes a pending install", async () => {
    const installs = pendingInstalls();
    const h = popupHarness({ requireApp: true, gate: installs.next });
    h.log.length = 0;
    h.contentsEvent("did-finish-load");
    h.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    installs.settle(0, "stale");
    await flush();
    expect(h.log).toEqual(["install-gate", "books.advance", "install-gate"]);
    installs.settle(1, "installed");
    await flush();
    expect(h.log.filter((entry) => entry === "books.gate")).toHaveLength(1);
    expect(h.log.filter((entry) => entry === "reconcile")).toHaveLength(1);
    expect(h.log.at(-1)).toBe("reconcile");
  });

  it("never gates a popup whose replacement install is stale or fails", async () => {
    const stale = pendingInstalls();
    const a = popupHarness({ requireApp: true, gate: stale.next });
    a.log.length = 0;
    a.contentsEvent("did-finish-load");
    a.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    stale.settle(0, "stale");
    stale.settle(1, "stale");
    await flush();
    expect(a.log).not.toContain("books.gate");
    expect(a.log).not.toContain("reconcile");
    expect(a.log).not.toContain("popup.destroy");

    const failing = pendingInstalls();
    const b = popupHarness({ requireApp: true, gate: failing.next });
    b.log.length = 0;
    b.contentsEvent("did-finish-load");
    b.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    failing.settle(0, "stale");
    failing.settle(1, "failed");
    await flush();
    expect(b.log).not.toContain("books.gate");
    expect(b.log.at(-1)).toBe("popup.destroy");
  });

  it("does not gate again for an in-page change after the popup was gated", async () => {
    const h = popupHarness({ requireApp: true });
    h.contentsEvent("did-finish-load");
    await flush();
    h.log.length = 0;
    h.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    await flush();
    expect(h.log).toEqual(["books.advance", "install-gate"]);
  });

  it("does not gate a popup whose document a full navigation replaced", async () => {
    const installs = pendingInstalls();
    const h = popupHarness({ requireApp: true, gate: installs.next });
    h.log.length = 0;
    h.contentsEvent("did-finish-load");
    h.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    h.contentsEvent("did-start-navigation", {}, PAGE, false, true);
    installs.settle(0, "stale");
    installs.settle(1, "installed");
    await flush();
    expect(h.log).not.toContain("books.gate");
    expect(h.log).not.toContain("reconcile");
  });

  it("lets only the latest install gate the popup, whichever order they resolve in", async () => {
    const gates = (log: string[]) =>
      log.filter((entry) => entry === "books.gate").length;
    const early = pendingInstalls();
    const a = popupHarness({ requireApp: true, gate: early.next });
    a.log.length = 0;
    a.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    a.contentsEvent("did-finish-load");
    early.settle(0, "installed");
    await flush();
    expect(gates(a.log)).toBe(0);
    early.settle(1, "installed");
    await flush();
    expect(gates(a.log)).toBe(1);
    expect(a.log.filter((entry) => entry === "reconcile")).toHaveLength(1);

    const late = pendingInstalls();
    const b = popupHarness({ requireApp: true, gate: late.next });
    b.log.length = 0;
    b.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    b.contentsEvent("did-finish-load");
    late.settle(1, "installed");
    await flush();
    late.settle(0, "installed");
    await flush();
    expect(gates(b.log)).toBe(1);
    expect(b.log.filter((entry) => entry === "reconcile")).toHaveLength(1);
  });

  it("ignores a superseded install that succeeds while its replacement is pending", async () => {
    const installs = pendingInstalls();
    const h = popupHarness({ requireApp: true, gate: installs.next });
    h.log.length = 0;
    h.contentsEvent("did-finish-load");
    h.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    installs.settle(0, "installed");
    await flush();
    expect(h.log).not.toContain("books.gate");
    expect(h.log).not.toContain("reconcile");
    installs.settle(1, "installed");
    await flush();
    expect(h.log.filter((entry) => entry === "books.gate")).toHaveLength(1);
    expect(h.log.filter((entry) => entry === "reconcile")).toHaveLength(1);
  });

  it("ends the wait when the popup fails to load or its renderer is lost", async () => {
    const afterwards = async (
      end: (h: ReturnType<typeof popupHarness>) => void,
    ) => {
      const installs = pendingInstalls();
      const h = popupHarness({ requireApp: true, gate: installs.next });
      h.log.length = 0;
      h.contentsEvent("did-finish-load");
      h.contentsEvent("did-navigate-in-page", {}, NEXT, true);
      end(h);
      installs.settle(0, "stale");
      installs.settle(1, "installed");
      await flush();
      return h.log;
    };
    for (const end of [
      (h: ReturnType<typeof popupHarness>) =>
        h.contentsEvent("did-fail-load", {}, -105, "ERR", NEXT, true),
      (h: ReturnType<typeof popupHarness>) =>
        h.contentsEvent("render-process-gone"),
    ]) {
      const log = await afterwards(end);
      expect(log).not.toContain("books.gate");
      expect(log).not.toContain("reconcile");
      expect(log).not.toContain("popup.destroy");
    }
  });

  it("keeps the wait through a cancellation or a subframe failure", async () => {
    const installs = pendingInstalls();
    const h = popupHarness({ requireApp: true, gate: installs.next });
    h.log.length = 0;
    h.contentsEvent("did-finish-load");
    h.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    h.contentsEvent("did-fail-load", {}, -3, "ERR_ABORTED", NEXT, true);
    h.contentsEvent("did-fail-load", {}, -105, "ERR", NEXT, false);
    installs.settle(0, "stale");
    installs.settle(1, "installed");
    await flush();
    expect(h.log.filter((entry) => entry === "books.gate")).toHaveLength(1);
  });

  it("ignores an older popup install that fails while the newer one is pending", async () => {
    const installs = pendingInstalls();
    const h = popupHarness({ requireApp: true, gate: installs.next });
    h.log.length = 0;
    h.contentsEvent("did-navigate-in-page", {}, NEXT, true);
    h.contentsEvent("did-finish-load");
    installs.settle(0, "failed");
    await flush();
    expect(h.log).not.toContain("popup.destroy");
    installs.settle(1, "installed");
    await flush();
    expect(h.log.filter((entry) => entry === "books.gate")).toHaveLength(1);
    expect(h.log.filter((entry) => entry === "reconcile")).toHaveLength(1);
  });

  it("ignores a popup install failure that arrives after the wait ended", async () => {
    const installs = pendingInstalls();
    const h = popupHarness({ requireApp: true, gate: installs.next });
    h.log.length = 0;
    h.contentsEvent("did-finish-load");
    h.contentsEvent("render-process-gone");
    installs.settle(0, "failed");
    await flush();
    expect(h.log).not.toContain("popup.destroy");

    const latest = pendingInstalls();
    const b = popupHarness({ requireApp: true, gate: latest.next });
    b.log.length = 0;
    b.contentsEvent("did-finish-load");
    latest.settle(0, "failed");
    await flush();
    expect(b.log).toContain("popup.destroy");
  });

  it("ignores a late load failure of an earlier popup navigation", async () => {
    const installs = pendingInstalls();
    const h = popupHarness({ requireApp: true, gate: installs.next });
    h.log.length = 0;
    h.contentsEvent("did-start-navigation", {}, PAGE, false, true);
    h.contentsEvent("did-start-navigation", {}, NEXT, false, true);
    h.contentsEvent("did-finish-load");
    // Navigation PAGE fails after NEXT finished and started its install.
    h.contentsEvent("did-fail-load", {}, -105, "ERR", PAGE, true);
    installs.settle(0, "installed");
    await flush();
    expect(h.log.filter((entry) => entry === "books.gate")).toHaveLength(1);
    expect(h.log.filter((entry) => entry === "reconcile")).toHaveLength(1);
  });

  it("follows a redirect to the failure of the navigation being followed", async () => {
    const installs = pendingInstalls();
    const h = popupHarness({ requireApp: true, gate: installs.next });
    h.log.length = 0;
    h.contentsEvent("did-start-navigation", {}, PAGE, false, true);
    h.contentsEvent("did-redirect-navigation", {}, NEXT, false, true);
    h.contentsEvent("did-finish-load");
    h.contentsEvent("did-fail-load", {}, -105, "ERR", NEXT, true);
    installs.settle(0, "installed");
    await flush();
    expect(h.log).not.toContain("books.gate");
  });
});
