import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromotionLeaseHandle } from "../../src/apps/desktop/promotion-lease";

const nativePorts = vi.hoisted(() => ({
  acquire: vi.fn(),
  verify: vi.fn(),
  release: vi.fn(),
}));

// No kernel, filesystem, app or provider is exercised, including default wiring.
vi.mock("../../src/apps/desktop/promotion-lease", () => ({
  acquirePromotionLease: nativePorts.acquire,
  verifyPromotionLease: nativePorts.verify,
  releasePromotionLease: nativePorts.release,
}));

import {
  StartupPromotionLeaseReleaseError,
  withStartupPromotionLease,
  type StartupPromotionLeasePorts,
} from "../../src/apps/desktop/startup-promotion-lease";

const userData = "/fixture/startup-user-data";
const generation = "current-startup-generation";

function fixture() {
  const events: string[] = [];
  const lease: PromotionLeaseHandle = Object.freeze({
    file: `${userData}/farol-next-state/promotion.lease`,
    record: Object.freeze({
      schema: 1,
      generation,
      role: "admission",
      pid: 101,
      nonce: "fixture-nonce",
      acquiredAt: "2026-10-06T00:00:00.000Z",
    }),
  });
  let held = false;
  const ports = {
    acquire: vi.fn<StartupPromotionLeasePorts["acquire"]>(async () => {
      events.push("acquire");
      held = true;
      return lease;
    }),
    verify: vi.fn<StartupPromotionLeasePorts["verify"]>(async (handle) => {
      events.push("verify");
      return held && handle === lease;
    }),
    release: vi.fn<StartupPromotionLeasePorts["release"]>(async (handle) => {
      expect(handle).toBe(lease);
      events.push("release");
      held = false;
    }),
  } satisfies StartupPromotionLeasePorts;
  return { lease, ports, events, held: () => held };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("startup promotion exclusion (pure consumer-port fixtures)", () => {
  it("refuses a held promotion before any critical callback and does not retry", async () => {
    const { ports } = fixture();
    ports.acquire.mockResolvedValue(null);
    const critical = vi.fn(async () => true);
    await expect(
      withStartupPromotionLease(userData, generation, critical, ports),
    ).rejects.toThrow("STARTUP_PROMOTION_BUSY");
    expect(critical).not.toHaveBeenCalled();
    expect(ports.acquire).toHaveBeenCalledExactlyOnceWith(
      userData,
      generation,
      "admission",
    );
    expect(ports.verify).not.toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("refuses a lost initial fence before work and releases the acquired handle once", async () => {
    const { ports, lease } = fixture();
    ports.verify.mockResolvedValue(false);
    const critical = vi.fn(async () => true);
    await expect(
      withStartupPromotionLease(userData, generation, critical, ports),
    ).rejects.toThrow("STARTUP_PROMOTION_LEASE_LOST");
    expect(critical).not.toHaveBeenCalled();
    expect(ports.acquire).toHaveBeenCalledTimes(1);
    expect(ports.verify).toHaveBeenCalledExactlyOnceWith(lease);
    expect(ports.release).toHaveBeenCalledExactlyOnceWith(lease);
  });

  it.each([true, false])(
    "returns previousRunClean=%s after exact acquire/verify/work/final-fence/release order",
    async (previousRunClean) => {
      const { ports, lease, events } = fixture();
      const result: boolean = await withStartupPromotionLease(
        userData,
        generation,
        async (verify) => {
          events.push("work");
          expect(await verify()).toBe(true);
          events.push("write");
          return previousRunClean;
        },
        ports,
      );
      expect(result).toBe(previousRunClean);
      expect(events).toEqual([
        "acquire",
        "verify",
        "work",
        "verify",
        "write",
        "release",
      ]);
      expect(ports.acquire).toHaveBeenCalledExactlyOnceWith(
        userData,
        generation,
        "admission",
      );
      expect(ports.verify.mock.calls).toEqual([[lease], [lease]]);
      expect(ports.release).toHaveBeenCalledExactlyOnceWith(lease);
    },
  );

  it("retains the same lease across blocked readiness and marker publication", async () => {
    const { ports, lease, held, events } = fixture();
    const entered = deferred();
    const ready = deferred();
    const writing = deferred();
    const written = deferred();
    let completed = false;
    const startup = withStartupPromotionLease(
      userData,
      generation,
      async (verify) => {
        entered.resolve();
        await ready.promise;
        events.push("presence");
        expect(await verify()).toBe(true);
        events.push("write-start");
        writing.resolve();
        await written.promise;
        events.push("write-complete");
        return true;
      },
      ports,
    ).then((value) => {
      completed = true;
      return value;
    });
    await entered.promise;
    expect(held()).toBe(true);
    expect(events).toEqual(["acquire", "verify"]);
    expect(ports.release).not.toHaveBeenCalled();
    ready.resolve();
    await writing.promise;
    expect(held()).toBe(true);
    expect(completed).toBe(false);
    expect(ports.release).not.toHaveBeenCalled();
    expect(ports.acquire).toHaveBeenCalledTimes(1);
    expect(ports.verify.mock.calls).toEqual([[lease], [lease]]);
    written.resolve();
    await expect(startup).resolves.toBe(true);
    expect(held()).toBe(false);
    expect(events.slice(-2)).toEqual(["write-complete", "release"]);
    expect(ports.release).toHaveBeenCalledExactlyOnceWith(lease);
  });

  it("preserves the original work failure and releases once without another acquire", async () => {
    const { ports, lease } = fixture();
    const failure = new Error("marker presence outcome unknown");
    await expect(
      withStartupPromotionLease(
        userData,
        generation,
        async () => {
          throw failure;
        },
        ports,
      ),
    ).rejects.toBe(failure);
    expect(ports.release).toHaveBeenCalledExactlyOnceWith(lease);
    expect(ports.acquire).toHaveBeenCalledTimes(1);
  });

  it("does not admit configuration until the one release has completed", async () => {
    const { ports, lease } = fixture();
    const releasing = deferred();
    const released = deferred();
    ports.release.mockImplementation(async () => {
      releasing.resolve();
      await released.promise;
    });
    const initialize = vi.fn();
    const startup = withStartupPromotionLease(
      userData,
      generation,
      async () => true,
      ports,
    ).then(initialize);
    await releasing.promise;
    expect(initialize).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledExactlyOnceWith(lease);
    released.resolve();
    await startup;
    expect(initialize).toHaveBeenCalledExactlyOnceWith(true);
    expect(ports.acquire).toHaveBeenCalledTimes(1);
  });

  it("preserves a thrown verify failure, invokes no work and releases once", async () => {
    const { ports, lease } = fixture();
    const failure = new Error("fence unreadable");
    ports.verify.mockRejectedValue(failure);
    const critical = vi.fn(async () => true);
    await expect(
      withStartupPromotionLease(userData, generation, critical, ports),
    ).rejects.toBe(failure);
    expect(critical).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledExactlyOnceWith(lease);
  });

  it("does not release or retry after an acquire failure with unknown outcome", async () => {
    const { ports } = fixture();
    const failure = new Error("acquire outcome unknown");
    ports.acquire.mockRejectedValue(failure);
    const critical = vi.fn(async () => true);
    await expect(
      withStartupPromotionLease(userData, generation, critical, ports),
    ).rejects.toBe(failure);
    expect(critical).not.toHaveBeenCalled();
    expect(ports.acquire).toHaveBeenCalledTimes(1);
    expect(ports.verify).not.toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("exposes the original final verifier so the consumer refuses a write after fence loss", async () => {
    const { ports, lease } = fixture();
    ports.verify.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const write = vi.fn();
    await expect(
      withStartupPromotionLease(
        userData,
        generation,
        async (verify) => {
          if (!(await verify())) throw new Error("marker fence lost");
          write();
          return true;
        },
        ports,
      ),
    ).rejects.toThrow("marker fence lost");
    expect(write).not.toHaveBeenCalled();
    expect(ports.verify.mock.calls).toEqual([[lease], [lease]]);
    expect(ports.acquire).toHaveBeenCalledTimes(1);
    expect(ports.release).toHaveBeenCalledExactlyOnceWith(lease);
  });

  it("refuses successful work when release fails, keeping that failure visible", async () => {
    const { ports, lease } = fixture();
    const releaseFailure = new Error("release outcome unknown");
    ports.release.mockRejectedValue(releaseFailure);
    const admission = vi.fn();
    const startup = withStartupPromotionLease(
      userData,
      generation,
      async () => true,
      ports,
    ).then(admission);
    await expect(startup).rejects.toMatchObject({
      name: "StartupPromotionLeaseReleaseError",
      message: "STARTUP_PROMOTION_LEASE_RELEASE_FAILED",
      cause: releaseFailure,
      primaryFailure: undefined,
      releaseFailure,
      errors: [releaseFailure],
    });
    expect(admission).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledExactlyOnceWith(lease);
    expect(ports.acquire).toHaveBeenCalledTimes(1);
  });

  it.each([new Error("marker write failed"), undefined, null])(
    "reports the original work failure separately from release failure (%s)",
    async (primaryError) => {
      const { ports, lease } = fixture();
      const releaseFailure = new Error("release outcome unknown");
      ports.release.mockRejectedValue(releaseFailure);
      const startup = withStartupPromotionLease(
        userData,
        generation,
        async () => {
          throw primaryError;
        },
        ports,
      );
      await expect(startup).rejects.toBeInstanceOf(
        StartupPromotionLeaseReleaseError,
      );
      await expect(startup).rejects.toMatchObject({
        cause: primaryError,
        primaryFailure: { error: primaryError },
        releaseFailure,
        errors: [primaryError, releaseFailure],
      });
      expect(ports.release).toHaveBeenCalledExactlyOnceWith(lease);
      expect(ports.acquire).toHaveBeenCalledTimes(1);
    },
  );

  it("composes defaults directly from the existing acquire, verify and release", async () => {
    const { lease } = fixture();
    nativePorts.acquire.mockResolvedValue(lease);
    nativePorts.verify.mockResolvedValue(true);
    nativePorts.release.mockResolvedValue(undefined);
    await expect(
      withStartupPromotionLease(userData, generation, async (verify) => {
        expect(await verify()).toBe(true);
        return false;
      }),
    ).resolves.toBe(false);
    expect(nativePorts.acquire).toHaveBeenCalledExactlyOnceWith(
      userData,
      generation,
      "admission",
    );
    expect(nativePorts.verify.mock.calls).toEqual([[lease], [lease]]);
    expect(nativePorts.release).toHaveBeenCalledExactlyOnceWith(lease);
  });

  it("prevents publication during a simulated held promotion; removing the guard publishes", async () => {
    // A promotion actor already holds the shared exclusion. Marker publication
    // itself has no lock: this scenario must detect an unguarded startup.
    function scenario() {
      const { ports, lease } = fixture();
      let promotionHeld = true;
      const originalMarker = Object.freeze({ status: "unknown", pid: 202 });
      let marker: object = originalMarker;
      const presence = vi.fn(() => marker !== null);
      const publish = vi.fn(() => {
        marker = { generation, pid: 101 };
      });
      ports.acquire.mockImplementation(async () =>
        promotionHeld ? null : lease,
      );
      const critical = vi.fn(async () => {
        presence();
        publish();
        return false;
      });
      return {
        ports,
        critical,
        presence,
        publish,
        marker: () => marker,
        originalMarker,
        promotionHeld: () => promotionHeld,
        finishPromotion: () => {
          promotionHeld = false;
        },
      };
    }

    const guarded = scenario();
    await expect(
      withStartupPromotionLease(
        userData,
        generation,
        guarded.critical,
        guarded.ports,
      ),
    ).rejects.toThrow("STARTUP_PROMOTION_BUSY");
    expect(guarded.promotionHeld()).toBe(true);
    expect(guarded.critical).not.toHaveBeenCalled();
    expect(guarded.presence).not.toHaveBeenCalled();
    expect(guarded.publish).not.toHaveBeenCalled();
    expect(guarded.marker()).toBe(guarded.originalMarker);
    guarded.finishPromotion();
    await Promise.resolve();
    expect(guarded.critical).not.toHaveBeenCalled();
    expect(guarded.ports.acquire).toHaveBeenCalledTimes(1);
    expect(guarded.ports.release).not.toHaveBeenCalled();

    // Negative control uses the same marker callback with the wrapper omitted.
    const unguarded = scenario();
    await unguarded.critical();
    expect(unguarded.promotionHeld()).toBe(true);
    expect(unguarded.publish).toHaveBeenCalledTimes(1);
    expect(unguarded.marker()).not.toBe(unguarded.originalMarker);
    expect(unguarded.ports.acquire).not.toHaveBeenCalled();
  });
});
