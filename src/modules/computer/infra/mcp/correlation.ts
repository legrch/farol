import type { MutableComputerCallRequest } from "../../contract/mutable-computer-contract";
import type { ReadonlyComputerCallRequest } from "../../contract/readonly-computer-contract";

export type ReadRange =
  Readonly<{ offset: number; length: number }> | undefined;

export function sameRange(left: ReadRange, right: ReadRange): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.offset === right.offset && left.length === right.length;
}

export function correlationMatches(
  request: ReadonlyComputerCallRequest,
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
    operation: ReadonlyComputerCallRequest["operation"];
  }>,
): boolean {
  return (
    value.ownerId === request.ownerId &&
    value.sessionId === request.sessionId &&
    value.taskId === request.taskId &&
    value.taskEpoch === request.taskEpoch &&
    value.participantId === request.participantId &&
    value.turnId === request.turnId &&
    value.generation === request.generation &&
    value.callId === request.callId &&
    value.workspaceId === request.workspaceId &&
    value.relativePath === request.operation.relativePath &&
    value.operation.kind === request.operation.kind &&
    value.operation.relativePath === request.operation.relativePath &&
    (value.operation.kind !== "workspace.read" ||
      (request.operation.kind === "workspace.read" &&
        sameRange(value.operation.range, request.operation.range))) &&
    (value.operation.kind !== "workspace.search" ||
      (request.operation.kind === "workspace.search" &&
        value.operation.pattern === request.operation.pattern)) &&
    (value.operation.kind !== "verification.run" ||
      (request.operation.kind === "verification.run" &&
        value.operation.command === request.operation.command))
  );
}

export function mutationCorrelationMatches(
  request: MutableComputerCallRequest,
  value: Readonly<{
    operationId: string;
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
    operation: Readonly<{
      kind: "workspace.edit" | "workspace.write";
      relativePath: string;
      expectedSha256: string | null;
    }>;
  }>,
): boolean {
  return (
    value.operationId === request.operationId &&
    value.ownerId === request.ownerId &&
    value.sessionId === request.sessionId &&
    value.taskId === request.taskId &&
    value.taskEpoch === request.taskEpoch &&
    value.participantId === request.participantId &&
    value.turnId === request.turnId &&
    value.generation === request.generation &&
    value.callId === request.callId &&
    value.workspaceId === request.workspaceId &&
    value.relativePath === request.operation.relativePath &&
    value.operation.kind === request.operation.kind &&
    value.operation.relativePath === request.operation.relativePath &&
    value.operation.expectedSha256 === request.operation.expectedSha256
  );
}
