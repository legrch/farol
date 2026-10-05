import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type Json,
  type ChatComputerAdmissionResponse,
  type ChatReadIntentPromote,
  type ChatReadIntentResolve,
  type ChatReadIntentResolved,
  type ChatReadIntentWithdrawn,
  type ChatReadIntentAccountApprove,
  type ChatReadIntentAccountApproved,
  type ChatReadIntentAccountRevoke,
  type ChatHandle,
} from "./wire.ts";

// Transport for the already captured Go owner. No new task/turn identity,
// automatic cancellation, replacement admission or retry is created here.
export class ReadIntentBridge {
  private readonly selections = new Map<
    string,
    { input: ChatReadIntentResolve; result: Promise<ChatReadIntentResolved> }
  >();
  private readonly promotions = new Map<
    string,
    { input: ChatReadIntentPromote; result: Promise<ChatHandle> }
  >();
  private readonly approvals = new Map<
    string,
    {
      input: ChatReadIntentAccountApprove;
      result: Promise<ChatReadIntentAccountApproved>;
    }
  >();
  private readonly revocations = new Map<
    string,
    { input: ChatReadIntentAccountRevoke; result: Promise<void> }
  >();
  // Retain the original transport attempt, including rejection. A second UI
  // dismissal must not mint a new effect after a lost withdrawal reply.
  private readonly withdrawals = new Map<
    string,
    { admission: ChatComputerAdmissionResponse; result: Promise<void> }
  >();
  constructor(private readonly client: Client) {}

  async resolve(input: ChatReadIntentResolve): Promise<ChatReadIntentResolved> {
    const selected = structuredClone(input);
    if (!validate("ChatReadIntentResolve", selected))
      throw new BridgeError("refused", "read_intent_request_invalid");
    const key = selected.admission.admissionOperationId;
    const existing = this.selections.get(key);
    if (existing) {
      if (!isDeepStrictEqual(existing.input, selected))
        throw new BridgeError("refused", "read_intent_selection_crossed");
      return structuredClone(await existing.result);
    }
    const result = Promise.resolve().then(async () => {
      const reply = await this.call<ChatReadIntentResolved>(
        "resolve",
        "ChatReadIntentResolve",
        selected,
        "ChatReadIntentResolved",
      );
      if (
        !isDeepStrictEqual(reply.admission, selected.admission) ||
        !isDeepStrictEqual(reply.selection, reply.resolution.resolved) ||
        !/^[a-f0-9]{64}$/u.test(reply.resolution.configSHA256) ||
        !reply.resolution.translationId ||
        !reply.resolution.requestedAlias ||
        !reply.resolution.requestedExecutor
      )
        throw new BridgeError("unknown", "read_intent_selection_crossed");
      return structuredClone(reply);
    });
    this.selections.set(key, { input: selected, result });
    return structuredClone(await result);
  }

  async promote(input: ChatReadIntentPromote): Promise<ChatHandle> {
    const selected = structuredClone(input);
    if (!validate("ChatReadIntentPromote", selected))
      throw new BridgeError("refused", "read_intent_request_invalid");
    const existing = this.promotions.get(
      selected.admission.admissionOperationId,
    );
    if (existing) {
      if (!isDeepStrictEqual(existing.input, selected))
        throw new BridgeError("refused", "read_intent_promotion_crossed");
      return structuredClone(await existing.result);
    }
    const result = Promise.resolve().then(() => this.promoteOnce(selected));
    this.promotions.set(selected.admission.admissionOperationId, {
      input: selected,
      result,
    });
    return structuredClone(await result);
  }

  private async promoteOnce(
    selected: ChatReadIntentPromote,
  ): Promise<ChatHandle> {
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

  // Called by trusted host composition only after explicit owner confirmation.
  // Keep the original attempt across double-clicks, rerenders and lost replies.
  async approveAccount(
    input: ChatReadIntentAccountApprove,
  ): Promise<ChatReadIntentAccountApproved> {
    const selected = structuredClone(input);
    if (
      !validate("ChatReadIntentAccountApprove", selected) ||
      selected.confirmedPrincipalKey !== selected.observation.principalKey
    )
      throw new BridgeError("refused", "read_intent_request_invalid");
    const key = selected.admission.admissionOperationId;
    const existing = this.approvals.get(key);
    if (existing) {
      if (!isDeepStrictEqual(existing.input, selected))
        throw new BridgeError("refused", "read_intent_account_crossed");
      return structuredClone(await existing.result);
    }
    const result = Promise.resolve().then(() =>
      this.approveAccountOnce(selected),
    );
    this.approvals.set(key, { input: selected, result });
    return structuredClone(await result);
  }

  private async approveAccountOnce(
    selected: ChatReadIntentAccountApprove,
  ): Promise<ChatReadIntentAccountApproved> {
    const reply = await this.call<ChatReadIntentAccountApproved>(
      "account.approve",
      "ChatReadIntentAccountApprove",
      selected,
      "ChatReadIntentAccountApproved",
    );
    if (
      !isDeepStrictEqual(reply.admission, selected.admission) ||
      reply.principalKey !== selected.confirmedPrincipalKey
    )
      throw new BridgeError("unknown", "read_intent_account_crossed");
    return reply;
  }

  async revokeAccount(input: ChatReadIntentAccountRevoke): Promise<void> {
    const selected = structuredClone(input);
    if (!validate("ChatReadIntentAccountRevoke", selected))
      throw new BridgeError("refused", "read_intent_request_invalid");
    const key = selected.admission.admissionOperationId;
    const existing = this.revocations.get(key);
    if (existing) {
      if (!isDeepStrictEqual(existing.input, selected))
        throw new BridgeError("refused", "read_intent_account_crossed");
      return existing.result;
    }
    const result = Promise.resolve().then(async () => {
      const reply = await this.call<ChatReadIntentWithdrawn>(
        "account.revoke",
        "ChatReadIntentAccountRevoke",
        selected,
        "ChatReadIntentWithdrawn",
      );
      if (!isDeepStrictEqual(reply.admission, selected.admission))
        throw new BridgeError("unknown", "read_intent_account_crossed");
    });
    this.revocations.set(key, { input: selected, result });
    return result;
  }

  async withdraw(admission: ChatComputerAdmissionResponse): Promise<void> {
    const selected = structuredClone(admission);
    if (!validate("ChatReadIntentWithdraw", { admission: selected }))
      throw new BridgeError("refused", "read_intent_request_invalid");
    const existing = this.withdrawals.get(selected.admissionOperationId);
    if (existing) {
      if (!isDeepStrictEqual(existing.admission, selected))
        throw new BridgeError("refused", "read_intent_withdrawal_crossed");
      return existing.result;
    }
    const result = Promise.resolve().then(() => this.withdrawOnce(selected));
    this.withdrawals.set(selected.admissionOperationId, {
      admission: selected,
      result,
    });
    return result;
  }

  private async withdrawOnce(
    selected: ChatComputerAdmissionResponse,
  ): Promise<void> {
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
    method:
      "resolve" | "promote" | "withdraw" | "account.approve" | "account.revoke",
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
