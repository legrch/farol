import { describe, expect, it, vi } from "vitest";
import {
  createInstanceRequest,
  type InstanceAcknowledgement,
  type InstanceRequest,
  type LaunchIdentity,
} from "../../../src/apps/desktop/single-instance";
import { PrimaryStartup } from "../../../src/apps/desktop/primary-startup";
import {
  createInstance,
  secondInstanceAcknowledgementPrefix,
  secondInstanceResultPrefix,
  type InstancePorts,
} from "./instance";

// The single-instance host over scripted owners. Main's `let`s are fields the
// ports read afresh, the Electron app and stderr are recorders, the
// acknowledgement files are fakes, and every effect lands in one ordered log.
// The request codec, the decision, the readiness predicate and the refusal text
// are the real ones. No Electron, filesystem, window or installed profile runs.

const identity: LaunchIdentity = {
  environment: "preview",
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  inputLedgerSha256: "c".repeat(64),
};
const foreignIdentity: LaunchIdentity = {
  ...identity,
  sourceCommit: "e".repeat(40),
};

type Status = InstanceAcknowledgement["status"];
type Options = Readonly<{
  quitting?: boolean;
  applying?: boolean;
  stopping?: boolean;
  runtimeState?: "starting" | "ready" | "offline" | "failed";
  hasWindow?: boolean;
  destroyed?: boolean;
  runtimeViews?: number;
  otherViews?: number;
  expectedViews?: number;
  holdReady?: boolean;
  startupFails?: boolean;
  recovery?: boolean;
  recoveryFails?: boolean;
  openFails?: boolean;
  recoveryThrows?: boolean;
  writeFails?: unknown;
  waited?: InstanceAcknowledgement | null | "throws";
  foreign?: number | "throws";
  requestIdentity?: LaunchIdentity;
  backgroundOnly?: boolean;
}>;

