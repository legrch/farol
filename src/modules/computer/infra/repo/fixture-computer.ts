import { failure, success } from "../../../../pkg/kernel/domain/result";
import type { DeferredGate } from "../../../../pkg/async/deferred-gate";
import type { ComputerExecutor } from "../../app/port/computer-executor";

export class FixtureComputer implements ComputerExecutor {
  constructor(private readonly approval: DeferredGate) {}

  async execute() {
    if ((await this.approval.wait()) === "cancelled") {
      return failure("COMPUTER_EXECUTION_CANCELLED" as const);
    }
    return success({
      kind: "synthetic-status" as const,
      label: "Fixture workspace",
      state: "ready" as const,
    });
  }
}
