import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { chatGptUpdateIdleProbe } from "../../../src/apps/desktop/chatgpt-update-idle";
import {
  UPDATE_CLOSE_CONFIRMATION_MS,
  createUpdateAdmission,
  type ChatGptUpdateAdmissionDiagnostic,
  type ChatGptUpdateIdleEffectGuard,
} from "./admission";

const HOME = "https://chatgpt.com/";
const PAGE = "https://chatgpt.com/c/task";

// Everything the admission drives is a hand-driven fake: no Electron, no timer,
// no inspector. These fixtures classify local mock outcomes only.

async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

function fakeClock() {
  let now = 1_000;
  type Timer = { at: number; callback: () => void; cancelled: boolean };
  const timers: Timer[] = [];
  return {
    now: () => now,
    after: (callback: () => void, ms: number) => {
      const timer: Timer = { at: now + ms, callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    armed: () => timers.filter((timer) => !timer.cancelled).length,
    // Move time without firing anything: the host callback "consumes" budget.
    skip(ms: number) {
      now += ms;
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true;
        now = Math.max(now, due.at);
        due.callback();
      }
      now = target;
    },
  };
}

type Behavior = (
  method: string,
  params?: { expression?: string },
) => Promise<unknown> | undefined;

function fakeContents(log: string[]) {
  const inspector = new EventEmitter();
  const world = {
    attached: false,
    destroyed: false,
    url: PAGE,
    devtools: false,
    probe: { state: "idle" } as unknown,
    probeBehavior: undefined as (() => Promise<unknown>) | undefined,
    commandBehavior: undefined as Behavior | undefined,
    attachThrows: false,
    detachThrows: false,
  };
  const debuggerClient = Object.assign(inspector, {
    isAttached: () => world.attached,
    attach: vi.fn((version: string) => {
      log.push(`attach ${version}`);
      if (world.attachThrows) throw new Error("attach");
      world.attached = true;
    }),
    detach: vi.fn(() => {
      log.push("detach");
      if (world.detachThrows) throw new Error("detach");
      world.attached = false;
    }),
    sendCommand: vi.fn(
      (method: string, params?: { expression?: string }): Promise<unknown> => {
        log.push(
          method === "Runtime.evaluate" && params?.expression === "void 0"
            ? "void0"
            : method,
        );
        const scripted = world.commandBehavior?.(method, params);
        if (scripted !== undefined) return scripted;
        if (method === "Debugger.pause")
          inspector.emit("message", {}, "Debugger.paused");
        if (method === "Debugger.resume")
          inspector.emit("message", {}, "Debugger.resumed");
        if (
          method === "Runtime.evaluate" &&
          params?.expression === chatGptUpdateIdleProbe
        )
          return Promise.resolve({
            result: { type: "object", value: world.probe },
          });
        return Promise.resolve({});
      },
    ),
  });
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerClient,
    isDestroyed: () => world.destroyed,
    getURL: () => world.url,
    isDevToolsOpened: () => world.devtools,
    executeJavaScript: vi.fn((code: string): Promise<unknown> => {
      log.push(code === chatGptUpdateIdleProbe ? "execute" : "execute?");
      return world.probeBehavior
        ? world.probeBehavior()
        : Promise.resolve(world.probe);
    }),
  });
  return { contents, debuggerClient, world };
}

function harness(options: { contents?: ReturnType<typeof fakeContents> } = {}) {
  const log: string[] = [];
  const clock = fakeClock();
  const page = options.contents ?? fakeContents(log);
  const surface = {
    kind: "embedded" as "embedded" | "window",
    webContents: page.contents,
    destroyed: false,
    isDestroyed: () => surface.destroyed,
  };
  const state = {
    reserved: false,
    opening: false,
    taskInFlight: false,
    signInMode: false,
    popup: false,
    openSurface: true,
    surface: surface as typeof surface | null,
    loaded: true,
    generation: 1,
  };
  const reports: ChatGptUpdateAdmissionDiagnostic[] = [];
  const closing = {
    contents: [page.contents] as (typeof page.contents)[],
    settled: true,
    beginThrows: false,
    began: 0,
    forgot: 0,
    ended: 0,
  };
  const admission = createUpdateAdmission({
    homeUrl: HOME,
    route: {
      reserved: () => state.reserved,
      setReserved: (reserved) => {
        state.reserved = reserved;
      },
      opening: () => state.opening,
      taskInFlight: () => state.taskInFlight,
      signInMode: () => state.signInMode,
      hasLivePopup: () => state.popup,
      hasOpenSurface: () => state.openSurface,
      surface: () => state.surface,
      loaded: () => state.loaded,
      documentGeneration: () => state.generation,
      beginClose: () => {
        closing.began += 1;
        if (closing.beginThrows) throw new Error("begin");
        return {
          contents: closing.contents,
          settled: () => closing.settled,
          forget: () => {
            closing.forgot += 1;
          },
        };
      },
      endClose: () => {
        closing.ended += 1;
      },
    },
    clock,
    report: (diagnostic) => reports.push(diagnostic),
  });
  return { admission, clock, page, surface, state, reports, log, closing };
}

