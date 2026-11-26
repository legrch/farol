import { describe, expect, it, vi } from "vitest";
import { readinessProbe } from "../../../src/apps/desktop/chatgpt/scripts";
import {
  READINESS_OBSERVATION_MS,
  createReadinessObserver,
  createTaskScriptRunner,
  TaskScriptNotDispatchedError,
  taskScriptRefusalReason,
  type TaskScriptDispatchGate,
  type ObservedFrame,
  type SignInStatusReason,
} from "./observe";

const CHAT = "https://chatgpt.com/";
const CHAT_OTHER = "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc";
const FOREIGN = "https://example.com/";

const AUTHENTICATED = { composerVisible: true, signInVisible: false };
const SIGNED_OUT = { composerVisible: false, signInVisible: true };
const GUEST_COMPOSER = { composerVisible: true, signInVisible: true };
const NOTHING = { composerVisible: false, signInVisible: false };

const UNREACHABLE = {
  state: "unreachable",
  code: "CHATGPT_PAGE_UNREACHABLE",
} as const;
const UNRECOGNIZED = {
  state: "unsupported",
  code: "CHATGPT_UI_UNRECOGNIZED",
} as const;
const SIGN_IN_REQUIRED = {
  state: "signed_out",
  code: "CHATGPT_SIGN_IN_REQUIRED",
} as const;
const READY = { state: "authenticated", code: null } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A frame and contents whose every read throws once the native object is
// "gone", as Electron's do after a window is destroyed.
function fakeSurface(
  options: {
    url?: string;
    answer?: () => Promise<unknown>;
    withFrame?: boolean;
  } = {},
) {
  const url = options.url ?? CHAT;
  const answer = options.answer ?? (async () => AUTHENTICATED);
  const frame = {
    dead: false,
    url,
    run: vi.fn(async (_script: string, _gesture?: boolean): Promise<unknown> =>
      answer(),
    ),
    isDestroyed: () => frame.dead,
    executeJavaScript: (script: string, gesture?: boolean) =>
      frame.run(script, gesture),
  };
  const contents = {
    gone: false,
    destroyed: false,
    url,
    frame: (options.withFrame === false ? null : frame) as ObservedFrame | null,
    direct: vi.fn(
      async (_script: string, _gesture?: boolean): Promise<unknown> => answer(),
    ),
    getURL: () => {
      if (contents.gone) throw new Error("Object has been destroyed");
      return contents.url;
    },
    isDestroyed: () => contents.destroyed,
    get mainFrame() {
      if (contents.gone) throw new Error("Object has been destroyed");
      return contents.frame;
    },
    executeJavaScript: (script: string, gesture?: boolean) =>
      contents.direct(script, gesture),
  };
  const surface = {
    dead: false,
    isDestroyed: () => surface.dead,
    webContents: contents,
  };
  const destroy = () => {
    surface.dead = true;
    contents.destroyed = true;
    contents.gone = true;
    frame.dead = true;
  };
  return { surface, contents, frame, destroy };
}

type Fake = ReturnType<typeof fakeSurface>;

