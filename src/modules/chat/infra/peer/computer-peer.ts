import { failure } from "../../../../pkg/kernel/domain/result";
import type {
  ChatComputerRequest,
  ComputerCapability,
} from "../../app/port/computer-capability";
import {
  ComputerCallResponseSchema,
  type ComputerContract,
} from "../../../computer/contract/computer-contract";

export class ComputerPeer implements ComputerCapability {
  constructor(private readonly contract: ComputerContract) {}

  async execute(request: ChatComputerRequest) {
    const raw = await this.contract.execute({ ...request });
    const parsed = ComputerCallResponseSchema.safeParse(raw);
    if (!parsed.success) return failure("COMPUTER_CONTRACT_INVALID");
    if (!parsed.data.ok) return parsed.data;
    const value = parsed.data.value;
    const exact =
      value.ownerId === request.ownerId &&
      value.sessionId === request.sessionId &&
      value.taskId === request.taskId &&
      value.turnId === request.turnId &&
      value.generation === request.generation &&
      value.callId === request.callId;
    return exact ? parsed.data : failure("COMPUTER_CONTRACT_CORRELATION");
  }
}
