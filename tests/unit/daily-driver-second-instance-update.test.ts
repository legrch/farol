import { admissionFixture } from "../support/desktop-admission";
import {
  windowAdmission,
  type WindowAdmissionState,
} from "../../apps/desktop/window/main";
import { createInstance } from "../../apps/desktop/host/instance";
import { expect, it, vi } from "vitest";
import { PrimaryStartup } from "../../src/apps/desktop/primary-startup";
import { WindowOpenCoordinator } from "../../src/apps/desktop/lifecycle-policy";
import { createInstanceRequest } from "../../src/apps/desktop/single-instance";

// Real request codec/decision, startup/readiness and coordinator, plus the real
// single-instance host over fake ports. Native window mechanics and ACK
// publication are controlled; this does not exercise Electron, an installed
// update or a live launch.

function host({
  applying = false,
  quitting = false,
  stopping = false,
  failedRuntime = false,
  hasWindow = true,
  holdReady = false,
  holdOpen = false,
  foreign = false,
  backgroundOnly = false,
} = {}) {
  const launchIdentity = {
    environment: "preview" as const,
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    inputLedgerSha256: "c".repeat(64),
  };
  const candidate = createInstanceRequest(
    foreign
      ? { ...launchIdentity, sourceCommit: "e".repeat(40) }
      : launchIdentity,
    backgroundOnly,
  );
  let finishReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    finishReady = resolve;
  });
  const startup = new PrimaryStartup();
  startup.begin(ready);
  const waitReady = vi.spyOn(startup, "whenReady");
  if (!holdReady) finishReady();
  let finishOpen!: () => void;
  const pendingOpen = new Promise<void>((resolve) => {
    finishOpen = resolve;
  });
  if (!holdOpen) finishOpen();
  let beginOpen!: () => void;
  const openStarted = new Promise<void>((resolve) => {
    beginOpen = resolve;
  });
  const window = { isDestroyed: () => false };
  const context: Record<string, unknown> & {
    window: typeof window | null;
  } = {
    windowOpenCoordinator: new WindowOpenCoordinator(),
    window: hasWindow ? window : null,
    runtimeState: failedRuntime ? "failed" : "ready",
    runtimeStopping: stopping,
    quitInProgress: quitting,
    installedUpdateAdmission: applying,
  };
  const create = vi.fn(async () => {
    context.window = window;
    beginOpen();
    await pendingOpen;
  });
  const reveal = vi.fn();
  const acknowledge = vi.fn(
    async (
      _root: string,
      _candidate: unknown,
      _status: unknown,
      _identity: unknown,
    ) => undefined,
  );
  const recoverWindowOpenFailure = () => {
    throw new Error("UNEXPECTED_RECOVERY");
  };
  Object.assign(
    context,
    windowAdmission({
      state: context as unknown as WindowAdmissionState,
      coordinator: context.windowOpenCoordinator as WindowOpenCoordinator,
      createWindow: () => create(),
      revealWindow: reveal,
      recoverWindowOpenFailure,
    }),
  );
  const { desktopAdmission } = admissionFixture(context);
  const actions = createInstance({
    app: {
      getPath: () => "/controlled-user-data",
      on: vi.fn(),
      releaseSingleInstanceLock: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
    },
    stderr: { write: vi.fn() },
    desktopAdmission,
    launchIdentity,
    instanceRequest: candidate,
    primaryStartup: startup,
    runtimeStopping: () => context.runtimeStopping as boolean,
    runtimeState: () =>
      context.runtimeState as "starting" | "ready" | "offline" | "failed",
    window: () => context.window,
    taskViewKinds: new Map(),
    expectedTasks: [],
    ensureWindow: context.ensureWindow as () => Promise<void>,
    recoverWindowOpenFailure,
    writeInstanceAcknowledgement: acknowledge,
    waitForInstanceAcknowledgement: async () => null,
    foreignAcknowledgementCount: async () => 0,
  });
  return {
    handle: actions.handleSecondInstance,
    ready: actions.isPrimaryReady,
    candidate,
    context,
    create,
    reveal,
    acknowledge,
    waitReady,
    finishReady,
    finishOpen,
    openStarted,
  };
}