function rig(initial: Fake | null = fakeSurface()) {
  const state = {
    fake: initial,
    documentGeneration: 1,
    loaded: true,
    awaitingCommit: false,
    disposing: false,
    blocked: false,
    e2eOrigin: null as string | null,
  };
  const clock = {
    t: 5_000,
    timers: [] as { callback: () => void; ms: number; cancelled: boolean }[],
  };
  const diagnostics: {
    reason: SignInStatusReason;
    pageState: string | null;
  }[] = [];
  const observer = createReadinessObserver({
    route: {
      surface: () => state.fake?.surface ?? null,
      documentGeneration: () => state.documentGeneration,
      loaded: () => state.loaded,
      awaitingCommit: () => state.awaitingCommit,
      disposing: () => state.disposing,
      blocked: () => state.blocked,
    },
    e2eOrigin: () => state.e2eOrigin,
    clock: {
      now: () => clock.t,
      after: (callback, ms) => {
        const timer = { callback, ms, cancelled: false };
        clock.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
    diagnose: (reason, pageState) => {
      diagnostics.push({ reason, pageState });
    },
  });
  const swapWindow = (next: Fake) => {
    state.fake = next;
  };
  return { observer, state, clock, diagnostics, swapWindow };
}

describe("readPage", () => {
  it("reports an unreachable page when there is no window or it is destroyed", async () => {
    const none = rig(null);
    await expect(none.observer.readPage(true)).resolves.toEqual({
      observation: UNREACHABLE,
      reason: "no-window",
    });
    const fake = fakeSurface();
    const gone = rig(fake);
    fake.destroy();
    await expect(gone.observer.readPage(true)).resolves.toEqual({
      observation: UNREACHABLE,
      reason: "no-window",
    });
    expect(fake.frame.run).not.toHaveBeenCalled();
  });

  it("reports load-failed while the load slot failed or a commit is pending", async () => {
    const failed = rig();
    failed.state.loaded = false;
    await expect(failed.observer.readPage(true)).resolves.toEqual({
      observation: UNREACHABLE,
      reason: "load-failed",
    });
    const pending = rig();
    pending.state.awaitingCommit = true;
    await expect(pending.observer.readPage(true)).resolves.toEqual({
      observation: UNREACHABLE,
      reason: "load-failed",
    });
    expect(failed.state.fake?.frame.run).not.toHaveBeenCalled();
    expect(pending.state.fake?.frame.run).not.toHaveBeenCalled();
  });

  it("refuses a page outside the allowed ChatGPT origins without running the probe", async () => {
    const foreign = rig(fakeSurface({ url: FOREIGN }));
    await expect(foreign.observer.readPage(true)).resolves.toEqual({
      observation: UNRECOGNIZED,
      reason: "url-unsupported",
    });
    expect(foreign.state.fake?.frame.run).not.toHaveBeenCalled();
    // The fixture origin is allowed only when the route names it.
    const fixture = rig(fakeSurface({ url: "http://127.0.0.1:4010/x" }));
    fixture.state.e2eOrigin = "http://127.0.0.1:4010";
    await expect(fixture.observer.readPage(true)).resolves.toMatchObject({
      observation: READY,
      reason: "answered",
    });
  });

  it("classifies each closed probe answer and passes the probe and the gesture through", async () => {
    const cases: [unknown, unknown][] = [
      [AUTHENTICATED, READY],
      [SIGNED_OUT, SIGN_IN_REQUIRED],
      [GUEST_COMPOSER, SIGN_IN_REQUIRED],
      [NOTHING, UNRECOGNIZED],
    ];
    for (const [answer, expected] of cases) {
      const world = rig(fakeSurface({ answer: async () => answer }));
      await expect(world.observer.readPage(false)).resolves.toEqual({
        observation: expected,
        reason: "answered",
      });
      expect(world.state.fake?.frame.run).toHaveBeenCalledWith(
        readinessProbe,
        false,
      );
    }
    const gesture = rig();
    await gesture.observer.readPage(true);
    expect(gesture.state.fake?.frame.run).toHaveBeenCalledWith(
      readinessProbe,
      true,
    );
  });

  it("runs the probe on the contents when there is no main frame", async () => {
    const world = rig(fakeSurface({ withFrame: false }));
    await expect(world.observer.readPage(true)).resolves.toMatchObject({
      observation: READY,
      reason: "answered",
    });
    expect(world.state.fake?.contents.direct).toHaveBeenCalledWith(
      readinessProbe,
      true,
    );
  });

  it("never upgrades an answer of an unknown shape", async () => {
    const shapes = [
      null,
      "authenticated",
      {},
      { composerVisible: true },
      { composerVisible: "yes", signInVisible: false },
      { ...AUTHENTICATED, extra: true },
    ];
    for (const answer of shapes) {
      const world = rig(fakeSurface({ answer: async () => answer }));
      await expect(world.observer.readPage(true)).resolves.toEqual({
        observation: UNRECOGNIZED,
        reason: "probe-unrecognized",
      });
    }
  });

  it("reports probe-threw, never a state, for a failed or contradicted read", async () => {
    const rejected = rig(
      fakeSurface({
        answer: async () => {
          throw new Error("boom");
        },
      }),
    );
    await expect(rejected.observer.readPage(true)).resolves.toEqual({
      observation: UNRECOGNIZED,
      reason: "probe-threw",
    });

    const deadFrame = fakeSurface();
    deadFrame.frame.dead = true;
    await expect(rig(deadFrame).observer.readPage(true)).resolves.toEqual({
      observation: UNRECOGNIZED,
      reason: "probe-threw",
    });
    expect(deadFrame.frame.run).not.toHaveBeenCalled();

    const movedFrame = fakeSurface();
    movedFrame.frame.url = CHAT_OTHER;
    await expect(rig(movedFrame).observer.readPage(true)).resolves.toEqual({
      observation: UNRECOGNIZED,
      reason: "probe-threw",
    });
    expect(movedFrame.frame.run).not.toHaveBeenCalled();
  });

  it("refuses an authenticated answer when the frame changed during the probe", async () => {
    const mutations: [string, (fake: Fake) => void][] = [
      ["destroyed", (fake) => (fake.frame.dead = true)],
      ["navigated", (fake) => (fake.frame.url = CHAT_OTHER)],
      [
        "replaced",
        (fake) =>
          (fake.contents.frame = {
            isDestroyed: () => false,
            url: CHAT,
            executeJavaScript: async () => AUTHENTICATED,
          }),
      ],
    ];
    for (const [, mutate] of mutations) {
      const gate = deferred<unknown>();
      const fake = fakeSurface({ answer: () => gate.promise });
      const world = rig(fake);
      const read = world.observer.readPage(true);
      mutate(fake);
      gate.resolve(AUTHENTICATED);
      await expect(read).resolves.toEqual({
        observation: UNRECOGNIZED,
        reason: "probe-threw",
      });
    }
  });

  it("turns a window destroyed mid-probe into probe-threw, not a positive answer", async () => {
    const gate = deferred<unknown>();
    const fake = fakeSurface({ answer: () => gate.promise });
    const world = rig(fake);
    const read = world.observer.readPage(true);
    fake.destroy();
    gate.resolve(AUTHENTICATED);
    await expect(read).resolves.toEqual({
      observation: UNRECOGNIZED,
      reason: "probe-threw",
    });
  });

  it("lets a native throw from the url read before the probe reach the caller", async () => {
    const fake = fakeSurface();
    fake.contents.gone = true;
    await expect(rig(fake).observer.readPage(true)).rejects.toThrow(
      "destroyed",
    );
    expect(fake.frame.run).not.toHaveBeenCalled();
  });
});

describe("observe", () => {
  it("returns the page read directly when there was no window to bind it to", async () => {
    const world = rig(null);
    await expect(world.observer.observe()).resolves.toEqual(UNREACHABLE);
    expect(world.observer.latest()).toBeNull();
  });

  it("publishes an authenticated read for the exact document it read", async () => {
    const world = rig();
    await expect(world.observer.observe()).resolves.toEqual(READY);
    expect(world.observer.latest()).toMatchObject({
      surface: world.state.fake?.surface,
      documentGeneration: 1,
      url: CHAT,
      sequence: 1,
      observation: READY,
    });
    expect(world.observer.sequence()).toBe(1);
  });

  it("answers unknown when the document changed while the probe ran", async () => {
    const mutations: [string, (world: ReturnType<typeof rig>) => void][] = [
      ["generation", (world) => (world.state.documentGeneration = 2)],
      ["load slot", (world) => (world.state.loaded = false)],
      ["pending commit", (world) => (world.state.awaitingCommit = true)],
      ["disposing", (world) => (world.state.disposing = true)],
      [
        "url",
        (world) => {
          if (world.state.fake) world.state.fake.contents.url = CHAT_OTHER;
        },
      ],
      ["window replaced", (world) => world.swapWindow(fakeSurface())],
      ["window destroyed", (world) => world.state.fake?.destroy()],
    ];
    for (const [, mutate] of mutations) {
      const gate = deferred<unknown>();
      const world = rig(fakeSurface({ answer: () => gate.promise }));
      const observing = world.observer.observe();
      mutate(world);
      gate.resolve(AUTHENTICATED);
      await expect(observing).resolves.toEqual(UNRECOGNIZED);
      expect(world.observer.latest()).toBeNull();
    }
  });

  it("lets an older positive answer authorize nothing once a newer read began", async () => {
    const first = deferred<unknown>();
    const answers = [first.promise, Promise.resolve(NOTHING)];
    const world = rig(
      fakeSurface({
        answer: () => answers.shift() ?? Promise.resolve(NOTHING),
      }),
    );
    const older = world.observer.observe();
    const newer = world.observer.observe();
    await expect(newer).resolves.toEqual(UNRECOGNIZED);
    first.resolve(AUTHENTICATED);
    await expect(older).resolves.toEqual(UNRECOGNIZED);
    expect(world.observer.latest()?.observation).toEqual(UNRECOGNIZED);
  });

  it("returns the newer settled read to an older one that finished after it", async () => {
    const first = deferred<unknown>();
    const answers = [first.promise, Promise.resolve(AUTHENTICATED)];
    const world = rig(
      fakeSurface({
        answer: () => answers.shift() ?? Promise.resolve(NOTHING),
      }),
    );
    const older = world.observer.observe();
    await expect(world.observer.observe()).resolves.toEqual(READY);
    first.resolve(SIGNED_OUT);
    await expect(older).resolves.toEqual(READY);
  });

  it("keeps a signed-out answer over a later unclassifiable one for the same document", async () => {
    const answers: unknown[] = [SIGNED_OUT, NOTHING, "garbled"];
    const world = rig(fakeSurface({ answer: async () => answers.shift() }));
    await expect(world.observer.observe()).resolves.toEqual(SIGN_IN_REQUIRED);
    await expect(world.observer.observe()).resolves.toEqual(SIGN_IN_REQUIRED);
    await expect(world.observer.observe()).resolves.toEqual(SIGN_IN_REQUIRED);
  });

  it("does not carry a signed-out answer over to a different document", async () => {
    const answers: unknown[] = [SIGNED_OUT, NOTHING];
    const world = rig(fakeSurface({ answer: async () => answers.shift() }));
    await expect(world.observer.observe()).resolves.toEqual(SIGN_IN_REQUIRED);
    world.state.documentGeneration = 2;
    await expect(world.observer.observe()).resolves.toEqual(UNRECOGNIZED);
  });

  it("lets an authenticated answer replace a signed-out one", async () => {
    const answers: unknown[] = [SIGNED_OUT, AUTHENTICATED];
    const world = rig(fakeSurface({ answer: async () => answers.shift() }));
    await world.observer.observe();
    await expect(world.observer.observe()).resolves.toEqual(READY);
  });

  it("invalidates every read begun so far", async () => {
    const gate = deferred<unknown>();
    const world = rig(fakeSurface({ answer: () => gate.promise }));
    const observing = world.observer.observe();
    world.observer.invalidate();
    expect(world.observer.sequence()).toBe(2);
    gate.resolve(AUTHENTICATED);
    await expect(observing).resolves.toEqual(UNRECOGNIZED);
  });
});

describe("a stalled page read", () => {
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const fire = (clock: ReturnType<typeof rig>["clock"], ms: number) => {
    clock.t += ms;
    for (const timer of clock.timers)
      if (!timer.cancelled && timer.ms <= ms) timer.callback();
  };

  it.each([true, false])(
    "settles observe() to the unrecognized observation at the readiness deadline (frame=%s)",
    async (withFrame) => {
      const gate = deferred<unknown>();
      const fake = fakeSurface({ answer: () => gate.promise, withFrame });
      const { observer, clock } = rig(fake);
      const settled = vi.fn();
      const pending = observer.observe().then((value) => {
        settled(value);
        return value;
      });
      await flush();
      expect(settled).not.toHaveBeenCalled();
      fire(clock, READINESS_OBSERVATION_MS);
      await flush();
      expect(settled).toHaveBeenCalledWith(UNRECOGNIZED);
      // A late positive answer changes nothing and publishes no readiness.
      gate.resolve(AUTHENTICATED);
      await flush();
      expect(await pending).toEqual(UNRECOGNIZED);
      expect(observer.latest()).not.toMatchObject({ observation: READY });
    },
  );

  it("never answers authenticated for a probe that resolves after the deadline", async () => {
    const gate = deferred<unknown>();
    const { observer, clock } = rig(
      fakeSurface({ answer: () => gate.promise }),
    );
    const pending = observer.observe();
    await flush();
    clock.t += READINESS_OBSERVATION_MS + 1;
    gate.resolve(AUTHENTICATED);
    await flush();
    await expect(pending).resolves.toEqual(UNRECOGNIZED);
  });

  it("cancels the deadline timer once the probe answered", async () => {
    const { observer, clock } = rig();
    await expect(observer.observe()).resolves.toEqual(READY);
    expect(clock.timers.every((timer) => timer.cancelled)).toBe(true);
  });
});

describe("observeSignInStatus", () => {
  it("reports authenticated and signed_out with a frozen binding and nothing published", async () => {
    for (const [answer, state] of [
      [AUTHENTICATED, "authenticated"],
      [SIGNED_OUT, "signed_out"],
    ] as const) {
      const world = rig(fakeSurface({ answer: async () => answer }));
      const result = await world.observer.observeSignInStatus();
      expect(result.state).toBe(state);
      expect(result.binding).toEqual({ sequence: 1, documentGeneration: 1 });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.binding)).toBe(true);
      expect(world.observer.isCurrentSignInStatus(result)).toBe(true);
      expect(world.observer.latest()).toBeNull();
      expect(world.diagnostics).toEqual([]);
      // The probe ran without a user gesture and its timer was cancelled.
      expect(world.state.fake?.frame.run).toHaveBeenCalledWith(
        readinessProbe,
        false,
      );
      expect(world.clock.timers).toHaveLength(1);
      expect(world.clock.timers[0]).toMatchObject({
        ms: READINESS_OBSERVATION_MS,
        cancelled: true,
      });
    }
  });

  it("never upgrades an answer that is not a settled state", async () => {
    const answers: [unknown, string | null][] = [
      [NOTHING, "unsupported"],
      ["garbled", "unsupported"],
      [{ composerVisible: true }, "unsupported"],
    ];
    for (const [answer, pageState] of answers) {
      const world = rig(fakeSurface({ answer: async () => answer }));
      const result = await world.observer.observeSignInStatus();
      expect(result).toEqual({ state: "unknown", binding: null });
      expect(Object.isFrozen(result)).toBe(true);
      expect(world.diagnostics).toEqual([{ reason: "unconfirmed", pageState }]);
      expect(world.observer.isCurrentSignInStatus(result)).toBe(false);
    }
  });

  it("never upgrades a read that did not answer", async () => {
    const cases: [string, ReturnType<typeof rig>, string][] = [
      ["url", rig(fakeSurface({ url: FOREIGN })), "unsupported"],
      [
        "throw",
        rig(
          fakeSurface({
            answer: async () => {
              throw new Error("boom");
            },
          }),
        ),
        "unsupported",
      ],
    ];
    for (const [, world, pageState] of cases) {
      const result = await world.observer.observeSignInStatus();
      expect(result).toEqual({ state: "unknown", binding: null });
      expect(world.diagnostics).toEqual([{ reason: "unconfirmed", pageState }]);
    }
  });

  it("refuses at admission without reading the page", async () => {
    const mutations: [string, (world: ReturnType<typeof rig>) => void][] = [
      ["disposing", (world) => (world.state.disposing = true)],
      ["blocked", (world) => (world.state.blocked = true)],
      ["pending commit", (world) => (world.state.awaitingCommit = true)],
      [
        "contents destroyed",
        (world) => {
          if (world.state.fake) world.state.fake.contents.destroyed = true;
        },
      ],
    ];
    for (const [, mutate] of mutations) {
      const world = rig();
      mutate(world);
      const result = await world.observer.observeSignInStatus();
      expect(result).toEqual({ state: "unknown", binding: null });
      expect(world.diagnostics).toEqual([
        { reason: "admission", pageState: null },
      ]);
      expect(world.state.fake?.frame.run).not.toHaveBeenCalled();
      expect(world.clock.timers).toHaveLength(0);
    }
  });

  it("refuses when there is no current document to read", async () => {
    const none = rig(null);
    await expect(none.observer.observeSignInStatus()).resolves.toEqual({
      state: "unknown",
      binding: null,
    });
    expect(none.diagnostics).toEqual([
      { reason: "document-not-current", pageState: null },
    ]);

    const loading = rig();
    loading.state.loaded = false;
    await loading.observer.observeSignInStatus();
    expect(loading.diagnostics).toEqual([
      { reason: "document-not-current", pageState: null },
    ]);
    expect(loading.state.fake?.frame.run).not.toHaveBeenCalled();

    const destroyedSurface = rig();
    if (destroyedSurface.state.fake)
      destroyedSurface.state.fake.surface.dead = true;
    await destroyedSurface.observer.observeSignInStatus();
    expect(destroyedSurface.diagnostics).toEqual([
      { reason: "document-not-current", pageState: null },
    ]);
  });

  it("answers unknown when the bound timer wins, and cancels it otherwise", async () => {
    const gate = deferred<unknown>();
    const world = rig(fakeSurface({ answer: () => gate.promise }));
    const pending = world.observer.observeSignInStatus();
    expect(world.clock.timers).toHaveLength(1);
    expect(world.clock.timers[0]?.ms).toBe(2_000);
    world.clock.timers[0]?.callback();
    await expect(pending).resolves.toEqual({ state: "unknown", binding: null });
    expect(world.diagnostics).toEqual([
      { reason: "unconfirmed", pageState: null },
    ]);
    expect(world.clock.timers[0]?.cancelled).toBe(true);
    gate.resolve(AUTHENTICATED);
    expect(world.observer.latest()).toBeNull();
  });

  it("accepts an answer just inside the 2 s monotonic budget and refuses it at the boundary", async () => {
    const answerAt = async (elapsed: number) => {
      const gate = deferred<unknown>();
      const world = rig(fakeSurface({ answer: () => gate.promise }));
      const pending = world.observer.observeSignInStatus();
      world.clock.t += elapsed;
      gate.resolve(AUTHENTICATED);
      return pending;
    };
    await expect(answerAt(READINESS_OBSERVATION_MS - 1)).resolves.toMatchObject(
      { state: "authenticated" },
    );
    await expect(answerAt(READINESS_OBSERVATION_MS)).resolves.toEqual({
      state: "unknown",
      binding: null,
    });
    await expect(answerAt(READINESS_OBSERVATION_MS + 500)).resolves.toEqual({
      state: "unknown",
      binding: null,
    });
  });

  it("refuses an answer when the clock ran backwards or is not finite", async () => {
    for (const next of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const gate = deferred<unknown>();
      const world = rig(fakeSurface({ answer: () => gate.promise }));
      const pending = world.observer.observeSignInStatus();
      world.clock.t = next === -1 ? world.clock.t - 1 : next;
      gate.resolve(AUTHENTICATED);
      await expect(pending).resolves.toEqual({
        state: "unknown",
        binding: null,
      });
    }
  });

  it("refuses an answer when the document or route changed while the probe ran", async () => {
    const mutations: [string, (world: ReturnType<typeof rig>) => void][] = [
      ["generation", (world) => (world.state.documentGeneration = 2)],
      [
        "url",
        (world) => {
          if (world.state.fake) world.state.fake.contents.url = CHAT_OTHER;
        },
      ],
      ["replaced", (world) => world.swapWindow(fakeSurface())],
      ["destroyed", (world) => world.state.fake?.destroy()],
      ["blocked", (world) => (world.state.blocked = true)],
      ["disposing", (world) => (world.state.disposing = true)],
      ["pending commit", (world) => (world.state.awaitingCommit = true)],
      ["load slot", (world) => (world.state.loaded = false)],
      ["newer read", (world) => world.observer.invalidate()],
    ];
    for (const [, mutate] of mutations) {
      const gate = deferred<unknown>();
      const world = rig(fakeSurface({ answer: () => gate.promise }));
      const pending = world.observer.observeSignInStatus();
      mutate(world);
      gate.resolve(AUTHENTICATED);
      await expect(pending).resolves.toEqual({
        state: "unknown",
        binding: null,
      });
      expect(world.diagnostics).toHaveLength(1);
      expect(world.diagnostics[0]?.reason).toMatch(/unconfirmed|exception/);
    }
  });

  it("turns a native exception into unknown", async () => {
    const world = rig();
    if (world.state.fake)
      world.state.fake.surface.isDestroyed = () => {
        throw new Error("native");
      };
    await expect(world.observer.observeSignInStatus()).resolves.toEqual({
      state: "unknown",
      binding: null,
    });
    expect(world.diagnostics).toEqual([
      { reason: "exception", pageState: null },
    ]);
  });

  it("is not affected by a diagnostic callback that throws", async () => {
    const observer = createReadinessObserver({
      route: {
        surface: () => null,
        documentGeneration: () => 1,
        loaded: () => true,
        awaitingCommit: () => false,
        disposing: () => false,
        blocked: () => false,
      },
      e2eOrigin: () => null,
      clock: { now: () => 0, after: () => () => undefined },
      diagnose: () => {
        throw new Error("sink");
      },
    });
    await expect(observer.observeSignInStatus()).resolves.toEqual({
      state: "unknown",
      binding: null,
    });
  });

  it("forgets the previous result as soon as a new status read begins", async () => {
    const world = rig();
    const first = await world.observer.observeSignInStatus();
    expect(world.observer.isCurrentSignInStatus(first)).toBe(true);
    const gate = deferred<unknown>();
    if (world.state.fake)
      world.state.fake.frame.run.mockReturnValue(gate.promise);
    const second = world.observer.observeSignInStatus();
    expect(world.observer.isCurrentSignInStatus(first)).toBe(false);
    gate.resolve(AUTHENTICATED);
    await second;
  });
});

