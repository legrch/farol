import { describe, expect, it } from "vitest";
import { transferAdmissible, transferThrottled } from "./progress";

describe("transfer progress", () => {
  it("admits monotonic counters that agree on one total", () => {
    expect(
      transferAdmissible({ receivedBytes: 5, totalBytes: 10 }, -1, undefined),
    ).toBe(true);
    expect(
      transferAdmissible({ receivedBytes: 5, totalBytes: 10 }, 6, undefined),
    ).toBe(false);
    expect(
      transferAdmissible({ receivedBytes: 5, totalBytes: 10 }, 0, 20),
    ).toBe(false);
    expect(
      transferAdmissible({ receivedBytes: 11, totalBytes: 10 }, 0, undefined),
    ).toBe(false);
    expect(
      transferAdmissible({ receivedBytes: 0, totalBytes: 0 }, 0, undefined),
    ).toBe(false);
    expect(
      transferAdmissible(
        { receivedBytes: 1, totalBytes: 2_147_483_649 },
        0,
        undefined,
      ),
    ).toBe(false);
    expect(
      transferAdmissible({ receivedBytes: 0.5, totalBytes: 10 }, 0, undefined),
    ).toBe(false);
  });

  it("throttles ticks inside the interval but never the last byte", () => {
    expect(transferThrottled(100, 0, 5, 10)).toBe(true);
    expect(transferThrottled(300, 0, 5, 10)).toBe(false);
    expect(transferThrottled(100, 0, 10, 10)).toBe(false);
    expect(transferThrottled(0, -Infinity, 5, 10)).toBe(false);
    expect(transferThrottled(0, 5, 5, 10)).toBe(false);
  });
});