type Harness = ReturnType<typeof harness>;

async function heldIdle(h: Harness, guard?: ChatGptUpdateIdleEffectGuard) {
  const admission = await h.admission.idle(guard);
  if (!admission.ok) throw new Error(admission.code);
  return admission;
}

const listenerCount = (h: Harness): number =>
  h.page.contents.listenerCount("before-input-event") +
  h.page.contents.listenerCount("before-mouse-event") +
  h.page.debuggerClient.listenerCount("message") +
  h.page.debuggerClient.listenerCount("detach");

describe("closing browser work for an update", () => {
  it("keeps the close confirmation bound at two seconds", () => {
    expect(UPDATE_CLOSE_CONFIRMATION_MS).toBe(2_000);
  });

  it.each([
    ["an update already holds the route", "reserved"],
    ["the route is opening", "opening"],
    ["a task is in flight", "taskInFlight"],
  ] as const)("refuses as busy when %s, touching nothing", async (_n, key) => {
    const h = harness();
    h.state[key] = true;
    const reserved = h.state.reserved;
    expect(await h.admission.close()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_BUSY",
    });
    expect(h.closing.began).toBe(0);
    expect(h.closing.ended).toBe(0);
    expect(h.state.reserved).toBe(reserved);
  });

  it("reserves, waits for the pages to be destroyed, forgets them and hands back the reservation", async () => {
    const h = harness();
    const pending = h.admission.close();
    await flush();
    expect(h.state.reserved).toBe(true);
    expect(h.closing.forgot).toBe(0);
    h.page.contents.emit("destroyed");
    const admission = await pending;
    if (!admission.ok) throw new Error(admission.code);
    expect(h.closing.began).toBe(1);
    expect(h.closing.forgot).toBe(1);
    expect(h.closing.ended).toBe(1);
    expect(h.clock.armed()).toBe(0);
    expect(h.state.reserved).toBe(true);
    h.state.openSurface = false;
    expect(await admission.recheck()).toEqual({ ok: true });
    await admission.release();
    expect(h.state.reserved).toBe(false);
  });

  it("does not wait for a page that is already destroyed", async () => {
    const h = harness();
    h.page.world.destroyed = true;
    const admission = await h.admission.close();
    expect(admission.ok).toBe(true);
    expect(h.clock.armed()).toBe(0);
  });

  it("waits for every page, popups included", async () => {
    const other = fakeContents([]);
    const h = harness();
    h.closing.contents = [h.page.contents, other.contents];
    const pending = h.admission.close();
    await flush();
    h.page.contents.emit("destroyed");
    await flush();
    expect(h.closing.forgot).toBe(0);
    other.contents.emit("destroyed");
    expect((await pending).ok).toBe(true);
  });

  it("holds the reservation when a page does not confirm within two seconds", async () => {
    const h = harness();
    const pending = h.admission.close();
    await flush();
    h.clock.advance(UPDATE_CLOSE_CONFIRMATION_MS - 1);
    await flush();
    expect(h.closing.ended).toBe(0);
    h.clock.advance(1);
    expect(await pending).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    });
    expect(h.state.reserved).toBe(true);
    expect(h.closing.forgot).toBe(0);
    expect(h.closing.ended).toBe(1);
    expect(h.page.contents.listenerCount("destroyed")).toBe(0);
  });

  it("holds the reservation when a surface survives the confirmed close", async () => {
    const h = harness();
    h.page.world.destroyed = true;
    h.closing.settled = false;
    expect(await h.admission.close()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    });
    expect(h.state.reserved).toBe(true);
    expect(h.closing.forgot).toBe(0);
    expect(h.closing.ended).toBe(1);
  });

  it("holds the reservation and still ends the close when the route cannot begin it", async () => {
    const h = harness();
    h.closing.beginThrows = true;
    expect(await h.admission.close()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    });
    expect(h.state.reserved).toBe(true);
    expect(h.closing.ended).toBe(1);
  });

  it("answers state unknown once the reservation or the surface state is lost", async () => {
    const h = harness();
    h.page.world.destroyed = true;
    const admission = await h.admission.close();
    if (!admission.ok) throw new Error(admission.code);
    h.state.openSurface = true;
    expect(await admission.recheck()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    h.state.openSurface = false;
    h.state.reserved = false;
    expect(await admission.recheck()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    h.state.reserved = true;
    await admission.release();
    await admission.release();
    expect(await admission.recheck()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
  });
});

describe("idle admission: the Quit budget", () => {
  it.each([
    null,
    {},
    { deadlineAt: "100", canStartEffect: () => true },
    { deadlineAt: Number.NaN, canStartEffect: () => true },
    { deadlineAt: Number.POSITIVE_INFINITY, canStartEffect: () => true },
    { deadlineAt: 100, canStartEffect: true },
  ])("rejects the malformed guard %# before any effect", async (guard) => {
    const h = harness();
    expect(
      await h.admission.idle(guard as unknown as ChatGptUpdateIdleEffectGuard),
    ).toEqual({ ok: false, code: "UPDATE_BROWSER_STATE_UNKNOWN" });
    expect(h.reports).toEqual([
      { stage: "admission", reason: "guard_invalid" },
    ]);
    expect(h.state.reserved).toBe(false);
    expect(h.log).toEqual([]);
  });

  it("rejects a guard whose fields throw when read", async () => {
    const h = harness();
    const guard = {
      get deadlineAt(): number {
        throw new Error("hostile");
      },
      canStartEffect: () => true,
    };
    expect((await h.admission.idle(guard)).ok).toBe(false);
    expect(h.reports).toEqual([
      { stage: "admission", reason: "guard_invalid" },
    ]);
  });

  it("refuses with deadline_expired when the budget is already spent", async () => {
    const h = harness();
    expect(
      await h.admission.idle({
        deadlineAt: h.clock.now(),
        canStartEffect: () => true,
      }),
    ).toEqual({ ok: false, code: "UPDATE_BROWSER_STATE_UNKNOWN" });
    expect(h.reports).toEqual([
      { stage: "admission", reason: "deadline_expired" },
    ]);
    expect(h.log).toEqual([]);
  });

  it("refuses with reservation_lost when the host will not start an effect", async () => {
    const h = harness();
    await h.admission.idle({
      deadlineAt: h.clock.now() + 10_000,
      canStartEffect: () => false,
    });
    expect(h.reports).toEqual([
      { stage: "admission", reason: "reservation_lost" },
    ]);
    expect(h.state.reserved).toBe(false);
  });

  it("refuses with guard_invalid when the host callback throws", async () => {
    const h = harness();
    await h.admission.idle({
      deadlineAt: h.clock.now() + 10_000,
      canStartEffect: () => {
        throw new Error("hostile");
      },
    });
    expect(h.reports).toEqual([
      { stage: "admission", reason: "guard_invalid" },
    ]);
  });

  it("refuses when the host callback itself consumes the budget", async () => {
    const h = harness();
    await h.admission.idle({
      deadlineAt: h.clock.now() + 100,
      canStartEffect: () => {
        h.clock.skip(100);
        return true;
      },
    });
    expect(h.reports).toEqual([
      { stage: "admission", reason: "deadline_expired" },
    ]);
  });

  it("keeps the original budget however the caller's object changes afterwards", async () => {
    const h = harness();
    const guard = {
      deadlineAt: h.clock.now() + 500,
      canStartEffect: () => true,
    };
    const admission = await heldIdle(h, guard);
    guard.deadlineAt = h.clock.now() + 1_000_000;
    guard.canStartEffect = () => true;
    h.clock.skip(500);
    expect(await admission.recheck()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(h.reports.at(-1)).toEqual({
      stage: "admission",
      reason: "deadline_expired",
    });
    await admission.release();
  });

  it("bounds a hanging effect by the smaller of the probe bound and the remaining budget", async () => {
    const h = harness();
    h.page.world.probeBehavior = () => new Promise(() => undefined);
    const pending = h.admission.idle({
      deadlineAt: h.clock.now() + 500,
      canStartEffect: () => true,
    });
    await flush();
    h.clock.advance(499);
    await flush();
    expect(h.reports).toEqual([]);
    h.clock.advance(1);
    expect(await pending).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(h.reports).toEqual([{ stage: "probe", reason: "timeout" }]);
    expect(h.state.reserved).toBe(false);
  });
});

describe("idle admission: refusing before the page is touched", () => {
  it.each([
    ["an update already holds the route", "reserved"],
    ["the route is opening", "opening"],
    ["a task is in flight", "taskInFlight"],
    ["a sign-in is open", "signInMode"],
    ["a popup is open", "popup"],
  ] as const)("refuses as busy when %s", async (_n, key) => {
    const h = harness();
    h.state[key] = true;
    const reserved = h.state.reserved;
    expect(await h.admission.idle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_BUSY",
    });
    expect(h.reports).toEqual([{ stage: "admission", reason: "busy" }]);
    expect(h.state.reserved).toBe(reserved);
    expect(h.log).toEqual([]);
  });

  it.each([
    [
      "no surface",
      (h: Harness) => {
        h.state.surface = null;
      },
      { stage: "surface", reason: "unavailable" },
    ],
    [
      "a separate window",
      (h: Harness) => {
        h.surface.kind = "window";
      },
      { stage: "surface", reason: "not_embedded" },
    ],
    [
      "a destroyed surface",
      (h: Harness) => {
        h.surface.destroyed = true;
      },
      { stage: "surface", reason: "destroyed" },
    ],
    [
      "a document that has not loaded",
      (h: Harness) => {
        h.state.loaded = false;
      },
      { stage: "document", reason: "not_loaded" },
    ],
    [
      "an unrecognized address",
      (h: Harness) => {
        h.page.world.url = "https://evil.test/";
      },
      { stage: "document", reason: "url_unrecognized" },
    ],
  ] as const)(
    "refuses as unknown on %s, with no reservation and nothing attached",
    async (_n, arrange, diagnostic) => {
      const h = harness();
      arrange(h);
      expect(await h.admission.idle()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      expect(h.reports).toEqual([diagnostic]);
      expect(h.state.reserved).toBe(false);
      expect(h.log).toEqual([]);
      expect(listenerCount(h)).toBe(0);
    },
  );
});

describe("idle admission: a route with no open browser surface", () => {
  it("reserves without touching a page, and rechecks the reservation", async () => {
    const h = harness();
    h.state.openSurface = false;
    const admission = await heldIdle(h);
    expect(h.state.reserved).toBe(true);
    expect(await admission.recheck()).toEqual({ ok: true });
    expect(h.log).toEqual([]);
    await admission.release();
    await admission.release();
    expect(h.state.reserved).toBe(false);
  });

  it("fails the recheck when the reservation is gone or a surface appeared", async () => {
    const h = harness();
    h.state.openSurface = false;
    const admission = await heldIdle(h);
    h.state.openSurface = true;
    expect(await admission.recheck()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(h.reports.at(-1)).toEqual({
      stage: "admission",
      reason: "reservation_lost",
    });
    h.state.openSurface = false;
    await admission.release();
    expect((await admission.recheck()).ok).toBe(false);
  });

  it("refuses when the host stops the effect between the first check and the reservation", async () => {
    const h = harness();
    h.state.openSurface = false;
    let calls = 0;
    const result = await h.admission.idle({
      deadlineAt: h.clock.now() + 10_000,
      canStartEffect: () => ++calls < 2,
    });
    expect(result.ok).toBe(false);
    expect(h.state.reserved).toBe(false);
    expect(h.reports).toEqual([
      { stage: "admission", reason: "reservation_lost" },
    ]);
  });
});

describe("idle admission: the first idle proof", () => {
  it.each([
    [
      { state: "running" },
      "UPDATE_BROWSER_BUSY",
      { stage: "probe", reason: "running" },
    ],
    [
      { state: "draft" },
      "UPDATE_BROWSER_DRAFT",
      { stage: "probe", reason: "draft" },
    ],
    [
      { state: "unknown" },
      "UPDATE_BROWSER_STATE_UNKNOWN",
      { stage: "probe", reason: "unknown" },
    ],
    [
      { state: "idle", extra: 1 },
      "UPDATE_BROWSER_STATE_UNKNOWN",
      { stage: "probe", reason: "parse_failed" },
    ],
    [
      { state: "asleep" },
      "UPDATE_BROWSER_STATE_UNKNOWN",
      { stage: "probe", reason: "parse_failed" },
    ],
    [
      null,
      "UPDATE_BROWSER_STATE_UNKNOWN",
      { stage: "probe", reason: "parse_failed" },
    ],
  ] as const)(
    "refuses on the reading %j without pausing the page",
    async (reading, code, diagnostic) => {
      const h = harness();
      h.page.world.probe = reading;
      expect(await h.admission.idle()).toEqual({ ok: false, code });
      expect(h.reports).toEqual([diagnostic]);
      expect(h.state.reserved).toBe(false);
      expect(h.log).toEqual(["execute"]);
      expect(listenerCount(h)).toBe(0);
      expect(h.clock.armed()).toBe(0);
    },
  );

  it("refuses as failed when the probe throws", async () => {
    const h = harness();
    h.page.world.probeBehavior = () => Promise.reject(new Error("navigated"));
    await h.admission.idle();
    expect(h.reports).toEqual([{ stage: "probe", reason: "failed" }]);
    expect(h.state.reserved).toBe(false);
  });

  it("refuses as timeout when the probe never answers in two seconds", async () => {
    const h = harness();
    h.page.world.probeBehavior = () => new Promise(() => undefined);
    const pending = h.admission.idle();
    await flush();
    h.clock.advance(1_999);
    await flush();
    expect(h.state.reserved).toBe(true);
    h.clock.advance(1);
    await pending;
    expect(h.reports).toEqual([{ stage: "probe", reason: "timeout" }]);
    expect(h.state.reserved).toBe(false);
    expect(listenerCount(h)).toBe(0);
  });

  it("discards a reading taken after the document changed under it", async () => {
    const h = harness();
    h.page.world.probeBehavior = async () => {
      h.page.world.url = "https://chatgpt.com/c/other";
      return { state: "idle" };
    };
    await h.admission.idle();
    expect(h.reports).toEqual([{ stage: "document", reason: "url_changed" }]);
    expect(h.state.reserved).toBe(false);
  });

  it("fences the page's input while it holds the reservation", async () => {
    const h = harness();
    let fenced = 0;
    h.page.world.probeBehavior = async () => {
      for (const event of ["before-input-event", "before-mouse-event"]) {
        const preventDefault = vi.fn();
        h.page.contents.emit(event, { preventDefault });
        fenced += preventDefault.mock.calls.length;
      }
      return { state: "running" };
    };
    await h.admission.idle();
    expect(fenced).toBe(2);
  });
});

describe("idle admission: pausing the page", () => {
  it("proves idle, pauses under its own inspector session and proves idle again", async () => {
    const h = harness();
    const admission = await heldIdle(h);
    expect(h.log).toEqual([
      "execute",
      "attach 1.3",
      "Debugger.enable",
      "Debugger.pause",
      "Runtime.evaluate",
    ]);
    expect(h.state.reserved).toBe(true);
    expect(h.reports).toEqual([]);
    expect(h.clock.armed()).toBe(0);
    expect(await admission.recheck()).toEqual({ ok: true });
    // Held rechecks read through the inspector, never the paused page.
    expect(h.log.at(-1)).toBe("Runtime.evaluate");
    expect(h.log.filter((entry) => entry === "execute")).toHaveLength(1);
    await admission.release();
  });

  it("releases by resuming, detaching, removing every listener and the reservation", async () => {
    const h = harness();
    const admission = await heldIdle(h);
    await admission.release();
    expect(h.log.slice(-2)).toEqual(["Debugger.resume", "detach"]);
    expect(h.state.reserved).toBe(false);
    expect(listenerCount(h)).toBe(0);
    expect(h.clock.armed()).toBe(0);
  });

  it("shares one release between repeated calls and sends nothing twice", async () => {
    const h = harness();
    const admission = await heldIdle(h);
    const first = admission.release();
    const second = admission.release();
    await Promise.all([first, second]);
    expect(h.log.filter((entry) => entry === "Debugger.resume")).toHaveLength(
      1,
    );
    expect(h.log.filter((entry) => entry === "detach")).toHaveLength(1);
  });

  it("skips the debugger on release when it is gone or already detached", async () => {
    const gone = harness();
    const goneAdmission = await heldIdle(gone);
    gone.page.world.destroyed = true;
    gone.log.length = 0;
    await goneAdmission.release();
    expect(gone.log).toEqual([]);
    expect(gone.state.reserved).toBe(false);
    expect(listenerCount(gone)).toBe(0);

    const detached = harness();
    const detachedAdmission = await heldIdle(detached);
    detached.page.debuggerClient.emit("detach", {}, "target_closed");
    detached.log.length = 0;
    await detachedAdmission.release();
    expect(detached.log).toEqual([]);
    expect(detached.state.reserved).toBe(false);
  });

  it("refuses without attaching when an inspector is already attached or DevTools is open", async () => {
    for (const [arrange, reason] of [
      [
        (h: Harness) => {
          h.page.world.attached = true;
        },
        "already_attached",
      ],
      [
        (h: Harness) => {
          h.page.world.devtools = true;
        },
        "devtools_open",
      ],
    ] as const) {
      const h = harness();
      arrange(h);
      expect(await h.admission.idle()).toEqual({
        ok: false,
        code: "UPDATE_BROWSER_STATE_UNKNOWN",
      });
      expect(h.reports).toEqual([{ stage: "debugger", reason }]);
      expect(h.log).toEqual(["execute"]);
      expect(h.page.world.attached).toBe(reason === "already_attached");
      expect(h.state.reserved).toBe(false);
      expect(listenerCount(h)).toBe(0);
    }
  });

  it("refuses without detaching when the attach itself fails", async () => {
    const h = harness();
    h.page.world.attachThrows = true;
    await h.admission.idle();
    expect(h.reports).toEqual([{ stage: "debugger", reason: "attach_failed" }]);
    expect(h.log).not.toContain("detach");
    expect(h.state.reserved).toBe(false);
    expect(listenerCount(h)).toBe(0);
  });

  it("detaches its own session when enabling the debugger fails", async () => {
    const h = harness();
    h.page.world.commandBehavior = (method) =>
      method === "Debugger.enable"
        ? Promise.reject(new Error("enable"))
        : undefined;
    await h.admission.idle();
    expect(h.reports).toEqual([{ stage: "debugger", reason: "enable_failed" }]);
    expect(h.log.at(-1)).toBe("detach");
    expect(h.page.world.attached).toBe(false);
    expect(h.state.reserved).toBe(false);
    expect(listenerCount(h)).toBe(0);
  });

  it("detaches its own session when enabling the debugger times out", async () => {
    const h = harness();
    h.page.world.commandBehavior = (method) =>
      method === "Debugger.enable" ? new Promise(() => undefined) : undefined;
    const pending = h.admission.idle();
    await flush();
    h.clock.advance(2_000);
    await pending;
    expect(h.reports).toEqual([{ stage: "debugger", reason: "timeout" }]);
    expect(h.log.at(-1)).toBe("detach");
    expect(h.state.reserved).toBe(false);
  });

  it("detaches and reports a pause timeout when no paused event ever arrives", async () => {
    const h = harness();
    h.page.world.commandBehavior = (method) =>
      method === "Debugger.pause" ? Promise.resolve({}) : undefined;
    const pending = h.admission.idle();
    await flush();
    // A quiet page gets one no-op statement to acknowledge the pause.
    expect(h.log).toContain("void0");
    h.clock.advance(2_000);
    await pending;
    expect(h.reports).toEqual([{ stage: "pause", reason: "timeout" }]);
    expect(h.log.at(-1)).toBe("detach");
    expect(h.state.reserved).toBe(false);
    expect(listenerCount(h)).toBe(0);
  });

  it("reports a failed pause and detaches", async () => {
    const h = harness();
    h.page.world.commandBehavior = (method) =>
      method === "Debugger.pause"
        ? Promise.reject(new Error("pause"))
        : undefined;
    await h.admission.idle();
    expect(h.reports).toEqual([{ stage: "pause", reason: "failed" }]);
    expect(h.log.at(-1)).toBe("detach");
    expect(h.state.reserved).toBe(false);
  });

  it("holds the reservation and every listener when a failed pause cannot detach", async () => {
    const h = harness();
    h.page.world.commandBehavior = (method) =>
      method === "Debugger.pause"
        ? Promise.reject(new Error("pause"))
        : undefined;
    h.page.world.detachThrows = true;
    expect(await h.admission.idle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    });
    expect(h.reports).toEqual([{ stage: "release", reason: "detach_failed" }]);
    expect(h.state.reserved).toBe(true);
    expect(h.log.filter((entry) => entry === "detach")).toHaveLength(1);
    expect(listenerCount(h)).toBeGreaterThan(0);
  });

  it("resumes, then detaches, when the proof under the pause refuses", async () => {
    const h = harness();
    h.page.world.commandBehavior = (method, params) =>
      method === "Runtime.evaluate" &&
      params?.expression === chatGptUpdateIdleProbe
        ? Promise.resolve({
            result: { type: "object", value: { state: "running" } },
          })
        : undefined;
    expect(await h.admission.idle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_BUSY",
    });
    expect(h.reports).toEqual([{ stage: "paused_probe", reason: "running" }]);
    expect(h.log.slice(-2)).toEqual(["Debugger.resume", "detach"]);
    expect(h.state.reserved).toBe(false);
    expect(listenerCount(h)).toBe(0);
  });

  it.each([
    [{ result: { type: "string", value: { state: "idle" } } }],
    [
      {
        result: { type: "object", value: { state: "idle" } },
        exceptionDetails: {},
      },
    ],
    [{ result: { type: "object", value: { state: "other" } } }],
    [null],
  ])("fails closed on the unrecognized inspector reply %j", async (reply) => {
    const h = harness();
    h.page.world.commandBehavior = (method, params) =>
      method === "Runtime.evaluate" &&
      params?.expression === chatGptUpdateIdleProbe
        ? Promise.resolve(reply)
        : undefined;
    expect(await h.admission.idle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(h.reports).toEqual([
      { stage: "paused_probe", reason: "parse_failed" },
    ]);
    expect(h.state.reserved).toBe(false);
    expect(h.log.slice(-2)).toEqual(["Debugger.resume", "detach"]);
  });

  it("refuses the held recheck when the page's idle state changes", async () => {
    const h = harness();
    const admission = await heldIdle(h);
    h.page.world.probe = { state: "draft" };
    expect(await admission.recheck()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_DRAFT",
    });
    expect(h.reports.at(-1)).toEqual({
      stage: "paused_probe",
      reason: "draft",
    });
    await admission.release();
  });
});

describe("idle admission: a held admission that stops being current", () => {
  it.each([
    [
      "the reservation is lost",
      (h: Harness) => {
        h.state.reserved = false;
      },
      { stage: "admission", reason: "reservation_lost" },
    ],
    [
      "the route replaced its surface",
      (h: Harness) => {
        h.state.surface = null;
      },
      { stage: "surface", reason: "changed" },
    ],
    [
      "the surface is destroyed",
      (h: Harness) => {
        h.surface.destroyed = true;
      },
      { stage: "surface", reason: "destroyed" },
    ],
    [
      "the contents are destroyed",
      (h: Harness) => {
        h.page.world.destroyed = true;
      },
      { stage: "surface", reason: "destroyed" },
    ],
    [
      "the document unloads",
      (h: Harness) => {
        h.state.loaded = false;
      },
      { stage: "document", reason: "not_loaded" },
    ],
    [
      "a new document generation starts",
      (h: Harness) => {
        h.state.generation += 1;
      },
      { stage: "document", reason: "changed" },
    ],
    [
      "the address changes",
      (h: Harness) => {
        h.page.world.url = "https://chatgpt.com/c/elsewhere";
      },
      { stage: "document", reason: "url_changed" },
    ],
    [
      "a task starts",
      (h: Harness) => {
        h.state.taskInFlight = true;
      },
      { stage: "admission", reason: "busy" },
    ],
    [
      "the route starts opening",
      (h: Harness) => {
        h.state.opening = true;
      },
      { stage: "admission", reason: "busy" },
    ],
    [
      "a sign-in starts",
      (h: Harness) => {
        h.state.signInMode = true;
      },
      { stage: "admission", reason: "busy" },
    ],
    [
      "a popup opens",
      (h: Harness) => {
        h.state.popup = true;
      },
      { stage: "admission", reason: "busy" },
    ],
    [
      "the pause is lost",
      (h: Harness) => {
        h.page.debuggerClient.emit("message", {}, "Debugger.resumed");
      },
      { stage: "pause", reason: "unconfirmed" },
    ],
    [
      "the inspector session is lost",
      (h: Harness) => {
        h.page.debuggerClient.emit("detach", {}, "target_closed");
      },
      { stage: "pause", reason: "unconfirmed" },
    ],
  ] as const)("answers unknown when %s", async (_n, change, diagnostic) => {
    const h = harness();
    const admission = await heldIdle(h);
    change(h);
    expect(await admission.recheck()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_STATE_UNKNOWN",
    });
    expect(h.reports.at(-1)).toEqual(diagnostic);
    h.state.reserved = true;
    h.page.world.destroyed = true;
    await admission.release();
  });

  it("sends no further command once the host stops allowing effects", async () => {
    const h = harness();
    let allowed = true;
    const admission = await heldIdle(h, {
      deadlineAt: h.clock.now() + 10_000,
      canStartEffect: () => allowed,
    });
    allowed = false;
    const before = h.log.length;
    expect((await admission.recheck()).ok).toBe(false);
    expect(h.log.slice(before)).toEqual([]);
    expect(h.reports.at(-1)).toEqual({
      stage: "admission",
      reason: "reservation_lost",
    });
    // Cleanup is not an effect the budget can forbid: release still resumes.
    await admission.release();
    expect(h.log.slice(-2)).toEqual(["Debugger.resume", "detach"]);
    expect(h.state.reserved).toBe(false);
  });
});

