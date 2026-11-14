import { expect, it, vi } from "vitest";
import { WindowOpenCoordinator } from "../../../src/apps/desktop/lifecycle-policy";

import { windowAdmission, type WindowAdmissionState } from "./main";

// Real portable admission and coordinator; native creation and recovery are
// controlled ports. No Electron, provider or profile is exercised.

function host({
  hasWindow = false,
  quitting = false,
  applying = false,
  stopping = false,
  failedRuntime = false,
  openFails = false,
  pendingOpen = Promise.resolve(),
} = {}) {
  const window = { isDestroyed: () => false };
  const context = {
    window: hasWindow ? window : null,
    quitInProgress: quitting,
    installedUpdateAdmission: applying,
    runtimeStopping: stopping,
    runtimeState: failedRuntime ? "failed" : "ready",
    windowOpenCoordinator: new WindowOpenCoordinator(),
  };
  const create = vi.fn(async () => {
    if (openFails) throw new Error("controlled window load failure");
    context.window = window;
    await pendingOpen;
  });
  const reveal = vi.fn();
  const recover = vi.fn(() => {
    context.window = null;
  });
  const admission = windowAdmission({
    state: context as unknown as WindowAdmissionState,
    coordinator: context.windowOpenCoordinator,
    createWindow: create,
    revealWindow: reveal,
    recoverWindowOpenFailure: recover,
  });
  const actions = {
    ensure: admission.ensureWindow,
    reopen: admission.reopenWindow,
  };
  return { ...actions, create, reveal, recover, context, window };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

it.each([
  { quitting: true, hasWindow: false },
  { quitting: true, hasWindow: true },
  { applying: true, hasWindow: false },
  { applying: true, hasWindow: true },
])("does not create or reveal after admission closes %j", async (options) => {
  const h = host(options);
  h.reopen();
  await settle();
  expect(h.create).not.toHaveBeenCalled();
  expect(h.reveal).not.toHaveBeenCalled();
  expect(h.recover).not.toHaveBeenCalled();
});

it.each(["quitInProgress", "installedUpdateAdmission"] as const)(
  "does not create when %s closes after the coordinator queued an open",
  async (flag) => {
    const h = host();
    const opening = h.ensure();
    h.context[flag] = true;
    await opening;
    expect(h.create).not.toHaveBeenCalled();
    expect(h.reveal).not.toHaveBeenCalled();
    expect(h.context.window).toBeNull();
  },
);

it("opens normally and reveals an already-open window without another creation", async () => {
  const h = host();
  await h.ensure();
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.reveal).not.toHaveBeenCalled();
  h.reopen();
  await settle();
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.reveal).toHaveBeenCalledTimes(1);
  expect(h.context.window).toBe(h.window);
});

it("joins the original pending creation even after its window already exists", async () => {
  let finish!: () => void;
  const pendingOpen = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const h = host({ pendingOpen });
  const first = h.ensure();
  await Promise.resolve();
  expect(h.context.window).toBe(h.window);
  const second = h.ensure();
  expect(second).toBe(first);
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.reveal).not.toHaveBeenCalled();
  finish();
  await first;
});

it("retains the offline diagnostic window after runtime startup failed", async () => {
  const h = host({ stopping: true, failedRuntime: true });
  await h.ensure();
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.context.window).toBe(h.window);
});

it("retains a creation already dispatched before Quit without another open or reveal", async () => {
  let finish!: () => void;
  const pendingOpen = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const h = host({ pendingOpen });
  const first = h.ensure();
  await Promise.resolve();
  expect(h.create).toHaveBeenCalledTimes(1);
  h.context.quitInProgress = true;
  h.reopen();
  finish();
  await first;
  await settle();
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.reveal).not.toHaveBeenCalled();
  expect(h.recover).not.toHaveBeenCalled();
});

it("contains a failed normal reopen and preserves its existing recovery", async () => {
  const h = host({ openFails: true });
  h.reopen();
  await settle();
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.recover).toHaveBeenCalledTimes(1);
  expect(h.reveal).not.toHaveBeenCalled();
  expect(h.context.window).toBeNull();
});

it.each(["quitInProgress", "installedUpdateAdmission"] as const)(
  "contains the original pending open failure after %s closes admission",
  async (flag) => {
    let fail!: (error: Error) => void;
    const pendingOpen = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    const h = host({ pendingOpen });
    h.reopen();
    await Promise.resolve();
    expect(h.create).toHaveBeenCalledTimes(1);
    h.context[flag] = true;
    fail(new Error("controlled late window load failure"));
    await settle();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.reveal).not.toHaveBeenCalled();
    expect(h.recover).toHaveBeenCalledTimes(1);
    expect(h.context.window).toBeNull();
  },
);
