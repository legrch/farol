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

/** Adapter targets contain IDs; persisted targets contain owner labels. Never
 * normalize an identifier before lookup or accept a label as an adapter ID. */
export function resolveOperationTarget(
  target: OperationMetadata["target"],
  workspaces: OperationWorkspaceLabels,
  representation: "identifier" | "label",
) {
  const labels = OperationWorkspaceLabelsSchema.parse(
    workspaces.map(({ workspaceId, label }) => ({ workspaceId, label })),
  );
  const workspace = labels.find((entry) =>
    representation === "identifier"
      ? entry.workspaceId === target.workspace
      : entry.label === target.workspace,
  );
  const { workspace: supplied, relativePath, ...rest } = target;
  return OperationTargetSchema.parse({
    ...rest,
    ...(supplied === undefined
      ? {}
      : { workspace: workspace?.label ?? unknownWorkspace }),
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
      target: resolveOperationTarget(entry.target, workspaces, "label"),
    })),
  });
}
