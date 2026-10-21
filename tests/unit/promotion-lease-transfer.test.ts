import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

// Filesystem/descriptor doubles select macOS as a controlled host value only.
// Restore the actual runner platform after each case; this is policy evidence,
// not native lock, descriptor transfer or Linux/macOS qualification.
const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;

const fake = vi.hoisted(() => ({
  directoryInode: 20n,
  fileInode: 30n,
  mode: 0o600,
  links: 1n,
  canonical: "/private/fixture/farol-state/promotion.lease",
  closeError: false,
  handle: undefined as unknown as {
    fd: number;
    stat: ReturnType<typeof vi.fn>;
    truncate: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    sync: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("node:fs/promises", () => {
  const info = (directory: boolean, opened = false) => ({
    dev: 10n,
    ino: directory ? fake.directoryInode : opened ? 30n : fake.fileInode,
    uid: BigInt(process.geteuid?.() ?? 0),
    mode: BigInt(directory ? 0o700 : fake.mode),
    nlink: fake.links,
    isFile: () => !directory,
    isDirectory: () => directory,
  });
  return {
    default: {
      mkdir: vi.fn(async () => undefined),
      realpath: vi.fn(async () => fake.canonical),
      lstat: vi.fn(async (file: string) =>
        info(!file.endsWith("promotion.lease")),
      ),
      open: vi.fn(async () => {
        fake.handle = {
          fd: 17,
          stat: vi.fn(async () => info(false, true)),
          truncate: vi.fn(async () => undefined),
          write: vi.fn(async () => undefined),
          sync: vi.fn(async () => undefined),
          close: vi.fn(async () => {
            if (fake.closeError)
              throw new Error("fixture close outcome unknown");
            fake.handle.fd = -1;
          }),
        };
        return fake.handle;
      }),
    },
  };
});

import * as desktop from "../../src/apps/desktop/promotion-lease";
// @ts-expect-error Tooling deliberately runs as plain JavaScript.
import * as tooling from "../../tooling/promotion-lease.mjs";

beforeEach(() => {
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "darwin",
  });
  fake.directoryInode = 20n;
  fake.fileInode = 30n;
  fake.mode = 0o600;
  fake.links = 1n;
  fake.canonical = "/private/fixture/farol-state/promotion.lease";
  fake.closeError = false;
});
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  expect(Object.getOwnPropertyDescriptor(process, "platform")).toEqual(
    platformDescriptor,
  );
});

describe.each([
  ["desktop", desktop],
  ["tooling", tooling as typeof desktop],
] as const)("%s lease transfer policy (filesystem mocked)", (_name, api) => {
  async function held() {
    return (await api.acquirePromotionLease(
      "/private/fixture",
      "selected",
      "promotion",
    ))!;
  }

  it.each(["linux", "win32"] as const)(
    "refuses the unsupported %s host before mocked lease IO",
    async (platform) => {
      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: platform,
      });
      vi.clearAllMocks();
      await expect(
        api.acquirePromotionLease("/private/fixture", "selected", "promotion"),
      ).rejects.toThrow("PROMOTION_LEASE_PLATFORM_UNSUPPORTED");
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.lstat).not.toHaveBeenCalled();
      expect(fs.realpath).not.toHaveBeenCalled();
      expect(fs.open).not.toHaveBeenCalled();
    },
  );

  it("selects the existing identity once and closes once without rewriting its record", async () => {
    const lease = await held();
    const transfer = await api.createPromotionLeaseTransfer(lease);
    expect(transfer.identity).toEqual({ device: "10", inode: "30" });
    expect(transfer.descriptor).toBe(17);
    expect(await transfer.verify()).toBe(true);
    await expect(api.createPromotionLeaseTransfer(lease)).rejects.toThrow(
      "ALREADY_SELECTED",
    );
    const truncations = fake.handle.truncate.mock.calls.length;
    await transfer.release();
    expect(fake.handle.truncate).toHaveBeenCalledTimes(truncations);
    expect(fake.handle.close).toHaveBeenCalledTimes(1);
    expect(await transfer.verify()).toBe(false);
    await expect(transfer.release()).rejects.toThrow("ALREADY_RELEASED");
    await api.releasePromotionLease(lease);
    expect(fake.handle.close).toHaveBeenCalledTimes(1);
  });

  it("refuses copied handles and admission leases", async () => {
    const lease = await held();
    await expect(
      api.createPromotionLeaseTransfer({ ...lease }),
    ).rejects.toThrow("NOT_HELD");
    await api.releasePromotionLease(lease);
    const admission = await api.acquirePromotionLease(
      "/private/fixture",
      "admission",
      "admission",
    );
    await expect(api.createPromotionLeaseTransfer(admission!)).rejects.toThrow(
      "NOT_HELD",
    );
    await api.releasePromotionLease(admission!);
  });

  it.each(["inode", "directory", "mode", "links", "canonical", "descriptor"])(
    "refuses a changed %s before transfer release",
    async (change) => {
      const lease = await held();
      const transfer = await api.createPromotionLeaseTransfer(lease);
      if (change === "inode") fake.fileInode = 31n;
      if (change === "directory") fake.directoryInode = 21n;
      if (change === "mode") fake.mode = 0o644;
      if (change === "links") fake.links = 2n;
      if (change === "canonical")
        fake.canonical = "/private/elsewhere/promotion.lease";
      if (change === "descriptor") fake.handle.fd = 18;
      expect(await transfer.verify()).toBe(false);
      await expect(transfer.release()).rejects.toThrow("TRANSFER_UNSAFE");
      expect(fake.handle.close).not.toHaveBeenCalled();
      await expect(transfer.release()).rejects.toThrow("ALREADY_RELEASED");
      await api.releasePromotionLease(lease);
    },
  );

  it("does not silently acknowledge or retry an uncertain parent close", async () => {
    const lease = await held();
    const transfer = await api.createPromotionLeaseTransfer(lease);
    fake.closeError = true;
    await expect(transfer.release()).rejects.toThrow(
      "fixture close outcome unknown",
    );
    expect(await transfer.verify()).toBe(false);
    await expect(transfer.release()).rejects.toThrow("ALREADY_RELEASED");
    await api.releasePromotionLease(lease);
    expect(fake.handle.close).toHaveBeenCalledTimes(1);
  });

  it("refuses after an ordinary release and never closes a reused descriptor", async () => {
    const lease = await held();
    const transfer = await api.createPromotionLeaseTransfer(lease);
    await api.releasePromotionLease(lease);
    fake.handle.fd = 17;
    await expect(transfer.release()).rejects.toThrow("TRANSFER_UNSAFE");
    expect(fake.handle.close).toHaveBeenCalledTimes(1);
  });
});
