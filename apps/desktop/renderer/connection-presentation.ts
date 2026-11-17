import type { Intent, WindowSnapshot } from "../../../src/ui/renderer/contract";
import { computerSetup } from "../../../src/ui/renderer/computer-setup";
import { connectorVerificationInFlight } from "../../../src/ui/renderer/setup-gate";
import { selectedConnectorApp } from "../../../src/pkg/product-settings/connector-app-selection";
import { dependencyFences } from "../../../src/ui/renderer/command-eligibility";

/** Presentation only. Current work and the last confirmed result stay distinct. */
export function connectionPresentation(
  snapshot: WindowSnapshot,
  local: readonly Intent[] = [],
) {
  const computer = computerSetup(snapshot);
  const settings =
    snapshot.configuration?.status === "ready"
      ? snapshot.configuration.settings
      : null;
  const connector = settings?.connectors.secureMcp;
  const previous = connector?.lastVerifiedAttachment ?? connector?.attachment;
  // Remember onboarding across builds and runtime generations. This is only
  // presentation of the saved app choice, never current attachment authority.
  // Changing the app clears this history in the configuration owner.
  const setupRemembered = Boolean(
    settings?.setup.journey.dismissed &&
    connector &&
    previous &&
    previous.tunnelId === connector.tunnelId &&
    selectedConnectorApp(connector) !== null &&
    !settings.setup.connect.outcomeUnknown &&
    connector.appVerificationPending !== true,
  );
  const verifying = connectorVerificationInFlight(snapshot, local);
  const status = snapshot.connectionStatus;
  const transportState = status?.state ?? null;
  const transportExpiry = status?.validUntilMillis ?? null;
  const recentTransport =
    transportState === "recent_transport" &&
    transportExpiry != null &&
    transportExpiry > Date.now();
  // Failed transport stays attention even after the original expiry is gone.
  const transportNeedsAttention = [
    "reconnecting",
    "unavailable",
    "action_required",
    "stopped",
  ].includes(transportState ?? "");
  // Saved setup is not current proof. Expired or missing observation must not
  // render as Setup complete / Connected.
  const transportUnconfirmed =
    !recentTransport &&
    !transportNeedsAttention &&
    (transportState === "unobserved" ||
      transportState === "checking" ||
      transportState === "recent_transport" ||
      transportState === null);
  const checking =
    !snapshot.independentSession &&
    snapshot.status !== "unavailable" &&
    snapshot.status !== "incompatible" &&
    snapshot.runtime !== "failed" &&
    !transportNeedsAttention &&
    (snapshot.connectionChecking === true ||
      snapshot.status === "starting" ||
      snapshot.runtime === "starting" ||
      verifying) &&
    !(verifying && computer.externalAccessVerified && !transportNeedsAttention);
  const setupFactsReady =
    computer.localConnectionCurrent &&
    !dependencyFences(snapshot, "computer", local).unknown &&
    setupRemembered;
  const savedSetupReady =
    !checking && !transportNeedsAttention && !transportUnconfirmed && setupFactsReady;
  const connected =
    !checking &&
    !transportNeedsAttention &&
    recentTransport &&
    (computer.externalAccessVerified || savedSetupReady);
  const unconfirmedSavedSetup =
    !checking &&
    !transportNeedsAttention &&
    !connected &&
    transportUnconfirmed &&
    setupFactsReady;
  const label = checking
    ? "Checking connection…"
    : transportNeedsAttention
      ? "Connection needs attention"
      : connected && computer.externalAccessVerified
        ? "Connected — ChatGPT can reach this Mac"
        : connected
          ? "Connected — ChatGPT setup is saved"
          : unconfirmedSavedSetup
            ? "Connection not confirmed — ChatGPT setup is saved"
            : computer.localConnectionCurrent
              ? "Connection available — ChatGPT connection needs a check"
              : "Not connected yet";
  const text = checking
    ? "Checking connection…"
    : transportNeedsAttention
      ? "Connection needs attention"
      : connected
        ? "Connected"
        : unconfirmedSavedSetup
          ? "Connection not confirmed"
          : computer.localConnectionCurrent
            ? "Connection available"
            : "Not connected yet";
  return {
    checking,
    connected,
    label,
    text,
    savedSetupReady,
    attention:
      !checking && !connected && !savedSetupReady,
    transportNeedsAttention,
    unconfirmedSavedSetup,
  };
}