describe("isCurrentSignInStatus", () => {
  async function confirmed() {
    const world = rig();
    const result = await world.observer.observeSignInStatus();
    return { world, result };
  }

  it("refuses a result the observer did not retain", async () => {
    const { world } = await confirmed();
    expect(
      world.observer.isCurrentSignInStatus({
        state: "authenticated",
        binding: { sequence: 1, documentGeneration: 1 },
      }),
    ).toBe(false);
  });

  it("holds just inside the budget and drops the result at it", async () => {
    const inside = await confirmed();
    inside.world.clock.t += READINESS_OBSERVATION_MS - 1;
    expect(inside.world.observer.isCurrentSignInStatus(inside.result)).toBe(
      true,
    );
    const boundary = await confirmed();
    boundary.world.clock.t += READINESS_OBSERVATION_MS;
    expect(boundary.world.observer.isCurrentSignInStatus(boundary.result)).toBe(
      false,
    );
    // Dropped for good: rewinding the clock does not revive it.
    boundary.world.clock.t -= READINESS_OBSERVATION_MS;
    expect(boundary.world.observer.isCurrentSignInStatus(boundary.result)).toBe(
      false,
    );
  });

  it("drops the result when the clock is not usable", async () => {
    const backwards = await confirmed();
    backwards.world.clock.t -= 1;
    expect(
      backwards.world.observer.isCurrentSignInStatus(backwards.result),
    ).toBe(false);
    const invalid = await confirmed();
    invalid.world.clock.t = Number.NaN;
    expect(invalid.world.observer.isCurrentSignInStatus(invalid.result)).toBe(
      false,
    );
  });

  it("drops the result when the document, window or route changed", async () => {
    const mutations: [string, (world: ReturnType<typeof rig>) => void][] = [
      ["generation", (world) => (world.state.documentGeneration = 2)],
      ["blocked", (world) => (world.state.blocked = true)],
      ["replaced", (world) => world.swapWindow(fakeSurface())],
      ["newer read", (world) => world.observer.invalidate()],
      ["destroyed", (world) => world.state.fake?.destroy()],
    ];
    for (const [, mutate] of mutations) {
      const { world, result } = await confirmed();
      mutate(world);
      expect(world.observer.isCurrentSignInStatus(result)).toBe(false);
      // Even once the world is restored the result stays dropped.
      world.state.blocked = false;
      world.state.documentGeneration = 1;
      expect(world.observer.isCurrentSignInStatus(result)).toBe(false);
    }
  });

  it("treats a native throw while rechecking as not current", async () => {
    const { world, result } = await confirmed();
    if (world.state.fake) world.state.fake.contents.gone = true;
    expect(world.observer.isCurrentSignInStatus(result)).toBe(false);
  });
});

