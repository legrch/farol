import { createHash } from "node:crypto";
import { z } from "zod";
import {
  WorkspaceContinuitySchema,
  WorkspaceRootIdentitySchema,
  type ProductSettings,
} from "../../pkg/product-settings/contract";

// OWNER-CONSENT only: no current ShellVerified, build, startup device, inode,
// timestamps, Settings revision/generation, publication or stored check receipts.
// The independent effective approval still computes and guards those facts.
export function workspaceConsentDigest(settings: ProductSettings): string {
  const approval = {
    ownerId: "owner-desktop",
    computerId: settings.computer.computerId,
    commands: settings.computer.commands,
    filePolicy: settings.computer.filePolicy ?? "",
    network: "none",
    workspaces: settings.computer.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      access: workspace.access,
      excludedPaths: [...workspace.excludedPaths],
      gitHistoryApproved: workspace.gitHistoryApproved === true,
      gitMetadata: workspace.gitMetadata
        ? {
            gitDirectory: workspace.gitMetadata.gitDirectory,
            commonDirectory: workspace.gitMetadata.commonDirectory,
          }
        : null,
    })),
  };
  return createHash("sha256").update(JSON.stringify(approval)).digest("hex");
}

// This is a strict trusted-host input, not a new public Settings command.
// It is accepted only after the original WAL's withdraw ACK was retained.
export const ContinuityWriteIntentSchema = z.strictObject({
  operationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().safe(),
  expectedGeneration: z.number().int().positive().safe(),
  expectedConsentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  rootIdentity: WorkspaceRootIdentitySchema,
  continuity: WorkspaceContinuitySchema,
});
export type ContinuityWriteIntent = z.infer<typeof ContinuityWriteIntentSchema>;

// Never hold a Go native/store mutex while awaiting this TS writer. The sole
// trusted composition supplies synchronous reservation currentness, an exact
// ACK from the original Go withdrawal, and a fresh held-native requalification.
export type ContinuityWriteFence = Readonly<{
  current(): boolean;
  withdrawalAcknowledged(): boolean;
  requalifyNative(): Promise<boolean>;
}>;

export function nextContinuitySettings(
  original: ProductSettings,
  intent: ContinuityWriteIntent,
): ProductSettings | null {
  const parsed = ContinuityWriteIntentSchema.safeParse(intent);
  if (!parsed.success) return null;
  const input = parsed.data;
  const workspace = original.computer.workspaces.find(
    (current) => current.workspaceId === input.workspaceId,
  );
  if (
    original.revision !== input.expectedRevision ||
    original.computer.generation !== input.expectedGeneration ||
    original.computer.pendingEdit !== null ||
    !workspace?.rootIdentity ||
    input.continuity.workspaceId !== workspace.workspaceId ||
    input.continuity.computerId !== original.computer.computerId ||
    input.continuity.root !== workspace.root ||
    input.continuity.fileId !== input.rootIdentity.inode ||
    (workspace.continuity === undefined &&
      input.continuity.enrollment.operationId !== input.operationId) ||
    workspaceConsentDigest(original) !== input.expectedConsentSha256 ||
    original.revision === Number.MAX_SAFE_INTEGER ||
    original.computer.generation === Number.MAX_SAFE_INTEGER
  )
    return null;
  // Once enrolled, retain the original continuity tuple and exact path. Only
  // current device/inode changes; replacing birth/UUID is fresh consent, not a
  // remount. Legacy may be enrolled only by the explicit picker owner.
  if (
    workspace.continuity &&
    (workspace.continuity.volumeUuid !== input.continuity.volumeUuid ||
      workspace.continuity.fileId !== input.continuity.fileId ||
      workspace.continuity.birthSeconds !== input.continuity.birthSeconds ||
      workspace.continuity.birthNanoseconds !==
        input.continuity.birthNanoseconds ||
      workspace.continuity.enrollment.operationId !==
        input.continuity.enrollment.operationId)
  )
    return null;
  const next: ProductSettings = {
    ...original,
    revision: original.revision + 1,
    computer: {
      ...original.computer,
      generation: original.computer.generation + 1,
      workspaces: original.computer.workspaces.map((entry) => {
        if (entry.workspaceId !== workspace.workspaceId) return entry;
        const { accessCheck: _stale, ...rest } = entry;
        return {
          ...rest,
          rootIdentity: { ...input.rootIdentity },
          continuity: structuredClone(workspace.continuity ?? input.continuity),
        };
      }),
    },
    setup: {
      ...original.setup,
      computer: {
        ...original.setup.computer,
        verified: null,
        reachable: "unknown",
        needsAction: "Verify this workspace after reconnecting Farol.",
      },
    },
  };
  // An input that changes owner consent, including exclusions/Commands/Git,
  // never becomes an authorized remount or legacy enrollment.
  return workspaceConsentDigest(next) === input.expectedConsentSha256
    ? next
    : null;
}
