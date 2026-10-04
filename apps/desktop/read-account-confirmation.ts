import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeError } from "./bridge/client.ts";
import type {
  ChatComputerAdmissionResponse,
  ChatReadIntentAccountApprove,
  ChatReadIntentAccountApproved,
} from "./bridge/wire.ts";
import type { BoundChatGptAccountObservation } from "./chatgpt-account-observation.ts";

export type ReadAccountConfirmationView = Readonly<{
  confirmationId: string;
  state: "observed" | "approved";
}>;

// Correlates an explicit UI confirmation with the exact browser observation and
// original transport attempt. This object grants no account authority: only the
// Go approval RPC can mint that grant, and Go rechecks it at actual Send.
export class ReadAccountConfirmation {
  private readonly confirmationId = randomUUID();
  private readonly admission: ChatComputerAdmissionResponse;
  private observed: BoundChatGptAccountObservation | null = null;
  private inspection: Promise<ReadAccountConfirmationView> | undefined;
  private confirmation: Promise<ReadAccountConfirmationView> | undefined;
  private approved = false;

  constructor(
    private readonly input: Readonly<{
      admission: ChatComputerAdmissionResponse;
      current(): boolean;
      read(): Promise<BoundChatGptAccountObservation | null>;
      approve(
        request: ChatReadIntentAccountApprove,
      ): Promise<ChatReadIntentAccountApproved>;
    }>,
  ) {
    this.admission = structuredClone(input.admission);
  }

  projection(): ReadAccountConfirmationView | null {
    return this.observed
      ? {
          confirmationId: this.confirmationId,
          state: this.approved ? "approved" : "observed",
        }
      : null;
  }

  async inspect(): Promise<ReadAccountConfirmationView> {
    this.inspection ??= Promise.resolve().then(async () => {
      this.checkCurrent();
      const observed = await this.input.read();
      this.checkCurrent();
      if (!observed)
        throw new BridgeError("refused", "CHATGPT_ACCOUNT_UNAVAILABLE");
      this.observed = structuredClone(observed);
      return this.projection()!;
    });
    return structuredClone(await this.inspection);
  }

  async confirm(confirmationId: string): Promise<ReadAccountConfirmationView> {
    if (!this.observed || confirmationId !== this.confirmationId)
      throw new BridgeError("refused", "CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
    this.confirmation ??= Promise.resolve().then(() => this.confirmOnce());
    return structuredClone(await this.confirmation);
  }

  private checkCurrent(): void {
    if (!this.input.current())
      throw new BridgeError("refused", "CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
  }

  private async confirmOnce(): Promise<ReadAccountConfirmationView> {
    this.checkCurrent();
    const captured = this.observed!;
    const fresh = await this.input.read();
    this.checkCurrent();
    if (!fresh) throw new BridgeError("refused", "CHATGPT_ACCOUNT_UNAVAILABLE");
    if (
      !isDeepStrictEqual(fresh.binding, captured.binding) ||
      fresh.account.accountKey !== captured.account.accountKey
    )
      throw new BridgeError("refused", "CHATGPT_ACCOUNT_CHANGED");
    const account = fresh.account;
    const receipt = await this.input.approve({
      admission: this.admission,
      confirmedPrincipalKey: captured.account.accountKey,
      observation: {
        state: "observed",
        source: account.source,
        principalKey: account.accountKey,
        observedAtMillis: String(account.observedAtMillis),
        expiresAtMillis: String(account.expiresAtMillis),
      },
    });
    if (
      !this.input.current() ||
      !isDeepStrictEqual(receipt.admission, this.admission) ||
      receipt.principalKey !== captured.account.accountKey
    )
      throw new BridgeError("unknown", "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED");
    this.approved = true;
    return this.projection()!;
  }
}