function scriptRig(
  options: {
    url?: string;
    withFrame?: boolean;
    answer?: () => Promise<unknown>;
  } = {},
) {
  const fake = fakeSurface(options);
  const state = {
    fake: fake as Fake | null,
    disposing: false,
    observationGeneration: 7,
    physicalGeneration: 3,
    loadFailed: false,
    awaitingCommit: false,
  };
  const clock = {
    t: 10_000,
    timers: [] as { callback: () => void; ms: number; cancelled: boolean }[],
  };
  const run = createTaskScriptRunner({
    route: {
      surface: () => state.fake?.surface ?? null,
      disposing: () => state.disposing,
      observationGeneration: () => state.observationGeneration,
      physicalDocumentGeneration: () => state.physicalGeneration,
      documentLoadFailed: () => state.loadFailed,
      documentAwaitingCommit: () => state.awaitingCommit,
    },
    clock: {
      now: () => clock.t,
      after: (callback, ms) => {
        const timer = { callback, ms, cancelled: false };
        clock.timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  });
  const call = (
    deadline = clock.t + 5_000,
    allow?: boolean | "response",
    contents = fake.contents,
    gate?: TaskScriptDispatchGate,
  ) => run(contents, "script()", true, deadline, 7, allow, gate);
  return { fake, state, clock, call };
}

describe("task script runner", () => {
  it("runs the script on the captured frame with the gesture and returns the value", async () => {
    const world = scriptRig({ answer: async () => ({ ok: 1 }) });
    await expect(world.call()).resolves.toEqual({ ok: 1 });
    expect(world.fake.frame.run).toHaveBeenCalledWith("script()", true);
    expect(world.clock.timers).toHaveLength(1);
    expect(world.clock.timers[0]).toMatchObject({ ms: 5_000, cancelled: true });
  });

  it("falls back to the contents when there is no main frame", async () => {
    const world = scriptRig({ withFrame: false, answer: async () => "v" });
    await expect(world.call()).resolves.toBe("v");
    expect(world.fake.contents.direct).toHaveBeenCalledWith("script()", true);
  });

  it("refuses before running when the document is unavailable", async () => {
    const mutations: [string, (world: ReturnType<typeof scriptRig>) => void][] =
      [
        ["no window", (world) => (world.state.fake = null)],
        ["destroyed", (world) => world.fake.destroy()],
        ["disposing", (world) => (world.state.disposing = true)],
        ["retired task", (world) => (world.state.observationGeneration = 8)],
        ["load failed", (world) => (world.state.loadFailed = true)],
        ["pending commit", (world) => (world.state.awaitingCommit = true)],
        ["frame destroyed", (world) => (world.fake.frame.dead = true)],
        ["frame url", (world) => (world.fake.frame.url = CHAT_OTHER)],
        ["past deadline", (world) => (world.clock.t += 5_000)],
      ];
    for (const [, mutate] of mutations) {
      const world = scriptRig();
      const deadline = world.clock.t + 5_000;
      mutate(world);
      // A destroyed native object throws on access: either way it is refused.
      await expect(world.call(deadline)).rejects.toThrow();
      expect(world.fake.frame.run).not.toHaveBeenCalled();
      expect(world.fake.contents.direct).not.toHaveBeenCalled();
    }
  });

  it("classifies every refusal before the executor as not dispatched", async () => {
    const cases: [
      string,
      "document" | "deadline",
      (world: ReturnType<typeof scriptRig>) => void,
    ][] = [
      ["no window", "document", (world) => (world.state.fake = null)],
      ["destroyed", "document", (world) => world.fake.destroy()],
      ["disposing", "document", (world) => (world.state.disposing = true)],
      [
        "retired task",
        "document",
        (world) => (world.state.observationGeneration = 8),
      ],
      ["load failed", "document", (world) => (world.state.loadFailed = true)],
      [
        "pending commit",
        "document",
        (world) => (world.state.awaitingCommit = true),
      ],
      [
        "frame destroyed",
        "document",
        (world) => (world.fake.frame.dead = true),
      ],
      ["frame url", "document", (world) => (world.fake.frame.url = CHAT_OTHER)],
      ["past deadline", "deadline", (world) => (world.clock.t += 5_000)],
    ];
    for (const [name, reason, mutate] of cases) {
      const world = scriptRig();
      const deadline = world.clock.t + 5_000;
      mutate(world);
      const error = await world.call(deadline).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, name).toBeInstanceOf(TaskScriptNotDispatchedError);
      expect(taskScriptRefusalReason(error), name).toBe(reason);
      expect(world.fake.frame.run).not.toHaveBeenCalled();
      expect(world.fake.contents.direct).not.toHaveBeenCalled();
    }
  });

  it("leaves every rejection after the executor was called unclassified", async () => {
    const gate = deferred<unknown>();
    const timedOut = scriptRig({ answer: () => gate.promise });
    const deadline = timedOut.clock.t + 1_000;
    const pending = timedOut.call(deadline);
    timedOut.clock.t = deadline;
    timedOut.clock.timers[0]?.callback();
    const timeout = await pending.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(timedOut.fake.frame.run).toHaveBeenCalledOnce();
    expect(timeout).toBeInstanceOf(Error);
    expect(taskScriptRefusalReason(timeout)).toBeNull();

    const moved = scriptRig({
      answer: async () => {
        moved.fake.contents.url = CHAT_OTHER;
        moved.fake.frame.url = CHAT_OTHER;
        return "v";
      },
    });
    const navigated = await moved.call().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(moved.fake.frame.run).toHaveBeenCalledOnce();
    expect(navigated).toMatchObject({
      message: "ChatGPT task document unavailable",
    });
    expect(taskScriptRefusalReason(navigated)).toBeNull();

    const thrown = scriptRig({
      answer: async () => {
        throw new Error("bridge lost");
      },
    });
    const bridge = await thrown.call().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(taskScriptRefusalReason(bridge)).toBeNull();
    expect(taskScriptRefusalReason("not an error")).toBeNull();
  });

  it("records the hand-off on the gate in the step that calls the executor", async () => {
    const world = scriptRig({ answer: async () => "v" });
    const gate = { revoked: false, dispatched: false };
    await expect(
      world.call(undefined, undefined, undefined, gate),
    ).resolves.toBe("v");
    expect(gate).toEqual({ revoked: false, dispatched: true });
    expect(world.fake.frame.run).toHaveBeenCalledOnce();
  });

  it("never calls an executor for a revoked gate", async () => {
    for (const withFrame of [true, false]) {
      const world = scriptRig({ withFrame });
      const gate = { revoked: true, dispatched: false };
      const error = await world
        .call(undefined, undefined, undefined, gate)
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      expect(taskScriptRefusalReason(error)).toBe("deadline");
      expect(gate.dispatched).toBe(false);
      expect(world.fake.frame.run).not.toHaveBeenCalled();
      expect(world.fake.contents.direct).not.toHaveBeenCalled();
    }
  });

  it("honours a revocation that lands while the runner is still reading the page", async () => {
    // The timeout fires between the runner's first read and its hand-off.
    const world = scriptRig();
    const gate = { revoked: false, dispatched: false };
    Object.defineProperty(world.fake.contents, "frame", {
      get: () => {
        gate.revoked = true;
        return world.fake.frame;
      },
    });
    const error = await world.call(undefined, undefined, undefined, gate).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(taskScriptRefusalReason(error)).toBe("deadline");
    expect(gate.dispatched).toBe(false);
    expect(world.fake.frame.run).not.toHaveBeenCalled();
    expect(world.fake.contents.direct).not.toHaveBeenCalled();
  });

  it("never calls an executor once the gate's own deadline has passed", async () => {
    // The caller's deadline is earlier than the task deadline the runner holds.
    const world = scriptRig();
    const deadline = world.clock.t + 30_000;
    const gate = {
      revoked: false,
      dispatched: false,
      notAfter: world.clock.t + 5_000,
    };
    world.clock.t += 6_000;
    const error = await world.call(deadline, undefined, undefined, gate).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(taskScriptRefusalReason(error)).toBe("deadline");
    expect(gate.dispatched).toBe(false);
    expect(world.fake.frame.run).not.toHaveBeenCalled();
    expect(world.fake.contents.direct).not.toHaveBeenCalled();

    // One tick inside it, the script is handed over.
    const inside = scriptRig({ answer: async () => "v" });
    const open = {
      revoked: false,
      dispatched: false,
      notAfter: inside.clock.t + 5_000,
    };
    inside.clock.t += 4_999;
    await expect(
      inside.call(inside.clock.t + 30_000, undefined, undefined, open),
    ).resolves.toBe("v");
    expect(open.dispatched).toBe(true);
  });

  it("leaves the gate undispatched when the document guard refuses", async () => {
    const world = scriptRig();
    world.state.disposing = true;
    const gate = { revoked: false, dispatched: false };
    await expect(
      world.call(undefined, undefined, undefined, gate),
    ).rejects.toBeInstanceOf(TaskScriptNotDispatchedError);
    expect(gate.dispatched).toBe(false);
  });

  it("refuses contents other than the window's own", async () => {
    const world = scriptRig();
    const other = fakeSurface().contents;
    await expect(world.call(undefined, false, other)).rejects.toThrow(
      "ChatGPT task document unavailable",
    );
  });

  it("rejects when the deadline timer fires first", async () => {
    const gate = deferred<unknown>();
    const world = scriptRig({ answer: () => gate.promise });
    const deadline = world.clock.t + 1_234;
    const pending = world.call(deadline);
    expect(world.clock.timers[0]?.ms).toBe(1_234);
    // A timer concludes the deadline only once the clock has reached it.
    world.clock.t = deadline;
    world.clock.timers[0]?.callback();
    await expect(pending).rejects.toThrow("ChatGPT task deadline exceeded");
    expect(world.clock.timers[0]?.cancelled).toBe(true);
  });

  it("rejects an answer that arrived at or after the deadline", async () => {
    const gate = deferred<unknown>();
    const world = scriptRig({ answer: () => gate.promise });
    const deadline = world.clock.t + 5_000;
    const pending = world.call(deadline);
    world.clock.t = deadline;
    gate.resolve("late");
    await expect(pending).rejects.toThrow("ChatGPT task deadline exceeded");

    const inside = deferred<unknown>();
    const early = scriptRig({ answer: () => inside.promise });
    const waiting = early.call(early.clock.t + 5_000);
    early.clock.t += 4_999;
    inside.resolve("ok");
    await expect(waiting).resolves.toBe("ok");
  });

  it("refuses an answer when the document changed unless navigation is allowed", async () => {
    const navigate = (world: ReturnType<typeof scriptRig>) => {
      world.fake.contents.url = CHAT_OTHER;
      world.fake.frame.url = CHAT_OTHER;
    };
    const run = async (allow?: boolean | "response") => {
      const gate = deferred<unknown>();
      const world = scriptRig({ answer: () => gate.promise });
      const pending = world.call(undefined, allow);
      navigate(world);
      gate.resolve("v");
      return pending;
    };
    await expect(run()).rejects.toThrow("ChatGPT task document unavailable");
    await expect(run(false)).rejects.toThrow(
      "ChatGPT task document unavailable",
    );
    await expect(run(true)).resolves.toBe("v");
    await expect(run("response")).resolves.toBe("v");
  });

  it("keeps response polling from adopting a replaced or retired document", async () => {
    const mutations: [string, (world: ReturnType<typeof scriptRig>) => void][] =
      [
        [
          "physical generation",
          (world) => (world.state.physicalGeneration = 4),
        ],
        ["retired task", (world) => (world.state.observationGeneration = 8)],
        ["load failed", (world) => (world.state.loadFailed = true)],
        ["pending commit", (world) => (world.state.awaitingCommit = true)],
        ["destroyed", (world) => world.fake.destroy()],
        [
          "frame replaced",
          (world) =>
            (world.fake.contents.frame = {
              isDestroyed: () => false,
              url: CHAT,
              executeJavaScript: async () => "x",
            }),
        ],
      ];
    for (const [, mutate] of mutations) {
      const gate = deferred<unknown>();
      const world = scriptRig({ answer: () => gate.promise });
      const pending = world.call(undefined, "response");
      mutate(world);
      gate.resolve("v");
      await expect(pending).rejects.toThrow();
    }
  });

  it("skips the post-answer document check when the caller allows navigation, even if the window was destroyed meanwhile", async () => {
    const gate = deferred<unknown>();
    const world = scriptRig({ answer: () => gate.promise });
    const pending = world.call(undefined, true);
    world.fake.destroy();
    gate.resolve("v");
    // allowNavigationAfter=true skips the post-check, as before.
    await expect(pending).resolves.toBe("v");
  });

  it("cancels its timer when the script throws", async () => {
    const world = scriptRig({
      answer: async () => {
        throw new Error("script failed");
      },
    });
    await expect(world.call()).rejects.toThrow("script failed");
    expect(world.clock.timers[0]?.cancelled).toBe(true);
  });
});
