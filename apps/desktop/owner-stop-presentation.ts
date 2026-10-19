import type { ConnectorClosureReceipt } from "./bridge/connector-host.ts";

// Correlation for completed presentation only. Go owns the actual stopped state;
// this identity cannot create a permission, restore a binding or replay a close.
export type OwnerStopPresentation = Readonly<{
  owner: object;
  connector: object;
  core: object;
  receipt: ConnectorClosureReceipt;
  computerGeneration: number;
  connectorGeneration: number;
}>;
export type OwnerStopPresentationFrame = Readonly<{
  owner: object;
  connector: object;
  core: object;
  receipt: ConnectorClosureReceipt | undefined;
  computerGeneration: number;
  connectorGeneration: number;
  backendAvailable: boolean;
  stoppedSettings: boolean;
  setupOutcomeUnknown: boolean;
  helperRunning: boolean;
  helperOutcomeUnknown: boolean;
  tunnelObserved: boolean;
  currentBinding: boolean;
  admissionInProgress: boolean;
  quitting: boolean;
  updating: boolean;
}>;

export function ownerStopPresentationCurrent(
  original: OwnerStopPresentation,
  current: OwnerStopPresentationFrame,
): boolean {
  return (
    current.owner === original.owner &&
    current.connector === original.connector &&
    current.core === original.core &&
    current.receipt === original.receipt &&
    original.receipt.reason === "owner_stop" &&
    original.receipt.result.recovery === "settled" &&
    current.computerGeneration === original.computerGeneration &&
    current.connectorGeneration === original.connectorGeneration &&
    current.backendAvailable &&
    current.stoppedSettings &&
    !current.setupOutcomeUnknown &&
    !current.helperRunning &&
    !current.helperOutcomeUnknown &&
    !current.tunnelObserved &&
    !current.currentBinding &&
    !current.admissionInProgress &&
    !current.quitting &&
    !current.updating
  );
}
