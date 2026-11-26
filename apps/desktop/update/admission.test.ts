import { describe, expect, it, vi } from "vitest";
import {
  createAdmissionGate,
  recheckAdmission,
  type Admission,
  type HeldAdmission,
} from "./admission";

const RELEASE = "UPDATE_BROWSER_RELEASE_UNCONFIRMED";

const held = (over: Partial<HeldAdmission> = {}): HeldAdmission => ({
  ok: true,
  release: async () => undefined,
  ...over,
});

const gate = (acquire: (...args: unknown[]) => Promise<Admission>) => {
  const drained = vi.fn(async (_beforeEffect: () => void) => true);
  const port = vi.fn(acquire);
  return {
    drained,
    port,
    gate: createAdmissionGate<string, string>({
      acquire: (...args) => port(...args),
      drained,
    }),
  };
};

describe("admission recheck", () => {
  it("is idle when the admission has no recheck", async () => {
    expect(await recheckAdmission(held())).toEqual({ ok: true });
  });

  it("returns the recheck's own answer, refusal included", async () => {
    expect(
      await recheckAdmission(held({ recheck: async () => ({ ok: true }) })),
    ).toEqual({ ok: true });
    expect(
      await recheckAdmission(
        held({ recheck: async () => ({ ok: false, code: "BUSY" }) }),
      ),
    ).toEqual({ ok: false, code: "BUSY" });
  });

  it("fails closed when the recheck throws", async () => {
    expect(
      await recheckAdmission(
        held({
          recheck: async () => {
            throw new Error("boom");
          },
        }),
      ),
    ).toEqual({ ok: false, code: "UPDATE_BROWSER_STATE_UNKNOWN" });
  });
});

describe("admission acquire", () => {
  it("passes only the arguments the caller supplied", async () => {
    const { gate: g, port } = gate(async () => held());
    await g.acquire();
    await g.acquire(undefined, "quit");
    await g.acquire(undefined, "quit", "confirm");
    await g.acquire(undefined, undefined, "confirm");
    expect(port.mock.calls.map((call) => call.length)).toEqual([1, 2, 3, 3]);
    expect(port.mock.calls[1]![1]).toBe("quit");
    expect(port.mock.calls[3]![1]).toBeUndefined();
    expect(port.mock.calls[3]![2]).toBe("confirm");
  });

  it("probes the drain with the caller's beforeEffect", async () => {
    const beforeEffect = vi.fn();
    const { gate: g, port, drained } = gate(async () => held());
    await g.acquire(beforeEffect);
    expect(beforeEffect).toHaveBeenCalledTimes(1);
    const settled = port.mock.calls[0]![0] as () => Promise<boolean>;
    expect(await settled()).toBe(true);
    expect(drained).toHaveBeenCalledWith(beforeEffect);
  });

  it("returns an admitted lease untouched", async () => {
    const admission = held();
    const { gate: g } = gate(async () => admission);
    expect(await g.acquire()).toBe(admission);
    expect(g.releaseUnconfirmed()).toBe(false);
  });

  it("passes an ordinary refusal through without latching", async () => {
    const { gate: g, port } = gate(async () => ({ ok: false, code: "BUSY" }));
    expect(await g.acquire()).toEqual({ ok: false, code: "BUSY" });
    expect(g.releaseUnconfirmed()).toBe(false);
    await g.acquire();
    expect(port).toHaveBeenCalledTimes(2);
  });

  it("latches an unconfirmed release and refuses every later acquire", async () => {
    const { gate: g, port } = gate(async () => ({ ok: false, code: RELEASE }));
    expect(await g.acquire()).toEqual({ ok: false, code: RELEASE });
    expect(g.releaseUnconfirmed()).toBe(true);
    expect(await g.acquire()).toEqual({ ok: false, code: RELEASE });
    expect(port).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the host acquire throws", async () => {
    const { gate: g, port } = gate(async () => {
      throw new Error("lease");
    });
    expect(await g.acquire()).toEqual({ ok: false, code: RELEASE });
    expect(g.releaseUnconfirmed()).toBe(true);
    expect(await g.acquire()).toEqual({ ok: false, code: RELEASE });
    expect(port).toHaveBeenCalledTimes(1);
  });

  it("fails closed when beforeEffect throws, before any acquire", async () => {
    const { gate: g, port } = gate(async () => held());
    const result = await g.acquire(() => {
      throw new Error("inactive");
    });
    expect(result).toEqual({ ok: false, code: RELEASE });
    expect(g.releaseUnconfirmed()).toBe(true);
    expect(port).not.toHaveBeenCalled();
  });
});

