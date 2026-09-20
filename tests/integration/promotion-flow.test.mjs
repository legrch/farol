import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const roleChildScript = fileURLToPath(
  new URL("./fixtures/promotion-role-child.mjs", import.meta.url),
);

// Composes the same pieces `tooling/promote-preview.mjs` does for
// `--apply`, without spawning the CLI: acquire the generation-owned lease,
// drain-check under it, place, release. This is the packet's positive
// evidence — a controlled A -> B -> A promotion into a throwaway
// destination — plus the two refusals the lease exists for.
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
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
    await runPromotionApply({
      home: homeRoot,
      source,
      artifactSha256,
      receiptText,
    });
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

  it("S35-03/2 the registry's own admission wiring refuses while a live promotion holds the lease, and admits again once it is released", async () => {
    const homeRoot = await home();
    const userData = userDataOf(homeRoot);
    const registry = new LiveTaskRegistry(5, {
      acquireForAdmission: async () => {
        const handle = await acquirePromotionLease(
          userData,
          "app-gen",
          "admission",
        );
        if (!handle) return null;
        return { release: () => releasePromotionLease(handle) };
      },
    });
    await expect(
      registry.admitDurable(fixtureTask(), async () => {}),
    ).resolves.toMatchObject({ status: "admitted" });

    // Impersonates a separate promotion process: pid 1 always exists and is
    // never this test's own pid, so a real, live-checked acquire sees a
    // genuinely different, live holder — exactly what a real cross-process
    // promotion CLI would look like.
    const lease = await acquirePromotionLease(userData, "gen-z", "promotion", {
      pid: 1,
    });
    expect(lease).not.toBeNull();
    try {
      await expect(
        registry.admitDurable(
          fixtureTask({
            taskId: "task-b",
            sessionId: "task-b",
            turnId: "turn-b",
          }),
          async () => {},
        ),
      ).resolves.toMatchObject({ status: "promotion_pending" });
    } finally {
      await releasePromotionLease(lease);
    }

    await expect(
      registry.admitDurable(
        fixtureTask({
          taskId: "task-c",
          sessionId: "task-c",
          turnId: "turn-c",
        }),
        async () => {},
      ),
    ).resolves.toMatchObject({ status: "admitted" });
  });

  function spawnRoleChild(userData, role, generation, ...files) {
    return spawn(
      process.execPath,
      [roleChildScript, userData, role, generation, ...files],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  function collectOutput(child) {
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    return () => Buffer.concat(chunks).toString("utf8");
  }

  function waitForLine(child, needle) {
    return new Promise((resolve, reject) => {
      let buffer = "";
      const onData = (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes(needle)) {
          child.stdout.off("data", onData);
          resolve();
        }
      };
      child.stdout.on("data", onData);
      child.once("error", reject);
      setTimeout(
        () => reject(new Error(`timed out waiting for ${needle}`)),
        10_000,
      ).unref();
    });
  }

  function waitForClose(child) {
    return new Promise((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
  }

  // S35-03/2, real-process form of the packet's required scenario: admission
  // sees no lease, is paused before its durable attempt; promotion (a real,
  // separate process) then takes the lease; admission resumes and tries to
  // start work; exactly one of the two wins, and placement is never blocked
  // by the loser.
  //
  // The interleaving is forced, not hoped for: the promotion process is
  // spawned only after admission has reported "sees no lease" and reached
  // its pause. Spawning both at once let promotion acquire before admission's
  // own check on a loaded machine, so admission truthfully printed HELD:true
  // and the wait for HELD:false ran out (first seen in the 2026-09-20 root
  // gate on 891faada, 5015 ms). The budget below matches the 10 s handshake
  // polls this test already uses for two cold Node processes; a genuine hang
  // still fails on those polls.
  it("S35-03/2 two real processes: admission paused before its attempt loses to a promotion already holding the lease, and placement proceeds", async () => {
    const homeRoot = await home();
    await ensureUserData(homeRoot);
    const userData = userDataOf(homeRoot);
    const handshake = await fs.mkdtemp(
      path.join(await realTemporaryRoot(), "farol-next-flow-handshake-"),
    );
    roots.push(handshake);
    const admissionReady = path.join(handshake, "admission-ready");
    const admissionGo = path.join(handshake, "admission-go");
    const promotionReady = path.join(handshake, "promotion-ready");
    const promotionRelease = path.join(handshake, "promotion-release");

    const admission = spawnRoleChild(
      userData,
      "admission",
      "app-gen",
      admissionReady,
      admissionGo,
    );
    const admissionOutput = collectOutput(admission);
    let promotion = null;
    let promotionOutput = () => "";

    try {
      // Admission has checked ("sees no lease") and is now paused, before it
      // ever attempts to acquire.
      await waitForLine(admission, "HELD:false");
      await expect
        .poll(
          () =>
            fs.access(admissionReady).then(
              () => true,
              () => false,
            ),
          {
            timeout: 10_000,
          },
        )
        .toBe(true);

      // Only now does promotion — a real, separate process — take the lease
      // for real (this is its drain-check-through-placement window) while
      // admission is still paused.
      promotion = spawnRoleChild(
        userData,
        "promotion",
        "gen-promo",
        "",
        "",
        promotionReady,
        promotionRelease,
      );
      promotionOutput = collectOutput(promotion);
      await waitForLine(promotion, "ACQUIRED");
      await expect
        .poll(
          () =>
            fs.access(promotionReady).then(
              () => true,
              () => false,
            ),
          {
            timeout: 10_000,
          },
        )
        .toBe(true);
      const heldByPromotion = JSON.parse(
        await fs.readFile(
          path.join(userData, "farol-next-state", "promotion.lease"),
          "utf8",
        ),
      );
      expect(heldByPromotion.generation).toBe("gen-promo");

      // Admission resumes and tries to start work: it must lose,
      // deterministically, with its own refusal.
      await fs.writeFile(admissionGo, "go");
      const admissionCode = await waitForClose(admission);
      expect(admissionOutput()).toBe("HELD:false\nREFUSED\n");
      expect(admissionCode).toBe(1);

      // The loser never blocked placement: promotion proceeds and releases
      // on its own schedule, holding the exact same record throughout.
      const stillPromotion = JSON.parse(
        await fs.readFile(
          path.join(userData, "farol-next-state", "promotion.lease"),
          "utf8",
        ),
      );
      expect(stillPromotion).toEqual(heldByPromotion);
      await fs.writeFile(promotionRelease, "release");
      const promotionCode = await waitForClose(promotion);
      // Promotion started after admission's check and before admission's
      // attempt, so it can only ever have seen a free lease.
      expect(promotionOutput()).toBe("HELD:false\nACQUIRED\nRELEASED\n");
      expect(promotionCode).toBe(0);
    } finally {
      admission.kill("SIGKILL");
      promotion?.kill("SIGKILL");
    }
  }, 30_000);
});
