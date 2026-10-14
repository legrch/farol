import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it, vi } from "vitest";
import {
  PrimaryStartup,
  primaryStartupReady,
} from "../../src/apps/desktop/primary-startup";
import {
  WindowOpenCoordinator,
  containWindowOpenFailure,
} from "../../src/apps/desktop/lifecycle-policy";
import { decideSecondInstance } from "../../src/apps/desktop/single-instance";

// Real request codec/decision, startup/readiness and coordinator, plus actual
// host callbacks. Native window mechanics and ACK publication are controlled;
// this does not exercise Electron, an installed update or a live launch.
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const callbacks = [
  "ensureWindow",
  "isPrimaryReady",
  "handleSecondInstance",
].map((name) => {
  const node = tree.program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === name,
  );
  if (!node || node.start === null || node.end === null)
    throw new Error(`SECOND_INSTANCE_CALLBACK_MISSING:${name}`);
  return source.slice(node.start, node.end);
});

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
    environment: "preview",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    inputLedgerSha256: "c".repeat(64),
  };
  const candidate = {
    ...launchIdentity,
    sourceCommit: foreign ? "e".repeat(40) : launchIdentity.sourceCommit,
    nonce: "d".repeat(32),
    ...(backgroundOnly
      ? { schema: "farol.next.single-instance/3", backgroundOnly: true }
      : { schema: "farol.next.single-instance/2" }),
  };
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
  const context: Record<string, unknown> = {
    launchIdentity,
    primaryStartup: startup,
    startupRecovery: null,
    primaryStartupReady,
    decideSecondInstance,
    containWindowOpenFailure,
    windowOpenCoordinator: new WindowOpenCoordinator(),
    window: hasWindow ? window : null,
    runtimeState: failedRuntime ? "failed" : "ready",
    runtimeStopping: stopping,
    quitInProgress: quitting,
    installedUpdateAdmission: applying,
    taskViewKinds: new Map(),
    expectedTasks: [],
    app: { getPath: () => "/controlled-user-data" },
  };
  const create = vi.fn(async () => {
    context.window = window;
    beginOpen();
    await pendingOpen;
  });
  const reveal = vi.fn();
  const acknowledge = vi.fn(
    async (
      _root: unknown,
      _candidate: unknown,
      _status: unknown,
      _identity: unknown,
    ) => undefined,
  );
  Object.assign(context, {
    createWindow: create,
    revealWindow: reveal,
    recoverWindowOpenFailure: () => {
      throw new Error("UNEXPECTED_RECOVERY");
    },
    writeInstanceAcknowledgement: acknowledge,
  });
  const actions = vm.runInNewContext(
    stripTypeScriptTypes(
      `${callbacks.join("\n")}\n({ handle: handleSecondInstance, ready: isPrimaryReady })`,
    ),
    context,
  ) as { handle(candidate: unknown): Promise<void>; ready(): boolean };
  return {
    ...actions,
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

it("reveals only the recovery window without acknowledging normal runtime readiness", async () => {
  const h = host({ holdReady: true });
  const reopen = vi.fn(async () => undefined);
  h.context.startupRecovery = { reopen };
  await h.handle(h.candidate);
  expect(reopen).toHaveBeenCalledOnce();
  expect(h.waitReady).not.toHaveBeenCalled();
  expect(h.create).not.toHaveBeenCalled();
  expect(h.reveal).not.toHaveBeenCalled();
  expectAck(h, "reopen-failed");
});

it("does not open recovery for foreign or background-only launches", async () => {
  for (const options of [{ foreign: true }, { backgroundOnly: true }]) {
    const h = host(options),
      reopen = vi.fn(async () => undefined);
    h.context.startupRecovery = { reopen };
    await h.handle(h.candidate);
    expect(reopen).not.toHaveBeenCalled();
    expect(h.waitReady).not.toHaveBeenCalled();
    expectAck(h, options.foreign ? "identity-mismatch" : "reopen-failed");
  }
});
