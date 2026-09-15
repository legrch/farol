import { success } from "../../../../pkg/kernel/domain/result";
import type { DeferredGate } from "../../../../pkg/async/deferred-gate";
import type { ComputerExecutor } from "../../app/port/computer-executor";

export class FixtureComputer implements ComputerExecutor {
  constructor(private readonly approval: DeferredGate) {}

  async execute() {
    await this.approval.wait();
    return success({
      kind: "synthetic-status" as const,
      label: "Fixture workspace",
      state: "ready" as const,
    });
  }
}
