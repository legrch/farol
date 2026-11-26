import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductConfigurationCommand } from "../../../src/pkg/product-settings/contract";
import type {
  Destination,
  Intent,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";
import { settings, signInReply } from "../../../tests/renderer/fixture";
import { initial } from "./snapshot";
import { createSignIn } from "./signin";

type Observe = Extract<
  ProductConfigurationCommand,
  { kind: "chatgpt.observe-sign-in" }
>;

const buildId = "a".repeat(64);
const signInStep: Destination = {
  area: "setup",
  page: "general",
  taskId: "",
  setupStep: "signin",
};
const browser: Destination = { area: "chatgpt", page: "general", taskId: "" };
const verification = {
  profile: "profile",
  configRevision: 1,
  workspaceId: null,
  runtimeGeneration: "generation",
  buildId,
  protocol: "protocol",
  verifiedAt: "2026-01-01T00:00:00.000Z",
};
const applied = (id: string): Intent => ({ id, state: "applied", code: null });

function configuration(
  options: { verified?: boolean; dismissed?: boolean } = {},
) {
  const value = settings();
  if (options.verified) value.setup.chatgpt.verified = verification;
  if (options.dismissed) value.setup.journey.dismissed = true;
  return { status: "ready" as const, settings: value };
}

function baseState(overrides: Partial<WindowSnapshot> = {}): WindowSnapshot {
  return {
    ...initial,
    status: "current",
    runtime: "ready",
    route: "loaded",
    buildId,
    configuration: configuration(),
    destination: signInStep,
    update: { phase: "idle", checkedAt: null },
    ...overrides,
  };
}

function harness(start: WindowSnapshot = baseState()) {
  const world = {
    state: start,
    clock: 1_000,
    navigation: 0,
    disposed: false,
    booting: false,
    patches: [] as Partial<WindowSnapshot>[],
    configured: [] as { command: ProductConfigurationCommand; key: string }[],
    returned: 0,
    completed: 0,
    requests: [] as Observe[],
    replies: [] as ((value: unknown) => void)[],
    holds: [] as ((error: unknown) => void)[],
    answer: null as null | ((request: Observe) => unknown),
  };
  const sign = createSignIn({
    api: {
      configure: vi.fn((command: ProductConfigurationCommand) => {
        world.requests.push(command as Observe);
        if (world.answer)
          return Promise.resolve(world.answer(command as Observe));
        return new Promise<unknown>((resolve, reject) => {
          world.replies.push(resolve);
          world.holds.push(reject);
        });
      }) as never,
    },
    snapshot: () => world.state,
    patch: (value) => {
      world.patches.push(value);
      sign.supersedeReturnAttempt(value);
      world.state = { ...world.state, ...value };
    },
    configure: async (command, key) => {
      world.configured.push({ command, key });
      return applied(key);
    },
    timers: {
      set: (run, ms) => setTimeout(run, ms),
      clear: (handle) => clearTimeout(handle),
      now: () => world.clock,
    },
    navigationRevision: () => world.navigation,
    lifecycle: {
      disposed: () => world.disposed,
      booting: () => world.booting,
    },
    effects: {
      returnToSetup: () => {
        world.returned++;
      },
      completeSetup: () => {
        world.completed++;
      },
    },
  });
  const elapse = (ms: number) => {
    world.clock += ms;
    vi.advanceTimersByTime(ms);
  };
  const reply = (
    index: number,
    state: "authenticated" | "signed_out" | "unknown",
  ) => world.replies[index]?.(signInReply(world.requests[index]!, state));
  const lastObservation = () => world.state.signInObservation;
  return { world, sign, elapse, reply, lastObservation };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("observation settle window", () => {
  it("publishes the pending latch before one bridge request", () => {
    const { world, sign, lastObservation } = harness();
    sign.observe();
    expect(world.requests).toHaveLength(1);
    expect(world.requests[0]).toMatchObject({
      kind: "chatgpt.observe-sign-in",
      buildId,
    });
    expect(lastObservation()).toMatchObject({
      pending: true,
      state: "unknown",
      binding: null,
    });
    sign.observe();
    expect(world.requests).toHaveLength(1);
  });

  it("expires after exactly 2.5 s and drops the late reply", async () => {
    const { world, sign, elapse, reply, lastObservation } = harness();
    sign.observe();
    elapse(2_499);
    expect(lastObservation()?.pending).toBe(true);
    elapse(1);
    expect(lastObservation()).toMatchObject({
      pending: false,
      state: "unknown",
      binding: null,
    });
    const patches = world.patches.length;
    reply(0, "authenticated");
    await flush();
    expect(world.patches).toHaveLength(patches);
    expect(lastObservation()?.state).toBe("unknown");
    expect(world.configured).toHaveLength(0);
  });

  it("settles an exact in-time reply and clears the settle timer", async () => {
    const { world, sign, elapse, reply, lastObservation } = harness();
    sign.startAttempt();
    sign.observe();
    elapse(400);
    reply(0, "authenticated");
    await flush();
    expect(lastObservation()).toMatchObject({
      pending: false,
      state: "authenticated",
      binding: { documentGeneration: 0, sequence: 1 },
    });
    expect(world.completed).toBe(1);
    expect(world.configured.map((item) => item.key)).toEqual([
      "settings:chatgpt.verify:",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never upgrades from unknown on a reply at the deadline", async () => {
    const { sign, world, reply, lastObservation } = harness();
    sign.observe();
    world.clock += 2_500;
    reply(0, "authenticated");
    await flush();
    expect(lastObservation()).toMatchObject({
      pending: false,
      state: "unknown",
      binding: null,
    });
  });

  it("keeps unknown for a reply that names another observation or build", async () => {
    for (const mutate of [
      (value: Record<string, unknown>) => ({
        ...value,
        // A well-formed UUID that names a different observation, so the reply
        // passes the schema and only the correlation check can refuse it.
        observationId: "00000000-0000-4000-8000-000000000000",
      }),
      (value: Record<string, unknown>) => ({
        ...value,
        buildId: "b".repeat(64),
      }),
    ]) {
      const { world, sign, lastObservation } = harness();
      world.answer = (request) => ({
        ok: true,
        snapshot: { status: "ready", settings: settings() },
        evidence: mutate(
          signInReply(request, "authenticated").evidence as Record<
            string,
            unknown
          >,
        ),
      });
      sign.observe();
      await flush();
      expect(lastObservation()).toMatchObject({
        pending: false,
        state: "unknown",
        binding: null,
      });
    }
  });

  it("settles unknown when the bridge rejects", async () => {
    const { world, sign, lastObservation } = harness();
    sign.observe();
    world.holds[0]?.(new Error("lost"));
    await flush();
    expect(lastObservation()).toMatchObject({
      pending: false,
      state: "unknown",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start while booting, unready, applying or pending", () => {
    for (const make of [
      () => {
        const h = harness();
        h.world.booting = true;
        return h;
      },
      () => harness(baseState({ runtime: "starting" })),
      () => harness(baseState({ status: "stale" })),
      () => harness(baseState({ update: { phase: "applying" } as never })),
      () => harness(baseState({ buildId: null })),
      () => harness(baseState({ destination: browser })),
    ]) {
      const h = make();
      h.sign.observe();
      expect(h.world.requests).toHaveLength(0);
    }
  });

  it("drops a stale result after a newer revision", async () => {
    const { world, sign, reply, lastObservation } = harness();
    sign.observe();
    sign.invalidate();
    expect(lastObservation()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    sign.observe();
    const second = world.requests[1]!;
    expect(second.observationId).not.toBe(world.requests[0]!.observationId);
    reply(0, "authenticated");
    await flush();
    expect(lastObservation()).toMatchObject({
      observationId: second.observationId,
      pending: true,
    });
    reply(1, "signed_out");
    await flush();
    expect(lastObservation()).toMatchObject({
      observationId: second.observationId,
      pending: false,
      state: "signed_out",
    });
  });

  it("drops a reply once the window is no longer observing", async () => {
    const { world, sign, reply, lastObservation } = harness();
    sign.observe();
    world.state = { ...world.state, runtime: "offline" } as WindowSnapshot;
    reply(0, "authenticated");
    await flush();
    expect(lastObservation()?.pending).toBe(true);
  });
});

describe("disposal", () => {
  it("leaves no timer and fences the late reply", async () => {
    const { world, sign, reply, lastObservation } = harness(
      baseState({ configuration: configuration({ verified: true }) }),
    );
    sign.observe();
    expect(vi.getTimerCount()).toBe(1);
    sign.dispose();
    world.disposed = true;
    expect(vi.getTimerCount()).toBe(0);
    reply(0, "authenticated");
    await flush();
    expect(lastObservation()?.pending).toBe(true);
    expect(world.configured).toHaveLength(0);
    expect(world.completed).toBe(0);
  });

  it("clears an armed read timer", () => {
    const { world, sign } = harness(
      baseState({ configuration: configuration({ verified: true }) }),
    );
    sign.scheduleReads();
    expect(vi.getTimerCount()).toBe(1);
    sign.dispose();
    world.disposed = true;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(world.requests).toHaveLength(0);
  });

  it("does not arm after disposal", () => {
    const { world, sign } = harness(
      baseState({ configuration: configuration({ verified: true }) }),
    );
    world.disposed = true;
    sign.scheduleReads();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("saved sign-in read window", () => {
  const saved = () =>
    harness(baseState({ configuration: configuration({ verified: true }) }));

  it("spaces six bounded reads by the documented delays", async () => {
    const { world, sign, elapse, reply } = saved();
    const delays = [500, 1_500, 3_000, 5_000, 8_000, 10_000];
    sign.scheduleReads();
    for (const [index, delay] of delays.entries()) {
      elapse(delay - 1);
      expect(world.requests).toHaveLength(index);
      elapse(1);
      expect(world.requests).toHaveLength(index + 1);
      reply(index, "unknown");
      await flush();
    }
    expect(world.requests).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(0);
    sign.scheduleReads();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms one timer at a time", () => {
    const { sign } = saved();
    sign.scheduleReads();
    sign.scheduleReads();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("an ineligible window at expiry consumes no attempt", () => {
    const { world, sign, elapse } = saved();
    sign.scheduleReads();
    world.state = { ...world.state, runtime: "offline" } as WindowSnapshot;
    elapse(500);
    expect(world.requests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    world.state = { ...world.state, runtime: "ready" } as WindowSnapshot;
    sign.scheduleReads();
    elapse(499);
    expect(world.requests).toHaveLength(0);
    elapse(1);
    expect(world.requests).toHaveLength(1);
  });

  it("reset clears the timer and restarts the delays", async () => {
    const { world, sign, elapse, reply } = saved();
    sign.scheduleReads();
    elapse(500);
    reply(0, "unknown");
    await flush();
    sign.resetReads();
    expect(vi.getTimerCount()).toBe(0);
    sign.scheduleReads();
    elapse(499);
    expect(world.requests).toHaveLength(1);
    elapse(1);
    expect(world.requests).toHaveLength(2);
  });

  it("stops once authenticated and when setup is finished", () => {
    const authenticated = saved();
    authenticated.world.state = {
      ...authenticated.world.state,
      signInObservation: {
        observationId: "x",
        buildId,
        counter: 1,
        pending: false,
        state: "authenticated",
        binding: { documentGeneration: 0, sequence: 1 },
      },
    };
    authenticated.sign.scheduleReads();
    expect(vi.getTimerCount()).toBe(0);
    const finished = harness(
      baseState({
        configuration: configuration({ verified: true, dismissed: true }),
      }),
    );
    finished.sign.scheduleReads();
    expect(vi.getTimerCount()).toBe(0);
    expect(finished.sign.observationEntry()).toBe(false);
  });

  it("waits for a loaded document", () => {
    const { world, sign } = saved();
    world.state = { ...world.state, route: "loading" } as WindowSnapshot;
    sign.scheduleReads();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("automatic verification", () => {
  const authenticated = (generation: number) => ({
    observationId: "x",
    buildId,
    counter: 1,
    pending: false,
    state: "authenticated" as const,
    binding: { documentGeneration: generation, sequence: 1 },
  });

  it("requests one verification per authenticated document", () => {
    const { world, sign } = harness();
    sign.startAttempt();
    world.state = { ...world.state, signInObservation: authenticated(3) };
    sign.confirm();
    sign.confirm();
    expect(world.configured).toHaveLength(1);
    world.state = { ...world.state, signInObservation: authenticated(4) };
    sign.confirm();
    expect(world.configured).toHaveLength(2);
    world.state = { ...world.state, signInObservation: authenticated(3) };
    sign.confirm();
    expect(world.configured).toHaveLength(2);
  });

  it("needs a started attempt or a saved verification", () => {
    const { world, sign } = harness();
    world.state = { ...world.state, signInObservation: authenticated(1) };
    sign.confirm();
    expect(world.configured).toHaveLength(0);
    const saved = harness(
      baseState({ configuration: configuration({ verified: true }) }),
    );
    saved.world.state = {
      ...saved.world.state,
      signInObservation: authenticated(1),
    };
    saved.sign.confirm();
    expect(saved.world.configured).toHaveLength(1);
  });

  it("is skipped when this document already has a matching check", () => {
    const { world, sign } = harness();
    sign.startAttempt();
    world.state = {
      ...world.state,
      signInObservation: authenticated(1),
      setupSignInCheck: {
        buildId,
        binding: { documentGeneration: 1, sequence: 1 },
      },
    };
    sign.confirm();
    expect(world.configured).toHaveLength(0);
  });

  it("a new attempt forgets an applied verification of the prior document", () => {
    const { world, sign } = harness();
    sign.startAttempt();
    world.state = { ...world.state, signInObservation: authenticated(2) };
    sign.confirm();
    expect(world.configured).toHaveLength(1);
    world.state = {
      ...world.state,
      setupSignInCheck: {
        buildId,
        binding: { documentGeneration: 2, sequence: 1 },
      },
      intents: {
        "settings:chatgpt.verify:": applied("settings:chatgpt.verify:"),
      },
    };
    sign.startAttempt();
    expect(world.patches.at(-2)).toEqual({ setupSignInCheck: null });
    expect(world.patches.at(-1)).toEqual({ signInObservation: null });
    world.state = { ...world.state, signInObservation: authenticated(2) };
    sign.confirm();
    expect(world.configured).toHaveLength(2);
  });
});

describe("setup return attempts", () => {
  const verifyKey = "settings:chatgpt.verify:";
  const open = "settings:chatgpt.open-sign-in:";
  const observed = {
    observationId: "x",
    buildId,
    counter: 1,
    pending: false,
    state: "authenticated" as const,
    binding: { documentGeneration: 5, sequence: 4 },
  };
  function returning() {
    const h = harness(
      baseState({
        destination: browser,
        setupSignInReturn: signInStep,
        intents: { [open]: applied(open), [verifyKey]: applied(verifyKey) },
        signInObservation: observed,
        setupSignInCheck: {
          buildId,
          binding: { documentGeneration: 5, sequence: 3 },
        },
      }),
    );
    h.sign.recordReturnAttempt(signInStep, open);
    return h;
  }

  it("returns to setup once, after a confirmed sign-in", () => {
    const { world, sign } = returning();
    sign.returnAfterConfirmed();
    expect(world.returned).toBe(1);
    sign.returnAfterConfirmed();
    expect(world.returned).toBe(1);
  });

  it("waits for a verification that is not older than the observation", () => {
    const { world, sign } = returning();
    world.state = {
      ...world.state,
      setupSignInCheck: {
        buildId,
        binding: { documentGeneration: 5, sequence: 9 },
      },
    };
    sign.returnAfterConfirmed();
    expect(world.returned).toBe(0);
  });

  it("is dropped by a navigation, a new build or an applying update", () => {
    const navigated = returning();
    navigated.world.navigation++;
    navigated.sign.supersedeReturnAttempt({});
    navigated.world.navigation--;
    navigated.sign.returnAfterConfirmed();
    expect(navigated.world.returned).toBe(0);
    for (const value of [
      { buildId: "c".repeat(64) },
      { update: { phase: "applying" } as never },
    ]) {
      const { world, sign } = returning();
      sign.supersedeReturnAttempt(value);
      sign.returnAfterConfirmed();
      expect(world.returned).toBe(0);
    }
  });

  it("an unrelated patch keeps the attempt", () => {
    const { world, sign } = returning();
    sign.supersedeReturnAttempt({ appearance: world.state.appearance });
    sign.returnAfterConfirmed();
    expect(world.returned).toBe(1);
  });

  it("an explicit return consumes the continuation", () => {
    const { world, sign } = returning();
    sign.clearReturnAttempt();
    sign.returnAfterConfirmed();
    expect(world.returned).toBe(0);
  });

  it("recording an attempt restarts and arms the bounded read window", () => {
    const { world, sign, elapse } = returning();
    world.state = {
      ...world.state,
      signInObservation: null,
      intents: { [open]: applied(open) },
    };
    sign.startAttempt();
    sign.resetReads();
    sign.recordReturnAttempt(signInStep, open);
    expect(vi.getTimerCount()).toBe(1);
    elapse(500);
    expect(world.requests).toHaveLength(1);
  });

  it("an unsettled first-login keeps reading only while its attempt is current", () => {
    const { world, sign } = harness(
      baseState({
        destination: browser,
        setupSignInReturn: signInStep,
        intents: { [open]: applied(open) },
        signInObservation: { ...observed, state: "signed_out", binding: null },
      }),
    );
    sign.startAttempt();
    world.state = {
      ...world.state,
      signInObservation: { ...observed, state: "signed_out", binding: null },
    };
    sign.scheduleReads();
    expect(vi.getTimerCount()).toBe(0);
    sign.recordReturnAttempt(signInStep, open);
    expect(vi.getTimerCount()).toBe(1);
    sign.resetReads();
    world.state = {
      ...world.state,
      intents: { [open]: { id: open, state: "unknown", code: "X" } },
    };
    sign.scheduleReads();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("navigation and reconcile", () => {
  it("observes when entering sign-in without a sample", () => {
    const { world, sign } = harness(baseState({ destination: browser }));
    sign.reobserveAfterNavigation(false);
    expect(world.requests).toHaveLength(0);
    world.state = { ...world.state, destination: signInStep };
    sign.reobserveAfterNavigation(false);
    expect(world.requests).toHaveLength(1);
  });

  it("a settled sample stays across a revisit of sign-in", () => {
    const { world, sign } = harness(
      baseState({
        signInObservation: {
          observationId: "x",
          buildId,
          counter: 1,
          pending: false,
          state: "authenticated",
          binding: { documentGeneration: 0, sequence: 1 },
        },
      }),
    );
    sign.reobserveAfterNavigation(false);
    expect(world.requests).toHaveLength(0);
  });

  it("reconcile observes a loaded window without a sample and retriggers completion", () => {
    const { world, sign } = harness();
    sign.reconcile();
    expect(world.requests).toHaveLength(1);
    expect(world.completed).toBe(1);
  });

  it("the sign-in step and a saved verification are observation entries", () => {
    expect(harness().sign.observationEntry()).toBe(true);
    expect(harness().sign.onEntry()).toBe(true);
    const away = harness(baseState({ destination: browser }));
    expect(away.sign.observationEntry()).toBe(false);
    expect(away.sign.onEntry()).toBe(false);
    away.sign.startAttempt();
    expect(away.sign.observationEntry()).toBe(false);
    away.world.state = { ...away.world.state, setupSignInReturn: signInStep };
    expect(away.sign.observationEntry()).toBe(true);
  });
});
