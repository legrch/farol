import type { Result } from "../../../../pkg/kernel/domain/result";

export type ChatComputerOperation =
  | Readonly<{ kind: "workspace.read"; relativePath: string }>
  | Readonly<{ kind: "workspace.list"; relativePath: string }>
  | Readonly<{
      kind: "workspace.search";
      relativePath: string;
      pattern: string;
    }>;

export type ChatComputerRequest = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
  callId: string;
  workspaceId: string;
  operation: ChatComputerOperation;
}>;

export type ChatComputerOutputValue =
  | Readonly<{
      kind: "workspace.text";
      text: string;
      bytes: number;
    }>
  | Readonly<{
      kind: "workspace.entries";
      entries: readonly string[];
      truncated: boolean;
    }>
  | Readonly<{
      kind: "workspace.matches";
      matches: readonly Readonly<{
        path: string;
        line: number;
        text: string;
        truncated: boolean;
      }>[];
      resultLimited: boolean;
      scanLimited: boolean;
    }>;

export type ChatComputerOutput = Readonly<{
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
  output: ChatComputerOutputValue;
}>;

export interface ComputerCapability {
  execute(
    request: ChatComputerRequest,
  ): Promise<Result<ChatComputerOutput, string>>;
}
