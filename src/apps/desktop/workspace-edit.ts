import type { WorkspaceMutationReceipt } from "../../modules/computer/app/port/mutable-workspace";
import { PrivateWorkspaceMutationStore } from "../../modules/computer/infra/repo/private-workspace-mutation-store";

const DESKTOP_OWNER_ID = "owner-desktop";
const DESKTOP_SESSION_ID = "desktop-computer-session";
const DESKTOP_TASK_ID = "desktop-computer-task";
const DESKTOP_PARTICIPANT_ID = "desktop-main";

export type PendingWorkspaceEdit = Readonly<{
  operationId: string;
  workspaceId: string;
  computerGeneration: number;
  relativePath: string;
  bytes: number;
  beforeSha256: string;
  expiresAt: number;
}>;

// Compatibility reader only: what a restarted desktop can learn about a legacy
// submitted guarded edit from
// the durable operation store alone.  Observation never executes anything and
// needs no write authority: it reports the recorded outcome of that exact
// operation ID, and an admitted operation whose executor vanished is unknown,
// never retried.
export type ObservedWorkspaceEdit =
  | Readonly<{
      status: "completed";
      operationId: string;
      receipt: WorkspaceMutationReceipt;
      redelivered: true;
    }>
  | Readonly<{ status: "failed"; operationId: string; code: string }>
  | Readonly<{ status: "outcome_unknown"; operationId: string }>
  | Readonly<{ status: "not_admitted"; operationId: string }>
  | Readonly<{ status: "unavailable"; operationId: string }>;

export function workspaceEditPreview(
  pending: PendingWorkspaceEdit,
): Readonly<Record<string, unknown>> {
  return {
    kind: "computer.workspace-edit-preview",
    operationId: pending.operationId,
    workspaceId: pending.workspaceId,
    relativePath: pending.relativePath,
    bytes: pending.bytes,
    beforeSha256: pending.beforeSha256,
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
}

function desktopMutationIdentity(
  pending: Pick<PendingWorkspaceEdit, "operationId" | "computerGeneration">,
) {
  return {
    operationId: pending.operationId,
    ownerId: DESKTOP_OWNER_ID,
    sessionId: DESKTOP_SESSION_ID,
    taskId: DESKTOP_TASK_ID,
    taskEpoch: pending.computerGeneration,
    participantId: DESKTOP_PARTICIPANT_ID,
  } as const;
}

export async function observeWorkspaceEdit(
  dependencies: Readonly<{ mutationStateRoot: string }>,
  pending: Pick<
    PendingWorkspaceEdit,
    "operationId" | "workspaceId" | "computerGeneration"
  >,
): Promise<ObservedWorkspaceEdit> {
  const operationId = pending.operationId;
  let record;
  try {
    record = await new PrivateWorkspaceMutationStore({
      root: dependencies.mutationStateRoot,
    }).loadExisting(desktopMutationIdentity(pending));
  } catch {
    return { status: "unavailable", operationId };
  }
  if (record === null) return { status: "not_admitted", operationId };
  if (record.workspaceId !== pending.workspaceId) {
    return { status: "unavailable", operationId };
  }
  switch (record.phase) {
    case "completed":
      return {
        status: "completed",
        operationId,
        receipt: record.outcome.receipt,
        redelivered: true,
      };
    case "failed":
      return { status: "failed", operationId, code: record.outcome.code };
    case "prepared":
    case "outcome_unknown":
      return { status: "outcome_unknown", operationId };
  }
}
