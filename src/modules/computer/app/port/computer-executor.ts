import type { Result } from "../../../../pkg/kernel/domain/result";
import type { ComputerRequest } from "../../domain/access";

export type ComputerOutput = Readonly<{
  kind: "synthetic-status";
  label: string;
  state: "ready";
}>;

export interface ComputerExecutor {
  execute(
    request: ComputerRequest,
  ): Promise<
    Result<
      ComputerOutput,
      "COMPUTER_EXECUTION_FAILED" | "COMPUTER_EXECUTION_CANCELLED"
    >
  >;
}
