import type { Result } from "../../../../pkg/kernel/domain/result";

export type ChatComputerRequest = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
  callId: string;
  operation: "inspect_fixture";
  target: "synthetic://workspace/status";
}>;

export type ChatComputerOutput = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
  callId: string;
  output: Readonly<{
    kind: "synthetic-status";
    label: string;
    state: "ready";
  }>;
}>;

export interface ComputerCapability {
  execute(
    request: ChatComputerRequest,
  ): Promise<Result<ChatComputerOutput, string>>;
}
