import type { DesktopGoCore } from "../go-core-host";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";

// The Go core's settings store boundary at startup: the computer authority is
// bound to the core's withdrawal, then the core's store is attached to the one
// configuration owner. Main keeps the owners, the startup boundary around this
// call and every identity: the configuration, core and window are late getters
// compared at call time, never copied. After a fence the renderer is told the
// configuration changed only when the same owner, the same core and the same
// live window are still current and admission is open; a renderer that cannot
// be reached never replaces the fence's own outcome.

export type SettingsOwner = Pick<
  ProductConfigurationService,
  "attachComputerAuthority" | "attachSettingsDeliveryStore"
>;

export type SettingsCore = Pick<
  DesktopGoCore,
  "withdraw" | "connectSettingsStore"
>;

export type SettingsWindow = Readonly<{
  isDestroyed: () => boolean;
  webContents: Readonly<{ send: (channel: string) => void }>;
}>;

export type GoSettingsPorts = Readonly<{
  configuration: () => SettingsOwner | null;
  core: () => SettingsCore | null;
  window: () => SettingsWindow | null;
  admissionClosed: () => boolean;
  ownerId: string;
  configurationChanged: string;
}>;

export function connectGoSettings(ports: GoSettingsPorts): void {
  const settingsOwner = ports.configuration()!;
  const settingsCore = ports.core()!;
  settingsOwner.attachComputerAuthority(() => settingsCore.withdraw());
  settingsCore.connectSettingsStore((profileId) => {
    const store = settingsOwner.attachSettingsDeliveryStore({
      profileId,
      ownerId: ports.ownerId,
    });
    return {
      read: (input) => store.read(input.deadlineMillis),
      replace: (input) => store.replace(input.change, input.deadlineMillis),
      fence: () => {
        const observationWindow = ports.window();
        const outcome = store.fence();
        if (
          ports.configuration() === settingsOwner &&
          ports.core() === settingsCore &&
          !ports.admissionClosed() &&
          ports.window() === observationWindow &&
          observationWindow &&
          !observationWindow.isDestroyed()
        ) {
          try {
            observationWindow.webContents.send(ports.configurationChanged);
          } catch {
            // Renderer delivery must not replace the original fence outcome.
          }
        }
        return outcome;
      },
    };
  });
}