function build(options: Options = {}) {
  const log: string[] = [];
  const written: string[] = [];
  const state = {
    quitting: options.quitting ?? false,
    applying: options.applying ?? false,
    stopping: options.stopping ?? false,
    runtimeState: options.runtimeState ?? "ready",
    hasWindow: options.hasWindow ?? true,
    destroyed: options.destroyed ?? false,
    runtimeViews: options.runtimeViews ?? 0,
    otherViews: options.otherViews ?? 0,
    expectedViews: options.expectedViews ?? 0,
    recovery: options.recovery ?? false,
  };
  const startup = new PrimaryStartup();
  let finishReady!: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    finishReady = () =>
      options.startupFails ? reject(new Error("STARTUP")) : resolve();
  });
  startup.begin(ready);
  if (!options.holdReady) finishReady();
  const whenReady = vi.spyOn(startup, "whenReady");

  const listeners: ((...args: never[]) => void)[] = [];
  const app = {
    getPath: vi.fn((name: "userData") => {
      log.push(`getPath:${name}`);
      return "/controlled-user-data";
    }),
    on: vi.fn(
      (
        event: "second-instance",
        listener: (
          event: unknown,
          commandLine: string[],
          workingDirectory: string,
          additionalData: unknown,
        ) => void,
      ) => {
        log.push(`on:${event}`);
        listeners.push(listener);
      },
    ),
    releaseSingleInstanceLock: vi.fn(() => {
      log.push("release-lock");
    }),
    quit: vi.fn(() => {
      log.push("quit");
    }),
    exit: vi.fn((code: number) => {
      log.push(`exit:${code}`);
    }),
  };
  const stderr = {
    write: vi.fn((text: string) => {
      written.push(text);
      log.push(`stderr:${text.trim()}`);
      return true;
    }),
  };
  const reopen = vi.fn(async () => {
    log.push("recovery-reopen");
    if (options.recoveryFails) throw new Error("RECOVERY");
  });
  const ensureWindow = vi.fn(async () => {
    log.push("ensure-window");
    if (options.openFails) throw new Error("OPEN");
    state.hasWindow = true;
  });
  const recoverWindowOpenFailure = vi.fn(() => {
    log.push("recover-window");
    if (options.recoveryThrows) throw new Error("RECOVER");
  });
  const write = vi.fn(
    async (
      _root: string,
      _candidate: unknown,
      status: Status,
      _identity?: LaunchIdentity,
    ): Promise<void> => {
      log.push(`ack:${status}`);
      if (options.writeFails !== undefined) throw options.writeFails;
    },
  );
  const wait: InstancePorts["waitForInstanceAcknowledgement"] = vi.fn(
    async () => {
      log.push("wait-ack");
      if (options.waited === "throws") throw new Error("WAIT");
      return options.waited ?? null;
    },
  );
  const foreign: InstancePorts["foreignAcknowledgementCount"] = vi.fn(
    async () => {
      log.push("foreign-count");
      if (options.foreign === "throws") throw new Error("FOREIGN");
      return options.foreign ?? 0;
    },
  );
  const taskViewKinds = new Map<string, "runtime" | "chatgpt">();
  const sync = () => {
    taskViewKinds.clear();
    for (let index = 0; index < state.runtimeViews; index += 1)
      taskViewKinds.set(`runtime-${index}`, "runtime");
    for (let index = 0; index < state.otherViews; index += 1)
      taskViewKinds.set(`chatgpt-${index}`, "chatgpt");
  };
  sync();
  const live = {
    isDestroyed: () => state.destroyed,
  };
  const request: InstanceRequest = createInstanceRequest(
    options.requestIdentity ?? identity,
    options.backgroundOnly ?? false,
  );
  const ports: InstancePorts = {
    app,
    stderr,
    desktopAdmission: {
      get quitInProgress() {
        return state.quitting;
      },
      get installedUpdateAdmission() {
        return state.applying;
      },
    },
    launchIdentity: identity,
    instanceRequest: request,
    primaryStartup: startup,
    runtimeStopping: () => state.stopping,
    runtimeState: () => state.runtimeState,
    window: () => (state.hasWindow ? live : null),
    taskViewKinds,
    get expectedTasks() {
      return { length: state.expectedViews };
    },
    startupRecovery: () => (state.recovery ? { reopen } : null),
    ensureWindow,
    recoverWindowOpenFailure,
    writeInstanceAcknowledgement: write,
    waitForInstanceAcknowledgement: wait,
    foreignAcknowledgementCount: foreign,
  };
  return {
    instance: createInstance(ports),
    state,
    sync,
    request,
    log,
    written,
    app,
    stderr,
    listeners,
    reopen,
    ensureWindow,
    recoverWindowOpenFailure,
    write,
    wait,
    foreign,
    whenReady,
    finishReady,
    ports,
  };
}

function acknowledged(h: ReturnType<typeof build>): string[] {
  return h.log.filter((line) => line.startsWith("ack:"));
}

function acknowledgement(
  status: Status,
  from: LaunchIdentity = identity,
): InstanceAcknowledgement {
  return {
    schema: "farol.single-instance/2",
    nonce: "d".repeat(32),
    status,
    ...from,
  };
}

describe("primary readiness", () => {
  it("is ready only with a ready runtime, a live window and every expected task view", () => {
    const h = build({ runtimeViews: 2, otherViews: 1, expectedViews: 2 });
    expect(h.instance.isPrimaryReady()).toBe(true);
  });

  it.each([
    ["the runtime is starting", { runtimeState: "starting" as const }],
    ["the runtime is offline", { runtimeState: "offline" as const }],
    ["the runtime failed", { runtimeState: "failed" as const }],
    ["there is no window", { hasWindow: false }],
    ["the window is destroyed", { destroyed: true }],
    ["a task view is missing", { runtimeViews: 1, expectedViews: 2 }],
    ["an extra task view exists", { runtimeViews: 3, expectedViews: 2 }],
    ["only chatgpt views exist", { otherViews: 2, expectedViews: 2 }],
    ["a Quit is in progress", { quitting: true }],
    ["the runtime is stopping", { stopping: true }],
    ["an installed update owns admission", { applying: true }],
  ])("is not ready when %s", (_name, options) => {
    expect(build(options).instance.isPrimaryReady()).toBe(false);
  });

  it("reads every owner again at each call, including after the instance exists", () => {
    const h = build({ runtimeViews: 1, expectedViews: 1 });
    expect(h.instance.isPrimaryReady()).toBe(true);
    h.state.stopping = true;
    expect(h.instance.isPrimaryReady()).toBe(false);
    h.state.stopping = false;
    h.state.applying = true;
    expect(h.instance.isPrimaryReady()).toBe(false);
    h.state.applying = false;
    h.state.hasWindow = false;
    expect(h.instance.isPrimaryReady()).toBe(false);
    h.state.hasWindow = true;
    h.state.runtimeViews = 0;
    h.sync();
    expect(h.instance.isPrimaryReady()).toBe(false);
    h.state.runtimeViews = 1;
    h.sync();
    expect(h.instance.isPrimaryReady()).toBe(true);
  });
});

