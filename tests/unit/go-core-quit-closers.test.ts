import { afterEach, expect, it, vi } from "vitest";
import { goCoreQuitClosers } from "../../apps/desktop/go-core-quit-closers";
import { createQuitDrain } from "../../src/apps/desktop/quit-drain";

afterEach(() => vi.useRealTimers());

it.each(["connector", "saved-chat-bridge"])(
  "keeps Go available until %s has finished, even if its closer is called first",
  async (name) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dependent = vi.fn(() => pending);
    const core = vi.fn(async () => undefined);
    const closers = goCoreQuitClosers({ name, close: dependent }, core);
    const closingCore = closers[1]!.close();
    const closingDependent = closers[0]!.close();
    await Promise.resolve();
    expect(dependent).toHaveBeenCalledTimes(1);
    expect(core).not.toHaveBeenCalled();
    release();
    await Promise.all([closingCore, closingDependent, closers[1]!.close()]);
    expect(core).toHaveBeenCalledTimes(1);
  },
);

it("retains a failed connector while closing Go once, without replay on reentrant Quit", async () => {
  vi.useFakeTimers();
  const dependent = vi.fn(async () => {
    throw new Error("MCP_UNCONFIRMED");
  });
  const core = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);
  const quit = vi.fn();
  const drain = createQuitDrain({
    deadlineMs: 1_000,
    collect: () =>
      goCoreQuitClosers({ name: "connector", close: dependent }, core),
    record,
    quit,
  });
  const event = { preventDefault: vi.fn() };
  drain.onBeforeQuit(event);
  drain.onBeforeQuit(event);
  await vi.advanceTimersByTimeAsync(0);
  expect(record).toHaveBeenCalledWith({
    drained: false,
    unconfirmed: ["connector"],
  });
  expect(dependent).toHaveBeenCalledTimes(1);
  expect(core).toHaveBeenCalledTimes(1);
  expect(quit).toHaveBeenCalledTimes(1);
});

it("joins the original start and MCP cleanup before retiring Go", async () => {
  vi.useFakeTimers();
  let completeStart!: () => void;
  let completeMcp!: () => void;
  const start = new Promise<void>((resolve) => {
    completeStart = resolve;
  });
  const mcp = new Promise<void>((resolve) => {
    completeMcp = resolve;
  });
  const core = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);
  const dependent = vi.fn(async () => {
    await start;
    await mcp;
  });
  const drain = createQuitDrain({
    deadlineMs: 2_000,
    recordReserveMs: 500,
    collect: () =>
      goCoreQuitClosers({ name: "connector", close: dependent }, core),
    record,
    quit: vi.fn(),
  });
  drain.onBeforeQuit({ preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  completeStart();
  await vi.advanceTimersByTimeAsync(0);
  expect(core).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  completeMcp();
  await vi.advanceTimersByTimeAsync(0);
  expect(core).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith({ drained: true, unconfirmed: [] });
});

it("does not retire Go past a still-pending connector just to claim a clean deadline", async () => {
  vi.useFakeTimers();
  const core = vi.fn(async () => undefined);
  const record = vi.fn(async () => undefined);
  const quit = vi.fn();
  const drain = createQuitDrain({
    deadlineMs: 1_000,
    recordReserveMs: 100,
    collect: () =>
      goCoreQuitClosers(
        { name: "connector", close: () => new Promise(() => {}) },
        core,
      ),
    record,
    quit,
  });
  drain.onBeforeQuit({ preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(core).not.toHaveBeenCalled();
  expect(record).toHaveBeenCalledWith({
    drained: false,
    unconfirmed: ["connector", "go-core"],
  });
  expect(quit).toHaveBeenCalledTimes(1);
});

it("does not start a late Go retirement from a connector that settled after its original deadline", async () => {
  let release!: () => void;
  const dependent = new Promise<void>((resolve) => {
    release = resolve;
  });
  let allowed = true;
  const core = vi.fn(async () => undefined);
  const closers = goCoreQuitClosers(
    { name: "connector", close: () => dependent },
    core,
    () => allowed,
  );
  const original = closers[1]!.close();
  allowed = false;
  release();
  await expect(original).rejects.toThrow("GO_CORE_QUIT_DEADLINE_EXPIRED");
  await expect(closers[1]!.close()).rejects.toThrow(
    "GO_CORE_QUIT_DEADLINE_EXPIRED",
  );
  expect(core).not.toHaveBeenCalled();
});
