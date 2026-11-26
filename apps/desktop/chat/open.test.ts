import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROUTE_OPEN_DEADLINE_MS,
  RouteOpenTimedOut,
  createOpenStepRace,
  createOrdinaryReady,
  decideRetryAfterJoin,
  decideRetryFailedOpen,
  decideSignInExit,
  decideSignInReturn,
  hideAfterOpenTimeout,
  shouldReportUnopenedSignIn,
  signInReturnStillCurrent,
  signInStatusFromObservation,
  temporaryChatUrl,
} from "./open";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Surface = { isDestroyed: () => boolean; destroy: () => void };

function surface(initiallyDestroyed = false) {
  const state = {
    destroyed: initiallyDestroyed,
    destroyThrows: false,
    // destroy returns, but the destruction is not confirmed (asynchronous).
    destroyIsAsync: false,
  };
  const log: string[] = [];
  const candidate: Surface = {
    isDestroyed: () => state.destroyed,
    destroy: () => {
      log.push("destroy");
      if (state.destroyThrows) throw new Error("destroy refused");
      if (!state.destroyIsAsync) state.destroyed = true;
    },
  };
  return { candidate, state, log };
}

function raceHarness(
  input: {
    owned?: boolean;
    protectedSurface?: boolean;
    target?: ReturnType<typeof surface>;
  } = {},
) {
  const log: string[] = [];
  const state = {
    owned: input.owned ?? true,
    protectedSurface: input.protectedSurface ?? true,
  };
  const target = input.target ?? surface();
  const race = createOpenStepRace<Surface>({
    now: () => Date.now(),
    after: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    owned: (candidate) => {
      expect(candidate).toBe(target.candidate);
      return state.owned;
    },
    protectedSurface: () => state.protectedSurface,
    leaveSignIn: () => log.push("leave-sign-in"),
    teardownStarted: () => log.push("teardown-started"),
    teardownSettled: (_candidate, confirmed) =>
      log.push(confirmed ? "confirmed" : "unconfirmed"),
  });
  return { race, log, state, target };
}

describe("the open deadline", () => {
  it("is thirty seconds", () => {
    expect(ROUTE_OPEN_DEADLINE_MS).toBe(30_000);
  });
});