describe("second launch reaching the primary", () => {
  it("writes nothing for a request it cannot parse", async () => {
    const h = build();
    await h.instance.handleSecondInstance({ schema: "unknown" });
    await h.instance.handleSecondInstance(null);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.whenReady).not.toHaveBeenCalled();
    expect(h.ensureWindow).not.toHaveBeenCalled();
  });

  it("acknowledges a ready primary as reopened after waiting for startup and opening the window", async () => {
    const h = build({ runtimeViews: 1, expectedViews: 1 });
    await h.instance.handleSecondInstance(h.request);
    expect(h.log).toEqual([
      "ensure-window",
      "getPath:userData",
      "ack:reopened",
    ]);
    expect(h.whenReady).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith(
      "/controlled-user-data",
      h.request,
      "reopened",
      identity,
    );
  });

  it("acknowledges what the real decision said without touching the window for a foreign build", async () => {
    const h = build({ requestIdentity: foreignIdentity });
    await h.instance.handleSecondInstance(h.request);
    expect(acknowledged(h)).toEqual(["ack:identity-mismatch"]);
    expect(h.whenReady).not.toHaveBeenCalled();
    expect(h.ensureWindow).not.toHaveBeenCalled();
    expect(h.reopen).not.toHaveBeenCalled();
  });

  it("refuses a background-only launch without opening anything", async () => {
    const h = build({ backgroundOnly: true });
    await h.instance.handleSecondInstance(h.request);
    expect(acknowledged(h)).toEqual(["ack:reopen-failed"]);
    expect(h.whenReady).not.toHaveBeenCalled();
    expect(h.ensureWindow).not.toHaveBeenCalled();
  });

  describe("while Quit, Apply or runtime stop already owns admission", () => {
    it.each([
      ["a Quit", { quitting: true }],
      ["an installed update", { applying: true }],
      ["a runtime stop", { stopping: true }],
    ])(
      "refuses before waiting or opening when %s is in progress",
      async (_name, options) => {
        const h = build(options);
        await h.instance.handleSecondInstance(h.request);
        expect(acknowledged(h)).toEqual(["ack:reopen-failed"]);
        expect(h.whenReady).not.toHaveBeenCalled();
        expect(h.ensureWindow).not.toHaveBeenCalled();
        expect(h.reopen).not.toHaveBeenCalled();
      },
    );

    it("keeps an identity mismatch distinct even while an update owns admission", async () => {
      const h = build({ applying: true, requestIdentity: foreignIdentity });
      await h.instance.handleSecondInstance(h.request);
      expect(acknowledged(h)).toEqual(["ack:identity-mismatch"]);
      expect(h.whenReady).not.toHaveBeenCalled();
    });

    it.each([
      ["Quit", (h: ReturnType<typeof build>) => (h.state.quitting = true)],
      ["Apply", (h: ReturnType<typeof build>) => (h.state.applying = true)],
      [
        "a runtime stop",
        (h: ReturnType<typeof build>) => (h.state.stopping = true),
      ],
    ])(
      "refuses when %s begins while startup readiness is pending",
      async (_name, begin) => {
        const h = build({ holdReady: true, runtimeViews: 0 });
        const handling = h.instance.handleSecondInstance(h.request);
        expect(h.whenReady).toHaveBeenCalledTimes(1);
        begin(h);
        h.finishReady();
        await handling;
        expect(acknowledged(h)).toEqual(["ack:reopen-failed"]);
        expect(h.ensureWindow).not.toHaveBeenCalled();
      },
    );
  });

  describe("when the primary is not ready to take the launch", () => {
    it("refuses when startup fails and never opens a window", async () => {
      const h = build({ startupFails: true });
      await h.instance.handleSecondInstance(h.request);
      expect(acknowledged(h)).toEqual(["ack:reopen-failed"]);
      expect(h.ensureWindow).not.toHaveBeenCalled();
    });

    it("keeps an unavailable runtime classified as reopen-failed after the window opened", async () => {
      const h = build({ runtimeState: "failed" });
      await h.instance.handleSecondInstance(h.request);
      expect(h.ensureWindow).toHaveBeenCalledTimes(1);
      expect(acknowledged(h)).toEqual(["ack:reopen-failed"]);
    });

    it("refuses when the task views are not all present after the open", async () => {
      const h = build({ runtimeViews: 0, expectedViews: 1 });
      await h.instance.handleSecondInstance(h.request);
      expect(h.ensureWindow).toHaveBeenCalledTimes(1);
      expect(acknowledged(h)).toEqual(["ack:reopen-failed"]);
    });

    it("contains a window-open failure, recovers the window and refuses", async () => {
      const h = build({ openFails: true });
      await h.instance.handleSecondInstance(h.request);
      expect(h.log).toEqual([
        "ensure-window",
        "recover-window",
        "getPath:userData",
        "ack:reopen-failed",
      ]);
    });

    it("still refuses when the recovery itself throws", async () => {
      const h = build({ openFails: true, recoveryThrows: true });
      await h.instance.handleSecondInstance(h.request);
      expect(h.recoverWindowOpenFailure).toHaveBeenCalledTimes(1);
      expect(acknowledged(h)).toEqual(["ack:reopen-failed"]);
    });

    it("reopens only the recovery window and never reports normal readiness", async () => {
      const h = build({ recovery: true, holdReady: true });
      await h.instance.handleSecondInstance(h.request);
      expect(h.reopen).toHaveBeenCalledTimes(1);
      expect(h.whenReady).not.toHaveBeenCalled();
      expect(h.ensureWindow).not.toHaveBeenCalled();
      expect(acknowledged(h)).toEqual(["ack:reopen-failed"]);
    });

    it("refuses even when the recovery window fails to reopen", async () => {
      const h = build({ recovery: true, recoveryFails: true });
      await h.instance.handleSecondInstance(h.request);
      expect(h.reopen).toHaveBeenCalledTimes(1);
      expect(acknowledged(h)).toEqual(["ack:reopen-failed"]);
    });

    it("does not open recovery for a foreign or background-only launch", async () => {
      for (const options of [
        { requestIdentity: foreignIdentity },
        { backgroundOnly: true },
      ]) {
        const h = build({ recovery: true, ...options });
        await h.instance.handleSecondInstance(h.request);
        expect(h.reopen).not.toHaveBeenCalled();
      }
    });
  });

  describe("the acknowledgement written back", () => {
    it("is written once, to the user-data directory, with the primary's identity", async () => {
      const h = build();
      await h.instance.handleSecondInstance(h.request);
      expect(h.write).toHaveBeenCalledTimes(1);
      expect(h.write.mock.calls[0]).toEqual([
        "/controlled-user-data",
        h.request,
        "reopened",
        identity,
      ]);
      expect(h.stderr.write).not.toHaveBeenCalled();
    });

    it.each([
      [Object.assign(new Error("denied"), { code: "EACCES" }), "EACCES"],
      [new Error("INSTANCE_ACK_UNSAFE"), "INSTANCE_ACK_UNSAFE"],
      [new Error("/private/path"), "unknown"],
      ["not an error", "unknown"],
    ])(
      "reports a failed publication as a content-free token, once, and does not retry (%#)",
      async (failure, token) => {
        const h = build({ writeFails: failure });
        await h.instance.handleSecondInstance(h.request);
        expect(h.written).toEqual([
          `${secondInstanceAcknowledgementPrefix}${token}\n`,
        ]);
        expect(h.write).toHaveBeenCalledTimes(1);
      },
    );
  });
});

