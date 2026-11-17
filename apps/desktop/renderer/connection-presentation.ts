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
  const transportState = snapshot.connectionStatus?.state ?? null;
  // Failed transport stays attention even after the original expiry is gone.
  const transportNeedsAttention = [
    "reconnecting",
    "unavailable",
    "action_required",
    "stopped",
  ].includes(transportState ?? "");
  // The green light is the live tunnel runtime. A missing or expired server
  // poll is not a user problem. Ping and the ChatGPT test must not be what
  // turns the light on, and sign-in or workspace checks must not turn it off.
  const windowCurrent =
    snapshot.status === "current" && snapshot.runtime === "ready";
  const tunnelLive =
    windowCurrent && computer.facts.runtimeCurrent && !transportNeedsAttention;
  const checking =
    !tunnelLive &&
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
  const savedSetupReady = tunnelLive && setupFactsReady;
  const connected = tunnelLive;
  const unconfirmedSavedSetup = false;
  const label = checking
    ? "Checking connection…"
    : transportNeedsAttention
      ? "Connection needs attention"
      : connected && computer.externalAccessVerified
        ? "Connected — ChatGPT can reach this Mac"
        : connected && setupRemembered
          ? "Connected — ChatGPT setup is saved"
          : connected
            ? "Connected — tunnel is live"
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
    attention: !checking && !connected && !savedSetupReady,
    transportNeedsAttention,
    unconfirmedSavedSetup,
  };
}
