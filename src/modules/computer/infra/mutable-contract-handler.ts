import type { RunMutableComputerAction } from "../app/service/run-mutable-computer-action";
import {
  MutableComputerCallRequestSchema,
  MutableComputerCallResponseSchema,
  type MutableComputerCallRequest,
  type MutableComputerCallResponse,
  type MutableComputerContract,
  type MutableComputerExecutionContext,
} from "../contract/mutable-computer-contract";

function summary(request: MutableComputerCallRequest) {
  const operation = request.operation;
  const operationSummary =
    operation.kind === "workspace.write"
      ? {
          kind: operation.kind,
          relativePath: operation.relativePath,
          expectedSha256: operation.expectedSha256,
        }
      : {
          kind: operation.kind,
          relativePath: operation.relativePath,
          expectedSha256: operation.expectedSha256,
        };
  return {
    operationId: request.operationId,
    ownerId: request.ownerId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    taskEpoch: request.taskEpoch,
    participantId: request.participantId,
    turnId: request.turnId,
    generation: request.generation,
    callId: request.callId,
    workspaceId: request.workspaceId,
    relativePath: operation.relativePath,
    operation: operationSummary,
  };
}

export class MutableComputerContractHandler implements MutableComputerContract {
  constructor(private readonly service: RunMutableComputerAction) {}

  async execute(
    request: unknown,
    context: MutableComputerExecutionContext = {},
  ): Promise<MutableComputerCallResponse> {
    const parsed = MutableComputerCallRequestSchema.safeParse(request);
    if (!parsed.success) {
      return {
        ok: false,
        correlation: null,
        error: {
          code: "COMPUTER_INVALID_REQUEST",
          source: "contract",
          retry: "never",
        },
      };
    }
    const correlation = summary(parsed.data);
    const result = await this.service.execute(parsed.data, context);
    if (!result.ok) {
      return MutableComputerCallResponseSchema.parse({
        ok: false,
        correlation,
        error: result.error,
      });
    }
    const value = result.value;
    const expectedOperation =
      parsed.data.operation.kind === "workspace.write" ? "write" : "edit";
    if (
      value.operationId !== parsed.data.operationId ||
      value.ownerId !== parsed.data.ownerId ||
      value.sessionId !== parsed.data.sessionId ||
      value.taskId !== parsed.data.taskId ||
      value.taskEpoch !== parsed.data.taskEpoch ||
      value.participantId !== parsed.data.participantId ||
      value.turnId !== parsed.data.turnId ||
      value.generation !== parsed.data.generation ||
      value.callId !== parsed.data.callId ||
      value.workspaceId !== parsed.data.workspaceId ||
      value.relativePath !== parsed.data.operation.relativePath ||
      value.operation !== expectedOperation ||
      value.receipt.operation !== expectedOperation ||
      value.receipt.relativePath !== parsed.data.operation.relativePath
    ) {
      return {
        ok: false,
        correlation,
        error: {
          code: "COMPUTER_MUTATION_CORRELATION",
          source: "contract",
          retry: "never",
        },
      };
    }
    return MutableComputerCallResponseSchema.parse({
      ok: true,
      value: {
        ...correlation,
        receipt: value.receipt,
        resultRetention: value.resultRetention,
        redelivered: value.redelivered,
      },
    });
  }
}
