import { failure, success } from "../../../../pkg/kernel/domain/result";
import type {
  ChatComputerRequest,
  ComputerCapability,
} from "../../app/port/computer-capability";
import {
  ReadonlyComputerCallResponseSchema,
  type ReadonlyComputerContract,
} from "../../../computer/contract/readonly-computer-contract";

export type ReadonlyComputerPeerBinding = Readonly<{
  taskEpoch: number;
  participantId: string;
}>;

export class ReadonlyComputerPeer implements ComputerCapability {
  constructor(
    private readonly contract: ReadonlyComputerContract,
    private readonly binding: ReadonlyComputerPeerBinding,
  ) {}

  async execute(request: ChatComputerRequest) {
    const raw = await this.contract.execute({
      ...request,
      taskEpoch: this.binding.taskEpoch,
      participantId: this.binding.participantId,
    });
    const parsed = ReadonlyComputerCallResponseSchema.safeParse(raw);
    if (!parsed.success) return failure("COMPUTER_CONTRACT_INVALID");
    if (!parsed.data.ok) return failure(parsed.data.error.code);
    const value = parsed.data.value;
    const exact =
      value.ownerId === request.ownerId &&
      value.sessionId === request.sessionId &&
      value.taskId === request.taskId &&
      value.taskEpoch === this.binding.taskEpoch &&
      value.participantId === this.binding.participantId &&
      value.turnId === request.turnId &&
      value.generation === request.generation &&
      value.callId === request.callId &&
      value.workspaceId === request.workspaceId &&
      value.relativePath === request.operation.relativePath;
    return exact
      ? success({
          ...value,
          output:
            value.output.kind === "workspace.entries"
              ? { ...value.output, entries: [...value.output.entries] }
              : value.output.kind === "workspace.matches"
                ? {
                    ...value.output,
                    matches: value.output.matches.map((match) => ({
                      ...match,
                    })),
                  }
                : value.output,
        })
      : failure("COMPUTER_CONTRACT_CORRELATION");
  }
}