describe("second-instance event", () => {
  it("registers one listener and hands the launch's own request to the handler", async () => {
    const h = build();
    h.instance.listenForSecondInstance();
    expect(h.app.on).toHaveBeenCalledTimes(1);
    expect(h.app.on.mock.calls[0]?.[0]).toBe("second-instance");
    const listener = h.listeners[0] as unknown as (
      event: unknown,
      commandLine: string[],
      workingDirectory: string,
      additionalData: unknown,
    ) => void;
    listener({}, ["--ignored"], "/ignored", h.request);
    await vi.waitFor(() => expect(h.write).toHaveBeenCalledTimes(1));
    expect(h.write.mock.calls[0]?.[1]).toBe(h.request);
    expect(h.write.mock.calls[0]?.[2]).toBe("reopened");
  });

  it("registers nothing until it is asked to", () => {
    const h = build();
    expect(h.app.on).not.toHaveBeenCalled();
  });
});

describe("a dev reopen that won the lock", () => {
  it("gives the lock back, says so and exits with one, in that order", () => {
    const h = build();
    h.instance.refuseDevReopen();
    expect(h.log).toEqual([
      "release-lock",
      `stderr:${secondInstanceResultPrefix}reopen-failed`,
      "exit:1",
    ]);
    expect(h.app.quit).not.toHaveBeenCalled();
  });
});

