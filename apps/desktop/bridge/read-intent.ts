import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type Json,
  type ChatComputerAdmissionResponse,
  type ChatReadIntentPromote,
  type ChatReadIntentWithdrawn,
  type ChatHandle,
} from "./wire.ts";

// Transport for the already captured Go owner. No new task/turn identity,
// automatic cancellation, replacement admission or retry is created here.
export class ReadIntentBridge {
  constructor(private readonly client: Client) {}

  async promote(input: ChatReadIntentPromote): Promise<ChatHandle> {
    const selected = structuredClone(input);
    const handle = await this.call<ChatHandle>(
      "promote",
      "ChatReadIntentPromote",
      selected,
      "ChatHandle",
    );
    const a = selected.admission;
    const b = handle.binding;
    const context = this.client.verifiedContext;
    if (
      b.profileId !== context.profileId ||
      b.backendGeneration !== context.backendGeneration ||
      b.ownerId !== a.ownerId ||
      b.sessionId !== a.sessionId ||
      b.taskId !== a.taskId ||
      b.taskEpoch !== a.taskEpoch ||
      b.participantId !== a.participantId ||
      b.turnId !== a.turnId ||
      b.turnGeneration !== a.generation ||
      b.operationId !== a.admissionOperationId
    )
      throw new BridgeError("unknown", "read_intent_owner_crossed");
    return handle;
  }

  async withdraw(admission: ChatComputerAdmissionResponse): Promise<void> {
    const selected = structuredClone(admission);
    const reply = await this.call<ChatReadIntentWithdrawn>(
      "withdraw",
      "ChatReadIntentWithdraw",
      { admission: selected },
      "ChatReadIntentWithdrawn",
    );
    if (!isDeepStrictEqual(reply.admission, selected))
      throw new BridgeError("unknown", "read_intent_withdrawal_crossed");
  }

  private async call<T>(
    method: "promote" | "withdraw",
    inputShape: string,
    input: unknown,
    outputShape: string,
  ): Promise<T> {
    if (!validate(inputShape, input))
      throw new BridgeError("refused", "read_intent_request_invalid");
    const context = this.client.verifiedContext;
    const id = randomUUID();
    const operationId = randomUUID();
    const result = await this.client.request(
      `chat.readintent.${method}`,
      input as Json,
      { id, operationId, timeoutMs: 16000 },
    );
    if (
      result.requestId !== id ||
      result.operationId !== operationId ||
      result.context.profileId !== context.profileId ||
      result.context.backendGeneration !== context.backendGeneration
    )
      throw new BridgeError("unknown", "read_intent_response_context");
    if (result.status !== "ok")
      throw new BridgeError(
        result.status,
        result.code ?? "read_intent_request_failed",
      );
    if (!validate(outputShape, result.data))
      throw new BridgeError("unknown", "read_intent_response_invalid");
    return result.data as T;
  }
}
