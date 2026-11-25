import { BridgeError } from "../bridge/client";

// The Chat startup profile: what the controlled E2E lane captures from the
// saved task settings once configuration is ready. A refusal classified as a
// bridge error leaves the profile absent; every other failure is a defect and
// propagates. `settings` answers the ready task settings, or null while
// configuration is not ready, and is read inside the guarded section.

export type ChatStartupProfilePorts<Profile> = Readonly<{
  environment: "dev" | "preview" | "owner-preview";
  e2e: boolean;
  origin: string | null;
  settings: () => Readonly<{ tasks?: unknown }> | null;
  capture: (
    input: Readonly<{
      environment: "dev" | "preview" | "owner-preview";
      e2e: boolean;
      origin: string | null;
      tasks: unknown;
    }>,
  ) => Profile | null;
}>;

export function chatStartupProfile<Profile>(
  ports: ChatStartupProfilePorts<Profile>,
): Profile | null {
  try {
    const settings = ports.settings();
    return settings === null
      ? null
      : ports.capture({
          environment: ports.environment,
          e2e: ports.e2e,
          origin: ports.origin,
          tasks: settings.tasks,
        });
  } catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    return null;
  }
}
