import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalRuntimeLifetime } from "../../../src/apps/desktop/local-runtime-lifetime";
import {
  createPreviewRuntime,
  type PreviewRuntimePorts,
  type PreviewRuntimeReady,
  type PreviewRuntimeState,
  type PreviewRuntimeTask,
} from "./host";

// The preview runtime start and exit over scripted owners. Main's `let`s are
// fields the ports read afresh and write through the setters, the child is an
// event emitter, the lifetime is a fake with a closed promise the test settles,
// and every effect appends to one ordered log. No process, timer beyond the
// fake clock, window or installed profile runs.
const identity = "controlled-runtime";
const task: PreviewRuntimeTask = {
  ownerId: "owner",
  sessionId: "session",
  taskId: "task",
  turnId: "turn",
  generation: 1,
  label: "label",
  hasComputer: false,
};

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
}

type Counts = Readonly<{ running: number; waiting: number; failed: number }>;

function build(
  options: Readonly<{
    resources?: () => Promise<void>;
    expectedTasks?: readonly PreviewRuntimeTask[];
    argv?: readonly string[];
    env?: Record<string, string | undefined>;
    demoMode?: boolean;
    parse?: (value: unknown) => PreviewRuntimeReady | null;
  }> = {},
) {
  const events: string[] = [];
  const state = {
    closed: false,
    stopping: false,
    runtime: null as PreviewRuntimeReady | null,
    runtimeState: "starting" as PreviewRuntimeState,
    runtimeError: null as string | null,
    counts: null as Counts | null,
    streams: new Map<string, unknown>(),
    pending: new Map<string, unknown>(),
    failures: new Map<string, unknown>(),
  };
  const children: FakeChild[] = [];
  const lifetimes: {
    lifetime: LocalRuntimeLifetime;
    settle: () => void;
    fail: () => void;
  }[] = [];
  const owned = new Map<LocalRuntimeLifetime, string>();
  const spawn = vi.fn(
    (command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
      events.push(`spawn ${command} ${args.join(" ")}`);
      const child = new FakeChild();
      children.push(child);
      void spawnOptions;
      return child as unknown as ChildProcess;
    },
  );
  const timers: { handler: () => void; ms: number; cleared: boolean }[] = [];
  const ports: PreviewRuntimePorts<PreviewRuntimeReady> = {
    desktopAdmission: { closed: () => state.closed },
    ownedLocalRuntimes: owned,
    runtimeStopping: () => state.stopping,
    setRuntimeStopping: (value) => {
      events.push(`set stopping ${value}`);
      state.stopping = value;
    },
    setRuntime: (value) => {
      events.push(`set runtime ${value === null ? "null" : value.identity}`);
      state.runtime = value;
    },
    setRuntimeState: (value) => {
      events.push(`set state ${value}`);
      state.runtimeState = value;
    },
    setRuntimeError: (value) => {
      events.push(`set error ${value}`);
      state.runtimeError = value;
    },
    setTaskCountsBeforeRuntimeExit: (value) => {
      events.push(`set counts ${value ? JSON.stringify(value) : "null"}`);
      state.counts = value;
    },
    installedUpdates: {
      resources: () => ({
        executable: "/private/Electron",
        directory: "/private/app",
        recheck: async () => {
          events.push("recheck");
          await options.resources?.();
        },
      }),
    },
    activeDesktopIdentity: { runtimeIdentity: identity },
    demoMode: options.demoMode ?? false,
    expectedTasks: options.expectedTasks ?? [],
    readySchema: {
      safeParse: (value) => {
        const data = (options.parse ?? ((v) => v as PreviewRuntimeReady))(
          value,
        );
        return data === null ? { success: false } : { success: true, data };
      },
    },
    streamControllers: state.streams,
    pendingComputer: state.pending,
    taskSurfaceFailures: state.failures,
    stopStreams: () => events.push("stopStreams"),
    disposeTaskViews: (reason) => events.push(`disposeTaskViews ${reason}`),
    publishRuntimeStatus: () => events.push("publish"),
    observeLocalRuntime: (_child, scope) => {
      events.push(`observe ${scope}`);
      let settle!: () => void;
      let fail!: () => void;
      const closed = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = () => reject(new Error("unconfirmed"));
      });
      const lifetime: LocalRuntimeLifetime = {
        closed,
        requestStop: () => undefined,
        close: () => closed,
      };
      lifetimes.push({ lifetime, settle, fail });
      return lifetime;
    },
    spawn,
    setTimeout: (handler, ms) => {
      const timer = { handler, ms, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      (timer as unknown as { cleared: boolean }).cleared = true;
    },
    env: options.env ?? {},
    argv: options.argv ?? [],
  };
  const subject = createPreviewRuntime(ports);
  const ready = (child: FakeChild, tasks: readonly PreviewRuntimeTask[] = []) =>
    child.emit("message", { identity, tasks });
  return {
    subject,
    state,
    events,
    children,
    lifetimes,
    owned,
    spawn,
    timers,
    ready,
  };
}

