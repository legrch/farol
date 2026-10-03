import type { RunReadonlyComputerAction } from "../app/service/run-readonly-computer-action";
import {
  ReadonlyComputerCallRequestSchema,
  type ReadonlyComputerCallResponse,
  type ReadonlyComputerCallRequest,
  type ReadonlyComputerContract,
  type ReadonlyComputerExecutionContext,
} from "../contract/readonly-computer-contract";

export function readonlyComputerCallCorrelation(
  request: ReadonlyComputerCallRequest,
) {
  return {
    ownerId: request.ownerId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    taskEpoch: request.taskEpoch,
    participantId: request.participantId,
    turnId: request.turnId,
    generation: request.generation,
    callId: request.callId,
    workspaceId: request.workspaceId,
    relativePath: request.operation.relativePath,
    operation: request.operation,
  };
}

export class ReadonlyComputerContractHandler implements ReadonlyComputerContract {
  constructor(private readonly service: RunReadonlyComputerAction) {}

  async execute(
    request: unknown,
    context: ReadonlyComputerExecutionContext = {},
  ): Promise<ReadonlyComputerCallResponse> {
    const parsed = ReadonlyComputerCallRequestSchema.safeParse(request);
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
    const result = await this.service.execute(parsed.data, context);
    if (!result.ok) {
      return {
        ok: false,
        correlation: readonlyComputerCallCorrelation(parsed.data),
        error: result.error,
      };
    }
    const output = result.value.output;
    return {
      ok: true,
      value: {
        ...result.value,
        output:
          output.kind === "workspace.entries"
            ? { ...output, entries: [...output.entries] }
            : output.kind === "workspace.matches"
              ? {
                  ...output,
                  matches: output.matches.map((match) => ({ ...match })),
                }
              : output,
      },
    };
  }
}
