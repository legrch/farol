import { describe, expect, it } from "vitest";
import { boundedContext, mutationAdmitted, readAllowed } from "./admission";

describe("readAllowed", () => {
  it("admits without a deadline and refuses a cancelled signal", () => {
    expect(readAllowed({}, () => 10)).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(readAllowed({ signal: controller.signal }, () => 10)).toBe(false);
  });

  it("requires a safe, non-negative deadline that has not passed", () => {
    expect(readAllowed({ deadlineAt: 11 }, () => 10)).toBe(true);
    expect(readAllowed({ deadlineAt: 10 }, () => 10)).toBe(false);
    expect(readAllowed({ deadlineAt: -1 }, () => -5)).toBe(false);
    expect(readAllowed({ deadlineAt: 1.5 }, () => 1)).toBe(false);
    expect(readAllowed({ deadlineAt: Number.NaN }, () => 1)).toBe(false);
  });

  it("does not read the clock when no deadline is set", () => {
    let reads = 0;
    readAllowed({}, () => (reads += 1));
    expect(reads).toBe(0);
  });
});

describe("mutationAdmitted", () => {
  it("closes at the expiry and on cancellation", () => {
    expect(mutationAdmitted(undefined, () => 9, 10)).toBe(true);
    expect(mutationAdmitted(undefined, () => 10, 10)).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(mutationAdmitted(controller.signal, () => 1, 10)).toBe(false);
  });
});

describe("boundedContext", () => {
  it("only shortens the window", () => {
    expect(boundedContext({}, 100).deadlineAt).toBe(100);
    expect(boundedContext({ deadlineAt: 50 }, 100).deadlineAt).toBe(50);
    expect(boundedContext({ deadlineAt: 500 }, 100).deadlineAt).toBe(100);
  });

  it("keeps the signal", () => {
    const controller = new AbortController();
    expect(boundedContext({ signal: controller.signal }, 1).signal).toBe(
      controller.signal,
    );
  });
});
