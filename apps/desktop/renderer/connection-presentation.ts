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
  const transportNeedsAttention =
    snapshot.connectionStatus?.validUntilMillis != null &&
    ["reconnecting", "unavailable", "action_required", "stopped"].includes(
      snapshot.connectionStatus.state,
    );
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
  const savedSetupReady =
    !checking &&
    !transportNeedsAttention &&
    computer.localConnectionCurrent &&
    !dependencyFences(snapshot, "computer", local).unknown &&
    setupRemembered;
  const recentTransport =
    snapshot.connectionStatus?.state === "recent_transport" &&
    snapshot.connectionStatus.validUntilMillis != null &&
    snapshot.connectionStatus.validUntilMillis > Date.now();
  const connected =
    !checking &&
    !transportNeedsAttention &&
    (computer.externalAccessVerified || (savedSetupReady && recentTransport));
  const label = checking
    ? "Checking connection…"
    : transportNeedsAttention
      ? "Connection needs attention"
      : connected && computer.externalAccessVerified
        ? "Connected — ChatGPT can reach this Mac"
        : connected
          ? "Tunnel connected — ChatGPT setup is saved"
          : savedSetupReady
            ? "ChatGPT setup is saved"
            : computer.localConnectionCurrent
              ? "Tunnel connected — ChatGPT connection needs a check"
              : "Not connected yet";
  const text = checking
    ? "Checking connection…"
    : transportNeedsAttention
      ? "Connection needs attention"
      : connected && computer.externalAccessVerified
        ? "Connected"
        : savedSetupReady && !connected
          ? "Setup complete"
          : computer.localConnectionCurrent
            ? "Tunnel connected"
            : "Not connected yet";
  return {
    checking,
    connected,
    label,
    text,
    savedSetupReady,
    attention: !checking && !connected && !savedSetupReady,
    transportNeedsAttention,
  };
}
