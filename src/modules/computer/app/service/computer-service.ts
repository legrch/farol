import type { Clock } from "../../../../pkg/kernel/app/clock";
import { type Result } from "../../../../pkg/kernel/domain/result";
import {
  authorizeComputerRequest,
  type ComputerErrorCode,
  type ComputerGrant,
  type ComputerRequest,
} from "../../domain/access";
import type {
  ComputerExecutor,
  ComputerExecutionResult,
} from "../port/computer-executor";

export class ComputerService {
  constructor(
    private readonly grant: ComputerGrant,
    private readonly executor: ComputerExecutor,
    private readonly clock: Clock,
  ) {}

  async execute(
    request: ComputerRequest,
  ): Promise<
    Result<
      ComputerExecutionResult,
      | ComputerErrorCode
      | "COMPUTER_EXECUTION_FAILED"
      | "COMPUTER_EXECUTION_CANCELLED"
      | "COMPUTER_EXECUTION_CORRELATION"
    >
  > {
    const authorized = authorizeComputerRequest(
      this.grant,
      request,
      this.clock.now(),
    );
    if (!authorized.ok) return authorized;
    const result = await this.executor.execute(authorized.value);
    if (!result.ok) return result;
    const value = result.value;
    if (
      value.ownerId !== request.ownerId ||
      value.sessionId !== request.sessionId ||
      value.taskId !== request.taskId ||
      value.turnId !== request.turnId ||
      value.generation !== request.generation ||
      value.callId !== request.callId
    ) {
      return {
        ok: false,
        error: { code: "COMPUTER_EXECUTION_CORRELATION", retry: "never" },
      };
    }
    return result;
  }
}
