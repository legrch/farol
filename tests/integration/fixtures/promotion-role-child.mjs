// A separate process used by promotion-flow.test.mjs's S35-03/2 proof: a
// real admission-role acquirer and a real promotion-role acquirer racing
// the SAME lease file, each optionally paused on a file handshake so the
// test can force a deterministic interleaving instead of relying on OS
// scheduling luck. Speaks only the tooling-side `.mjs` half of the
// protocol; either role can run in either process.
//
// argv: userData role generation [preReadyFile preGoFile] [postReadyFile postGoFile]
// - pre: written/awaited BEFORE attempting to acquire (narrates "sees no
//   lease, then pauses before its durable attempt").
// - post: written/awaited AFTER a successful acquire and BEFORE releasing,
//   so the test can hold this process's lease open for as long as it needs
//   a competitor to collide with it.
import fs from "node:fs/promises";
import {
  acquirePromotionLease,
  isPromotionLeaseHeld,
  releasePromotionLease,
} from "../../../tooling/promotion-lease.mjs";

const [
  ,
  ,
  userData,
  role,
  generation,
  preReadyFile,
  preGoFile,
  postReadyFile,
  postGoFile,
] = process.argv;

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

// Narrates "admission sees no lease" (or promotion checking the same): an
// ordinary check, not the acquisition itself, before any paused window.
process.stdout.write(`HELD:${await isPromotionLeaseHeld(userData)}\n`);

if (preReadyFile) await fs.writeFile(preReadyFile, "ready", { mode: 0o600 });
if (preGoFile) await waitForFile(preGoFile);

const handle = await acquirePromotionLease(userData, generation, role);
if (!handle) {
  process.stdout.write("REFUSED\n");
  process.exit(1);
}
process.stdout.write("ACQUIRED\n");

if (postReadyFile) await fs.writeFile(postReadyFile, "ready", { mode: 0o600 });
if (postGoFile) await waitForFile(postGoFile);

await releasePromotionLease(handle);
process.stdout.write("RELEASED\n");
