// A separate process used by promotion-lease.test.ts to prove the lease
// really excludes across process boundaries, not just within one test
// worker. Speaks the tooling-side `.mjs` half of the protocol while the
// test process speaks the `src/apps/desktop` TypeScript half.
import fs from "node:fs/promises";
import {
  acquirePromotionLease,
  releasePromotionLease,
} from "../../../tooling/promotion-lease.mjs";

const [, , userData, mode, generation, readyFile, goFile] = process.argv;

async function waitForFile(file) {
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

if (mode === "recover-pause") {
  // S35-03/3: pauses a real process's own stale-lease recovery right after
  // it has exclusively claimed the stale bytes (see `promotion-lease.mjs`'s
  // `claimForExchange`) and before it decides what to do with them. The
  // parent uses this handshake to force a deterministic, real cross-process
  // interleaving with a competing acquire that runs while this one is
  // paused, instead of relying on OS scheduling luck.
  const handle = await acquirePromotionLease(
    userData,
    generation,
    "admission",
    {
      beforeExchange: async () => {
        await fs.writeFile(readyFile, "ready", { mode: 0o600 });
        await waitForFile(goFile);
      },
    },
  );
  if (!handle) {
    process.stdout.write("REFUSED\n");
    process.exit(1);
  }
  process.stdout.write(`ACQUIRED:${JSON.stringify(handle.record)}\n`);
  await releasePromotionLease(handle);
  process.stdout.write("RELEASED\n");
  process.exit(0);
}

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
  // lease's stale-holder recovery, not a cooperative release. A bare
  // unresolved `Promise` is not enough to keep this alive: once the event
  // loop otherwise has nothing pending, Node treats an unsettled top-level
  // await as abandonable and exits on its own (see the "Detected unsettled
  // top-level await" warning), which would make a real still-alive holder
  // silently vanish out from under a test that waits on it for more than an
  // instant. A live interval is a real libuv handle that actually pins the
  // event loop.
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
} else {
  await releasePromotionLease(handle);
  process.stdout.write("RELEASED\n");
}
