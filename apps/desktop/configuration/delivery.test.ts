import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../../src/apps/desktop/settings/rules";
import type { ProductSettings } from "../../../src/pkg/product-settings/contract";
import type { SettingsStoreChange } from "../bridge/wire";
import {
  settingsStoreSnapshot,
  type SettingsStoreScope,
} from "../settings-store-document";
import {
  WorkspaceEditLeaseLost,
  createSettingsDelivery,
  type SettingsDeliveryPorts,
} from "./delivery";
import type {
  ComputerSettingsPublication,
  ConditionalSettingsWrite,
  WorkspaceEditLeaseGuard,
  WorkspaceEditLeaseHold,
} from "./input";
import type { StoreWriteFence } from "./store";

// The delivery store with every port faked: the settings holder, the service
// queue (a real serial chain, so "while another write is in flight" is real),
// the durable store, the withdrawal hook and the promotion lease. Real
// settings documents and the real change/snapshot mapping drive it, so each
// deadline, revision, conditional-write and fence outcome below is the one the
// Go core receives.

const UUID = "12345678-1234-4234-8234-123456789abc";
const OPERATION = "22345678-1234-4234-8234-123456789abc";
const WORKSPACE = "32345678-1234-4234-8234-123456789abc";
const scope: SettingsStoreScope = { profileId: UUID, ownerId: "owner" };

afterEach(() => {
  vi.restoreAllMocks();
});

const settings = (revision = 1): ProductSettings => ({
  ...defaultSettings(() => UUID),
  revision,
});

const pendingFor = (
  profileId = UUID,
): NonNullable<SettingsStoreChange["next"]> => ({
  backend: "go-owner-v2",
  operationId: OPERATION,
  profileId,
  workspaceId: WORKSPACE,
  relativePath: "file.txt",
  computerGeneration: "1",
  beforeSHA256: "a".repeat(64),
  submittedAt: "2026-11-26T10:00:00.123456789Z",
});

// A change that begins a pending edit from the given document.
const beginning = (
  from: ProductSettings,
  extra: Partial<SettingsStoreChange> = {},
): SettingsStoreChange => ({
  expected: settingsStoreSnapshot(from, scope),
  next: pendingFor(),
  invalidateVerification: false,
  ...extra,
});

// A change that clears the pending edit of the given document.
const clearing = (from: ProductSettings): SettingsStoreChange => ({
  expected: settingsStoreSnapshot(from, scope),
  invalidateVerification: false,
});

const withPending = (revision = 1): ProductSettings => {
  const base = settings(revision);
  return {
    ...base,
    computer: {
      ...base.computer,
      pendingEdit: {
        backend: "go-owner-v2",
        operationId: OPERATION,
        profileId: UUID,
        workspaceId: WORKSPACE,
        relativePath: "file.txt",
        computerGeneration: 1,
        beforeSha256: "a".repeat(64),
        submittedAt: "2026-11-26T10:00:00.123456789Z",
      },
    },
  };
};

type SaveConditional = (
  before: ProductSettings,
  candidate: ProductSettings,
  fence: StoreWriteFence,
) => Promise<ConditionalSettingsWrite>;