function expectAck(h: ReturnType<typeof host>, status: string) {
  expect(h.acknowledge).toHaveBeenCalledTimes(1);
  expect(h.acknowledge.mock.calls[0]?.[2]).toBe(status);
}

it("refuses before waiting or presenting when Apply already owns admission", async () => {
  const h = host({ applying: true });
  await h.handle(h.candidate);
  expectAck(h, "reopen-failed");
  expect(h.waitReady).not.toHaveBeenCalled();
  expect(h.reveal).not.toHaveBeenCalled();
  expect(h.create).not.toHaveBeenCalled();
});

it("refuses when Apply closes admission while startup readiness is pending", async () => {
  const h = host({ holdReady: true });
  const handling = h.handle(h.candidate);
  expect(h.waitReady).toHaveBeenCalledTimes(1);
  h.context.installedUpdateAdmission = true;
  h.finishReady();
  await handling;
  expectAck(h, "reopen-failed");
  expect(h.reveal).not.toHaveBeenCalled();
  expect(h.create).not.toHaveBeenCalled();
});

it("does not publish reopened when Apply starts after the native open was dispatched", async () => {
  const h = host({ hasWindow: false, holdOpen: true });
  const handling = h.handle(h.candidate);
  await h.openStarted;
  h.context.installedUpdateAdmission = true;
  h.finishOpen();
  await handling;
  expectAck(h, "reopen-failed");
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.reveal).not.toHaveBeenCalled();
});

it("makes readiness unavailable only while the existing Apply admission is held", () => {
  const h = host({ applying: true });
  expect(h.ready()).toBe(false);
  h.context.installedUpdateAdmission = false;
  expect(h.ready()).toBe(true);
});

it.each([true, false])(
  "retains ordinary exact-identity reopen (hasWindow=%s)",
  async (hasWindow) => {
    const h = host({ hasWindow });
    await h.handle(h.candidate);
    expectAck(h, "reopened");
    expect(h.create).toHaveBeenCalledTimes(hasWindow ? 0 : 1);
    expect(h.reveal).toHaveBeenCalledTimes(hasWindow ? 1 : 0);
  },
);

it.each([{ quitting: true }, { stopping: true }, { backgroundOnly: true }])(
  "retains the existing pre-ready refusal %j",
  async (options) => {
    const h = host(options);
    await h.handle(h.candidate);
    expectAck(h, "reopen-failed");
    expect(h.reveal).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  },
);

it("preserves Quit refusal when it begins while startup readiness is pending", async () => {
  const h = host({ holdReady: true });
  const handling = h.handle(h.candidate);
  h.context.quitInProgress = true;
  h.finishReady();
  await handling;
  expectAck(h, "reopen-failed");
  expect(h.reveal).not.toHaveBeenCalled();
});

it("keeps identity mismatch distinct even while Apply owns admission", async () => {
  const h = host({ applying: true, foreign: true });
  await h.handle(h.candidate);
  expectAck(h, "identity-mismatch");
  expect(h.waitReady).not.toHaveBeenCalled();
  expect(h.reveal).not.toHaveBeenCalled();
});

it("keeps an unavailable runtime classified without hiding its diagnostic window", async () => {
  const h = host({ failedRuntime: true });
  await h.handle(h.candidate);
  expectAck(h, "reopen-failed");
  expect(h.reveal).toHaveBeenCalledTimes(1);
});

it("acknowledges foreign and background-only launches without waiting for readiness", async () => {
  for (const options of [{ foreign: true }, { backgroundOnly: true }]) {
    const h = host(options);
    await h.handle(h.candidate);
    expect(h.waitReady).not.toHaveBeenCalled();
    expectAck(h, options.foreign ? "identity-mismatch" : "reopen-failed");
  }
});
