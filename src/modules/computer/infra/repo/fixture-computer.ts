import { failure, success } from "../../../../pkg/kernel/domain/result";
import type { DeferredGate } from "../../../../pkg/async/deferred-gate";
import type { ComputerExecutor } from "../../app/port/computer-executor";

export class FixtureComputer implements ComputerExecutor {
  constructor(private readonly approval: DeferredGate) {}

  async execute(request: Parameters<ComputerExecutor["execute"]>[0]) {
    if ((await this.approval.wait()) === "cancelled") {
      return failure("COMPUTER_EXECUTION_CANCELLED" as const);
    }
    return success({
      ownerId: request.ownerId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      turnId: request.turnId,
      generation: request.generation,
      callId: request.callId,
      output: {
        kind: "synthetic-status" as const,
        label: "Fixture workspace",
        state: "ready" as const,
        receipt: request.callId,
      },
    });
  }
}
