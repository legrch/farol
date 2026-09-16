import { success } from "../../../../pkg/kernel/domain/result";
import type {
  ChatComputerFailureSource,
  ChatComputerOperation,
  ChatComputerOutputValue,
  ChatComputerRequest,
  ChatComputerResult,
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

function computerFailure(
  code: string,
  source: ChatComputerFailureSource,
  classification: "refused" | "outcome_unknown" = "refused",
): ChatComputerResult {
  return {
    ok: false,
    error: { code, source, classification, retry: "never" },
  };
}

function correlationMatches(
  request: ChatComputerRequest,
  binding: ReadonlyComputerPeerBinding,
  value: Readonly<{
    ownerId: string;
    sessionId: string;
    taskId: string;
    taskEpoch: number;
    participantId: string;
    turnId: string;
    generation: number;
    callId: string;
    workspaceId: string;
    relativePath: string;
    operation: ChatComputerOperation;
  }>,
): boolean {
  return (
    value.ownerId === request.ownerId &&
    value.sessionId === request.sessionId &&
    value.taskId === request.taskId &&
    value.taskEpoch === binding.taskEpoch &&
    value.participantId === binding.participantId &&
    value.turnId === request.turnId &&
    value.generation === request.generation &&
    value.callId === request.callId &&
    value.workspaceId === request.workspaceId &&
    value.relativePath === request.operation.relativePath &&
    operationsMatch(value.operation, request.operation)
  );
}

function operationsMatch(
  left: ChatComputerOperation,
  right: ChatComputerOperation,
): boolean {
  return (
    left.kind === right.kind &&
    left.relativePath === right.relativePath &&
    (left.kind !== "workspace.search" ||
      (right.kind === "workspace.search" && left.pattern === right.pattern))
  );
}

function outputMatchesOperation(
  operation: ChatComputerOperation,
  output: ChatComputerOutputValue,
): boolean {
  return (
    (operation.kind === "workspace.read" && output.kind === "workspace.text") ||
    (operation.kind === "workspace.list" &&
      output.kind === "workspace.entries") ||
    (operation.kind === "workspace.search" &&
      output.kind === "workspace.matches")
  );
}

export class ReadonlyComputerPeer implements ComputerCapability {
  constructor(
    private readonly contract: ReadonlyComputerContract,
    private readonly binding: ReadonlyComputerPeerBinding,
  ) {}

  async execute(request: ChatComputerRequest): Promise<ChatComputerResult> {
    let raw: unknown;
    try {
      raw = await this.contract.execute({
        ...request,
        taskEpoch: this.binding.taskEpoch,
        participantId: this.binding.participantId,
      });
    } catch {
      return computerFailure(
        "COMPUTER_CONTRACT_UNAVAILABLE",
        "contract-transport",
        "outcome_unknown",
      );
    }
    const parsed = ReadonlyComputerCallResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return computerFailure(
        "COMPUTER_CONTRACT_INVALID",
        "contract",
        "outcome_unknown",
      );
    }
    if (!parsed.data.ok) {
      if (
        parsed.data.correlation === null ||
        !correlationMatches(request, this.binding, parsed.data.correlation)
      ) {
        return computerFailure(
          "COMPUTER_CONTRACT_CORRELATION",
          "contract",
          "outcome_unknown",
        );
      }
      return computerFailure(parsed.data.error.code, parsed.data.error.source);
    }
    const value = parsed.data.value;
    return correlationMatches(request, this.binding, value) &&
      outputMatchesOperation(request.operation, value.output)
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
      : computerFailure(
          "COMPUTER_CONTRACT_CORRELATION",
          "contract",
          "outcome_unknown",
        );
  }
}