function harness(
  initial: ProductSettings | null = settings(),
  options: {
    guard?: WorkspaceEditLeaseGuard;
    withdraw?: () => Promise<ComputerSettingsPublication>;
    changed?: (
      before: ProductSettings,
      candidate: ProductSettings,
      original: ProductSettings,
    ) => Promise<boolean>;
    save?: SaveConditional;
  } = {},
) {
  const state = { current: initial, lost: 0, settled: [] as ProductSettings[] };
  const save: SaveConditional =
    options.save ??
    (async (_before, candidate, fence) => {
      await fence.beforeWrite?.();
      fence.assertBeforePublication?.();
      return { status: "committed", settings: candidate };
    });
  const store = {
    load: vi.fn(async (): Promise<ProductSettings | null> => state.current),
    saveConditional: vi.fn(save),
    fenceConditionalWrites: vi.fn(),
  };
  let tail: Promise<unknown> = Promise.resolve();
  const holder: { withdraw: typeof options.withdraw } = {
    withdraw: options.withdraw,
  };
  const kept = new Map<string, WorkspaceEditLeaseHold>();
  const released: string[] = [];
  const authority = {
    withdrawal: vi.fn(() => holder.withdraw),
    changed: vi.fn(options.changed ?? (async () => false)),
  };
  const leases = {
    guard: options.guard,
    keep: vi.fn((id: string, lease: WorkspaceEditLeaseHold) => {
      kept.set(id, lease);
    }),
    release: vi.fn(async (id: string) => {
      released.push(id);
    }),
  };
  const ports: SettingsDeliveryPorts = {
    store,
    settings: {
      current: () => state.current,
      settle: (next) => {
        state.current = next;
        state.settled.push(next);
      },
      lose: () => {
        state.current = null;
        state.lost += 1;
      },
    },
    exclusive: <T>(work: () => Promise<T>) => {
      const run = tail.then(work);
      tail = run.catch(() => undefined);
      return run;
    },
    authority,
    leases,
  };
  const delivery = createSettingsDelivery(ports);
  return {
    state,
    store,
    holder,
    authority,
    leases,
    kept,
    released,
    delivery,
    adapter: delivery.attach(scope),
  };
}

// A second delivery over the same fakes, not yet attached.
const bare = (h: ReturnType<typeof harness>) =>
  createSettingsDelivery({
    store: h.store,
    settings: {
      current: () => h.state.current,
      settle: () => {},
      lose: () => {},
    },
    exclusive: (work) => work(),
    authority: { withdrawal: () => undefined, changed: async () => false },
    leases: { guard: undefined, keep: () => {}, release: async () => {} },
  });

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const lease = (verify?: () => Promise<boolean>) => {
  const hold = {
    release: vi.fn(async () => undefined),
    ...(verify ? { verify: vi.fn(verify) } : {}),
  } satisfies WorkspaceEditLeaseHold;
  const guard: WorkspaceEditLeaseGuard = {
    acquireForAdmission: vi.fn(async () => hold),
  };
  return { hold, guard };
};

const inFuture = (milliseconds: number) => String(Date.now() + milliseconds);

describe("createSettingsDelivery attach", () => {
  it("binds exactly once", () => {
    const h = harness();
    expect(h.delivery.attached).toBe(true);
    expect(() => h.delivery.attach(scope)).toThrow(
      "SETTINGS_DELIVERY_STORE_ALREADY_BOUND",
    );
  });

  it("starts unattached and unfenced", () => {
    const unattached = bare(harness());
    expect(unattached.attached).toBe(false);
    expect(unattached.fenced).toBe(false);
  });

  it("copies the scope it was given", async () => {
    const mutable = { ...scope };
    const adapter = bare(harness()).attach(mutable);
    mutable.profileId = "not-a-uuid";
    const read = await adapter.read();
    expect(read.status).toBe("ok");
    expect(read.snapshot?.current.profileId).toBe(UUID);
  });
});

