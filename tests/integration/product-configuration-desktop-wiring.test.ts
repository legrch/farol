import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
  type WorkspaceEditLeaseGuard,
} from "../../src/apps/desktop/product-configuration";
import {
  acquirePromotionLease,
  releasePromotionLease,
} from "../../src/apps/desktop/promotion-lease";
import { withSettingsEditLease } from "../../apps/desktop/with-settings-edit-lease";
import type { PendingWorkspaceEditDelivery } from "../../src/pkg/product-settings/contract";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

// Real lease/configuration integration with the same admission guard and
// withSettingsEditLease release wrapper used by normal main. Only the Go RPC
// result is doubled; no native workspace mutation is performed here.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function userData(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-next-desktop-wiring-"),
  );
  roots.push(root);
  return root;
}

// Structurally identical to the object literal `main.ts` now passes as
// `ProductConfigurationDependencies.promotionLease` when it constructs
// `ProductConfigurationService` in `main()`: same primitives, same
// "admission" role, same swallow-and-refuse behaviour on contention.
function desktopPromotionLeaseGuard(
  root: string,
  buildId: string,
): WorkspaceEditLeaseGuard {
  return {
    acquireForAdmission: async () => {
      const handle = await acquirePromotionLease(
        root,
        buildId,
        "admission",
      ).catch(() => null);
      if (!handle) return null;
      return { release: () => releasePromotionLease(handle) };
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
): PendingWorkspaceEditDelivery {
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

describe("desktop wiring: main.ts's own construction path shares the promotion lease", () => {
  it.each(["refused", "unknown", "lost"] as const)(
    "keeps the lease through %s result recording and releases without clearing delivery",
    async (outcome) => {
      const root = await userData();
      const buildId = "build-go-edit";
      const service = new ProductConfigurationService(
        new ProductSettingsStore({ root: path.join(root, "farol-next-state") }),
        { promotionLease: desktopPromotionLeaseGuard(root, buildId) },
      );
      await service.initialize();
      const workspace = await verifiedWriteWorkspace(service);
      const delivery = deliveryOf(
        "00000000-0000-4000-8000-0000000000ea",
        workspace,
        "2026-10-04T22:00:00.000Z",
      );
      expect(await service.recordPendingWorkspaceEdit(delivery)).toMatchObject({
        ok: true,
      });
      const original = new Error("original transport failure");
      const attempt = withSettingsEditLease(
        delivery.operationId,
        async () => {
          expect(
            await acquirePromotionLease(root, buildId, "promotion"),
          ).toBeNull();
          if (outcome !== "refused") {
            expect(
              await service.recordComputerMutationOutcomeUnknown(
                workspace.workspaceId,
              ),
            ).toMatchObject({ ok: true });
            expect(
              await acquirePromotionLease(root, buildId, "promotion"),
            ).toBeNull();
          }
          if (outcome === "lost") throw original;
          return outcome;
        },
        service.releaseWorkspaceEditLease.bind(service),
      );
      if (outcome === "lost") await expect(attempt).rejects.toBe(original);
      else expect(await attempt).toBe(outcome);
      const after = service.snapshot();
      expect(after).toMatchObject({
        status: "ready",
        settings: { computer: { pendingEdit: delivery } },
      });
      const next = await acquirePromotionLease(root, buildId, "promotion");
      expect(next).not.toBeNull();
      await releasePromotionLease(next!);
    },
  );
  it("S35-N03d an admitted edit refuses a promotion, a promotion refuses an edit, and recording the edit's outcome releases the lease", async () => {
    const root = await userData();
    const buildId = "build-desktop-wiring";
    // Exactly `main.ts`'s construction: `ProductConfigurationService` built
    // with the `promotionLease` dependency.
    const service = new ProductConfigurationService(
      new ProductSettingsStore({ root: path.join(root, "farol-next-state") }),
      { promotionLease: desktopPromotionLeaseGuard(root, buildId) },
    );
    await service.initialize();
    const workspace = await verifiedWriteWorkspace(service);
    const firstDelivery = deliveryOf(
      "00000000-0000-4000-8000-0000000000ee",
      workspace,
      "2026-09-20T10:05:00.000Z",
    );

    // The edit becomes durable and takes the same cross-process lease a
    // promotion would.
    const recorded = await service.recordPendingWorkspaceEdit(firstDelivery);
    expect(recorded).toMatchObject({ ok: true });

    // An admitted edit refuses a promotion: a live promotion attempt sees
    // the lease already held and is refused with its own readable outcome
    // (`null`, exactly the contention outcome `promote-preview.mjs` turns
    // into `PROMOTION_LEASE_HELD`).
    const promotionDuringEdit = await acquirePromotionLease(
      root,
      buildId,
      "promotion",
    );
    expect(promotionDuringEdit).toBeNull();

    // Exactly `main.ts`'s dispatch: `withSettingsEditLease`'s release argument is
    // `configuration.releaseWorkspaceEditLease.bind(configuration)`, not a
    // substitute closure. The edit's outcome is recorded here, in
    // `withSettingsEditLease`'s own `finally`, which must release the lease.
    const applied = await withSettingsEditLease(
      firstDelivery.operationId,
      async () => ({ phase: "completed" }),
      service.releaseWorkspaceEditLease.bind(service),
    );
    expect(applied.phase).toBe("completed");
    // Delivery acknowledgement (the caller's own follow-up, distinct from
    // the lease release `withSettingsEditLease` already performed above) is
    // what clears `computer.pendingEdit` so a later edit is admitted.
    await service.clearPendingWorkspaceEdit(firstDelivery.operationId);

    // Recording the outcome released the lease: a promotion can now take it.
    const promotionAfterOutcome = await acquirePromotionLease(
      root,
      buildId,
      "promotion",
    );
    expect(promotionAfterOutcome).not.toBeNull();

    // A promotion refuses an edit: while a live promotion holds the lease,
    // a new guarded edit is refused with its own readable code rather than
    // becoming durable.
    const secondDelivery = deliveryOf(
      "00000000-0000-4000-8000-0000000000ef",
      workspace,
      "2026-09-20T10:06:00.000Z",
    );
    const refused = await service.recordPendingWorkspaceEdit(secondDelivery);
    expect(refused).toMatchObject({
      ok: false,
      error: "WORKSPACE_MUTATION_PROMOTION_PENDING",
    });
    expect(refused.snapshot).toMatchObject({
      status: "ready",
      settings: { computer: { pendingEdit: null } },
    });

    // Once the promotion releases, the same edit can proceed and its own
    // lease releases the same way.
    await releasePromotionLease(promotionAfterOutcome!);
    const recordedAfter =
      await service.recordPendingWorkspaceEdit(secondDelivery);
    expect(recordedAfter).toMatchObject({ ok: true });
    await service.releaseWorkspaceEditLease(secondDelivery.operationId);
    const promotionFinal = await acquirePromotionLease(
      root,
      buildId,
      "promotion",
    );
    expect(promotionFinal).not.toBeNull();
    await releasePromotionLease(promotionFinal!);
  });
});