// Start and let the child answer with the expected ready message.
async function started(...args: Parameters<typeof build>) {
  const fixture = build(...args);
  const start = fixture.subject.start();
  await vi.waitFor(() => expect(fixture.children).toHaveLength(1));
  fixture.ready(fixture.children[0]!, args[0]?.expectedTasks ?? []);
  await start;
  return fixture;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preview runtime start", () => {
  it("rechecks the private resources, then spawns the runtime and records the ready owner", async () => {
    const { events, state, spawn, owned } = await started();
    expect(events.slice(0, 4)).toEqual([
      "set stopping false",
      "recheck",
      "spawn /private/Electron /private/app/runtime.cjs",
      "observe in-memory-preview",
    ]);
    expect(spawn.mock.calls[0]![2]).toMatchObject({
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      windowsHide: true,
    });
    expect(state.runtime?.identity).toBe(identity);
    expect(state.runtimeState).toBe("ready");
    expect(state.counts).toBeNull();
    expect(state.stopping).toBe(false);
    expect([...owned.values()]).toEqual(["local-runtime-1"]);
  });

  it("scrubs the child environment to the named keys and chooses the scenario", async () => {
    const env = (argv: string[], e: Record<string, string>, demo = false) => {
      const fixture = build({ argv, env: e, demoMode: demo });
      void fixture.subject.start();
      return vi
        .waitFor(() => expect(fixture.spawn).toHaveBeenCalled())
        .then(
          () =>
            (fixture.spawn.mock.calls[0]![2] as { env: Record<string, string> })
              .env,
        );
    };
    expect(await env([], { LANG: "ru_RU.UTF-8", HOME: "/leak" })).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      LANG: "ru_RU.UTF-8",
      FAROL_RUNTIME_IDENTITY: identity,
      FAROL_PREVIEW_SCENARIO: "normal",
      FAROL_PREVIEW_MODE: "empty",
    });
    expect((await env([], {})).LANG).toBe("en_US.UTF-8");
    expect(
      (await env(["--preview-stream-failure"], {}, true)).FAROL_PREVIEW_MODE,
    ).toBe("demo");
    expect(
      (await env(["--preview-stream-failure"], {})).FAROL_PREVIEW_SCENARIO,
    ).toBe("stream-failure");
    expect((await env(["--preview-failure"], {})).FAROL_PREVIEW_SCENARIO).toBe(
      "failure",
    );
    // The start-failure scenario needs the E2E lane as well as the argument.
    expect(
      (await env(["--preview-runtime-start-failure"], {}))
        .FAROL_PREVIEW_SCENARIO,
    ).toBe("normal");
    expect(
      (
        await env(["--preview-runtime-start-failure"], {
          FAROL_E2E: "1",
        })
      ).FAROL_PREVIEW_SCENARIO,
    ).toBe("startup-failure");
  });

  it("refuses a second start while the first child is owned", async () => {
    const { subject, spawn } = await started();
    await expect(subject.start()).rejects.toThrow(
      "LOCAL_RUNTIME_ALREADY_OWNED",
    );
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does nothing once the desktop no longer admits work", async () => {
    const fixture = build();
    fixture.state.closed = true;
    await fixture.subject.start();
    expect(fixture.events).toEqual([]);
  });

  it.each([
    [
      "Quit begins",
      (s: ReturnType<typeof build>["state"]) => (s.stopping = true),
    ],
    [
      "admission closes",
      (s: ReturnType<typeof build>["state"]) => (s.closed = true),
    ],
  ])(
    "does not spawn when %s while the resource recheck waits",
    async (_name, change) => {
      let release!: () => void;
      const fixture = build({
        resources: () => new Promise<void>((resolve) => (release = resolve)),
      });
      const start = fixture.subject.start();
      await vi.waitFor(() => expect(fixture.events).toContain("recheck"));
      change(fixture.state);
      release();
      await start;
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(fixture.owned.size).toBe(0);
    },
  );

  it("propagates a failed resource recheck without spawning", async () => {
    const fixture = build({
      resources: () => Promise.reject(new Error("INTEGRITY_CHANGED")),
    });
    await expect(fixture.subject.start()).rejects.toThrow("INTEGRITY_CHANGED");
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a spawn error",
      (child: FakeChild) => child.emit("error", new Error("ENOENT")),
      "RUNTIME_PROCESS_NOT_STARTED",
    ],
    [
      "a clean exit before ready",
      (child: FakeChild) => child.emit("exit", 0),
      "RUNTIME_EXITED",
    ],
    [
      "a failing exit before ready",
      (child: FakeChild) => child.emit("exit", 3),
      "RUNTIME_START_FAILED_3",
    ],
    [
      "a different identity",
      (child: FakeChild) =>
        child.emit("message", { identity: "other", tasks: [] }),
      "RUNTIME_IDENTITY_MISMATCH",
    ],
    [
      "a task list that is not the expected one",
      (child: FakeChild) => child.emit("message", { identity, tasks: [task] }),
      "RUNTIME_TASK_MANIFEST_MISMATCH",
    ],
  ])(
    "fails the start on %s and kills the child once",
    async (_n, act, code) => {
      const fixture = build();
      const start = fixture.subject.start();
      await vi.waitFor(() => expect(fixture.children).toHaveLength(1));
      const child = fixture.children[0]!;
      act(child);
      await start;
      expect(fixture.state.runtimeState).toBe("failed");
      expect(fixture.state.runtimeError).toBe(code);
      expect(fixture.state.runtime).toBeNull();
      expect(fixture.state.stopping).toBe(true);
      expect(child.kill).toHaveBeenCalledTimes(1);
      // Failure cleared the child slot: with the lifetime closed a new start is
      // admitted, and it is not repeated by the failure itself.
      expect(fixture.spawn).toHaveBeenCalledTimes(1);
      fixture.lifetimes[0]!.settle();
      await vi.waitFor(() => expect(fixture.owned.size).toBe(0));
      void fixture.subject.start();
      await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledTimes(2));
    },
  );

  it("times out after ten seconds without a ready message", async () => {
    const fixture = build();
    const start = fixture.subject.start();
    await vi.waitFor(() => expect(fixture.timers).toHaveLength(1));
    expect(fixture.timers[0]!.ms).toBe(10_000);
    fixture.timers[0]!.handler();
    await start;
    expect(fixture.state.runtimeError).toBe("RUNTIME_START_TIMEOUT");
    expect(fixture.state.runtimeState).toBe("failed");
  });

  it("accepts a ready message whose tasks equal the expected manifest", async () => {
    const { state } = await started({ expectedTasks: [task] });
    expect(state.runtimeState).toBe("ready");
  });

  it("ignores a ready message the schema refuses and a message after it settled", async () => {
    const fixture = build({
      parse: (value) =>
        (value as { identity?: string }).identity === identity
          ? (value as PreviewRuntimeReady)
          : null,
    });
    const start = fixture.subject.start();
    await vi.waitFor(() => expect(fixture.children).toHaveLength(1));
    const child = fixture.children[0]!;
    child.emit("message", { nonsense: true });
    expect(fixture.state.runtimeState).toBe("starting");
    fixture.ready(child);
    await start;
    child.emit("message", { identity: "late", tasks: [] });
    expect(fixture.state.runtime?.identity).toBe(identity);
  });

  it("clears the start timer when the child answers", async () => {
    const fixture = await started();
    expect(fixture.timers.every((timer) => timer.cleared)).toBe(true);
  });
});

