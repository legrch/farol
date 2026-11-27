import type { ConnectionStatusView } from "../renderer/connection-status";
import type { ConnectionStatusCapture } from "../connector/capture";
import { connectorRuntimeUncertain } from "../../../src/pkg/product-settings/connector-uncertainty";
import { currentConnectorAttachment } from "../../../src/apps/desktop/connector-app-receipt-wait";
import type { ProductConfigurationService } from "../../../src/apps/desktop/product-configuration";

// Whether the menu bar may show the connector as attached: only while a recent
// transport is live, the captured connection is still current, and settings
// carry an attachment for this build with no pending Computer edit, no unknown
// Computer outcome and no uncertain connector runtime.

export type MenuBarAttachedPorts = Readonly<{
  captureConnectionStatus: () => ConnectionStatusCapture | null;
  connectionStatusCurrent: (capture: ConnectionStatusCapture) => boolean;
  configuration: () => Pick<ProductConfigurationService, "snapshot"> | null;
  workspaceMutationOccupied: () => boolean;
  buildId: string;
}>;

export function menuBarAttached(
  ports: MenuBarAttachedPorts,
): (state: ConnectionStatusView["state"]) => boolean {
  return (state) => {
    const capture = ports.captureConnectionStatus();
    const snapshot = ports.configuration()?.snapshot();
    return (
      state === "recent_transport" &&
      capture?.kind === "running" &&
      ports.connectionStatusCurrent(capture) &&
      snapshot?.status === "ready" &&
      !ports.workspaceMutationOccupied() &&
      !connectorRuntimeUncertain(snapshot.settings) &&
      snapshot.settings.computer.pendingEdit === null &&
      !snapshot.settings.setup.computer.outcomeUnknown &&
      currentConnectorAttachment(snapshot.settings, ports.buildId) !== null
    );
  };
}