describe("the open step race", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the work before the deadline and clears the timer", async () => {
    const { race, target, log } = raceHarness();
    const work = deferred<string>();
    const step = race(
      target.candidate,
      work.promise,
      Date.now() + ROUTE_OPEN_DEADLINE_MS,
    );
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    work.resolve("loaded");
    await expect(step).resolves.toBe("loaded");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(ROUTE_OPEN_DEADLINE_MS);
    expect(log).toEqual([]);
    expect(target.state.destroyed).toBe(false);
  });

  it("clears the timer when the work rejects and passes its error through", async () => {
    const { race, target } = raceHarness();
    const work = deferred<string>();
    const failure = new Error("navigation failed");
    const step = race(
      target.candidate,
      work.promise,
      Date.now() + ROUTE_OPEN_DEADLINE_MS,
    );
    work.reject(failure);
    await expect(step).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    expect(target.state.destroyed).toBe(false);
  });

  it("times out at exactly the deadline, not a millisecond earlier", async () => {
    const { race, target } = raceHarness();
    const step = race(
      target.candidate,
      new Promise<never>(() => {}),
      Date.now() + ROUTE_OPEN_DEADLINE_MS,
    );
    let outcome: unknown = "pending";
    void step.catch((error: unknown) => {
      outcome = error;
    });
    await vi.advanceTimersByTimeAsync(ROUTE_OPEN_DEADLINE_MS - 1);
    expect(outcome).toBe("pending");
    expect(target.state.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(RouteOpenTimedOut);
    expect((outcome as Error).message).toBe("CHATGPT_ROUTE_OPEN_TIMEOUT");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("measures the delay from the deadline, not from the call", async () => {
    const { race, target } = raceHarness();
    const step = race(
      target.candidate,
      new Promise<never>(() => {}),
      Date.now() + 5_000,
    );
    const settled = vi.fn();
    void step.catch(settled);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("times out at once when the deadline has already passed", async () => {
    const { race, target } = raceHarness();
    const step = race(
      target.candidate,
      new Promise<never>(() => {}),
      Date.now() - 60_000,
    );
    const settled = vi.fn();
    void step.catch(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]?.[0]).toBeInstanceOf(RouteOpenTimedOut);
  });

  it("retires an owned protected surface: leaves sign-in, then destroys, then rejects", async () => {
    const { race, target, log } = raceHarness();
    const step = race(
      target.candidate,
      new Promise<never>(() => {}),
      Date.now() + 1_000,
    );
    const settled = vi.fn();
    void step.catch(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toEqual(["leave-sign-in", "teardown-started", "confirmed"]);
    expect(target.state.destroyed).toBe(true);
    expect(settled.mock.calls[0]?.[0]).toBeInstanceOf(RouteOpenTimedOut);
  });

  it("keeps a slow ordinary browser: no sign-in exit and no destroy", async () => {
    const { race, target, log } = raceHarness({ protectedSurface: false });
    const step = race(
      target.candidate,
      new Promise<never>(() => {}),
      Date.now() + 1_000,
    );
    const settled = vi.fn();
    void step.catch(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toEqual([]);
    expect(target.state.destroyed).toBe(false);
    expect(settled.mock.calls[0]?.[0]).toBeInstanceOf(RouteOpenTimedOut);
  });

  it("leaves a surface the route no longer owns alone", async () => {
    const { race, target, log } = raceHarness({ owned: false });
    const step = race(
      target.candidate,
      new Promise<never>(() => {}),
      Date.now() + 1_000,
    );
    const settled = vi.fn();
    void step.catch(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log).toEqual([]);
    expect(target.state.destroyed).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("does not destroy a surface that is already destroyed", async () => {
    const gone = surface(true);
    const { race, log } = raceHarness({ target: gone });
    const step = race(
      gone.candidate,
      new Promise<never>(() => {}),
      Date.now() + 1_000,
    );
    const settled = vi.fn();
    void step.catch(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gone.log).toEqual([]);
    expect(log).toEqual(["leave-sign-in", "teardown-started", "confirmed"]);
    expect(settled.mock.calls[0]?.[0]).toBeInstanceOf(RouteOpenTimedOut);
  });

  it("still times out when destroying the surface throws, and reports it unconfirmed", async () => {
    const { race, target, log } = raceHarness();
    target.state.destroyThrows = true;
    const step = race(
      target.candidate,
      new Promise<never>(() => {}),
      Date.now() + 1_000,
    );
    const settled = vi.fn();
    void step.catch(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target.log).toEqual(["destroy"]);
    expect(log).toEqual(["leave-sign-in", "teardown-started", "unconfirmed"]);
    expect(settled.mock.calls[0]?.[0]).toBeInstanceOf(RouteOpenTimedOut);
  });

  it("reports a destroy that returns without confirming as unconfirmed", async () => {
    const { race, target, log } = raceHarness();
    target.state.destroyIsAsync = true;
    const step = race(
      target.candidate,
      new Promise<never>(() => {}),
      Date.now() + 1_000,
    );
    const settled = vi.fn();
    void step.catch(settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(target.log).toEqual(["destroy"]);
    expect(log).toEqual(["leave-sign-in", "teardown-started", "unconfirmed"]);
    expect(settled.mock.calls[0]?.[0]).toBeInstanceOf(RouteOpenTimedOut);
  });

  it("cancels through the port it armed the timer with", async () => {
    const cancelled = vi.fn();
    const arm = vi.fn((_callback: () => void, _ms: number) => cancelled);
    const race = createOpenStepRace<Surface>({
      now: () => 500,
      after: arm,
      owned: () => true,
      protectedSurface: () => true,
      leaveSignIn: () => {},
      teardownStarted: () => {},
      teardownSettled: () => {},
    });
    await expect(
      race(surface().candidate, Promise.resolve("ok"), 2_500),
    ).resolves.toBe("ok");
    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm.mock.calls[0]?.[1]).toBe(2_000);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

describe("hiding after an open timeout", () => {
  function hidable(destroyed = false, throwsOnHide = false) {
    const hide = vi.fn(() => {
      if (throwsOnHide) throw new Error("hide refused");
    });
    return { isDestroyed: () => destroyed, hide };
  }

  it("hides a protected surface after a timeout", () => {
    const target = hidable();
    hideAfterOpenTimeout(new RouteOpenTimedOut("x"), target, true);
    expect(target.hide).toHaveBeenCalledTimes(1);
  });

  it("does not hide an ordinary browser, a destroyed surface or another error", () => {
    const ordinary = hidable();
    hideAfterOpenTimeout(new RouteOpenTimedOut("x"), ordinary, false);
    const destroyed = hidable(true);
    hideAfterOpenTimeout(new RouteOpenTimedOut("x"), destroyed, true);
    const other = hidable();
    hideAfterOpenTimeout(new Error("boom"), other, true);
    expect(ordinary.hide).not.toHaveBeenCalled();
    expect(destroyed.hide).not.toHaveBeenCalled();
    expect(other.hide).not.toHaveBeenCalled();
  });

  it("swallows a refused hide", () => {
    const target = hidable(false, true);
    expect(() =>
      hideAfterOpenTimeout(new RouteOpenTimedOut("x"), target, true),
    ).not.toThrow();
  });
});

describe("the ordinary-browser milestone", () => {
  function contentsHarness() {
    const listeners = new Set<() => void>();
    return {
      listeners,
      contents: {
        on: (_event: "dom-ready", listener: () => void) => {
          listeners.add(listener);
        },
        removeListener: (_event: "dom-ready", listener: () => void) => {
          listeners.delete(listener);
        },
      },
      fire: () => [...listeners].forEach((listener) => listener()),
    };
  }

  function gate(
    over: Partial<{
      protectedSurface: boolean;
      owned: boolean;
      advanced: boolean;
      loadFailed: boolean;
      awaitingCommit: boolean;
      allowedUrl: boolean;
    }> = {},
    onReady?: () => void,
  ) {
    const state = {
      protectedSurface: false,
      owned: true,
      advanced: true,
      loadFailed: false,
      awaitingCommit: false,
      allowedUrl: true,
      ...over,
    };
    const harness = contentsHarness();
    const ready = createOrdinaryReady(harness.contents, {
      protectedSurface: () => state.protectedSurface,
      owned: () => state.owned,
      advanced: () => state.advanced,
      loadFailed: () => state.loadFailed,
      awaitingCommit: () => state.awaitingCommit,
      allowedUrl: () => state.allowedUrl,
      ...(onReady ? { onReady } : {}),
    });
    return { ...harness, ...ready, state };
  }

  async function settled(promise: Promise<void>): Promise<boolean> {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    return done;
  }

  it("has no milestone and attaches nothing for a protected surface", () => {
    const { ready, listeners, release } = gate({ protectedSurface: true });
    expect(ready).toBeNull();
    expect(listeners.size).toBe(0);
    expect(() => release()).not.toThrow();
  });

  it("attaches a listener at creation and removes it on release", () => {
    const { ready, listeners, release } = gate();
    expect(ready).not.toBeNull();
    expect(listeners.size).toBe(1);
    release();
    expect(listeners.size).toBe(0);
  });

  it("resolves on dom-ready when every condition holds, and reports it first", async () => {
    const order: string[] = [];
    const { ready, fire } = gate({}, () => order.push("ready"));
    void ready?.then(() => order.push("resolved"));
    fire();
    await ready;
    expect(order).toEqual(["ready", "resolved"]);
  });

  it.each([
    ["the route lost the contents", { owned: false }],
    ["the document has not advanced", { advanced: false }],
    ["the document load failed", { loadFailed: true }],
    ["the document awaits its commit", { awaitingCommit: true }],
    ["the address is not allowed", { allowedUrl: false }],
  ])("does not resolve when %s", async (_name, over) => {
    const onReady = vi.fn();
    const { ready, fire } = gate(over, onReady);
    fire();
    expect(await settled(ready as Promise<void>)).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
  });

  it("resolves on a later dom-ready once the conditions hold", async () => {
    const { ready, fire, state } = gate({ awaitingCommit: true });
    fire();
    expect(await settled(ready as Promise<void>)).toBe(false);
    state.awaitingCommit = false;
    fire();
    expect(await settled(ready as Promise<void>)).toBe(true);
  });

  it("reads the conditions in the original order and stops at the first miss", () => {
    const reads: string[] = [];
    const harness = contentsHarness();
    createOrdinaryReady(harness.contents, {
      protectedSurface: () => false,
      owned: () => {
        reads.push("owned");
        return true;
      },
      advanced: () => {
        reads.push("advanced");
        return false;
      },
      loadFailed: () => {
        reads.push("loadFailed");
        return false;
      },
      awaitingCommit: () => {
        reads.push("awaitingCommit");
        return false;
      },
      allowedUrl: () => {
        reads.push("allowedUrl");
        return true;
      },
    });
    harness.fire();
    expect(reads).toEqual(["owned", "advanced"]);
  });
});

describe("navigate URL policy", () => {
  it("sets the temporary-chat flag on the home page", () => {
    expect(temporaryChatUrl("https://chatgpt.com/")).toBe(
      "https://chatgpt.com/?temporary-chat=true",
    );
  });

  it("keeps the path and other parameters and replaces an existing flag", () => {
    expect(
      temporaryChatUrl(
        "https://chatgpt.com/g/abc?model=x&temporary-chat=false",
      ),
    ).toBe("https://chatgpt.com/g/abc?model=x&temporary-chat=true");
  });

  it("throws on an address that is not a URL", () => {
    expect(() => temporaryChatUrl("not a url")).toThrow();
  });
});

describe("retrying a failed open", () => {
  const idle = {
    updateAdmission: false,
    taskInFlight: false,
    signInMode: false,
    opening: false,
    failedSurface: false,
  };

  it("opens afresh when nothing is in the way", () => {
    expect(decideRetryFailedOpen(idle)).toBe("open");
  });

  it("discards only a failed surface", () => {
    expect(decideRetryFailedOpen({ ...idle, failedSurface: true })).toBe(
      "discard-failed",
    );
  });

  it("joins an open already under way, before considering a failed surface", () => {
    expect(
      decideRetryFailedOpen({ ...idle, opening: true, failedSurface: true }),
    ).toBe("join");
  });

  it.each(["updateAdmission", "taskInFlight", "signInMode"] as const)(
    "refuses while %s, whatever else is true",
    (flag) => {
      expect(
        decideRetryFailedOpen({
          ...idle,
          [flag]: true,
          opening: true,
          failedSurface: true,
        }),
      ).toBe("refuse");
    },
  );

  it("opens after a joined open succeeded and nothing changed", () => {
    expect(
      decideRetryAfterJoin("opened", {
        updateAdmission: false,
        taskInFlight: false,
        signInMode: false,
      }),
    ).toBe("open");
  });

  it("refuses after a joined open that did not open", () => {
    expect(
      decideRetryAfterJoin("unreachable", {
        updateAdmission: false,
        taskInFlight: false,
        signInMode: false,
      }),
    ).toBe("refuse");
  });

  it.each(["updateAdmission", "taskInFlight", "signInMode"] as const)(
    "refuses after a joined open when %s arrived meanwhile",
    (flag) => {
      expect(
        decideRetryAfterJoin("opened", {
          updateAdmission: false,
          taskInFlight: false,
          signInMode: false,
          [flag]: true,
        }),
      ).toBe("refuse");
    },
  );
});

describe("sign-in mode decisions", () => {
  it("maps a page reading to a sign-in status, and anything else to unknown", () => {
    expect(signInStatusFromObservation("authenticated")).toBe("authenticated");
    expect(signInStatusFromObservation("signed_out")).toBe("not_authenticated");
    expect(signInStatusFromObservation("unreachable")).toBe("unknown");
    expect(signInStatusFromObservation("unsupported")).toBe("unknown");
    expect(signInStatusFromObservation(undefined)).toBe("unknown");
  });

  it("reports an unopened sign-in only for the latest attempt", () => {
    expect(shouldReportUnopenedSignIn(3, 3, "unreachable")).toBe(true);
    expect(shouldReportUnopenedSignIn(3, 3, "opened")).toBe(false);
    expect(shouldReportUnopenedSignIn(2, 3, "unreachable")).toBe(false);
  });

  it("plans a return: close outside sign-in, exit an embedded surface after the read, close a window after it", () => {
    expect(decideSignInReturn(false, "window")).toBe("close");
    expect(decideSignInReturn(false, "embedded")).toBe("close");
    expect(decideSignInReturn(true, "embedded")).toBe("exit-after-read");
    expect(decideSignInReturn(true, "window")).toBe("close-after-read");
  });

  it("lets a late return read act only while attempt, mode and surface still match", () => {
    const base = {
      attempt: 4,
      latestAttempt: 4,
      signInMode: true,
      sameSurface: true,
    };
    expect(signInReturnStillCurrent(base)).toBe(true);
    expect(signInReturnStillCurrent({ ...base, latestAttempt: 5 })).toBe(false);
    expect(signInReturnStillCurrent({ ...base, signInMode: false })).toBe(
      false,
    );
    expect(signInReturnStillCurrent({ ...base, sameSurface: false })).toBe(
      false,
    );
  });

  it("exits sign-in mode only when it is on, releasing the claim only if it is this route's", () => {
    expect(decideSignInExit(false, true)).toEqual({
      exit: false,
      releaseActive: false,
    });
    expect(decideSignInExit(true, true)).toEqual({
      exit: true,
      releaseActive: true,
    });
    expect(decideSignInExit(true, false)).toEqual({
      exit: true,
      releaseActive: false,
    });
  });
});