describe("preview runtime exit", () => {
  it("fails the runtime, keeps the live task counts and disposes the surfaces after a ready exit", async () => {
    const fixture = await started();
    fixture.state.streams.set("a", {});
    fixture.state.streams.set("b", {});
    fixture.state.pending.set("c", {});
    fixture.state.failures.set("d", {});
    fixture.state.failures.set("e", {});
    fixture.state.failures.set("f", {});
    fixture.events.length = 0;
    fixture.children[0]!.emit("exit", 0);
    expect(fixture.events).toEqual([
      'set counts {"running":2,"waiting":1,"failed":3}',
      "set runtime null",
      "set state failed",
      "set error RUNTIME_PROCESS_EXITED",
      "stopStreams",
      "disposeTaskViews runtime",
      "publish",
    ]);
    expect(fixture.state.failures.size).toBe(0);
    expect(fixture.state.pending.size).toBe(0);
    expect(fixture.state.counts).toEqual({
      running: 2,
      waiting: 1,
      failed: 3,
    });
    expect(fixture.state.runtimeState).toBe("failed");
  });

  it("reports a failing exit with its own code", async () => {
    const fixture = await started();
    fixture.children[0]!.emit("exit", 1);
    expect(fixture.state.runtimeError).toBe("RUNTIME_PROCESS_FAILED");
  });

  it("only forgets the runtime when Quit is stopping it", async () => {
    const fixture = await started();
    fixture.state.stopping = true;
    fixture.state.streams.set("a", {});
    fixture.events.length = 0;
    fixture.children[0]!.emit("exit", 0);
    expect(fixture.events).toEqual(["set runtime null"]);
    expect(fixture.state.runtimeState).toBe("ready");
    expect(fixture.state.runtimeError).toBeNull();
    expect(fixture.state.counts).toBeNull();
    expect(fixture.state.streams.size).toBe(1);
    // The child slot is free again once its lifetime closes.
    fixture.lifetimes[0]!.settle();
    await vi.waitFor(() => expect(fixture.owned.size).toBe(0));
    fixture.state.stopping = false;
    void fixture.subject.start();
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledTimes(2));
  });

  it("reads the stopping flag afresh at the exit, not when the start began", async () => {
    const fixture = await started();
    expect(fixture.state.stopping).toBe(false);
    fixture.state.stopping = true;
    fixture.children[0]!.emit("exit", 1);
    expect(fixture.state.runtimeState).toBe("ready");
  });

  it("counts a later exit again and clears the counts on the next ready start", async () => {
    const fixture = await started();
    fixture.children[0]!.emit("exit", 1);
    expect(fixture.state.counts).toEqual({ running: 0, waiting: 0, failed: 0 });
    fixture.lifetimes[0]!.settle();
    await vi.waitFor(() => expect(fixture.owned.size).toBe(0));
    const next = fixture.subject.start();
    await vi.waitFor(() => expect(fixture.children).toHaveLength(2));
    fixture.ready(fixture.children[1]!);
    await next;
    expect(fixture.state.counts).toBeNull();
    expect(fixture.state.runtimeState).toBe("ready");
  });
});

