import type {
  ProductConfigurationCommand,
  ProductConfigurationSnapshot,
  ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import type { OperationMetadata } from "../renderer/operations-contract";
export function configurationOperation(
  value: ProductConfigurationCommand,
  settings: ProductConfigurationSnapshot | undefined,
): OperationMetadata {
  const kind = value.kind;
  const workspace =
    "workspaceId" in value && settings?.status === "ready"
      ? settings.settings.computer.workspaces.find(
          (w) => w.workspaceId === value.workspaceId,
        )
      : undefined;
  const source =
    kind.startsWith("host.") || kind.startsWith("model.")
      ? "Codex"
      : /^(?:connector\.|setup\.|chatgpt\.(?:verify|open-sign-in|observe-sign-in)|computer\.(?:verify-workspace|check-folder))/u.test(
            kind,
          )
        ? "Setup"
        : "You";
  return {
    source,
    kind,
    target: {
      ...(workspace ? { workspace: workspace.label } : {}),
      ...(kind.startsWith("computer.run-git-")
        ? { command: "git", relativePath: "." }
        : {}),
      ...("relativePath" in value && typeof value.relativePath === "string"
        ? { relativePath: value.relativePath }
        : {}),
    },
  };
}

/** Select only target metadata from a validated receipt. Sealed selections need
 * not expose file paths in their original command; bodies/output stay excluded. */
export function configurationResultTarget(
  result: ProductConfigurationResult,
): OperationMetadata["target"] {
  if (!result.ok || !result.evidence || result.snapshot.status !== "ready")
    return {};
  const evidence = result.evidence;
  const workspace =
    "workspaceId" in evidence
      ? result.snapshot.settings.computer.workspaces.find(
          (w) => w.workspaceId === evidence.workspaceId,
        )
      : undefined;
  return {
    ...(workspace ? { workspace: workspace.label } : {}),
    ...("relativePath" in evidence && typeof evidence.relativePath === "string"
      ? { relativePath: evidence.relativePath }
      : {}),
    ...(evidence.kind === "computer.workspace-command"
      ? { command: "git", relativePath: "." }
      : {}),
  };
}