describe("settings delivery read", () => {
  it("returns the content-free snapshot when the readback is the current document", async () => {
    const h = harness();
    const result = await h.adapter.read();
    expect(result).toEqual({
      status: "ok",
      snapshot: settingsStoreSnapshot(settings(), scope),
    });
    expect(h.store.load).toHaveBeenCalledOnce();
  });

  it("is unavailable without current settings, without reading the file", async () => {
    const h = harness(null);
    expect(await h.adapter.read()).toEqual({ status: "unavailable" });
    expect(h.store.load).not.toHaveBeenCalled();
  });

  it("is unavailable once fenced", async () => {
    const h = harness();
    h.delivery.latchLoss();
    expect(await h.adapter.read()).toEqual({ status: "unavailable" });
    expect(h.store.load).not.toHaveBeenCalled();
  });

  it("is unavailable when the disk differs from the current document", async () => {
    const h = harness();
    h.store.load.mockResolvedValue(settings(2));
    expect(await h.adapter.read()).toEqual({ status: "unavailable" });
  });

  it("is unavailable when the file is missing or unreadable", async () => {
    const missing = harness();
    missing.store.load.mockResolvedValue(null);
    expect(await missing.adapter.read()).toEqual({ status: "unavailable" });
    const broken = harness();
    broken.store.load.mockRejectedValue(new Error("SETTINGS_UNSAFE"));
    expect(await broken.adapter.read()).toEqual({ status: "unavailable" });
  });

  it("is unsupported for a document the Go store cannot project", async () => {
    const adapter = bare(harness()).attach({
      profileId: "not-a-uuid",
      ownerId: "o",
    });
    expect(await adapter.read()).toEqual({ status: "unsupported" });
  });

  it("reads the settings late, on every call", async () => {
    const h = harness();
    expect((await h.adapter.read()).snapshot?.revision).toBe("1");
    h.state.current = settings(7);
    expect((await h.adapter.read()).snapshot?.revision).toBe("7");
  });

  it("is unavailable when the current settings are lost during the readback", async () => {
    const h = harness();
    h.store.load.mockImplementation(async () => {
      const disk = h.state.current;
      h.state.current = null;
      return disk;
    });
    expect(await h.adapter.read()).toEqual({ status: "unavailable" });
  });

  describe("deadline", () => {
    it("accepts a deadline within the next fifteen seconds", async () => {
      const h = harness();
      expect((await h.adapter.read(inFuture(10_000))).status).toBe("ok");
    });

    it.each([
      ["already expired", () => "1"],
      ["zero", () => "0"],
      ["negative", () => "-5"],
      ["fractional", () => "1.5"],
      ["not a number", () => "soon"],
      ["with leading zeros", () => `0${Date.now() + 5_000}`],
      ["further than fifteen seconds away", () => inFuture(15_500)],
      ["unsafe as an integer", () => "9".repeat(20)],
    ])("is unavailable for a deadline that is %s", async (_name, make) => {
      const h = harness();
      expect(await h.adapter.read(make())).toEqual({ status: "unavailable" });
      expect(h.store.load).not.toHaveBeenCalled();
    });

    it("is unavailable when the deadline passes during the readback", async () => {
      const h = harness();
      const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
      h.store.load.mockImplementation(async () => {
        now.mockReturnValue(2_000_000_000_100);
        return h.state.current;
      });
      expect(await h.adapter.read("2000000000100")).toEqual({
        status: "unavailable",
      });
      expect(h.store.load).toHaveBeenCalledOnce();
    });
  });

  it("queues behind a write in flight", async () => {
    const gate = deferred();
    const h = harness(settings(), {
      save: async (_before, candidate) => {
        await gate.promise;
        return { status: "committed", settings: candidate };
      },
    });
    const replace = h.adapter.replace(beginning(settings()));
    const read = h.adapter.read();
    await Promise.resolve();
    expect(h.store.load).not.toHaveBeenCalled();
    gate.resolve();
    expect((await replace).status).toBe("committed");
    expect((await read).snapshot?.pending?.operationId).toBe(OPERATION);
  });
});

