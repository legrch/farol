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
  ComputerOutput,
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
      ComputerOutput,
      | ComputerErrorCode
      | "COMPUTER_EXECUTION_FAILED"
      | "COMPUTER_EXECUTION_CANCELLED"
    >
  > {
    const authorized = authorizeComputerRequest(
      this.grant,
      request,
      this.clock.now(),
    );
    if (!authorized.ok) return authorized;
    return this.executor.execute(authorized.value);
  }
}
