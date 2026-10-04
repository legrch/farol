import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
  type ProductConfigurationDependencies,
} from "../../src/apps/desktop/product-configuration";
import { settingsStoreSnapshot } from "../../apps/desktop/settings-store-document";
import type {
  SettingsStorePending,
  SettingsStoreSnapshot,
} from "../../apps/desktop/bridge/wire";
import type { ProductSettings } from "../../src/pkg/product-settings/contract";

// Actual disposable config.json and the normal service queue. Go policy,
// transport, promotion locking and app startup are separate qualification layers.
const roots: string[] = [];
const scope = {
  profileId: "00000000-0000-4000-8000-00000000000a",
  ownerId: "owner",
};
const operationId = "00000000-0000-4000-8000-00000000000b";
const workspaceId = "00000000-0000-4000-8000-00000000000c";
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  options: {
    beforeCommit?: () => Promise<void>;
    seed?: (settings: ProductSettings) => void;
    dependencies?: ProductConfigurationDependencies;
  } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-settings-delivery-"),
  );
  roots.push(root);
  const store = new ProductSettingsStore(
    { root },
    options.beforeCommit ? { beforeCommit: options.beforeCommit } : {},
  );
  const initial = new ProductConfigurationService(store);
  await initial.initialize();
  const before = (await store.load())!;
  options.seed?.(before);
  await store.save(before);
  const service = new ProductConfigurationService(store, options.dependencies);
  await service.initialize();
  const adapter = service.attachSettingsDeliveryStore(scope);
  const snapshot = settingsStoreSnapshot(before, scope);
  const pending: SettingsStorePending = {
    backend: "go-owner-v2",
    operationId,
    profileId: scope.profileId,
    workspaceId,
    relativePath: "file.txt",
    computerGeneration: snapshot.current.generation,
    beforeSHA256: "a".repeat(64),
    submittedAt: "2026-10-04T22:00:00.123456789Z",
  };
  return { root, store, service, adapter, before, snapshot, pending };
}
async function current(
  adapter: Awaited<ReturnType<typeof fixture>>["adapter"],
): Promise<SettingsStoreSnapshot> {
  const result = await adapter.read();
  expect(result.status).toBe("ok");
  return result.snapshot!;
}
describe("typed mechanical Settings delivery store", () => {
  it("projects no private content and preserves unrelated fields in an exact replacement", async () => {
    const f = await fixture({
      seed: (s) => {
        s.tasks = { arbitrary: ["retained", "content"] };
      },
    });
    expect(await f.adapter.read()).toEqual({
      status: "ok",
      snapshot: f.snapshot,
    });
    expect(JSON.stringify(f.snapshot)).not.toContain("retained");
    const rename = vi.spyOn(fs, "rename");
    const result = await f.adapter.replace({
      expected: f.snapshot,
      next: f.pending,
      invalidateVerification: false,
    });
    expect(result.status).toBe("committed");
    expect(result.snapshot?.pending).toEqual(f.pending);
    expect(result.snapshot?.revision).toBe(String(f.before.revision + 1));
    const saved = (await f.store.load())!;
    expect({
      ...saved,
      revision: f.before.revision,
      computer: { ...saved.computer, pendingEdit: null },
    }).toEqual(f.before);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(
      await f.adapter.replace({
        expected: f.snapshot,
        next: f.pending,
        invalidateVerification: false,
      }),
    ).toEqual({ status: "not_written" });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy delivery unsupported instead of treating it as absent", async () => {
    const f = await fixture();
    const saved = structuredClone(f.before);
    saved.computer.pendingEdit = {
      operationId,
      workspaceId,
      relativePath: "legacy.txt",
      computerGeneration: 1,
      submittedAt: "2026-10-04T22:00:00Z",
    };
    await f.store.save(saved);
    const service = new ProductConfigurationService(f.store);
    await service.initialize();
    const adapter = service.attachSettingsDeliveryStore(scope);
    const rename = vi.spyOn(fs, "rename");
    expect(await adapter.read()).toEqual({ status: "unsupported" });
    expect(
      await adapter.replace({
        expected: f.snapshot,
        next: f.pending,
        invalidateVerification: false,
      }),
    ).toEqual({ status: "not_written" });
    expect(rename).not.toHaveBeenCalled();
    expect((await f.store.load())?.computer.pendingEdit).toEqual(
      saved.computer.pendingEdit,
    );
  });

  it.each(["wrong-scope", "bad-uuid", "overflow", "extra-field"])(
    "refuses unrepresentable input before writing: %s",
    async (kind) => {
      const f = await fixture();
      const next: Record<string, unknown> = { ...f.pending };
      if (kind === "wrong-scope") next.profileId = operationId;
      if (kind === "bad-uuid") next.operationId = "not-a-persisted-uuid";
      if (kind === "overflow") next.computerGeneration = "9007199254740992";
      if (kind === "extra-field")
        next.edits = [{ oldText: "secret", newText: "other" }];
      const rename = vi.spyOn(fs, "rename");
      expect(
        await f.adapter.replace({
          expected: f.snapshot,
          next,
          invalidateVerification: false,
        }),
      ).toEqual({ status: "not_written" });
      expect(rename).not.toHaveBeenCalled();
      expect(await f.store.load()).toEqual(f.before);
    },
  );

  it("takes and rechecks the admission lease before rename, then retains it through execution", async () => {
    const verify = vi.fn(async () => true),
      release = vi.fn(async () => undefined);
    const f = await fixture({
      dependencies: {
        promotionLease: {
          acquireForAdmission: async () => ({ verify, release }),
        },
      },
    });
    expect(
      (
        await f.adapter.replace({
          expected: f.snapshot,
          next: f.pending,
          invalidateVerification: false,
        })
      ).status,
    ).toBe("committed");
    expect(verify).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    await f.service.releaseWorkspaceEditLease(operationId);
    await f.service.releaseWorkspaceEditLease(operationId);
    expect(release).toHaveBeenCalledTimes(1);
    const expected = await current(f.adapter);
    expect(
      (await f.adapter.replace({ expected, invalidateVerification: false }))
        .status,
    ).toBe("committed");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each(["busy", "entry", "late"])(
    "refuses the unavailable lease at %s with zero replacements",
    async (stage) => {
      const verify = vi
        .fn(async () => stage !== "entry")
        .mockImplementationOnce(async () => stage !== "entry");
      if (stage === "late") verify.mockResolvedValueOnce(false);
      const release = vi.fn(async () => undefined);
      const f = await fixture({
        dependencies: {
          promotionLease: {
            acquireForAdmission: async () =>
              stage === "busy" ? null : { verify, release },
          },
        },
      });
      const rename = vi.spyOn(fs, "rename");
      expect(
        await f.adapter.replace({
          expected: f.snapshot,
          next: f.pending,
          invalidateVerification: false,
        }),
      ).toEqual({ status: "not_written" });
      expect(rename).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(stage === "busy" ? 0 : 1);
    },
  );

  it("serializes the complete replacement/readback with ordinary Settings writes", async () => {
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    let pause = false;
    const f = await fixture({
      beforeCommit: async () => {
        if (pause) {
          pause = false;
          enter();
          await resumed;
        }
      },
    });
    pause = true;
    const replacement = f.adapter.replace({
      expected: f.snapshot,
      next: f.pending,
      invalidateVerification: false,
    });
    await entered;
    const ordinary = f.service.renameComputer("Changed in same queue");
    resume();
    expect((await replacement).status).toBe("committed");
    expect((await ordinary).ok).toBe(true);
    const saved = (await f.store.load())!;
    expect(saved.computer.pendingEdit?.operationId).toBe(operationId);
    expect(saved.computer.name).toBe("Changed in same queue");
    expect(saved.revision).toBe(f.before.revision + 2);
  });

  it("withdraws authority before invalidation and publishes only exact known readback", async () => {
    const f = await fixture();
    const order: string[] = [];
    f.service.attachComputerAuthority(async () => {
      order.push("withdraw");
      expect(await f.store.load()).toEqual(f.before);
      return {
        publish: async (saved) => {
          order.push("publish");
          expect(await f.store.load()).toEqual(saved);
        },
      };
    });
    const result = await f.adapter.replace({
      expected: f.snapshot,
      next: f.pending,
      invalidateVerification: true,
    });
    expect(result.status).toBe("committed");
    expect(result.snapshot?.verificationInvalidated).toBe(true);
    expect(order).toEqual(["withdraw", "publish"]);
    expect(
      (
        await f.adapter.replace({
          expected: result.snapshot,
          invalidateVerification: false,
        })
      ).status,
    ).toBe("committed");
    expect((await current(f.adapter)).verificationInvalidated).toBe(true);
    expect(order).toEqual(["withdraw", "publish"]);
  });

  it.each(["rename", "publish"])(
    "fences unknown %s without reloading visible bytes into authority",
    async (stage) => {
      const f = await fixture();
      const publish = vi.fn(async () => {
        if (stage === "publish") throw new Error("lost publication ACK");
      });
      const withdraw = vi.fn(async () => ({ publish }));
      f.service.attachComputerAuthority(withdraw);
      const original = fs.rename.bind(fs);
      const rename = vi.spyOn(fs, "rename");
      if (stage === "rename")
        rename.mockImplementationOnce(async (a, b) => {
          await original(a, b);
          throw new Error("lost rename ACK");
        });
      expect(
        await f.adapter.replace({
          expected: f.snapshot,
          next: f.pending,
          invalidateVerification: true,
        }),
      ).toEqual({ status: "unknown" });
      expect((await f.store.load())?.computer.pendingEdit?.operationId).toBe(
        operationId,
      );
      expect(await f.adapter.read()).toEqual({ status: "unavailable" });
      await f.service.initialize();
      expect(f.service.snapshot().status).toBe("error");
      expect(
        await f.adapter.replace({
          expected: f.snapshot,
          next: f.pending,
          invalidateVerification: true,
        }),
      ).toEqual({ status: "unknown" });
      expect((await f.service.renameComputer("Must not save")).ok).toBe(false);
      await expect(f.store.save(f.before)).rejects.toThrow(
        "SETTINGS_WRITE_OUTCOME_UNKNOWN",
      );
      expect(rename).toHaveBeenCalledTimes(1);
      expect(withdraw).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(stage === "rename" ? 0 : 1);
    },
  );

  it("fences a late caller loss even after a known committed lower-level result", async () => {
    const f = await fixture();
    expect(
      (
        await f.adapter.replace({
          expected: f.snapshot,
          next: f.pending,
          invalidateVerification: false,
        })
      ).status,
    ).toBe("committed");
    await f.adapter.fence();
    expect(await f.adapter.read()).toEqual({ status: "unavailable" });
    const readback = (await f.store.load())!;
    expect(
      await f.store.saveConditional(readback, {
        ...readback,
        revision: readback.revision + 1,
      }),
    ).toEqual({ status: "unknown" });
    expect((await f.service.renameComputer("Must not save")).ok).toBe(false);
  });

  it("stops an in-flight publication after the caller fences its queued outcome", async () => {
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    let pause = false;
    const f = await fixture({
      beforeCommit: async () => {
        if (pause) {
          enter();
          await resumed;
        }
      },
    });
    const rename = vi.spyOn(fs, "rename");
    pause = true;
    const writing = f.adapter.replace({
      expected: f.snapshot,
      next: f.pending,
      invalidateVerification: false,
    });
    await entered;
    const fenced = f.adapter.fence();
    resume();
    expect(await writing).toEqual({ status: "not_written" });
    await fenced;
    expect(rename).not.toHaveBeenCalled();
    expect(await f.store.load()).toEqual(f.before);
    expect(await f.adapter.read()).toEqual({ status: "unavailable" });
  });

  it("retains a failed authority withdrawal instead of acknowledging a later fence", async () => {
    const f = await fixture();
    const withdraw = vi.fn(async () => {
      throw new Error("withdrawal acknowledgement lost");
    });
    f.service.attachComputerAuthority(withdraw);
    await expect(f.adapter.fence()).rejects.toThrow(
      "withdrawal acknowledgement lost",
    );
    await expect(f.adapter.fence()).rejects.toThrow(
      "withdrawal acknowledgement lost",
    );
    expect(withdraw).toHaveBeenCalledTimes(1);
    expect(await f.adapter.read()).toEqual({ status: "unavailable" });
    await expect(f.store.save(f.before)).rejects.toThrow(
      "SETTINGS_WRITE_OUTCOME_UNKNOWN",
    );
  });

  it("refuses authority publication after caller loss during final storage readback", async () => {
    const f = await fixture();
    const publish = vi.fn(async () => undefined);
    const withdraw = vi.fn(async () => ({ publish }));
    f.service.attachComputerAuthority(withdraw);
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    const load = f.store.load.bind(f.store);
    let reads = 0;
    vi.spyOn(f.store, "load").mockImplementation(async () => {
      if (++reads === 3) {
        enter();
        await resumed;
      }
      return load();
    });
    const writing = f.adapter.replace({
      expected: f.snapshot,
      next: f.pending,
      invalidateVerification: true,
    });
    await entered;
    const fenced = f.adapter.fence();
    resume();
    expect(await writing).toEqual({ status: "unknown" });
    await fenced;
    expect(publish).not.toHaveBeenCalled();
    expect(await f.adapter.read()).toEqual({ status: "unavailable" });
    expect(f.service.snapshot().status).toBe("error");
    expect((await load())?.computer.pendingEdit?.operationId).toBe(operationId);
  });

  it("retains uncertainty from the first withdrawal even before a settings write", async () => {
    const f = await fixture();
    const withdraw = vi.fn(async () => {
      throw new Error("original withdrawal ACK lost");
    });
    f.service.attachComputerAuthority(withdraw);
    const rename = vi.spyOn(fs, "rename");
    expect(
      await f.adapter.replace({
        expected: f.snapshot,
        next: f.pending,
        invalidateVerification: true,
      }),
    ).toEqual({ status: "unknown" });
    expect(rename).not.toHaveBeenCalled();
    expect(await f.adapter.read()).toEqual({ status: "unavailable" });
    expect((await f.service.renameComputer("Must stay closed")).ok).toBe(false);
    expect(
      await f.adapter.replace({
        expected: f.snapshot,
        next: f.pending,
        invalidateVerification: true,
      }),
    ).toEqual({ status: "unknown" });
    await expect(f.adapter.fence()).rejects.toThrow(
      "original withdrawal ACK lost",
    );
    await expect(f.adapter.fence()).rejects.toThrow(
      "original withdrawal ACK lost",
    );
    expect(withdraw).toHaveBeenCalledTimes(1);
  });

  it("does not restore a successful result after caller loss while authority publish is in flight", async () => {
    const f = await fixture();
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    const publish = vi.fn(async () => {
      enter();
      await resumed;
    });
    const withdraw = vi.fn(async () => ({ publish }));
    f.service.attachComputerAuthority(withdraw);
    const writing = f.adapter.replace({
      expected: f.snapshot,
      next: f.pending,
      invalidateVerification: true,
    });
    await entered;
    const fenced = f.adapter.fence();
    expect(f.service.snapshot().status).toBe("error");
    resume();
    expect(await writing).toEqual({ status: "unknown" });
    await fenced;
    expect(publish).toHaveBeenCalledTimes(1);
    expect(withdraw).toHaveBeenCalledTimes(2);
    expect(f.service.snapshot().status).toBe("error");
  });

  it("keeps ordinary queued Settings commits from republishing after a delivery fence", async () => {
    const f = await fixture();
    const publish = vi.fn(async () => undefined);
    f.service.attachComputerAuthority(async () => ({ publish }));
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    const load = f.store.load.bind(f.store);
    vi.spyOn(f.store, "load").mockImplementationOnce(async () => {
      enter();
      await resumed;
      return load();
    });
    const ordinary = f.service.renameComputer("Written before caller loss");
    await entered;
    const fenced = f.adapter.fence();
    resume();
    expect((await ordinary).ok).toBe(false);
    await fenced;
    expect(publish).not.toHaveBeenCalled();
    expect(f.service.snapshot().status).toBe("error");
    expect((await load())?.computer.name).toBe("Written before caller loss");
  });

  it("does not restore ordinary failure readback after a caller fence", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "save").mockRejectedValueOnce(
      new Error("storage write failed"),
    );
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const resumed = new Promise<void>((r) => {
      resume = r;
    });
    const load = f.store.load.bind(f.store);
    vi.spyOn(f.store, "load").mockImplementationOnce(async () => {
      enter();
      await resumed;
      return load();
    });
    const ordinary = f.service.renameComputer("Not persisted");
    await entered;
    const fenced = f.adapter.fence();
    resume();
    const result = await ordinary;
    await fenced;
    expect(result.ok).toBe(false);
    expect(result.snapshot.status).toBe("error");
    expect(f.service.snapshot().status).toBe("error");
  });

  it.each(["withdraw", "publish"])(
    "retains ordinary %s rejection crossing a caller fence without another authority call",
    async (stage) => {
      const f = await fixture();
      let enter!: () => void, reject!: (error: Error) => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const lost = new Promise<never>((_, r) => {
        reject = r;
      });
      const publish = vi.fn(async () => {
        enter();
        await lost;
      });
      const withdraw = vi.fn(async () => {
        if (stage === "withdraw") {
          enter();
          await lost;
        }
        return { publish };
      });
      f.service.attachComputerAuthority(withdraw);
      const ordinary = f.service.renameComputer(
        "Changed before authority loss",
      );
      await entered;
      const fenced = f.adapter.fence();
      const held = expect(fenced).rejects.toThrow(
        "original ordinary authority ACK lost",
      );
      reject(new Error("original ordinary authority ACK lost"));
      expect((await ordinary).ok).toBe(false);
      await held;
      await expect(f.adapter.fence()).rejects.toThrow(
        "original ordinary authority ACK lost",
      );
      expect(withdraw).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(stage === "publish" ? 1 : 0);
      expect(f.service.snapshot().status).toBe("error");
    },
  );

  it("preserves the original pending generation when clearing after a current generation change", async () => {
    const f = await fixture();
    await f.adapter.replace({
      expected: f.snapshot,
      next: f.pending,
      invalidateVerification: false,
    });
    const saved = (await f.store.load())!;
    saved.computer.generation++;
    saved.revision++;
    await f.store.save(saved);
    const reopened = new ProductConfigurationService(f.store);
    await reopened.initialize();
    const adapter = reopened.attachSettingsDeliveryStore(scope);
    const expected = await current(adapter);
    expect(expected.current.generation).not.toBe(
      expected.pending?.computerGeneration,
    );
    expect(expected.pending).toEqual(f.pending);
    expect(
      (await adapter.replace({ expected, invalidateVerification: false }))
        .status,
    ).toBe("committed");
    expect((await f.store.load())?.computer.pendingEdit).toBeNull();
  });
});
