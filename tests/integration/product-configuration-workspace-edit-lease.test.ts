import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
  type WorkspaceEditLeaseGuard,
  type SettingsDeliveryStore,
} from "../../src/apps/desktop/product-configuration";
import {
  acquirePromotionLease,
  promotionLeasePath,
  releasePromotionLease,
  verifyPromotionLease,
} from "../../src/apps/desktop/promotion-lease";
import { withSettingsEditLease } from "../../apps/desktop/with-settings-edit-lease";
import type { PendingWorkspaceEditDelivery } from "../../src/pkg/product-settings/contract";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

// S35-N03c: preserve the historical guarded-edit admission gap regression
// through the active typed storage writer. Real disposable configuration and
// promotion leases prove exclusion; no Go or native workspace edit runs here.

const childScript = fileURLToPath(
  new URL("./fixtures/promotion-lease-child.mjs", import.meta.url),
);

// Mechanical store fixture only; Go owns admission and delivery policy.
type GoDelivery = Extract<
  PendingWorkspaceEditDelivery,
  { backend: "go-owner-v2" }
>;
const deliveryStores = new WeakMap<
  ProductConfigurationService,
  SettingsDeliveryStore
>();
async function replaceDelivery(
  service: ProductConfigurationService,
  next?: GoDelivery,
  invalidateVerification = false,
) {
  let adapter = deliveryStores.get(service);
  if (!adapter) {
    adapter = service.attachSettingsDeliveryStore({
      profileId: "11111111-1111-4111-8111-111111111111",
      ownerId: "owner-desktop",
    });
    deliveryStores.set(service, adapter);
  }
  const read = await adapter.read();
  if (read.status !== "ok" || !read.snapshot)
    throw new Error("settings missing");
  return adapter.replace({
    expected: read.snapshot,
    ...(next
      ? {
          next: {
            backend: next.backend,
            operationId: next.operationId,
            profileId: next.profileId,
            workspaceId: next.workspaceId,
            relativePath: next.relativePath,
            computerGeneration: String(next.computerGeneration),
            beforeSHA256: next.beforeSha256,
            submittedAt: next.submittedAt,
          },
        }
      : {}),
    invalidateVerification,
  });
}

const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => killAndWait(child)));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function waitForLine(
  child: ReturnType<typeof spawn>,
  needle: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(needle)) {
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    setTimeout(
      () => reject(new Error(`timed out waiting for ${needle}`)),
      10_000,
    ).unref();
  });
}

function killAndWait(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
    child.kill("SIGKILL");
  });
}

/**
 * The adversary, exactly as `promotion-lease-fence.test.ts` builds it:
 * the lease file this hold locks is removed by name and a real second
 * process takes its replacement. After this returns, two live holders
 * exist and only the fence can tell them apart.
 */
