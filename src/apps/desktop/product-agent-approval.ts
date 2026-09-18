import type { ComputerApproval } from "../../modules/computer/domain/execution-authority";
import type { ProductSettings } from "../../pkg/product-settings/contract";

export type ProductAgentApprovalGrant = Readonly<{
  ownerId: string;
  capabilities: ComputerApproval["capabilities"];
  commands: ComputerApproval["commands"];
  expiresAt: number;
}>;

/**
 * The native Agent is a read-only Computer consumer. A workspace the owner
 * approved for guarded edits still permits reads, so every approved workspace
 * reaches the Agent through this one read projection: access "read" with that
 * workspace's own exclusions. Dropping write-approved workspaces instead would
 * silently take away read authority the owner granted, and passing their write
 * access through would let a delegate request it. Neither the write capability
 * nor network is ever part of the projection.
 */
export function productAgentApproval(
  computer: ProductSettings["computer"],
  grant: ProductAgentApprovalGrant,
): ComputerApproval {
  return {
    ownerId: grant.ownerId,
    computerId: computer.computerId,
    generation: computer.generation,
    workspaces: computer.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      access: "read" as const,
      ...(workspace.rootIdentity
        ? { rootIdentity: workspace.rootIdentity }
        : {}),
      ...(workspace.gitMetadata ? { gitMetadata: workspace.gitMetadata } : {}),
    })),
    excludedPaths: computer.workspaces.flatMap((workspace) =>
      workspace.excludedPaths.map((excluded) => ({
        workspaceId: workspace.workspaceId,
        path: excluded,
      })),
    ),
    capabilities: grant.capabilities.filter(
      (capability) => capability !== "workspace.write",
    ),
    network: "none",
    commands: grant.commands,
    expiresAt: grant.expiresAt,
  };
}
