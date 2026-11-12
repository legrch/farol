import { createHash } from "node:crypto";
import type { ProductSettings } from "../../../../pkg/product-settings/contract";

// The stable OWNER-CONSENT projection is distinct from current effective
// approval, native bindings and Settings publication. It contains owner choices,
// not ephemeral readiness, generation, device/inode, launch, or verification.
export function ownerComputerConsentProjection(settings: ProductSettings) {
  const workspaces = settings.computer.workspaces
    .map((workspace) => ({
      workspaceId: workspace.workspaceId,
      root: workspace.root,
      access: workspace.access,
      excludedPaths: [...workspace.excludedPaths].sort(),
      gitHistoryApproved: workspace.gitHistoryApproved === true,
    }))
    // Code-point order is independent of machine locale/ICU version.
    .sort((a, b) =>
      a.workspaceId < b.workspaceId
        ? -1
        : a.workspaceId > b.workspaceId
          ? 1
          : 0,
    );
  const commands = settings.computer.commands;
  const filePolicy = settings.computer.filePolicy ?? "";
  const scopes = workspaces.length > 0;
  const write = workspaces.some((workspace) => workspace.access === "write");

  // Authorised upper limits, not transient ShellVerified or an observed
  // attachment. Current admission always separately enforces native readiness.
  const capabilityLimits = [
    ...(scopes ? ["workspace.list", "workspace.read", "workspace.search"] : []),
    ...(scopes && commands !== "none" ? ["verification.run"] : []),
    ...(scopes && commands === "workspace" && filePolicy === "approved-roots-v1"
      ? ["workspace.shell"]
      : []),
    ...(write ? ["workspace.write"] : []),
  ];
  return {
    schema: 1,
    ownerId: "owner-desktop",
    computerId: settings.computer.computerId,
    workspaces,
    capabilityLimits,
    network: "none",
    commands,
    filePolicy,
  };
}

export function ownerComputerConsentDigest(settings: ProductSettings): string {
  return createHash("sha256")
    .update(JSON.stringify(ownerComputerConsentProjection(settings)))
    .digest("hex");
}
