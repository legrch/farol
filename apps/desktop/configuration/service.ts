import { BridgeError } from "../bridge/client";
import type { DesktopGoCore } from "../go-core-host";
import {
  ProductConfigurationService,
  ProductSettingsStore,
} from "../../../src/apps/desktop/product-configuration";
import type { admissionLease } from "../host/lease";

// The Settings service: the saved document under the profile's state root,
// with task-model policy and task-settings comparison answered by the current
// Go core. Each answer is bound to the core it started on; a core that is
// absent or replaced while it answers is refused as unavailable, never
// answered by its successor.

type TaskCore = Pick<DesktopGoCore, "resolveTaskModel" | "compareTaskSettings">;

export type ConfigurationServicePorts = Readonly<{
  root: string;
  desktopGoCore: () => TaskCore | null;
  promotionLease: ReturnType<typeof admissionLease>;
}>;

export function createConfigurationService(ports: ConfigurationServicePorts) {
  const { root, desktopGoCore, promotionLease } = ports;
  return new ProductConfigurationService(new ProductSettingsStore({ root }), {
    taskModelPolicy: async (revision, tasks, selection) => {
      const core = desktopGoCore();
      if (!core)
        throw new BridgeError(
          "unavailable",
          "host_task_model_policy_unavailable",
        );
      const result = await core.resolveTaskModel(revision, tasks, selection);
      if (desktopGoCore() !== core)
        throw new BridgeError("unavailable", "host_task_model_policy_changed");
      return result;
    },
    taskSettingsCompare: async (before, candidate) => {
      const core = desktopGoCore();
      if (!core)
        throw new BridgeError("unavailable", "host_task_settings_unavailable");
      const changed = await core.compareTaskSettings(before, candidate);
      if (desktopGoCore() !== core)
        throw new BridgeError("unavailable", "host_task_settings_changed");
      return changed;
    },
    // S35-N03d: the same cross-process lease `liveTaskRegistry` takes for
    // admission, so a guarded edit's durable critical phase excludes a live
    // promotion exactly the way a Chat turn or a native Agent start already
    // does.
    promotionLease,
  });
}