describe("a second launch waiting to be acknowledged", () => {
  async function settle(options: Options) {
    const h = build(options);
    h.instance.settleSecondInstance();
    await vi.waitFor(() => expect(h.app.quit).toHaveBeenCalledTimes(1));
    return h;
  }

  it("waits for its own request in the user-data directory", async () => {
    const h = await settle({ waited: acknowledgement("reopened") });
    expect(h.wait).toHaveBeenCalledWith("/controlled-user-data", h.request);
  });

  it("reports reopened and quits gracefully when the same build acknowledges a reopen", async () => {
    const h = await settle({ waited: acknowledgement("reopened") });
    expect(h.log).toEqual([
      "getPath:userData",
      "wait-ack",
      `stderr:${secondInstanceResultPrefix}reopened`,
      "quit",
    ]);
    expect(h.foreign).not.toHaveBeenCalled();
    expect(h.app.exit).not.toHaveBeenCalled();
  });

  it.each(["identity-mismatch", "reopen-failed"] as const)(
    "reports %s with the refusal message and quits",
    async (status) => {
      const h = await settle({ waited: acknowledgement(status) });
      expect(h.written).toHaveLength(2);
      expect(h.written[0]).toMatch(/^Farol .*\n$/u);
      expect(h.written[1]).toBe(`${secondInstanceResultPrefix}${status}\n`);
      expect(h.foreign).not.toHaveBeenCalled();
    },
  );

  it("reports a reopen acknowledged for a different build as unverified", async () => {
    const h = await settle({
      waited: acknowledgement("reopened", foreignIdentity),
    });
    expect(h.written[1]).toBe(`${secondInstanceResultPrefix}unverified\n`);
    expect(h.foreign).not.toHaveBeenCalled();
  });

  it("reports silence as unverified and says the primary published nothing", async () => {
    const h = await settle({ waited: null, foreign: 0 });
    expect(h.written).toHaveLength(3);
    expect(h.written[1]).toBe(`${secondInstanceResultPrefix}unverified\n`);
    expect(h.written[2]).toBe(`${secondInstanceAcknowledgementPrefix}absent\n`);
    expect(h.foreign).toHaveBeenCalledWith("/controlled-user-data", h.request);
  });

  it("says how many acknowledgements were for another launch", async () => {
    const h = await settle({ waited: null, foreign: 2 });
    expect(h.written[2]).toBe(
      `${secondInstanceAcknowledgementPrefix}foreign:2\n`,
    );
  });

  it("treats an unreadable count as foreign:-1", async () => {
    const h = await settle({ waited: null, foreign: "throws" });
    expect(h.written[2]).toBe(
      `${secondInstanceAcknowledgementPrefix}foreign:-1\n`,
    );
  });

  it("reports unverified and quits when the wait itself fails", async () => {
    const h = await settle({ waited: "throws" });
    expect(h.written).toEqual([`${secondInstanceResultPrefix}unverified\n`]);
    expect(h.foreign).not.toHaveBeenCalled();
  });

  it("quits exactly once and never exits hard", async () => {
    const h = await settle({ waited: acknowledgement("reopened") });
    await Promise.resolve();
    expect(h.app.quit).toHaveBeenCalledTimes(1);
    expect(h.app.exit).not.toHaveBeenCalled();
  });
});
