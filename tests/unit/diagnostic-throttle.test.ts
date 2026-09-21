import { describe, expect, it } from "vitest";
import { DiagnosticThrottle } from "../../src/ui/diagnostic-throttle";

function at(times: number[]): DiagnosticThrottle {
  let index = 0;
  return new DiagnosticThrottle(
    () => times[Math.min(index++, times.length - 1)]!,
  );
}

describe("a diagnostic that fires as often as the renderer draws", () => {
  it("always reports the first occurrence", () => {
    // The first one is the one that says a thing happened at all; silencing
    // it to save volume would lose the only line that matters.
    expect(at([0]).admit()).toEqual({ suppressed: 0 });
  });

  it("reports at most one line per interval", () => {
    const throttle = at([0, 1, 2, 999]);
    expect(throttle.admit()).toEqual({ suppressed: 0 });
    expect(throttle.admit()).toBeNull();
    expect(throttle.admit()).toBeNull();
    expect(throttle.admit()).toBeNull();
  });

  it("counts what it suppressed, so nobody reconstructs it from timestamps", () => {
    const throttle = at([0, 10, 20, 30, 1_000]);
    throttle.admit();
    throttle.admit();
    throttle.admit();
    throttle.admit();
    expect(throttle.admit()).toEqual({ suppressed: 3 });
  });

  it("starts counting again after it reports", () => {
    const throttle = at([0, 5, 1_000, 1_005, 2_000]);
    expect(throttle.admit()).toEqual({ suppressed: 0 });
    throttle.admit();
    expect(throttle.admit()).toEqual({ suppressed: 1 });
    throttle.admit();
    expect(throttle.admit()).toEqual({ suppressed: 1 });
  });

  it("gives a later episode its own first line", () => {
    // The menu closing ends the episode. Without the reset, reopening it
    // inside the same second would be silent, and the first line of the
    // second episode is exactly as interesting as the first line of the
    // first one.
    const throttle = at([0, 10, 20]);
    expect(throttle.admit()).toEqual({ suppressed: 0 });
    expect(throttle.admit()).toBeNull();
    throttle.reset();
    expect(throttle.admit()).toEqual({ suppressed: 0 });
  });

  it("cannot emit more than one line per interval however often it is called", () => {
    // The property the hung run needed: bounded output for unbounded input.
    let now = 0;
    const throttle = new DiagnosticThrottle(() => now);
    let lines = 0;
    for (let call = 0; call < 10_000; call += 1) {
      now += 1;
      if (throttle.admit()) lines += 1;
    }
    expect(lines).toBe(10);
  });
});

describe("what the window swallowed", () => {
  it("can be read before the window is forgotten", () => {
    // The hole this closes: `suppressed` only ever reached a line when a
    // LATER occurrence was admitted, so a burst just before a run failed
    // was invisible. Found while decoding a run that had exactly one line.
    const throttle = at([0, 1, 2, 3]);
    throttle.admit();
    throttle.admit();
    throttle.admit();
    expect(throttle.pending()).toBe(2);
  });

  it("is nothing when every occurrence was reported", () => {
    const throttle = at([0]);
    throttle.admit();
    expect(throttle.pending()).toBe(0);
  });

  it("is cleared by the reset that ends the episode", () => {
    const throttle = at([0, 1, 2]);
    throttle.admit();
    throttle.admit();
    expect(throttle.pending()).toBe(1);
    throttle.reset();
    expect(throttle.pending()).toBe(0);
  });
});
