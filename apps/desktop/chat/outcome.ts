import type { ChatGptSignInStatus } from "../../../src/apps/desktop/chatgpt-route";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";

// What the app does when the ChatGPT sign-in surface reports its outcome, and
// when the saved settings say a ChatGPT task may be admitted.
//
// The sign-in surface reports its outcome exactly once, when its window closes,
// never while it stays open and never a repeat. "unknown" (the page could not
// be read, e.g. a load failure) is recorded nowhere: it is not the same claim
// as an observed signed-out page, and an unverifiable outcome must not
// silently overwrite a previously verified one.
//
// The owner is brought back to Setup only when they were not already there:
// the first-run Setup wizard is itself a "Setup" surface, and jumping to the
// standalone Settings screen out from under an in-progress wizard step would
// abandon it. Guided Setup owns the computer section with the legacy wizard
// closed, and its restored step receives readiness without another Settings
// navigation.

export type SignInOutcomePorts = Readonly<{
  configuration: () => Pick<
    ProductConfigurationService,
    "recordChatGptObservation"
  > | null;
  chatGptPartition: string;
  buildId: string;
  runtimeEnvironment: string;
  setupOpen: () => boolean;
  section: () => string;
  publishShellAction: (
    action: "sign-in-returned" | "open-settings",
    source: "auth-window-closed",
    authWindowGeneration: number | null,
  ) => void;
}>;

export function signInOutcomeRecorder(
  ports: SignInOutcomePorts,
): (generation: number | null, status: ChatGptSignInStatus) => Promise<void> {
  return async (generation, status) => {
    const configuration = ports.configuration();
    if (configuration && status !== "unknown") {
      try {
        await configuration.recordChatGptObservation(
          status === "authenticated"
            ? {
                state: "authenticated",
                profile: "chatgpt.app-partition/1",
                runtimeGeneration: `${ports.chatGptPartition}:${ports.buildId}`,
                buildId: ports.buildId,
                protocol: "chatgpt-page-readiness/1",
              }
            : { state: "signed_out" },
          true,
        );
      } catch {
        // Not a request a renderer is blocked on; the next explicit "Check
        // connection" or sign-in attempt tries again.
      }
    }
    const action =
      ports.runtimeEnvironment === "dev" ||
      ports.setupOpen() ||
      ports.section() === "computer"
        ? "sign-in-returned"
        : "open-settings";
    ports.publishShellAction(action, "auth-window-closed", generation);
  };
}

// A ChatGPT task is admitted only while the saved ChatGPT setup is reachable,
// configured, free of an unknown outcome and verified.
export function chatGptAdmissionReady(
  configuration: Pick<ProductConfigurationService, "snapshot"> | null,
): boolean {
  const snapshot = configuration?.snapshot();
  if (!snapshot || snapshot.status !== "ready") return false;
  const readiness = snapshot.settings.setup.chatgpt;
  return (
    readiness.reachable === "reachable" &&
    readiness.configured &&
    !readiness.outcomeUnknown &&
    readiness.verified !== null
  );
}
