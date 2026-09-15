import { failure } from "../../../pkg/kernel/domain/result";
import type { ComputerService } from "../app/service/computer-service";
import {
  ComputerCallRequestSchema,
  type ComputerCallResponse,
  type ComputerContract,
} from "../contract/computer-contract";

export class ComputerContractHandler implements ComputerContract {
  constructor(private readonly service: ComputerService) {}

  async execute(request: unknown): Promise<ComputerCallResponse> {
    const parsed = ComputerCallRequestSchema.safeParse(request);
    if (!parsed.success) return failure("COMPUTER_INVALID_REQUEST");
    const value = parsed.data;
    const result = await this.service.execute({
      ownerId: value.ownerId,
      sessionId: value.sessionId,
      taskId: value.taskId,
      turnId: value.turnId,
      generation: value.generation,
      callId: value.callId,
      operation: "fixture.inspect",
      target: value.target,
    });
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        ownerId: value.ownerId,
        sessionId: value.sessionId,
        taskId: value.taskId,
        turnId: value.turnId,
        generation: value.generation,
        callId: value.callId,
        output: result.value,
      },
    };
  }
}