describe("idle admission: releasing under uncertainty", () => {
  it("holds the reservation when the resume fails, and never repeats it", async () => {
    const h = harness();
    const admission = await heldIdle(h);
    h.page.world.commandBehavior = (method) =>
      method === "Debugger.resume"
        ? Promise.reject(new Error("resume"))
        : undefined;
    await expect(admission.release()).rejects.toThrow(
      "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    );
    await expect(admission.release()).rejects.toThrow(
      "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    );
    expect(h.reports).toEqual([{ stage: "resume", reason: "failed" }]);
    expect(h.log.filter((entry) => entry === "Debugger.resume")).toHaveLength(
      1,
    );
    expect(h.log).not.toContain("detach");
    expect(h.state.reserved).toBe(true);
    expect(listenerCount(h)).toBeGreaterThan(0);
  });

  it("bounds the resume by its own two seconds, whatever is left of the Quit budget", async () => {
    const h = harness();
    const admission = await heldIdle(h, {
      deadlineAt: h.clock.now() + 50,
      canStartEffect: () => true,
    });
    h.page.world.commandBehavior = (method) =>
      method === "Debugger.resume" ? new Promise(() => undefined) : undefined;
    h.clock.skip(1_000);
    const released = admission.release();
    const outcome = released.then(
      () => "released",
      (error: Error) => error.message,
    );
    await flush();
    h.clock.advance(1_999);
    await flush();
    expect(h.reports).toEqual([]);
    h.clock.advance(1);
    expect(await outcome).toBe("UPDATE_BROWSER_RELEASE_UNCONFIRMED");
    expect(h.reports).toEqual([{ stage: "resume", reason: "timeout" }]);
    expect(h.state.reserved).toBe(true);
  });

  it("holds the reservation when the detach fails on release", async () => {
    const h = harness();
    const admission = await heldIdle(h);
    h.page.world.detachThrows = true;
    await expect(admission.release()).rejects.toThrow(
      "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    );
    expect(h.reports).toEqual([{ stage: "release", reason: "detach_failed" }]);
    expect(h.state.reserved).toBe(true);
    expect(listenerCount(h)).toBeGreaterThan(0);
  });

  it("holds the reservation when a refused proof cannot detach", async () => {
    const h = harness();
    h.page.world.commandBehavior = (method, params) =>
      method === "Runtime.evaluate" &&
      params?.expression === chatGptUpdateIdleProbe
        ? Promise.resolve({
            result: { type: "object", value: { state: "draft" } },
          })
        : undefined;
    h.page.world.detachThrows = true;
    expect(await h.admission.idle()).toEqual({
      ok: false,
      code: "UPDATE_BROWSER_RELEASE_UNCONFIRMED",
    });
    expect(h.state.reserved).toBe(true);
  });
});