describe("settings delivery replace", () => {
  it("commits the Go-selected change and adopts the written document", async () => {
    const h = harness();
    const result = await h.adapter.replace(beginning(settings()));
    expect(result.status).toBe("committed");
    expect(result.snapshot?.revision).toBe("2");
    expect(result.snapshot?.pending?.operationId).toBe(OPERATION);
    const [before, candidate] = h.store.saveConditional.mock.calls[0]!;
    expect(before).toEqual(settings());
    expect(before).not.toBe(h.state.current);
    expect(candidate.revision).toBe(2);
    expect(h.state.settled).toEqual([candidate]);
    expect(h.delivery.fenced).toBe(false);
  });

  it("is not_written without current settings", async () => {
    const h = harness(null);
    expect(await h.adapter.replace(beginning(settings()))).toEqual({
      status: "not_written",
    });
    expect(h.store.saveConditional).not.toHaveBeenCalled();
  });

  it("is unknown once fenced, before any other check", async () => {
    const h = harness();
    h.delivery.latchLoss();
    expect(await h.adapter.replace(beginning(settings()))).toEqual({
      status: "unknown",
    });
    expect(h.authority.changed).not.toHaveBeenCalled();
    expect(h.store.saveConditional).not.toHaveBeenCalled();
  });

  it("is not_written for a change the wire schema refuses", async () => {
    const h = harness();
    expect(await h.adapter.replace({ nonsense: true })).toEqual({
      status: "not_written",
    });
    expect(h.store.saveConditional).not.toHaveBeenCalled();
  });

  it("is not_written when the expected revision is stale", async () => {
    const h = harness(settings(3));
    expect(await h.adapter.replace(beginning(settings(2)))).toEqual({
      status: "not_written",
    });
    expect(h.store.saveConditional).not.toHaveBeenCalled();
    expect(h.delivery.fenced).toBe(false);
    expect(h.state.current).toEqual(settings(3));
  });

  it("is not_written when the change names another profile", async () => {
    const h = harness();
    const other = "42345678-1234-4234-8234-123456789abc";
    expect(
      await h.adapter.replace(
        beginning(settings(), { next: pendingFor(other) }),
      ),
    ).toEqual({ status: "not_written" });
    expect(h.store.saveConditional).not.toHaveBeenCalled();
  });

  it("is not_written when the scope itself is stale", async () => {
    const h = harness();
    const other = "42345678-1234-4234-8234-123456789abc";
    const stale = {
      ...beginning(settings()),
      expected: settingsStoreSnapshot(settings(), {
        profileId: other,
        ownerId: "owner",
      }),
    };
    expect(await h.adapter.replace(stale)).toEqual({ status: "not_written" });
    expect(h.store.saveConditional).not.toHaveBeenCalled();
  });

  it("captures the caller's bytes before the change joins the queue", async () => {
    const gate = deferred();
    const h = harness();
    h.store.load.mockImplementationOnce(async () => {
      await gate.promise;
      return h.state.current;
    });
    const blocker = h.adapter.read();
    const change = beginning(settings());
    const queued = h.adapter.replace(change);
    // A mutation after the call must not reach the queued write.
    (change.expected as { revision: string }).revision = "99";
    gate.resolve();
    await blocker;
    expect((await queued).status).toBe("committed");
  });

  describe("deadline", () => {
    it("is not_written before any work for an expired deadline", async () => {
      const h = harness();
      expect(await h.adapter.replace(beginning(settings()), "1")).toEqual({
        status: "not_written",
      });
      expect(h.authority.changed).not.toHaveBeenCalled();
      expect(h.store.saveConditional).not.toHaveBeenCalled();
    });

    it("is not_written when the deadline passes during the authority comparison", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
      const h = harness(settings(), {
        changed: async () => {
          now.mockReturnValue(2_000_000_000_100);
          return false;
        },
      });
      expect(
        await h.adapter.replace(beginning(settings()), "2000000000100"),
      ).toEqual({ status: "not_written" });
      expect(h.store.saveConditional).not.toHaveBeenCalled();
      expect(h.delivery.fenced).toBe(false);
    });

    it("keeps the write unpublished when the deadline passes before publication", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
      const h = harness(settings(), {
        save: async (_before, candidate, fence) => {
          await fence.beforeWrite?.();
          now.mockReturnValue(2_000_000_000_100);
          fence.assertBeforePublication?.();
          return { status: "committed", settings: candidate };
        },
      });
      const result = await h.adapter.replace(
        beginning(settings()),
        "2000000000100",
      );
      // The store was reached, so the outcome can no longer be proven absent.
      expect(result).toEqual({ status: "unknown" });
      expect(h.delivery.fenced).toBe(true);
      expect(h.state.settled).toEqual([]);
    });

    it("is unknown when the deadline passes after the write landed", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
      const h = harness(settings(), {
        save: async (_before, candidate) => {
          now.mockReturnValue(2_000_000_000_100);
          return { status: "committed", settings: candidate };
        },
      });
      expect(
        await h.adapter.replace(beginning(settings()), "2000000000100"),
      ).toEqual({ status: "unknown" });
      expect(h.delivery.fenced).toBe(true);
      expect(h.state.settled).toEqual([]);
    });
  });

  describe("conditional write", () => {
    it("returns not_written untouched and stays unfenced", async () => {
      const h = harness(settings(), {
        save: async () => ({ status: "not_written" }),
      });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "not_written",
      });
      expect(h.delivery.fenced).toBe(false);
      expect(h.store.fenceConditionalWrites).not.toHaveBeenCalled();
      expect(h.state.current).toEqual(settings());
      expect(h.state.settled).toEqual([]);
    });

    it("preserves an unknown outcome: latches, fences the writer and withdraws", async () => {
      const withdraw = vi.fn(async () => ({ publish: async () => undefined }));
      const h = harness(settings(), {
        withdraw,
        save: async () => ({ status: "unknown" }),
      });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "unknown",
      });
      expect(h.delivery.fenced).toBe(true);
      expect(h.store.fenceConditionalWrites).toHaveBeenCalled();
      expect(h.state.current).toBeNull();
      expect(h.state.settled).toEqual([]);
      expect(withdraw).toHaveBeenCalledOnce();
    });

    it("treats a throw after the store was called as unknown", async () => {
      const h = harness(settings(), {
        save: async () => {
          throw new Error("rename failed");
        },
      });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "unknown",
      });
      expect(h.delivery.fenced).toBe(true);
    });

    it("treats a throw before the store was called as not_written", async () => {
      const h = harness(settings(), {
        changed: async () => {
          throw new Error("TASK_CURRENT_SETTINGS_UNAVAILABLE");
        },
      });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "not_written",
      });
      expect(h.store.saveConditional).not.toHaveBeenCalled();
      expect(h.delivery.fenced).toBe(false);
    });

    it("refuses at the write when the settings changed since admission", async () => {
      const h = harness(settings(), {
        save: async (_before, candidate, fence) => {
          h.state.current = settings(5);
          await fence.beforeWrite?.();
          return { status: "committed", settings: candidate };
        },
      });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "unknown",
      });
      expect(h.state.settled).toEqual([]);
    });

    it("refuses before the rename when the delivery fenced in between", async () => {
      const h = harness(settings(), {
        save: async (_before, candidate, fence) => {
          await fence.beforeWrite?.();
          h.delivery.latchLoss();
          fence.assertBeforePublication?.();
          return { status: "committed", settings: candidate };
        },
      });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "unknown",
      });
      expect(h.state.settled).toEqual([]);
    });

    it("never adopts a write that landed after the loss was latched", async () => {
      const h = harness(settings(), {
        save: async (_before, candidate) => {
          h.delivery.latchLoss();
          return { status: "committed", settings: candidate };
        },
      });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "unknown",
      });
      expect(h.state.settled).toEqual([]);
      expect(h.state.current).toBeNull();
    });
  });

  describe("computer authority", () => {
    it("withdraws, writes, then publishes exactly the written document", async () => {
      const order: string[] = [];
      const publish = vi.fn(async (written: ProductSettings) => {
        order.push(`publish:${written.revision}`);
      });
      const h = harness(settings(), {
        changed: async () => true,
        withdraw: async () => {
          order.push("withdraw");
          return { publish };
        },
        save: async (_before, candidate) => {
          order.push("save");
          return { status: "committed", settings: candidate };
        },
      });
      const result = await h.adapter.replace(beginning(settings()));
      expect(result.status).toBe("committed");
      expect(order).toEqual(["withdraw", "save", "publish:2"]);
    });

    it("does not withdraw when the authority did not change", async () => {
      const withdraw = vi.fn(async () => ({ publish: async () => undefined }));
      const h = harness(settings(), { withdraw });
      await h.adapter.replace(beginning(settings()));
      expect(withdraw).not.toHaveBeenCalled();
    });

    it("does not withdraw when no publication owner is attached", async () => {
      const h = harness(settings(), { changed: async () => true });
      expect((await h.adapter.replace(beginning(settings()))).status).toBe(
        "committed",
      );
    });

    it("reads the withdrawal hook late", async () => {
      const withdraw = vi.fn(async () => ({ publish: async () => undefined }));
      const h = harness(settings(), { changed: async () => true });
      h.holder.withdraw = withdraw;
      await h.adapter.replace(beginning(settings()));
      expect(withdraw).toHaveBeenCalledOnce();
    });

    it("retains a failed withdrawal as unknown without writing or retrying", async () => {
      const failure = new Error("withdrawal reply lost");
      const withdraw = vi.fn(async () => {
        throw failure;
      });
      const h = harness(settings(), { changed: async () => true, withdraw });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "unknown",
      });
      expect(h.store.saveConditional).not.toHaveBeenCalled();
      expect(h.delivery.fenced).toBe(true);
      // The very same failure is what the fence reports; it is not retried.
      await expect(h.adapter.fence()).rejects.toBe(failure);
      expect(withdraw).toHaveBeenCalledOnce();
    });

    it("retains a failed publication as unknown", async () => {
      const failure = new Error("publication lost");
      const h = harness(settings(), {
        changed: async () => true,
        withdraw: async () => ({
          publish: async () => {
            throw failure;
          },
        }),
      });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "unknown",
      });
      expect(h.state.settled).toEqual([]);
      await expect(h.adapter.fence()).rejects.toBe(failure);
    });

    it("never publishes a write that landed after the loss was latched", async () => {
      const publish = vi.fn(async () => undefined);
      const h = harness(settings(), {
        changed: async () => true,
        withdraw: async () => ({ publish }),
        save: async (_before, candidate) => {
          h.delivery.latchLoss();
          return { status: "committed", settings: candidate };
        },
      });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "unknown",
      });
      expect(publish).not.toHaveBeenCalled();
      expect(h.state.settled).toEqual([]);
    });

    it("is unknown when the fence latches while the withdrawal is awaited", async () => {
      const gate = deferred<ComputerSettingsPublication>();
      const h = harness(settings(), {
        changed: async () => true,
        withdraw: () => gate.promise,
      });
      const replace = h.adapter.replace(beginning(settings()));
      await vi.waitFor(() => expect(h.authority.withdrawal).toHaveBeenCalled());
      h.delivery.latchLoss();
      gate.resolve({ publish: async () => undefined });
      expect(await replace).toEqual({ status: "unknown" });
      expect(h.store.saveConditional).not.toHaveBeenCalled();
    });
  });

  describe("promotion lease", () => {
    it("holds the lease of a beginning edit through the commit", async () => {
      const { hold, guard } = lease(async () => true);
      const h = harness(settings(), { guard });
      const result = await h.adapter.replace(beginning(settings()));
      expect(result.status).toBe("committed");
      expect(hold.verify).toHaveBeenCalledTimes(2);
      expect(h.leases.keep).toHaveBeenCalledWith(OPERATION, hold);
      expect(hold.release).not.toHaveBeenCalled();
    });

    it("takes no lease for an edit that does not begin", async () => {
      const { guard } = lease();
      const h = harness(withPending(), { guard });
      await h.adapter.replace(clearing(withPending()));
      expect(guard.acquireForAdmission).not.toHaveBeenCalled();
    });

    it("is not_written, releasing, when no lease could be acquired", async () => {
      const guard: WorkspaceEditLeaseGuard = {
        acquireForAdmission: vi.fn(async () => null),
      };
      const h = harness(settings(), { guard });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "not_written",
      });
      expect(h.store.saveConditional).not.toHaveBeenCalled();
    });

    it("is not_written, releasing, when the lease no longer verifies", async () => {
      const { hold, guard } = lease(async () => false);
      const h = harness(settings(), { guard });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "not_written",
      });
      expect(h.store.saveConditional).not.toHaveBeenCalled();
      expect(hold.release).toHaveBeenCalledOnce();
    });

    it("is unknown, releasing, when the lease is lost at the write", async () => {
      const verify = vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const { hold, guard } = lease(verify);
      const seen: unknown[] = [];
      const h = harness(settings(), {
        guard,
        save: async (_before, candidate, fence) => {
          try {
            await fence.beforeWrite?.();
          } catch (error) {
            seen.push(error);
            throw error;
          }
          return { status: "committed", settings: candidate };
        },
      });
      expect(await h.adapter.replace(beginning(settings()))).toEqual({
        status: "unknown",
      });
      expect(seen[0]).toBeInstanceOf(WorkspaceEditLeaseLost);
      expect((seen[0] as Error).message).toBe(
        "WORKSPACE_MUTATION_PROMOTION_PENDING",
      );
      expect(hold.release).toHaveBeenCalledOnce();
      expect(h.leases.keep).not.toHaveBeenCalled();
    });

    it("releases the lease of a not_written write", async () => {
      const { hold, guard } = lease(async () => true);
      const h = harness(settings(), {
        guard,
        save: async () => ({ status: "not_written" }),
      });
      await h.adapter.replace(beginning(settings()));
      expect(hold.release).toHaveBeenCalledOnce();
      expect(h.leases.keep).not.toHaveBeenCalled();
    });

    it("releases the stored hold when the commit clears the pending edit", async () => {
      const h = harness(withPending());
      const result = await h.adapter.replace(clearing(withPending()));
      expect(result.status).toBe("committed");
      expect(result.snapshot?.pending).toBeUndefined();
      expect(h.released).toEqual([OPERATION]);
    });

    it("does not release a hold while the pending edit remains", async () => {
      const h = harness(settings());
      await h.adapter.replace(beginning(settings()));
      expect(h.released).toEqual([]);
    });
  });
});