async function stealLease(root: string): Promise<void> {
  await fs.unlink(promotionLeasePath(root));
  const holder = spawn(
    process.execPath,
    [childScript, root, "hold", "adversary-generation"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(holder);
  await waitForLine(holder, "ACQUIRED");
}

async function userData(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-edit-lease-"),
  );
  roots.push(root);
  return root;
}

function dependencies(promotionLease: WorkspaceEditLeaseGuard | undefined) {
  let sequence = 0;
  const id = () =>
    `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
  const now = () => "2026-09-20T10:00:00.000Z";
  return promotionLease === undefined
    ? { now, id }
    : { now, id, promotionLease };
}

function admissionLeaseGuard(
  root: string,
  generation: string,
): WorkspaceEditLeaseGuard {
  return {
    acquireForAdmission: async () => {
      const handle = await acquirePromotionLease(root, generation, "admission");
      if (!handle) return null;
      return {
        release: () => releasePromotionLease(handle),
        verify: () => verifyPromotionLease(handle),
      };
    },
  };
}

/**
 * The same admission lease, with the real `verifyPromotionLease` as its
 * fence, counting how many times the service takes it: once on entry, and
 * once more immediately before the durable settings write.
 */
function fencedLeaseGuard(
  root: string,
  generation: string,
): WorkspaceEditLeaseGuard & {
  verifies: () => number;
  releases: () => number;
} {
  let verifies = 0,
    releases = 0;
  return {
    verifies: () => verifies,
    releases: () => releases,
    acquireForAdmission: async () => {
      const handle = await acquirePromotionLease(root, generation, "admission");
      if (!handle) return null;
      return {
        release: async () => {
          releases += 1;
          await releasePromotionLease(handle);
        },
        verify: async () => {
          verifies += 1;
          return verifyPromotionLease(handle);
        },
      };
    },
  };
}

async function verifiedWriteWorkspace(
  service: ProductConfigurationService,
): Promise<Readonly<{ workspaceId: string; computerGeneration: number }>> {
  const added = await service.addReadonlyWorkspace({
    root: "/Users/example/project",
    label: "Project",
  });
  if (added.snapshot.status !== "ready") throw new Error("settings missing");
  const workspaceId =
    added.snapshot.settings.computer.workspaces[0]?.workspaceId;
  if (!workspaceId) throw new Error("workspace missing");
  await service.updateWorkspaceAccess(workspaceId, "write");
  const verified = await service.recordComputerVerification(
    workspaceId,
    {
      profile: "computer.local.write/1",
      runtimeGeneration: "runtime-1",
      buildId: "a".repeat(64),
      protocol: "mutable-workspace/1",
    },
    { rootIdentity: SYNTHETIC_ROOT_IDENTITY },
  );
  if (verified.snapshot.status !== "ready") throw new Error("settings missing");
  return {
    workspaceId,
    computerGeneration: verified.snapshot.settings.computer.generation,
  };
}

function deliveryOf(
  operationId: string,
  workspace: Readonly<{ workspaceId: string; computerGeneration: number }>,
  submittedAt: string,
): GoDelivery {
  return {
    operationId,
    workspaceId: workspace.workspaceId,
    relativePath: "README.md",
    computerGeneration: workspace.computerGeneration,
    submittedAt,
    backend: "go-owner-v2",
    profileId: "11111111-1111-4111-8111-111111111111",
    beforeSha256: "a".repeat(64),
  };
}

describe("guarded workspace edit takes the promotion lease", () => {
  it("S35-N03c refuses a live promotion while an edit is durable, then lets it proceed once the edit's outcome is recorded", async () => {
    const root = await userData();
    const generation = "generation-a";
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root: path.join(root, "farol-next-state") }),
      dependencies(admissionLeaseGuard(root, generation)),
    );
    await service.initialize();
    const workspace = await verifiedWriteWorkspace(service);
    const delivery = deliveryOf(
      "00000000-0000-4000-8000-0000000000aa",
      workspace,
      "2026-09-20T10:01:00.000Z",
    );

    const recorded = await replaceDelivery(service, delivery);
    expect(recorded).toMatchObject({ status: "committed" });

    // A real promotion attempt, exactly as `promote-preview.mjs` makes it,
    // must refuse while the edit is durable: this is the gap the packet
    // named — a promotion's drain check and placement is not itself
    // fenced by anything the edit writes unless the SAME lease excludes it.
    const promotionAttempt = await acquirePromotionLease(
      root,
      generation,
      "promotion",
    );
    expect(promotionAttempt).toBeNull();

    // The edit's own outcome is now recorded (successfully, here); its
    // lease releases in `withSettingsEditLease`'s own `finally`, exactly once.
    const applied = await withSettingsEditLease(
      delivery.operationId,
      async () => ({ phase: "completed" }),
      service.releaseWorkspaceEditLease.bind(service),
    );
    expect(applied.phase).toBe("completed");

    // Only now can a promotion actually take the lease.
    const promotionAfter = await acquirePromotionLease(
      root,
      generation,
      "promotion",
    );
    expect(promotionAfter).not.toBeNull();
    await releasePromotionLease(promotionAfter!);
  });

  it("S35-N03c refuses a pending replacement without writing while a promotion already holds the lease", async () => {
    const root = await userData();
    const generation = "generation-b";
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root: path.join(root, "farol-next-state") }),
      dependencies(admissionLeaseGuard(root, generation)),
    );
    await service.initialize();
    const workspace = await verifiedWriteWorkspace(service);
    const delivery = deliveryOf(
      "00000000-0000-4000-8000-0000000000bb",
      workspace,
      "2026-09-20T10:02:00.000Z",
    );

    // A promotion is mid-flight, holding the lease from before its drain
    // check through placement, exactly as `promote-preview.mjs` does.
    const promotionHold = await acquirePromotionLease(
      root,
      generation,
      "promotion",
    );
    expect(promotionHold).not.toBeNull();

    const refused = await replaceDelivery(service, delivery);
    expect(refused).toEqual({ status: "not_written" });
    // The refusal must be readable AND must never let the edit become
    // durable: a promotion reading `config.json` right now must
    // still see no pending edit at all.
    expect(service.snapshot()).toMatchObject({
      status: "ready",
      settings: { computer: { pendingEdit: null } },
    });

    await releasePromotionLease(promotionHold!);
    const recordedAfter = await replaceDelivery(service, delivery);
    expect(recordedAfter).toMatchObject({ status: "committed" });
    await service.releaseWorkspaceEditLease(delivery.operationId);
  });

  it("S35-N03c releases the lease when an edit is acknowledged without ever being applied, so a promotion is not wedged forever", async () => {
    const root = await userData();
    const generation = "generation-c";
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root: path.join(root, "farol-next-state") }),
      dependencies(admissionLeaseGuard(root, generation)),
    );
    await service.initialize();
    const workspace = await verifiedWriteWorkspace(service);
    const delivery = deliveryOf(
      "00000000-0000-4000-8000-0000000000cc",
      workspace,
      "2026-09-20T10:03:00.000Z",
    );

    expect(await replaceDelivery(service, delivery)).toMatchObject({
      status: "committed",
    });
    const midflight = await acquirePromotionLease(
      root,
      generation,
      "promotion",
    );
    expect(midflight).toBeNull();

    // Mechanical clear is a release backstop when the execution wrapper did
    // not run. This fixture does not claim that Go would authorize an ACK.
    expect(await replaceDelivery(service)).toMatchObject({
      status: "committed",
    });

    const afterAck = await acquirePromotionLease(root, generation, "promotion");
    expect(afterAck).not.toBeNull();
    await releasePromotionLease(afterAck!);
  });

  it("keeps behaving as before when no promotionLease dependency is configured", async () => {
    const root = await userData();
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root: path.join(root, "farol-next-state") }),
      dependencies(undefined),
    );
    await service.initialize();
    const workspace = await verifiedWriteWorkspace(service);
    const delivery = deliveryOf(
      "00000000-0000-4000-8000-0000000000dd",
      workspace,
      "2026-09-20T10:04:00.000Z",
    );

    const recorded = await replaceDelivery(service, delivery);
    expect(recorded).toMatchObject({ status: "committed" });
    const applied = await withSettingsEditLease(
      delivery.operationId,
      async () => ({ phase: "outcome_unknown" }),
      service.releaseWorkspaceEditLease.bind(service),
    );
    expect(applied.phase).toBe("outcome_unknown");
  });
});

// S35-H1R: preserve the real stolen-inode regression at the typed writer's
// pre-rename fence. The existing disposable holder takes a replacement lease
// after entry verification, inside the store's beforeCommit seam.
describe("the guarded edit's fence sits at the durable write (S35-H1R)", () => {
  function storeWithSeam(
    root: string,
    seam: { steal: (() => Promise<void>) | null },
  ): ProductSettingsStore {
    return new ProductSettingsStore(
      { root: path.join(root, "farol-next-state") },
      {
        beforeCommit: async () => {
          const pending = seam.steal;
          seam.steal = null;
          if (pending) await pending();
        },
      },
    );
  }

  function settingsFileOf(root: string): string {
    return path.join(root, "farol-next-state", "config.json");
  }

  it("S35-H1R refuses, releases the hold and leaves the settings bytes untouched when the lease is stolen between the entry check and the write", async () => {
    const root = await userData();
    const generation = "generation-fence";
    const seam: { steal: (() => Promise<void>) | null } = { steal: null };
    const guard = fencedLeaseGuard(root, generation);
    const service = new ProductConfigurationService(
      storeWithSeam(root, seam),
      dependencies(guard),
    );
    await service.initialize();
    const workspace = await verifiedWriteWorkspace(service);
    const delivery = deliveryOf(
      "00000000-0000-4000-8000-0000000000ee",
      workspace,
      "2026-09-20T10:05:00.000Z",
    );
    const bytesBefore = await fs.readFile(settingsFileOf(root), "utf8");

    seam.steal = () => stealLease(root);
    const refused = await replaceDelivery(service, delivery);

    expect(refused).toEqual({ status: "not_written" });
    expect(service.snapshot()).toMatchObject({
      status: "ready",
      settings: { computer: { pendingEdit: null } },
    });
    // Nothing moved on disk: a promotion reading these bytes right now
    // still sees no pending edit, and no revision was spent on a refusal.
    expect(await fs.readFile(settingsFileOf(root), "utf8")).toBe(bytesBefore);
    // Both checks ran: the entry one (which passed) and the fence
    // immediately before the durable write (which refused).
    expect(guard.verifies()).toBe(2);

    // The hold this edit took is released rather than leaked: the thief is
    // the only holder left, and the edit's own operation has nothing
    // outstanding.
    expect(guard.releases()).toBe(1);
    await service.releaseWorkspaceEditLease(delivery.operationId);
    expect(guard.releases()).toBe(1);
  });

  it("S35-H1R control: the same edit records, and the same two checks run, when nobody steals the lease", async () => {
    const root = await userData();
    const generation = "generation-fence-control";
    const seam: { steal: (() => Promise<void>) | null } = { steal: null };
    const guard = fencedLeaseGuard(root, generation);
    const service = new ProductConfigurationService(
      storeWithSeam(root, seam),
      dependencies(guard),
    );
    await service.initialize();
    const workspace = await verifiedWriteWorkspace(service);
    const delivery = deliveryOf(
      "00000000-0000-4000-8000-0000000000ff",
      workspace,
      "2026-09-20T10:06:00.000Z",
    );

    const recorded = await replaceDelivery(service, delivery);

    expect(recorded).toMatchObject({ status: "committed" });
    expect(service.snapshot()).toMatchObject({
      status: "ready",
      settings: {
        computer: { pendingEdit: { operationId: delivery.operationId } },
      },
    });
    expect(await fs.readFile(settingsFileOf(root), "utf8")).toContain(
      delivery.operationId,
    );
    expect(guard.verifies()).toBe(2);

    // The lease is still held by this edit until its outcome is recorded.
    const promotionAttempt = await acquirePromotionLease(
      root,
      generation,
      "promotion",
    );
    expect(promotionAttempt).toBeNull();
    expect(guard.releases()).toBe(0);
    await service.releaseWorkspaceEditLease(delivery.operationId);
    await service.releaseWorkspaceEditLease(delivery.operationId);
    expect(guard.releases()).toBe(1);
    const afterRelease = await acquirePromotionLease(
      root,
      generation,
      "promotion",
    );
    expect(afterRelease).not.toBeNull();
    await releasePromotionLease(afterRelease!);
  });
});
