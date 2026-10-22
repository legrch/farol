import type {
  ProductConfigurationCommand,
  ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import type { OperationMetadata } from "../renderer/operations-contract";
export function configurationOperation(
  value: ProductConfigurationCommand,
): OperationMetadata {
  const kind = value.kind;
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
      ...("workspaceId" in value ? { workspace: value.workspaceId } : {}),
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
  return {
    ...("workspaceId" in evidence && typeof evidence.workspaceId === "string"
      ? { workspace: evidence.workspaceId }
      : {}),
    ...("relativePath" in evidence && typeof evidence.relativePath === "string"
      ? { relativePath: evidence.relativePath }
      : {}),
    ...(evidence.kind === "computer.workspace-command"
      ? { command: "git", relativePath: "." }
      : {}),
  };
}