describe("admission settle", () => {
  const blocked = { status: "blocked", code: "X" } as const;

  it("releases an admission that nothing keeps", async () => {
    const release = vi.fn(async () => undefined);
    const { gate: g } = gate(async () => held());
    const outcome = await g.settle(
      held({ release }),
      () => false,
      async () => blocked,
      () => "UNEXPECTED",
    );
    expect(outcome).toBe(blocked);
    expect(release).toHaveBeenCalledTimes(1);
    expect(g.held()).toBe(false);
    expect(g.releaseUnconfirmed()).toBe(false);
  });

  it("keeps and holds the admission when asked, without releasing", async () => {
    const release = vi.fn(async () => undefined);
    const { gate: g } = gate(async () => held());
    const outcome = await g.settle(
      held({ release }),
      () => true,
      async () => ({ status: "accepted" }),
      () => "UNEXPECTED",
    );
    expect(outcome).toEqual({ status: "accepted" });
    expect(release).not.toHaveBeenCalled();
    expect(g.held()).toBe(true);
  });

  it("classifies a throwing attempt as unknown and still settles", async () => {
    const release = vi.fn(async () => undefined);
    const { gate: g } = gate(async () => held());
    const outcome = await g.settle(
      held({ release }),
      () => false,
      async () => {
        throw new Error("cleanup");
      },
      () => "UNEXPECTED",
    );
    expect(outcome).toEqual({ status: "unknown", code: "UNEXPECTED" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reads keep after the attempt, so a late decision holds the lease", async () => {
    let keep = false;
    const release = vi.fn(async () => undefined);
    const { gate: g } = gate(async () => held());
    await g.settle(
      held({ release }),
      () => keep,
      async () => {
        keep = true;
        return blocked;
      },
      () => "UNEXPECTED",
    );
    expect(release).not.toHaveBeenCalled();
    expect(g.held()).toBe(true);
  });

  it("holds the lease and latches when release throws on a blocked outcome", async () => {
    const { gate: g } = gate(async () => held());
    const outcome = await g.settle(
      held({
        release: async () => {
          throw new Error("release");
        },
      }),
      () => false,
      async () => blocked,
      () => "UNEXPECTED",
    );
    expect(outcome).toEqual({ status: "blocked", code: RELEASE });
    expect(g.held()).toBe(true);
    expect(g.releaseUnconfirmed()).toBe(true);
  });

  it("keeps a classified unknown outcome when release throws", async () => {
    const unknown = { status: "unknown", code: "HANDOFF" } as const;
    const { gate: g } = gate(async () => held());
    const outcome = await g.settle(
      held({
        release: async () => {
          throw new Error("release");
        },
      }),
      () => false,
      async () => unknown,
      () => "UNEXPECTED",
    );
    expect(outcome).toBe(unknown);
    expect(g.held()).toBe(true);
    expect(g.releaseUnconfirmed()).toBe(true);
  });

  it("replaces an accepted outcome when release throws", async () => {
    const { gate: g } = gate(async () => held());
    const outcome = await g.settle(
      held({
        release: async () => {
          throw new Error("release");
        },
      }),
      () => false,
      async () => ({ status: "accepted" }),
      () => "UNEXPECTED",
    );
    expect(outcome).toEqual({ status: "blocked", code: RELEASE });
  });
});

describe("admission hold", () => {
  it("tracks the held lease and clears it", () => {
    const { gate: g } = gate(async () => held());
    expect(g.held()).toBe(false);
    g.hold(held());
    expect(g.held()).toBe(true);
    g.hold(null);
    expect(g.held()).toBe(false);
  });
});
