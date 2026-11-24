import {
  ProductConfigurationResultSchema,
  type ProductConfigurationCommand,
  type ProductConfigurationResult,
} from "../../../src/pkg/product-settings/contract";
import type {
  applyFarolModelConfigBlock,
  applyFarolModelProviderSelection,
  FarolModelProviderSpec,
  previewFarolModelConfigBlock,
  previewFarolModelProviderSelection,
  rollbackFarolModelConfigBlock,
  rollbackFarolModelProviderSelection,
} from "../../../src/apps/desktop/farol-model-config-block";
import type {
  FarolModelLifecycle,
  FarolModelLifecycleStatus,
} from "../../../src/apps/desktop/farol-model-lifecycle";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";

export type ModelConfigurationCommand = Extract<
  ProductConfigurationCommand,
  { kind: `model.${string}` }
>;

type ModelLifecycle = Pick<
  FarolModelLifecycle,
  "checkStatus" | "rotateAndRewrite"
>;

// Main owns the mutable state and the helper definitions. Everything here is a
// late getter or callback, bound to its real receiver at call time; the module
// copies no state and constructs no owner of its own.
export type ConfigurationModelPorts = Readonly<{
  configuration: () => ProductConfigurationService | null;
  modelLifecycle: () => ModelLifecycle | null;
  configurationFailure: (
    code: Extract<ProductConfigurationResult, { ok: false }>["error"],
  ) => ProductConfigurationResult;
  farolModelProviderSpec: () => Promise<FarolModelProviderSpec | null>;
  farolModelCodexConfigPath: () => string;
  farolModelCodexHostPresence: () => Promise<
    "running" | "not_running" | "unknown"
  >;
  previewFarolModelConfigBlock: typeof previewFarolModelConfigBlock;
  previewFarolModelProviderSelection: typeof previewFarolModelProviderSelection;
  applyFarolModelConfigBlock: typeof applyFarolModelConfigBlock;
  applyFarolModelProviderSelection: typeof applyFarolModelProviderSelection;
  rollbackFarolModelConfigBlock: typeof rollbackFarolModelConfigBlock;
  rollbackFarolModelProviderSelection: typeof rollbackFarolModelProviderSelection;
}>;

export function modelStatusEvidencePayload(
  status: FarolModelLifecycleStatus,
): Readonly<{
  kind: "model.status";
  state: "port_conflict" | "listening" | "connected";
  port: number | null;
  requestsServed: number;
  occupant?: "unprobed" | "farol" | "foreign" | "vacated";
}> | null {
  // S35-TA-2: a sealed endpoint accepts nothing, so it reports exactly
  // what the caller of a dead endpoint gets — `MODEL_ENDPOINT_UNAVAILABLE`
  // from the `null` below. It is deliberately not a new evidence value:
  // `model.status` is a cross-process contract, and "unavailable" is the
  // true statement about an endpoint that will never serve again.
  if (status.state === "not_running" || status.state === "sealed") return null;
  if (status.state === "port_conflict") {
    return {
      kind: "model.status",
      state: "port_conflict",
      port: status.port,
      requestsServed: 0,
      occupant: status.occupant,
    };
  }
  return {
    kind: "model.status",
    state: status.state,
    port: status.port,
    requestsServed: status.requestsServed,
  };
}

