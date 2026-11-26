import { describe, expect, it } from "vitest";
import { leaseHolder, leaseReadRetryable } from "./lease";

describe("leaseHolder", () => {
  const instance = "a".repeat(32);
  it("recognises this process and instance as its own", () => {
    expect(
      leaseHolder({ processId: 5, processInstanceId: instance }, 5, instance),
    ).toBe("own");
  });

  it("asks about liveness only for another process id", () => {
    expect(
      leaseHolder({ processId: 6, processInstanceId: instance }, 5, instance),
    ).toBe("other_process");
    expect(
      leaseHolder(
        { processId: 6, processInstanceId: "b".repeat(32) },
        5,
        instance,
      ),
    ).toBe("other_process");
  });

  it("treats the same process with another instance as stale", () => {
    expect(
      leaseHolder(
        { processId: 5, processInstanceId: "b".repeat(32) },
        5,
        instance,
      ),
    ).toBe("stale_instance");
  });
});

describe("leaseReadRetryable", () => {
  it("retries unsafe and corrupt leases until the last attempt", () => {
    const unsafe = new Error("CONTEXT_LEASE_UNSAFE");
    const corrupt = new Error("CONTEXT_LEASE_CORRUPT");
    expect(leaseReadRetryable(unsafe, 0, 7)).toBe(true);
    expect(leaseReadRetryable(corrupt, 6, 7)).toBe(true);
    expect(leaseReadRetryable(corrupt, 7, 7)).toBe(false);
  });

  it("never retries other failures", () => {
    expect(
      leaseReadRetryable(new Error("CONTEXT_LEASE_UNSUPPORTED"), 0, 7),
    ).toBe(false);
    expect(leaseReadRetryable("CONTEXT_LEASE_UNSAFE", 0, 7)).toBe(false);
  });
});
