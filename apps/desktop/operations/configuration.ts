import type {
  ProductConfigurationCommand,
  ProductConfigurationSnapshot,
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
      ...("relativePath" in value && typeof value.relativePath === "string"
        ? { relativePath: value.relativePath }
        : {}),
    },
  };
}
