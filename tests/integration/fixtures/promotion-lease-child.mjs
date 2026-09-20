// A separate process used by promotion-lease.test.ts to prove the lease
// really excludes across process boundaries, not just within one test
// worker. Speaks the tooling-side `.mjs` half of the protocol while the
// test process speaks the `src/apps/desktop` TypeScript half.
//
// argv: userData mode generation
// - `probe` / `acquire-release`: one acquire attempt; prints REFUSED (exit 1)
//   or ACQUIRED then RELEASED (exit 0).
// - `hold`: acquires, prints ACQUIRED and never releases; the parent kills
//   this process to prove that a dead holder's lock is gone in the kernel,
//   not recovered by anyone.
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
  // Deliberately never releases: the parent kills this process. A bare
  // unresolved `Promise` is not enough to keep this alive: once the event
  // loop otherwise has nothing pending, Node treats an unsettled top-level
  // await as abandonable and exits on its own, which would make a real
  // still-alive holder silently vanish out from under a test that waits on
  // it for more than an instant. A live interval is a real libuv handle that
  // actually pins the event loop.
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
} else {
  await releasePromotionLease(handle);
  process.stdout.write("RELEASED\n");
}
