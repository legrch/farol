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
import {
  applyWorkspaceEdit,
  type PendingWorkspaceEdit,
} from "../../src/apps/desktop/workspace-edit";
import type { RunMutableComputerAction } from "../../src/modules/computer/app/service/run-mutable-computer-action";
import type { PendingWorkspaceEditDelivery } from "../../src/pkg/product-settings/contract";
import { SYNTHETIC_ROOT_IDENTITY } from "../fixtures/root-identity";

// S35-N03d: `8a1c1892` proved the mechanism (`ProductConfigurationService`'s
// `promotionLease` dependency and `applyWorkspaceEdit`'s
// `releaseWorkspaceEditLease` callback) against hand-rolled test doubles,
// but left `main.ts` never actually passing them. This file exercises the
// exact two wiring points `main.ts` now carries — `ProductConfigurationService`
// constructed with the same `acquirePromotionLease`/`releasePromotionLease`
// primitives in the "admission" role (see the `liveTaskRegistry` guard
// `main.ts` already used for a Chat turn and a native Agent start), and
// `applyWorkspaceEdit`'s fourth argument bound exactly the way the
// `"computer.apply-workspace-edit"` dispatch now binds it
// (`configuration.releaseWorkspaceEditLease.bind(configuration)`) — rather
// than a substitute closure a unit test could get away with. `main.ts`
// itself cannot be imported here (it is an Electron entry module), so this
// reproduces its wiring inline, the same way
// `promotion-flow.test.mjs`'s "the registry's own admission wiring" case
// proves `LiveTaskRegistry`'s admission wiring without importing `main.ts`.

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
  };
}

function applyPendingOf(
  delivery: PendingWorkspaceEditDelivery,
): PendingWorkspaceEdit {
  return {
    operationId: delivery.operationId,
    workspaceId: delivery.workspaceId,
    computerGeneration: delivery.computerGeneration,
    relativePath: delivery.relativePath,
    bytes: 1,
    beforeSha256: "a".repeat(64),
    expiresAt: Date.now() + 10 * 60_000,
  };
}

function fakeCompletedAction(): RunMutableComputerAction {
  return {
    execute: async () => ({
      ok: true,
      value: {
        operationId: "fake",
        ownerId: "owner-desktop",
        sessionId: "desktop-computer-session",
        taskId: "desktop-computer-task",
        taskEpoch: 1,
        participantId: "desktop-main",
        turnId: "fake",
        generation: 1,
        callId: "fake",
        workspaceId: "workspace",
        relativePath: "README.md",
        operation: "edit" as const,
        receipt: {
          operation: "edit" as const,
          bytes: 1,
          replacements: 1,
          beforeSha256: "a".repeat(64),
          afterSha256: "b".repeat(64),
          relativePath: "README.md",
        },
        resultRetention: "durable" as const,
        redelivered: false,
      },
    }),
  } as unknown as RunMutableComputerAction;
}

describe("desktop wiring: main.ts's own construction path shares the promotion lease", () => {
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

    // Exactly `main.ts`'s dispatch: `applyWorkspaceEdit`'s fourth argument is
    // `configuration.releaseWorkspaceEditLease.bind(configuration)`, not a
    // substitute closure. The edit's outcome is recorded here, in
    // `applyWorkspaceEdit`'s own `finally`, which must release the lease.
    const applied = await applyWorkspaceEdit(
      fakeCompletedAction(),
      applyPendingOf(firstDelivery),
      { oldText: "old", newText: "new" },
      service.releaseWorkspaceEditLease.bind(service),
    );
    expect(applied.ok).toBe(true);
    // Delivery acknowledgement (the caller's own follow-up, distinct from
    // the lease release `applyWorkspaceEdit` already performed above) is
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
