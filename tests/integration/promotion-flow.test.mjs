import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { treeDigest } from "../../tooling/artifact-digest.mjs";
import {
  acquirePromotionLease,
  releasePromotionLease,
} from "../../tooling/promotion-lease.mjs";
import { runPromotionApply } from "../../tooling/promotion-apply.mjs";
import {
  activationObligations,
  assertActivationDrained,
} from "../../tooling/promotion-obligations.mjs";
import { assertPromotionDestination } from "../../tooling/promotion-destination.mjs";
import { LiveTaskRegistry } from "../../src/apps/desktop/live-task-registry.ts";
import { isPromotionLeaseHeldSync } from "../../src/apps/desktop/promotion-lease.ts";

// Composes the same pieces `tooling/promote-preview.mjs` does for
// `--apply`, without spawning the CLI: acquire the generation-owned lease,
// drain-check under it, place, release. This is the packet's positive
// evidence — a controlled A -> B -> A promotion into a throwaway
// destination — plus the two refusals the lease exists for.
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

// The promotion-apply helper walks every path component from "/" down to
// its target with `follow_symlinks=False`, so a tmp root that is itself a
// symlink (macOS's `/tmp` -> `/private/tmp`) must be resolved first, the
// same way `promotion-apply.test.mjs` and `two-generation-promotion.test.mjs`
// already do.
async function realTemporaryRoot() {
  return fs.realpath(os.tmpdir());
}

async function generationFixture(name, contents) {
  const app = await fs.mkdtemp(
    path.join(await realTemporaryRoot(), `farol-next-flow-${name}-`),
  );
  roots.push(app);
  const bundle = path.join(app, "Farol Next Preview.app");
  await fs.mkdir(path.join(bundle, "Contents"), { recursive: true });
  await fs.writeFile(path.join(bundle, "Contents", "payload"), contents, {
    mode: 0o600,
  });
  return bundle;
}

async function home() {
  const root = await fs.mkdtemp(
    path.join(await realTemporaryRoot(), "farol-next-flow-home-"),
  );
  roots.push(root);
  await fs.mkdir(path.join(root, "Applications"), {
    recursive: true,
    mode: 0o755,
  });
  await fs.chmod(root, 0o700);
  return root;
}

function userDataOf(homeRoot) {
  return path.join(homeRoot, "farol-next-userdata");
}

async function promote(homeRoot, source, generation) {
  const userData = userDataOf(homeRoot);
  const lease = await acquirePromotionLease(userData, generation, "promotion");
  if (!lease) throw new Error("PROMOTION_LEASE_HELD");
  try {
    const obligations = await activationObligations(userData);
    assertActivationDrained(obligations);
    const { destination, receipt } = assertPromotionDestination({
      home: homeRoot,
      source,
      destination: path.join(homeRoot, "Applications/Farol Next Preview.app"),
    });
    const artifactSha256 = await treeDigest(source);
    const receiptText = `${JSON.stringify({
      schema: "farol.next.promotion-plan/1",
      operation: "applied",
      generation,
      artifactSha256,
    })}\n`;
    await runPromotionApply({ home: homeRoot, source, artifactSha256, receiptText });
    return { destination, receipt, artifactSha256 };
  } finally {
    await releasePromotionLease(lease);
  }
}

async function ensureUserData(homeRoot) {
  await fs.mkdir(path.join(userDataOf(homeRoot), "farol-next-state"), {
    recursive: true,
    mode: 0o700,
  });
}

function fixtureTask(overrides = {}) {
  return {
    taskId: "task-a",
    sessionId: "task-a",
    turnId: "turn-a",
    label: "Task",
    provider: "chatgpt",
    requestedModel: null,
    observedModel: null,
    requestedMode: null,
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "idle",
    ...overrides,
  };
}

describe("promotion flow: lease held from the drain check through placement", () => {
  it("A -> B refused over A -> A removed, B placed -> B removed, A placed again, each ending with its own receipt", async () => {
    const homeRoot = await home();
    await ensureUserData(homeRoot);
    const a = await generationFixture("a", "generation-a\n");
    const b = await generationFixture("b", "generation-b\n");

    const placedA = await promote(homeRoot, a, "gen-a");
    expect(await treeDigest(placedA.destination)).toBe(placedA.artifactSha256);
    expect(
      JSON.parse(await fs.readFile(placedA.receipt, "utf8")).generation,
    ).toBe("gen-a");

    await expect(promote(homeRoot, b, "gen-b")).rejects.toThrow(
      /^PROMOTION_APPLY_REFUSED/u,
    );
    expect(await treeDigest(placedA.destination)).toBe(placedA.artifactSha256);

    await fs.rm(placedA.destination, { recursive: true, force: true });
    await fs.rm(placedA.receipt, { force: true });
    const placedB = await promote(homeRoot, b, "gen-b");
    expect(await treeDigest(placedB.destination)).toBe(placedB.artifactSha256);
    expect(placedB.artifactSha256).not.toBe(placedA.artifactSha256);

    await fs.rm(placedB.destination, { recursive: true, force: true });
    await fs.rm(placedB.receipt, { force: true });
    const placedAAgain = await promote(homeRoot, a, "gen-a");
    expect(await treeDigest(placedAAgain.destination)).toBe(
      placedA.artifactSha256,
    );
    expect(
      JSON.parse(await fs.readFile(placedAAgain.receipt, "utf8")).generation,
    ).toBe("gen-a");
  });

  it("refuses a promotion attempted while the lease is already held", async () => {
    const homeRoot = await home();
    await ensureUserData(homeRoot);
    const a = await generationFixture("held", "generation-a\n");
    const userData = userDataOf(homeRoot);
    const holder = await acquirePromotionLease(userData, "gen-x", "promotion");
    expect(holder).not.toBeNull();
    try {
      await expect(promote(homeRoot, a, "gen-y")).rejects.toThrow(
        "PROMOTION_LEASE_HELD",
      );
    } finally {
      await releasePromotionLease(holder);
    }
  });

  it("refuses to admit work while promotion holds the lease, and admits again once it is released", async () => {
    const homeRoot = await home();
    const userData = userDataOf(homeRoot);
    const registry = new LiveTaskRegistry(5, {
      isHeld: () => isPromotionLeaseHeldSync(userData),
    });
    expect(registry.admit(fixtureTask())).toMatchObject({ status: "admitted" });

    // Impersonates a separate promotion process: pid 1 always exists and is
    // never this test's own pid, so the registry's sync check (using its
    // own real pid as "self") sees a genuinely different, live holder —
    // exactly what a real cross-process promotion CLI would look like.
    const lease = await acquirePromotionLease(userData, "gen-z", "promotion", {
      pid: 1,
    });
    expect(lease).not.toBeNull();
    try {
      expect(
        registry.admit(fixtureTask({ taskId: "task-b", sessionId: "task-b", turnId: "turn-b" })),
      ).toMatchObject({ status: "promotion_pending" });
    } finally {
      await releasePromotionLease(lease);
    }

    expect(
      registry.admit(fixtureTask({ taskId: "task-c", sessionId: "task-c", turnId: "turn-c" })),
    ).toMatchObject({ status: "admitted" });
  });
});