describe("settings delivery fence", () => {
  it("latches loss synchronously, before the queued withdrawal runs", async () => {
    const gate = deferred();
    const h = harness(settings(), {
      save: async (_before, candidate) => {
        await gate.promise;
        return { status: "committed", settings: candidate };
      },
    });
    const replace = h.adapter.replace(beginning(settings()));
    await vi.waitFor(() => expect(h.store.saveConditional).toHaveBeenCalled());
    const fence = h.adapter.fence();
    // The write has not returned and the fence has not run, yet the loss is
    // already marked: the queued withdrawal is not the first loss marker.
    expect(h.delivery.fenced).toBe(true);
    expect(h.store.fenceConditionalWrites).toHaveBeenCalled();
    expect(h.state.current).toBeNull();
    gate.resolve();
    expect(await replace).toEqual({ status: "unknown" });
    await expect(fence).resolves.toBeUndefined();
    expect(h.state.settled).toEqual([]);
  });

  it("withdraws exactly once however often it is fenced", async () => {
    const withdraw = vi.fn(async () => ({ publish: async () => undefined }));
    const h = harness(settings(), { withdraw });
    await h.adapter.fence();
    await h.adapter.fence();
    await h.delivery.latchLoss();
    await h.adapter.fence();
    expect(withdraw).toHaveBeenCalledOnce();
    expect(h.delivery.fenced).toBe(true);
  });

  it("resolves without a publication owner attached", async () => {
    const h = harness();
    await expect(h.adapter.fence()).resolves.toBeUndefined();
    expect(h.delivery.fenced).toBe(true);
  });

  it("does not call the host owner again after a held withdrawal", async () => {
    const withdraw = vi.fn(async () => ({ publish: async () => undefined }));
    const h = harness(settings(), { withdraw });
    h.delivery.holdWithdrawal(true);
    await h.adapter.fence();
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("withdraws again when a published withdrawal is no longer held", async () => {
    const withdraw = vi.fn(async () => ({ publish: async () => undefined }));
    const h = harness(settings(), { changed: async () => true, withdraw });
    expect((await h.adapter.replace(beginning(settings()))).status).toBe(
      "committed",
    );
    expect(withdraw).toHaveBeenCalledTimes(1);
    await h.adapter.fence();
    expect(withdraw).toHaveBeenCalledTimes(2);
  });

  it("reports a failed withdrawal and keeps reporting that same outcome", async () => {
    const failure = new Error("host owner locked");
    const withdraw = vi.fn(async () => {
      throw failure;
    });
    const h = harness(settings(), { withdraw });
    await expect(h.adapter.fence()).rejects.toBe(failure);
    await expect(h.adapter.fence()).rejects.toBe(failure);
    expect(withdraw).toHaveBeenCalledOnce();
  });

  it("after a committed replace, withdraws authority and refuses further delivery", async () => {
    const h = harness();
    expect((await h.adapter.replace(beginning(settings()))).status).toBe(
      "committed",
    );
    await h.adapter.fence();
    expect(h.delivery.fenced).toBe(true);
    expect(h.state.current).toBeNull();
    expect(await h.adapter.read()).toEqual({ status: "unavailable" });
    expect(await h.adapter.replace(clearing(withPending()))).toEqual({
      status: "unknown",
    });
  });

  it("queues behind a write that is already in flight", async () => {
    const gate = deferred();
    const order: string[] = [];
    const withdraw = vi.fn(async () => {
      order.push("withdraw");
      return { publish: async () => undefined };
    });
    const h = harness(settings(), {
      withdraw,
      save: async (_before, candidate) => {
        order.push("save");
        await gate.promise;
        order.push("saved");
        return { status: "committed", settings: candidate };
      },
    });
    const replace = h.adapter.replace(beginning(settings()));
    await vi.waitFor(() => expect(order).toEqual(["save"]));
    const fence = h.adapter.fence();
    await Promise.resolve();
    expect(order).toEqual(["save"]);
    gate.resolve();
    await Promise.all([replace, fence]);
    expect(order).toEqual(["save", "saved", "withdraw"]);
  });
});

describe("settings delivery service hooks", () => {
  it("asserts the expected settings are still current and unfenced", () => {
    const h = harness();
    const current = h.state.current!;
    expect(() => h.delivery.assertCurrent(current)).not.toThrow();
    expect(() => h.delivery.assertCurrent(settings())).toThrow(
      "TASK_SETTINGS_SOURCE_CHANGED",
    );
    h.delivery.latchLoss();
    expect(() => h.delivery.assertCurrent(current)).toThrow(
      "TASK_SETTINGS_SOURCE_CHANGED",
    );
  });

  it("latches loss through the store and the settings holder together", () => {
    const h = harness();
    h.delivery.latchLoss();
    expect(h.delivery.fenced).toBe(true);
    expect(h.store.fenceConditionalWrites).toHaveBeenCalledOnce();
    expect(h.state.lost).toBe(1);
  });

  it("retains an authority failure as the fence outcome and latches loss", async () => {
    const h = harness();
    const failure = new Error("authority failed");
    h.delivery.retainAuthorityFailure(failure);
    expect(h.delivery.fenced).toBe(true);
    await expect(h.adapter.fence()).rejects.toBe(failure);
  });
});
