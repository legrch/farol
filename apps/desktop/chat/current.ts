import { isDeepStrictEqual } from "node:util";
import type { ChatGptRoute } from "../../../src/apps/desktop/chatgpt-route";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";
import type { PendingChatGptReadonlyTask } from "../configuration/ports";
import type { DesktopGoCore } from "../go-core-host";

// Whether a pending read-only ChatGPT task is still the one the owner can
// send: it is the same pending task, on the same route and Go core, its Go
// admission has not expired, and the saved settings still carry the same
// ChatGPT verification, Computer generation and verified workspace. Every
// owner is read when the check runs, never when it is built.

export type ReadonlyAccountPorts = Readonly<{
  configuration: () => Pick<ProductConfigurationService, "snapshot"> | null;
  pendingTask: () => PendingChatGptReadonlyTask | null;
  chatGptRoute: () => ChatGptRoute | null;
  desktopGoCore: () => DesktopGoCore | null;
  buildId: string;
  now: () => number;
}>;

export function readonlyAccountCurrent(
  ports: ReadonlyAccountPorts,
): (
  pending: PendingChatGptReadonlyTask,
  route: ChatGptRoute,
  core: DesktopGoCore,
) => boolean {
  return (pending, route, core) => {
    const snapshot = ports.configuration()?.snapshot();
    if (
      ports.pendingTask() !== pending ||
      ports.chatGptRoute() !== route ||
      ports.desktopGoCore() !== core ||
      !pending.goAdmission ||
      ports.now() >= pending.expiresAt ||
      snapshot?.status !== "ready"
    )
      return false;
    const settings = snapshot.settings;
    return (
      !settings.setup.chatgpt.outcomeUnknown &&
      pending.chatGptVerification.buildId === ports.buildId &&
      isDeepStrictEqual(
        settings.setup.chatgpt.verified,
        pending.chatGptVerification,
      ) &&
      settings.computer.generation === pending.computerGeneration &&
      settings.computer.workspaces.some(
        (workspace) => workspace.workspaceId === pending.workspaceId,
      ) &&
      settings.setup.computer.verified?.workspaceId === pending.workspaceId &&
      settings.setup.computer.verified.configRevision ===
        pending.computerGeneration
    );
  };
}
