import {
  validate,
  type ComputerContinuityStatusResponse,
  type ComputerStopStatusResponse,
} from "../bridge/wire";

const requiredCapabilities = [
  "computer.continuity.status",
  "computer.continuity.begin",
  "computer.continuity.confirm",
  "computer.continuity.plan",
  "computer.continuity.record",
  "computer.continuity.withdraw",
  "computer.continuity.stage",
  "computer.continuity.finish",
  "computer.continuity.qualify",
  "computer.stop.status",
  "computer.settings.store.next",
  "computer.settings.store.reply",
];

function settled(
  status: ComputerStopStatusResponse | ComputerContinuityStatusResponse,
) {
  return (
    status.restricted === false &&
    status.pendingOperationId === undefined &&
    status.pendingPhase === undefined &&
    (status.present || status.entryCount === 0)
  );
}

// The running core has already been attested against the desktop's compiled
// artifact declaration. Both status reads must also succeed on that core.
export function qualifyContinuityRecovery(
  input: Readonly<{
    platform: string;
    managedBuild: boolean;
    settingsSettled: boolean;
    capabilities: readonly string[] | undefined;
    continuity?: unknown;
    stop?: unknown;
  }>,
): true | "unavailable" {
  if (
    input.platform !== "darwin" ||
    input.managedBuild !== true ||
    input.settingsSettled !== true ||
    !requiredCapabilities.every((method) =>
      input.capabilities?.includes(method),
    ) ||
    !validate("ComputerContinuityStatusResponse", input.continuity) ||
    !validate("ComputerStopStatusResponse", input.stop)
  )
    return "unavailable";

  const continuity = input.continuity as ComputerContinuityStatusResponse;
  const stop = input.stop as ComputerStopStatusResponse;
  return settled(continuity) &&
    (continuity.present || !continuity.currentQualified) &&
    settled(stop)
    ? true
    : "unavailable";
}
