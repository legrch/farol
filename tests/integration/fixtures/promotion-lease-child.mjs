// A separate process used by promotion-lease.test.ts to prove the lease
// really excludes across process boundaries, not just within one test
// worker. Speaks the tooling-side `.mjs` half of the protocol while the
// test process speaks the `src/apps/desktop` TypeScript half.
import {
  acquirePromotionLease,
  releasePromotionLease,
} from "../../../tooling/promotion-lease.mjs";

const [, , userData, mode, generation] = process.argv;

const handle = await acquirePromotionLease(
  userData,
  generation ?? "child-generation",
  "admission",
);
if (!handle) {
  process.stdout.write("REFUSED\n");
  process.exit(1);
}
process.stdout.write("ACQUIRED\n");
if (mode === "hold") {
  // Deliberately never releases: the parent kills this process to prove the
  // lease's stale-holder recovery, not a cooperative release.
  await new Promise(() => {});
} else {
  await releasePromotionLease(handle);
  process.stdout.write("RELEASED\n");
}
