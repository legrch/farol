import type { Intent, WindowSnapshot } from "../../../src/ui/renderer/contract";
import { computerSetup } from "../../../src/ui/renderer/computer-setup";
import { connectorVerificationInFlight } from "../../../src/ui/renderer/setup-gate";

/** Presentation only. Current work and the last confirmed result stay distinct. */
export function connectionPresentation(
  snapshot: WindowSnapshot,
  local: readonly Intent[] = [],
) {
  const computer = computerSetup(snapshot);
  const checking =
    !snapshot.independentSession &&
    snapshot.status !== "unavailable" &&
    snapshot.status !== "incompatible" &&
    snapshot.runtime !== "failed" &&
    (snapshot.connectionChecking === true ||
      snapshot.status === "starting" ||
      snapshot.runtime === "starting" ||
      (connectorVerificationInFlight(snapshot, local) &&
        !computer.externalAccessVerified));
  const connected = !checking && computer.externalAccessVerified;
  const label = checking
    ? "Checking connection…"
    : connected
      ? "Connected — ChatGPT can reach this Mac"
      : computer.localConnectionCurrent
        ? "Tunnel connected — ChatGPT connection needs a check"
        : "Not connected yet";
  const text = checking
    ? "Checking connection…"
    : connected
      ? "Connected"
      : computer.localConnectionCurrent
        ? "Tunnel connected"
        : "Not connected yet";
  return { checking, connected, label, text };
}
