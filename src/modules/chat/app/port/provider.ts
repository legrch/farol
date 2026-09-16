import type { Result } from "../../../../pkg/kernel/domain/result";
import type {
  ChatComputerOperation,
  ChatComputerOutput,
} from "./computer-capability";

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
      workspaceId: string;
      operation: ChatComputerOperation;
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
  /** Prepare a session without dispatching. Only submit_activated proves dispatch. */
  prepare(request: ProviderRequest): Promise<ProviderSession>;
}
