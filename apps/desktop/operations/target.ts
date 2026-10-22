import { createHash } from "node:crypto";
import {
  OperationTargetSchema,
  OperationWorkspaceLabelsSchema,
  OperationsSnapshotSchema,
  type OperationMetadata,
  type OperationsSnapshot,
} from "../renderer/operations-contract";

export type OperationWorkspaceLabels = readonly {
  workspaceId: string;
  label: string;
}[];
export const unknownWorkspace = "[unknown workspace]";

/** Only hash an exact, validated configured ID, never arbitrary caller text. */
function workspaceIdentity(workspaceId: string): string {
  return createHash("sha256").update(workspaceId, "utf8").digest("hex");
}

/** Adapter targets carry IDs; persisted targets carry opaque identity and owner
 * labels. Persisted reads must prove identity, never a name. */
export function resolveOperationTarget(
  target: OperationMetadata["target"] & { workspaceIdentity?: unknown },
  workspaces: OperationWorkspaceLabels,
  representation: "identifier" | "persisted",
) {
  const labels = OperationWorkspaceLabelsSchema.parse(
    workspaces.map(({ workspaceId, label }) => ({ workspaceId, label })),
  );
  const {
    workspace: supplied,
    relativePath,
    workspaceIdentity: suppliedIdentity,
    ...rest
  } = target;
  const matches = labels.filter((entry) =>
    representation === "identifier"
      ? entry.workspaceId === supplied
      : suppliedIdentity === workspaceIdentity(entry.workspaceId),
  );
  // An ambiguous owner index cannot establish a workspace binding either.
  const workspace = matches.length === 1 ? matches[0] : undefined;
  return OperationTargetSchema.parse({
    ...rest,
    ...(supplied === undefined
      ? {}
      : { workspace: workspace?.label ?? unknownWorkspace }),
    ...(workspace
      ? { workspaceIdentity: workspaceIdentity(workspace.workspaceId) }
      : {}),
    ...(workspace && relativePath !== undefined ? { relativePath } : {}),
  });
}

/** Validate raw targets before the display schema can normalize caller IDs. */
export function resolveOperationsSnapshot(
  snapshot: OperationsSnapshot,
  workspaces: OperationWorkspaceLabels,
): OperationsSnapshot {
  return OperationsSnapshotSchema.parse({
    ...snapshot,
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      target: resolveOperationTarget(entry.target, workspaces, "persisted"),
    })),
  });
}
