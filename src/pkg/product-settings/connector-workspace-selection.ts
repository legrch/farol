import type { ProductSettings } from "./contract";

// Null is an explicitly empty selection. Undefined means configured folders
// have no current verification and must not use the no-access connection path.
export function connectorWorkspaceSelection(
  settings: ProductSettings,
): string | null | undefined {
  if (settings.computer.workspaces.length === 0) return null;
  const verified = settings.setup.computer.verified;
  if (
    verified?.configRevision !== settings.computer.generation ||
    verified.workspaceId === null ||
    !settings.computer.workspaces.some(
      (workspace) => workspace.workspaceId === verified.workspaceId,
    )
  )
    return undefined;
  return verified.workspaceId;
}
