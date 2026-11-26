import { createHash } from "node:crypto";
import type { ComputerConnectorBinding } from "../bridge/wire";
import { bindingMatches } from "./capture";

/** The attempt identity: a digest of one connector start's coordinates. */
export function attemptGeneration(
  buildId: string,
  input: Readonly<{
    connectorGeneration: number;
    computerGeneration: number;
    launchContractSha256: string;
    phase: string;
  }>,
): string {
  return createHash("sha256")
    .update(
      [
        String(input.connectorGeneration),
        String(input.computerGeneration),
        buildId,
        input.launchContractSha256,
        input.phase,
      ].join("\0"),
    )
    .digest("hex");
}

/** Whether a Close result acknowledges exactly the original binding. */
export function closureAcknowledges(
  result: Readonly<{
    closed: boolean;
    binding: Readonly<ComputerConnectorBinding>;
  }>,
  binding: Readonly<ComputerConnectorBinding>,
): boolean {
  return result.closed === true && bindingMatches(binding, result.binding);
}

/** The refusal code for a Close that did not settle recovery. */
export function recoveryFailureCode(recovery: string | undefined) {
  return recovery === "pending_operation"
    ? "CONNECTOR_RECOVERY_PENDING_OPERATION"
    : recovery === "operation_unknown"
      ? "CONNECTOR_RUNTIME_OUTCOME_UNKNOWN"
      : recovery === "authority_unknown"
        ? "CONNECTOR_RECOVERY_AUTHORITY_UNAVAILABLE"
        : "CONNECTOR_RECOVERY_UNAVAILABLE";
}