export function createConfigurationModel(ports: ConfigurationModelPorts) {
  const {
    configuration,
    modelLifecycle,
    configurationFailure,
    farolModelProviderSpec,
    farolModelCodexConfigPath,
    farolModelCodexHostPresence,
    previewFarolModelConfigBlock,
    previewFarolModelProviderSelection,
    applyFarolModelConfigBlock,
    applyFarolModelProviderSelection,
    rollbackFarolModelConfigBlock,
    rollbackFarolModelProviderSelection,
  } = ports;

  // Main retains parsed-command admission and its settings-availability guard,
  // so `configuration()` is present for every command that reaches here.
  async function configureAdmittedModel(
    command: ModelConfigurationCommand,
  ): Promise<ProductConfigurationResult> {
    switch (command.kind) {
      case "model.status": {
        const lifecycle = modelLifecycle();
        if (!lifecycle) {
          return configurationFailure("MODEL_ENDPOINT_UNAVAILABLE");
        }
        // `checkStatus()` adds one read-only loopback probe of a conflicting
        // port so the status can say what holds it.
        const payload = modelStatusEvidencePayload(
          await lifecycle.checkStatus(),
        );
        if (!payload) return configurationFailure("MODEL_ENDPOINT_UNAVAILABLE");
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
          evidence: payload,
        });
      }
      case "model.preview": {
        const spec = await farolModelProviderSpec();
        if (!spec) return configurationFailure("MODEL_ENDPOINT_UNAVAILABLE");
        const configPath = farolModelCodexConfigPath();
        const blockPreview = await previewFarolModelConfigBlock(
          configPath,
          spec,
        );
        const selectionPreview =
          command.selectAsDefault &&
          blockPreview.status !== "insecure_permissions" &&
          blockPreview.status !== "symlink" &&
          blockPreview.status !== "malformed"
            ? await previewFarolModelProviderSelection(configPath, spec)
            : null;
        return ProductConfigurationResultSchema.parse({
          ok: true,
          snapshot: configuration()!.snapshot(),
          evidence: {
            kind: "model.config-preview",
            configPath,
            providerBlockStatus: blockPreview.status,
            ...(blockPreview.status === "install" ||
            blockPreview.status === "update"
              ? {
                  providerBlockDiff: blockPreview.diff,
                  providerBlockTokenRedacted: blockPreview.tokenRedacted,
                }
              : {}),
            ...(blockPreview.status === "conflict"
              ? { providerBlockConflicts: blockPreview.conflicts }
              : {}),
            ...(blockPreview.status === "insecure_permissions"
              ? { providerBlockInsecureMode: blockPreview.mode }
              : {}),
            providerSelectionRequested: command.selectAsDefault,
            ...(selectionPreview
              ? {
                  providerSelectionStatus: selectionPreview.status,
                  ...(selectionPreview.status === "install" ||
                  selectionPreview.status === "update"
                    ? { providerSelectionDiff: selectionPreview.diff }
                    : {}),
                  ...(selectionPreview.status === "conflict"
                    ? { providerSelectionConflicts: selectionPreview.conflicts }
                    : {}),
                }
              : {}),
          },
        });
      }
      case "model.apply": {
        const spec = await farolModelProviderSpec();
        if (!spec) return configurationFailure("MODEL_ENDPOINT_UNAVAILABLE");
        const configPath = farolModelCodexConfigPath();
        try {
          const blockResult = await applyFarolModelConfigBlock(
            configPath,
            spec,
          );
          if (blockResult.status === "insecure_permissions") {
            return configurationFailure("MODEL_CONFIG_INSECURE_PERMISSIONS");
          }
          if (blockResult.status === "conflict") {
            return configurationFailure("MODEL_CONFIG_CONFLICT");
          }
          if (blockResult.status === "symlink") {
            return configurationFailure("MODEL_CONFIG_SYMLINK");
          }
          if (blockResult.status === "malformed") {
            return configurationFailure("MODEL_CONFIG_MALFORMED");
          }
          let selectionApplied = false;
          if (command.selectAsDefault) {
            const selectionResult = await applyFarolModelProviderSelection(
              configPath,
              spec,
            );
            if (selectionResult.status === "conflict") {
              return configurationFailure("MODEL_CONFIG_CONFLICT");
            }
            if (selectionResult.status === "symlink") {
              return configurationFailure("MODEL_CONFIG_SYMLINK");
            }
            if (selectionResult.status === "malformed") {
              return configurationFailure("MODEL_CONFIG_MALFORMED");
            }
            selectionApplied = selectionResult.status === "applied";
          }
          // A host that is running read its config at start and needs a
          // restart; one that is not picks the block up at its next start.
          const codexHost = await farolModelCodexHostPresence();
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
            evidence: {
              kind: "model.config-applied",
              providerBlockApplied: blockResult.status === "applied",
              providerSelectionApplied: selectionApplied,
              restartStep: "restart_codex_to_apply",
              codexHost,
            },
          });
        } catch {
          return configurationFailure("MODEL_CONFIG_APPLY_FAILED");
        }
      }
      case "model.rollback": {
        const configPath = farolModelCodexConfigPath();
        try {
          // Each rollback removes exactly its own managed region from the
          // file's current bytes — never a backup — so the order only decides
          // which refusal is reported first when a marker is damaged.
          const selectionRollback =
            await rollbackFarolModelProviderSelection(configPath);
          if (selectionRollback.status === "symlink") {
            return configurationFailure("MODEL_CONFIG_SYMLINK");
          }
          if (selectionRollback.status === "malformed") {
            return configurationFailure("MODEL_CONFIG_MALFORMED");
          }
          const blockRollback = await rollbackFarolModelConfigBlock(configPath);
          if (blockRollback.status === "symlink") {
            return configurationFailure("MODEL_CONFIG_SYMLINK");
          }
          if (blockRollback.status === "malformed") {
            return configurationFailure("MODEL_CONFIG_MALFORMED");
          }
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
            evidence: {
              kind: "model.config-rollback",
              providerBlockRestored: blockRollback.status === "restored",
              providerSelectionRestored:
                selectionRollback.status === "restored",
            },
          });
        } catch {
          return configurationFailure("MODEL_CONFIG_ROLLBACK_FAILED");
        }
      }
      case "model.rotate-token": {
        const lifecycle = modelLifecycle();
        if (!lifecycle) {
          return configurationFailure("MODEL_ENDPOINT_UNAVAILABLE");
        }
        try {
          // S35-H2-1: one operation, not two. `rotateAndRewrite` inspects the
          // installed block BEFORE the token moves, so a block it cannot
          // rewrite refuses while the owner's Codex config still
          // authenticates, and a rewrite that fails after the rotation puts
          // the previous token back. A block that is not installed is still
          // not installed by this action.
          const rotated = await lifecycle.rotateAndRewrite({
            configPath: farolModelCodexConfigPath(),
            spec: farolModelProviderSpec,
            preview: previewFarolModelConfigBlock,
            apply: applyFarolModelConfigBlock,
          });
          if (!rotated.ok) return configurationFailure(rotated.code);
          return ProductConfigurationResultSchema.parse({
            ok: true,
            snapshot: configuration()!.snapshot(),
            evidence: {
              kind: "model.token-rotated",
              providerBlockUpdated: rotated.providerBlockUpdated,
              providerBlockStatus: rotated.providerBlockStatus,
            },
          });
        } catch {
          return configurationFailure("MODEL_TOKEN_ROTATE_FAILED");
        }
      }
    }
  }

  return Object.freeze({ configureAdmittedModel });
}
