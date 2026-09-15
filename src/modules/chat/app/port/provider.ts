import type { Result } from "../../../../pkg/kernel/domain/result";
import type { ChatComputerOutput } from "./computer-capability";

export type ProviderRequest = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
  prompt: string;
}>;

export type ProviderEvent =
  | Readonly<{ kind: "submit_activated" }>
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "delta"; sequence: number; text: string }>
  | Readonly<{
      kind: "computer_call";
      callId: string;
      operation: "inspect_fixture";
      target: "synthetic://workspace/status";
    }>
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "failed"; code: string }>;

export interface ProviderSession {
  events(): AsyncIterable<ProviderEvent>;
  submitComputerResult(
    result: ChatComputerOutput,
  ): Promise<Result<undefined, "PROVIDER_RESULT_REJECTED">>;
}

export interface ChatProvider {
  open(request: ProviderRequest): Promise<ProviderSession>;
}
