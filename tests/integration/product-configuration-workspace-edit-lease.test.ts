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

// S35-N03c: `bfcb351f` closed the admission gap for a Chat turn and a
// native Agent start (both now hold the SAME promotion lease a promotion
// itself holds from before its drain check through placement, in the
// "admission" role — see `live-task-registry.ts`), but left the guarded
// workspace edit open: `recordPendingWorkspaceEdit` durably wrote
// `EDIT_DELIVERY_PENDING`-observable state (and the edit then wrote real
// bytes into the user's workspace) without checking or holding that lease
// at all. These tests exercise the exact interleaving in both orders,
// using the SAME `acquirePromotionLease`/`releasePromotionLease` primitives
// `tooling/promote-preview.mjs` uses for role "promotion", to prove a real
// promotion attempt and a real guarded edit now exclude each other.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

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
  const workspaceId = added.snapshot.settings.computer.workspaces[0]?.workspaceId;
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

function fakeAction(
  outcome: "completed" | "outcome_unknown",
): RunMutableComputerAction {
  return {
    execute: async () =>
      outcome === "completed"
        ? {
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
          }
        : {
            ok: false,
            error: {
              code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN",
              source: "native-workspace",
              retry: "never",
            },
          },
  } as unknown as RunMutableComputerAction;
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

    const recorded = await service.recordPendingWorkspaceEdit(delivery);
    expect(recorded).toMatchObject({ ok: true });

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
    // lease releases in `applyWorkspaceEdit`'s own `finally`, exactly once.
    const applied = await applyWorkspaceEdit(
      fakeAction("completed"),
      applyPendingOf(delivery),
      { oldText: "old", newText: "new" },
      (operationId) => service.releaseWorkspaceEditLease(operationId),
    );
    expect(applied.ok).toBe(true);

    // Only now can a promotion actually take the lease.
    const promotionAfter = await acquirePromotionLease(
      root,
      generation,
      "promotion",
    );
    expect(promotionAfter).not.toBeNull();
    await releasePromotionLease(promotionAfter!);
  });

  it("S35-N03c refuses a guarded edit with its own readable code while a promotion already holds the lease", async () => {
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

    const refused = await service.recordPendingWorkspaceEdit(delivery);
    expect(refused).toMatchObject({
      ok: false,
      error: "WORKSPACE_MUTATION_PROMOTION_PENDING",
    });
    // The refusal must be readable AND must never let the edit become
    // durable: a promotion reading `product-settings.json` right now must
    // still see no pending edit at all.
    expect(refused.snapshot).toMatchObject({
      status: "ready",
      settings: { computer: { pendingEdit: null } },
    });

    await releasePromotionLease(promotionHold!);
    const recordedAfter = await service.recordPendingWorkspaceEdit(delivery);
    expect(recordedAfter).toMatchObject({ ok: true });
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

    await service.recordPendingWorkspaceEdit(delivery);
    const midflight = await acquirePromotionLease(root, generation, "promotion");
    expect(midflight).toBeNull();

    // Acknowledged (e.g. after `recordComputerMutationOutcomeUnknown`) with
    // `applyWorkspaceEdit` never having run at all — the backstop in
    // `clearPendingEdit` must still free the lease rather than widening its
    // critical section to the person's own acknowledgement.
    await service.clearPendingWorkspaceEdit(delivery.operationId);

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

    const recorded = await service.recordPendingWorkspaceEdit(delivery);
    expect(recorded).toMatchObject({ ok: true });
    const applied = await applyWorkspaceEdit(
      fakeAction("outcome_unknown"),
      applyPendingOf(delivery),
      { oldText: "old", newText: "new" },
    );
    expect(applied.ok).toBe(false);
  });
});
