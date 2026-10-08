import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQuitDrain,
  type QuitDrainReceipt,
} from "../../src/apps/desktop/quit-drain";
import { createQuitUpdatePreparation } from "../../src/apps/desktop/quit-update-preparation";
import type { NormalQuitUpdateReceipt } from "../../src/modules/release/contract/installed-update";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("normal Quit joins only its current original Release admission", () => {
  const start = 1_000_000;
  const deadlineAt = start + 10_000;
  const reason = {
    kind: "ordinary-quit",
    deadlineAt,
    relaunch: false,
    requestQuit: false,
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });
  afterEach(() => vi.useRealTimers());

  function harness() {
    const result = deferred<NormalQuitUpdateReceipt>();
    const apply = vi.fn(() => result.promise);
    const preparation = createQuitUpdatePreparation(() => ({
      applyOnNormalQuit: apply,
    }));
    const receipts: QuitDrainReceipt[] = [];
    const collect = vi.fn(() => {
      expect(preparation.admissionAllowed(reason)).toBe(false);
      return [{ name: "original-child", close: async () => undefined }];
    });
    const quit = vi.fn();
    const drain = createQuitDrain({
      prepare: preparation.prepare,
      collect,
      deadlineMs: 10_000,
      record: async (receipt) => {
        receipts.push(receipt);
      },
      quit,
    });
    return { apply, preparation, result, drain, receipts, collect, quit };
  }

  it("passes the original deadline once and closes admission before destructive collection", async () => {
    const h = harness();
    expect(h.preparation.admissionAllowed(reason)).toBe(false);
    expect(h.preparation.effectAllowed()).toBe(false);
    h.drain.onBeforeQuit({ preventDefault() {} });
    h.drain.onBeforeQuit({ preventDefault() {} });
    expect(h.apply).toHaveBeenCalledExactlyOnceWith({
      kind: "ordinary-quit",
      deadlineAt,
    });
    expect(h.preparation.admissionAllowed(reason)).toBe(true);
    expect(h.preparation.effectAllowed()).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.collect).not.toHaveBeenCalled();
    h.result.resolve({ status: "accepted", relaunch: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.receipts).toEqual([{ drained: true, unconfirmed: [] }]);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(h.preparation.admissionAllowed(reason)).toBe(false);
    expect(h.preparation.effectAllowed()).toBe(false);
  });

  it.each([
    undefined,
    { ...reason, deadlineAt: deadlineAt + 1 },
    { ...reason, kind: "restart" },
    { ...reason, relaunch: true },
    { ...reason, requestQuit: true },
    { ...reason, enabled: true },
  ])(
    "cannot borrow Quit admission with a mismatched reason %#",
    async (foreign) => {
      const h = harness();
      h.drain.onBeforeQuit({ preventDefault() {} });
      expect(h.preparation.admissionAllowed(foreign)).toBe(false);
      expect(h.preparation.admissionAllowed(reason)).toBe(true);
      h.result.resolve({ status: "skipped", code: "UPDATE_QUIT_NOT_OPTED_IN" });
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it("expiry and late original ACK do not reopen admission or rewrite an unknown Quit", async () => {
    const h = harness();
    h.drain.onBeforeQuit({ preventDefault() {} });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.preparation.admissionAllowed(reason)).toBe(false);
    expect(h.receipts).toEqual([
      { drained: false, unconfirmed: ["preparation", "original-child"] },
    ]);
    expect(h.quit).toHaveBeenCalledTimes(1);
    h.result.resolve({ status: "accepted", relaunch: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.preparation.admissionAllowed(reason)).toBe(false);
    expect(h.receipts).toHaveLength(1);
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it("missing owner skips without creating admission or a substitute update", async () => {
    const h = createQuitUpdatePreparation(() => null);
    await expect(
      h.prepare({ deadlineAt, canStartEffect: () => true }),
    ).resolves.toEqual({
      status: "skipped",
      code: "UPDATE_QUIT_OWNER_UNAVAILABLE",
    });
    expect(h.admissionAllowed(reason)).toBe(false);
  });

  it("an expired original fence never invokes the owner", async () => {
    const apply = vi.fn();
    const h = createQuitUpdatePreparation(() => ({ applyOnNormalQuit: apply }));
    await expect(
      h.prepare({ deadlineAt, canStartEffect: () => false }),
    ).resolves.toEqual({
      status: "skipped",
      code: "UPDATE_QUIT_DEADLINE_EXPIRED",
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it("a lost owner response retains unknown instead of claiming clean preparation", async () => {
    const h = createQuitUpdatePreparation(() => ({
      applyOnNormalQuit: async () => {
        throw new Error("lost original reply");
      },
    }));
    await expect(
      h.prepare({ deadlineAt, canStartEffect: () => true }),
    ).resolves.toEqual({
      status: "unknown",
      code: "UPDATE_QUIT_PREPARATION_UNKNOWN",
    });
    expect(h.admissionAllowed(reason)).toBe(false);
  });
});
