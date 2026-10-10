import type { OwnedCloser } from "../../src/apps/desktop/quit-drain";

// MCP/account work uses the Go endpoint while draining. Generic Quit runs
// closers concurrently, so encode this dependency in their original promises.
export function goCoreQuitClosers(
  dependent: OwnedCloser | null,
  closeCore: (() => Promise<void>) | null,
  canCloseCore: () => boolean = () => true,
): readonly OwnedCloser[] {
  let dependentClose: Promise<void> | undefined;
  let coreClose: Promise<void> | undefined;
  const closeDependent = () =>
    (dependentClose ??= Promise.resolve().then(() => dependent!.close()));
  return [
    ...(dependent ? [{ name: dependent.name, close: closeDependent }] : []),
    ...(closeCore
      ? [
          {
            name: "go-core",
            close: () =>
              (coreClose ??= (async () => {
                // Failure still requires exact host cleanup, but never upgrades
                // the separately named dependent's outcome to confirmed drain.
                if (dependent) await closeDependent().catch(() => undefined);
                if (!canCloseCore())
                  throw new Error("GO_CORE_QUIT_DEADLINE_EXPIRED");
                await closeCore();
              })()),
          },
        ]
      : []),
  ];
}
