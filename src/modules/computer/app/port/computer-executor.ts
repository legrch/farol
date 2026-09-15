import type { Result } from "../../../../pkg/kernel/domain/result";
import type { ComputerRequest } from "../../domain/access";

export type ComputerOutput = Readonly<{
  kind: "synthetic-status";
  label: string;
  state: "ready";
  receipt: string;
}>;

export type ComputerExecutionResult = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
  callId: string;
  output: ComputerOutput;
}>;

export interface ComputerExecutor {
  execute(
    request: ComputerRequest,
  ): Promise<
    Result<
      ComputerExecutionResult,
      "COMPUTER_EXECUTION_FAILED" | "COMPUTER_EXECUTION_CANCELLED"
    >
  >;
}
