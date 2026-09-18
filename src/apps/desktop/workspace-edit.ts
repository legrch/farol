import type { MutableWorkspace } from "../../modules/computer/app/port/mutable-workspace";
import type {
  ReadonlyWorkspaceDescriptor,
  ReadonlyWorkspaceErrorCode,
  WorkspaceEditSnapshotReader,
} from "../../modules/computer/app/port/readonly-workspace";
import {
  RunMutableComputerAction,
  type MutableComputerActionResult,
} from "../../modules/computer/app/service/run-mutable-computer-action";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type AuthorityCapability,
  type ComputerApproval,
  type TaskAdmission,
} from "../../modules/computer/domain/execution-authority";
import { Sha256WorkspaceMutationDigester } from "../../modules/computer/infra/native/sha256-workspace-mutation-digester";
import { InMemoryAuthorityRepository } from "../../modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../modules/computer/infra/repo/in-memory-computer-approvals";
import { PrivateWorkspaceMutationStore } from "../../modules/computer/infra/repo/private-workspace-mutation-store";
import type {
  ApprovedProductWorkspace,
  ProductSettings,
} from "../../pkg/product-settings/contract";

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

export type WorkspaceEditPreparation =
  | Readonly<{ ok: true; pending: PendingWorkspaceEdit }>
  | Readonly<{ ok: false; code: ReadonlyWorkspaceErrorCode }>;

export type DesktopWorkspaceEditDependencies = Readonly<{
  mutationStateRoot: string;
  workspace: MutableWorkspace;
  now: () => number;
}>;

/**
 * Reads the file once and keeps the identity of exactly those bytes as the
 * edit precondition.  Applying later compares the same raw bytes, so a file
 * that changed in between is a conflict rather than an overwrite.
 */
export async function prepareWorkspaceEdit(
  reader: WorkspaceEditSnapshotReader,
  input: Readonly<{
    operationId: string;
    workspace: ReadonlyWorkspaceDescriptor;
    computerGeneration: number;
    relativePath: string;
    expiresAt: number;
  }>,
): Promise<WorkspaceEditPreparation> {
  const snapshot = await reader.readEditSnapshot({
    workspace: input.workspace,
    relativePath: input.relativePath,
  });
  if (!snapshot.ok) return { ok: false, code: snapshot.error.code };
  return {
    ok: true,
    pending: {
      operationId: input.operationId,
      workspaceId: input.workspace.workspaceId,
      computerGeneration: input.computerGeneration,
      relativePath: input.relativePath,
      bytes: snapshot.value.bytes,
      beforeSha256: snapshot.value.sha256,
      expiresAt: input.expiresAt,
    },
  };
}

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

export function desktopMutableWorkspaceAction(
  computer: ProductSettings["computer"],
  workspace: ApprovedProductWorkspace,
  expiresAt: number,
  dependencies: DesktopWorkspaceEditDependencies,
): RunMutableComputerAction | null {
  const approvalCapabilities: AuthorityCapability[] = [
    "workspace.list",
    "workspace.read",
    "workspace.search",
    ...(computer.workspaces.some((candidate) => candidate.access === "write")
      ? (["workspace.write"] as const)
      : []),
  ];
  const approval: ComputerApproval = {
    ownerId: DESKTOP_OWNER_ID,
    computerId: computer.computerId,
    generation: computer.generation,
    workspaces: computer.workspaces.map((candidate) => ({
      workspaceId: candidate.workspaceId,
      root: candidate.root,
      access: candidate.access,
    })),
    excludedPaths: computer.workspaces.flatMap((candidate) =>
      candidate.excludedPaths.map((excluded) => ({
        workspaceId: candidate.workspaceId,
        path: excluded,
      })),
    ),
    capabilities: approvalCapabilities,
    network: "none",
    commands: "none",
    expiresAt,
  };
  const admission: TaskAdmission = {
    authorityId: `desktop-authority-${computer.generation}`,
    ownerId: DESKTOP_OWNER_ID,
    sessionId: DESKTOP_SESSION_ID,
    taskId: DESKTOP_TASK_ID,
    taskEpoch: computer.generation,
    computerId: computer.computerId,
    computerGeneration: computer.generation,
    workspaces: [
      {
        workspaceId: workspace.workspaceId,
        mode: "subtree",
        root: workspace.root,
        access: "write",
      },
    ],
    excludedPaths: workspace.excludedPaths.map((excluded) => ({
      workspaceId: workspace.workspaceId,
      path: excluded,
    })),
    capabilities: ["workspace.read", "workspace.write"],
    network: "none",
    commands: "none",
    expiresAt,
  };
  const grant = deriveTaskGrant(approval, admission, dependencies.now());
  if (!grant.ok) return null;
  const participant = createParticipantAuthority(grant.value, {
    participantId: DESKTOP_PARTICIPANT_ID,
    role: "main",
    mutationOwnership: "task",
  });
  if (!participant.ok) return null;
  return new RunMutableComputerAction(
    new InMemoryAuthorityRepository([participant.value]),
    new InMemoryComputerApprovalRepository([approval]),
    new PrivateWorkspaceMutationStore({
      root: dependencies.mutationStateRoot,
    }),
    new Sha256WorkspaceMutationDigester(),
    dependencies.workspace,
    { now: dependencies.now },
  );
}

export function applyWorkspaceEdit(
  action: RunMutableComputerAction,
  pending: PendingWorkspaceEdit,
  edit: Readonly<{ oldText: string; newText: string }>,
): Promise<MutableComputerActionResult> {
  return action.execute({
    operationId: pending.operationId,
    ownerId: DESKTOP_OWNER_ID,
    sessionId: DESKTOP_SESSION_ID,
    taskId: DESKTOP_TASK_ID,
    taskEpoch: pending.computerGeneration,
    participantId: DESKTOP_PARTICIPANT_ID,
    turnId: pending.operationId,
    generation: pending.computerGeneration,
    callId: pending.operationId,
    workspaceId: pending.workspaceId,
    operation: {
      kind: "workspace.edit",
      relativePath: pending.relativePath,
      edits: [{ oldText: edit.oldText, newText: edit.newText }],
      expectedSha256: pending.beforeSha256,
    },
  });
}
