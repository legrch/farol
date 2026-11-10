import { BridgeError, type Client } from "./client.ts";
import { validate, type ComputerContinuityStatusResponse } from "./wire.ts";

/** Read-only protected Go WAL inspection; never settles an original effect,
 * creates a new request, or returns a current Computer approval capability. */
export class ContinuityStatusBridge {
  constructor(private readonly client: Pick<Client, "request">) {}

  async observe(): Promise<ComputerContinuityStatusResponse> {
    const outcome = await this.client.request("computer.continuity.status", {});
    if (outcome.status !== "ok")
      throw new BridgeError(
        outcome.status,
        outcome.code ?? "computer_continuity_status_unavailable",
      );
    if (
      outcome.operationId !== undefined ||
      !validate("ComputerContinuityStatusResponse", outcome.data)
    )
      throw new BridgeError("unknown", "computer_continuity_status_invalid");
    const result = outcome.data as unknown as ComputerContinuityStatusResponse;
    if (
      (result.currentQualified && (!result.present || result.restricted)) ||
      (result.pendingOperationId === undefined) !==
        (result.pendingPhase === undefined) ||
      (result.pendingOperationId !== undefined && !result.restricted)
    )
      throw new BridgeError("unknown", "computer_continuity_status_crossed");
    return Object.freeze({ ...result });
  }
}
