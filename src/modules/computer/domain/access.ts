import {
  failure,
  success,
  type Result,
} from "../../../pkg/kernel/domain/result";

export type ComputerErrorCode =
  | "COMPUTER_OWNER_MISMATCH"
  | "COMPUTER_SESSION_MISMATCH"
  | "COMPUTER_TASK_MISMATCH"
  | "COMPUTER_STALE_GENERATION"
  | "COMPUTER_GRANT_EXPIRED"
  | "COMPUTER_CAPABILITY_DENIED"
  | "COMPUTER_TARGET_DENIED";

export type ComputerGrant = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  generation: number;
  capability: "fixture.inspect";
  expiresAt: number;
}>;

export type ComputerRequest = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
  callId: string;
  operation: "fixture.inspect";
  target: string;
}>;

export function authorizeComputerRequest(
  grant: ComputerGrant,
  request: ComputerRequest,
  now: number,
): Result<ComputerRequest, ComputerErrorCode> {
  if (grant.ownerId !== request.ownerId)
    return failure("COMPUTER_OWNER_MISMATCH");
  if (grant.sessionId !== request.sessionId)
    return failure("COMPUTER_SESSION_MISMATCH");
  if (grant.taskId !== request.taskId) return failure("COMPUTER_TASK_MISMATCH");
  if (grant.generation !== request.generation)
    return failure("COMPUTER_STALE_GENERATION");
  if (now > grant.expiresAt) return failure("COMPUTER_GRANT_EXPIRED");
  if (grant.capability !== request.operation)
    return failure("COMPUTER_CAPABILITY_DENIED");
  if (request.target !== "synthetic://workspace/status") {
    return failure("COMPUTER_TARGET_DENIED");
  }
  return success(request);
}
