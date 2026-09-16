import type { RunReadonlyComputerAction } from "../app/service/run-readonly-computer-action";
import {
  ReadonlyComputerCallRequestSchema,
  type ReadonlyComputerCallResponse,
  type ReadonlyComputerContract,
} from "../contract/readonly-computer-contract";

export class ReadonlyComputerContractHandler implements ReadonlyComputerContract {
  constructor(private readonly service: RunReadonlyComputerAction) {}

  async execute(request: unknown): Promise<ReadonlyComputerCallResponse> {
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
    const result = await this.service.execute(parsed.data);
    if (!result.ok) {
      return {
        ok: false,
        correlation: {
          ownerId: parsed.data.ownerId,
          sessionId: parsed.data.sessionId,
          taskId: parsed.data.taskId,
          taskEpoch: parsed.data.taskEpoch,
          participantId: parsed.data.participantId,
          turnId: parsed.data.turnId,
          generation: parsed.data.generation,
          callId: parsed.data.callId,
          workspaceId: parsed.data.workspaceId,
          relativePath: parsed.data.operation.relativePath,
          operation: parsed.data.operation,
        },
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
