import { expect, it, vi } from "vitest";
import { settleFixtureCleanup } from "./fixture-cleanup.mjs";

function ports() {
  let time = 0;
  return {
    now: () => time,
    budgetMs: 300,
    delay: vi.fn(async (ms) => {
      time += ms;
    }),
    clear: (value) => value === "clear",
    complete: (value) => value !== "unknown",
  };
}
it("accepts an already clear observation without waiting", async () => {
  const p = ports(),
    observe = vi.fn(() => "clear");
  expect(await settleFixtureCleanup(observe, p)).toBe("clear");
  expect(observe).toHaveBeenCalledOnce();
  expect(p.delay).not.toHaveBeenCalled();
});
it("waits for a transient holder and requires a new clear observation", async () => {
  const p = ports(),
    observe = vi
      .fn()
      .mockReturnValueOnce("held")
      .mockReturnValueOnce("held")
      .mockReturnValue("clear");
  expect(await settleFixtureCleanup(observe, p)).toBe("clear");
  expect(observe).toHaveBeenCalledTimes(3);
  expect(p.delay).toHaveBeenCalledTimes(2);
});
it("preserves a holder after the shared deadline", async () => {
  const p = ports(),
    observe = vi.fn(() => "held");
  expect(await settleFixtureCleanup(observe, p)).toBe("held");
  expect(p.now()).toBe(300);
  expect(observe).toHaveBeenCalledTimes(4);
});
it("does not retry an incomplete observation, including after a known holder", async () => {
  for (const initial of [false, true]) {
    const p = ports(),
      observe = vi.fn(() => "unknown");
    if (initial) observe.mockReturnValueOnce("held");
    expect(await settleFixtureCleanup(observe, p)).toBe("unknown");
    expect(observe).toHaveBeenCalledTimes(initial ? 2 : 1);
  }
});
