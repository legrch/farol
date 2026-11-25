import { beforeEach, describe, expect, it, vi } from "vitest";

// The admission lease over a scripted promotion-lease module: which profile
// and build it asks for, when it reads the profile path, and how a refused or
// failing acquisition is reported.

const lease = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("../../../src/apps/desktop/promotion-lease", () => ({
  acquirePromotionLease: lease.acquire,
  releasePromotionLease: lease.release,
  verifyPromotionLease: lease.verify,
}));

const { admissionLease } = await import("./lease");

beforeEach(() => {
  lease.acquire.mockReset();
  lease.release.mockReset();
  lease.verify.mockReset();
});

describe("admission lease", () => {
  it("asks for the admission role under the profile path read at acquisition", async () => {
    let profile = "/before";
    const handle = { id: "h" };
    lease.acquire.mockResolvedValue(handle);
    const admission = admissionLease(() => profile, "build-1");
    profile = "/after";
    const held = await admission.acquireForAdmission();
    expect(lease.acquire).toHaveBeenCalledWith(
      "/after",
      "build-1",
      "admission",
    );
    held!.release();
    held!.verify();
    expect(lease.release).toHaveBeenCalledWith(handle);
    expect(lease.verify).toHaveBeenCalledWith(handle);
  });

  it("refuses admission when the lease is unavailable or unsafe", async () => {
    lease.acquire.mockResolvedValueOnce(null);
    expect(
      await admissionLease(() => "/p", "b").acquireForAdmission(),
    ).toBeNull();
    lease.acquire.mockRejectedValueOnce(new Error("PROMOTION_LEASE_UNSAFE"));
    expect(
      await admissionLease(() => "/p", "b").acquireForAdmission(),
    ).toBeNull();
  });
});