describe("preview runtime ownership and generation", () => {
  it("numbers each owned lifetime once and drops it when it closes", async () => {
    const fixture = await started();
    expect([...fixture.owned.values()]).toEqual(["local-runtime-1"]);
    fixture.children[0]!.emit("exit", 1);
    fixture.lifetimes[0]!.settle();
    await vi.waitFor(() => expect(fixture.owned.size).toBe(0));
    const next = fixture.subject.start();
    await vi.waitFor(() => expect(fixture.children).toHaveLength(2));
    fixture.ready(fixture.children[1]!);
    await next;
    expect([...fixture.owned.values()]).toEqual(["local-runtime-2"]);
  });

  it("keeps an unconfirmed shutdown owned and refuses a start over it", async () => {
    const fixture = await started();
    fixture.children[0]!.emit("exit", 1);
    fixture.lifetimes[0]!.fail();
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.owned.size).toBe(1);
    await expect(fixture.subject.start()).rejects.toThrow(
      "LOCAL_RUNTIME_ALREADY_OWNED",
    );
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps separate generations for separate instances", async () => {
    const first = await started();
    const second = await started();
    expect([...first.owned.values()]).toEqual(["local-runtime-1"]);
    expect([...second.owned.values()]).toEqual(["local-runtime-1"]);
  });
});
