import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it, vi } from "vitest";
import {
  WindowOpenCoordinator,
  containWindowOpenFailure,
} from "../../src/apps/desktop/lifecycle-policy";

// Execute the actual main-process admission functions with the real portable
// coordinator and controlled native counters. No Electron, provider or profile.
const source = fs.readFileSync(
  new URL("../../src/apps/desktop/main.ts", import.meta.url),
  "utf8",
);
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const callbacks = ["ensureWindow", "reopenWindow"].map((name) => {
  const node = tree.program.body.find(
    (node) => node.type === "FunctionDeclaration" && node.id?.name === name,
  );
  if (!node || node.start === null || node.end === null)
    throw new Error(`WINDOW_ADMISSION_CALLBACK_MISSING:${name}`);
  return source.slice(node.start, node.end);
});

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
  const context: Record<string, unknown> = {
    window: hasWindow ? window : null,
    quitInProgress: quitting,
    installedUpdateAdmission: applying,
    runtimeStopping: stopping,
    runtimeState: failedRuntime ? "failed" : "ready",
    windowOpenCoordinator: new WindowOpenCoordinator(),
    containWindowOpenFailure,
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
  Object.assign(context, {
    createWindow: create,
    revealWindow: reveal,
    recoverWindowOpenFailure: recover,
  });
  const actions = vm.runInNewContext(
    stripTypeScriptTypes(
      `${callbacks.join("\n")}\n({ ensure: ensureWindow, reopen: reopenWindow })`,
    ),
    context,
  ) as { ensure(): Promise<void>; reopen(): void };
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

it.each(["quitInProgress", "installedUpdateAdmission"])(
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
