import {
  acquirePromotionLease,
  releasePromotionLease,
  verifyPromotionLease,
} from "../../../src/apps/desktop/promotion-lease";

// The cross-process "admission" lease that live tasks and guarded Settings
// edits take before a durable critical phase, so either excludes an installed
// update promotion. An unsafe or unreadable lease state refuses admission
// (null) rather than surfacing the lease error as an unrelated crash; `verify`
// fences the durable write against a lease file replaced by hand. The profile
// path is read at each acquisition, after boot identity has pinned it.
export function admissionLease(userData: () => string, buildId: string) {
  return {
    acquireForAdmission: async () => {
      const handle = await acquirePromotionLease(
        userData(),
        buildId,
        "admission",
      ).catch(() => null);
      if (!handle) return null;
      return {
        release: () => releasePromotionLease(handle),
        verify: () => verifyPromotionLease(handle),
      };
    },
  };
}
