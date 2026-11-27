import { RunReadonlyComputerAction } from "../../modules/computer/app/service/run-readonly-computer-action";
import {
  createParticipantAuthority,
  deriveTaskGrant,
  type AuthorityCapability,
  type ComputerApproval,
  type TaskAdmission,
} from "../../modules/computer/domain/execution-authority";
import { InMemoryAuthorityRepository } from "../../modules/computer/infra/repo/in-memory-authorities";
import { InMemoryComputerApprovalRepository } from "../../modules/computer/infra/repo/in-memory-computer-approvals";
import type { VerificationWorkspaceAction } from "../../../apps/desktop/configuration/computer";
import type {
  ApprovedProductWorkspace,
  ProductSettings,
} from "../../pkg/product-settings/contract";
import { identityBoundWorkspaces } from "./identity-bound-workspaces";

type VerificationWorkspace = ConstructorParameters<
  typeof RunReadonlyComputerAction
>[2];

export function createVerificationWorkspaceAction(
  nativeWorkspace: VerificationWorkspace,
) {
  return function verificationWorkspaceAction(
    settings: ProductSettings,
    workspace: ApprovedProductWorkspace,
    expiresAt: number,
  ): VerificationWorkspaceAction | null {
    if (settings.computer.commands === "none") return null;
    const ownerId = "owner-desktop";
    const sessionId = "desktop-command-session";
    const taskId = "desktop-command-task";
    const participantId = "desktop-command-main";
    const approvalCapabilities: AuthorityCapability[] = [
      "workspace.list",
      "workspace.read",
      "workspace.search",
      "verification.run",
      ...(settings.computer.workspaces.some(
        (candidate) => candidate.access === "write",
      )
        ? (["workspace.write"] as const)
        : []),
    ];
    const bound = identityBoundWorkspaces(settings.computer.workspaces);
    const approval: ComputerApproval = {
      ownerId,
      computerId: settings.computer.computerId,
      generation: settings.computer.generation,
      workspaces: bound.map((candidate) => ({
        workspaceId: candidate.workspaceId,
        root: candidate.root,
        access: candidate.access,
        rootIdentity: candidate.rootIdentity,
        ...(candidate.gitMetadata
          ? { gitMetadata: candidate.gitMetadata }
          : {}),
      })),
      excludedPaths: bound.flatMap((candidate) =>
        candidate.excludedPaths.map((excluded) => ({
          workspaceId: candidate.workspaceId,
          path: excluded,
        })),
      ),
      capabilities: approvalCapabilities,
      network: "none",
      commands: settings.computer.commands,
      expiresAt,
    };
    const admission: TaskAdmission = {
      authorityId: `desktop-command-authority-${settings.computer.generation}`,
      ownerId,
      sessionId,
      taskId,
      taskEpoch: settings.computer.generation,
      computerId: settings.computer.computerId,
      computerGeneration: settings.computer.generation,
      workspaces: [
        {
          workspaceId: workspace.workspaceId,
          mode: "subtree",
          root: workspace.root,
          access: "read",
        },
      ],
      excludedPaths: workspace.excludedPaths.map((excluded) => ({
        workspaceId: workspace.workspaceId,
        path: excluded,
      })),
      capabilities: ["verification.run"],
      network: "none",
      commands: settings.computer.commands,
      expiresAt,
    };
    const grant = deriveTaskGrant(approval, admission, Date.now());
    if (!grant.ok) return null;
    const participant = createParticipantAuthority(grant.value, {
      participantId,
      role: "main",
      mutationOwnership: "none",
    });
    if (!participant.ok) return null;
    return new RunReadonlyComputerAction(
      new InMemoryAuthorityRepository([participant.value]),
      new InMemoryComputerApprovalRepository([approval]),
      nativeWorkspace,
      { now: () => Date.now() },
    );
  };
}
