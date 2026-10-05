import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeError } from "./bridge/client.ts";
import type { BrowserAccountObservation } from "./bridge/wire.ts";
import type { BoundChatGptAccountObservation } from "./chatgpt-account-observation.ts";

export type AccountObservationConfirmationView = Readonly<{
  confirmationId: string;
  state: "observed";
}>;

// Correlates explicit UI confirmation with an original browser observation.
// The consumer's commit port owns any authority; this object only checks that
// a fresh observation still has the same binding and principal.
export class AccountObservationConfirmation<T> {
  private readonly confirmationId = randomUUID();
  private observed: BoundChatGptAccountObservation | null = null;
  private inspection: Promise<AccountObservationConfirmationView> | undefined;
  private confirmation:
    Readonly<{ confirmationId: string; result: Promise<T> }> | undefined;

  constructor(
    private readonly input: Readonly<{
      current(): boolean;
      read(): Promise<BoundChatGptAccountObservation | null>;
      commit(input: {
        confirmedPrincipalKey: string;
        observation: BrowserAccountObservation;
      }): Promise<T>;
    }>,
  ) {}

  async inspect(): Promise<AccountObservationConfirmationView> {
    this.inspection ??= Promise.resolve().then(async () => {
      this.checkCurrent();
      const observed = await this.input.read();
      this.checkCurrent();
      if (!observed)
        throw new BridgeError("refused", "CHATGPT_ACCOUNT_UNAVAILABLE");
      this.observed = structuredClone(observed);
      return {
        confirmationId: this.confirmationId,
        state: "observed",
      } satisfies AccountObservationConfirmationView;
    });
    return structuredClone(await this.inspection);
  }

  async confirm(confirmationId: string): Promise<T> {
    if (
      this.confirmation &&
      confirmationId !== this.confirmation.confirmationId &&
      confirmationId !== this.confirmationId
    )
      throw new BridgeError("refused", "CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
    if (!this.confirmation) {
      // Capture validity at invocation, before any deferred inspection can finish.
      // Retain even an invalid first attempt; it cannot become a later retry.
      const captured = this.observed;
      this.confirmation = {
        confirmationId,
        result: Promise.resolve().then(() => {
          if (!captured || confirmationId !== this.confirmationId)
            throw new BridgeError(
              "refused",
              "CHATGPT_ACCOUNT_CONFIRMATION_INVALID",
            );
          return this.confirmOnce(captured);
        }),
      };
    }
    // Keep the cached result private, including nested consumer-owned data.
    return structuredClone(await this.confirmation.result);
  }

  private checkCurrent(): void {
    if (!this.input.current())
      throw new BridgeError("refused", "CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
  }

  private async confirmOnce(
    captured: BoundChatGptAccountObservation,
  ): Promise<T> {
    this.checkCurrent();
    const read = await this.input.read();
    this.checkCurrent();
    if (!read) throw new BridgeError("refused", "CHATGPT_ACCOUNT_UNAVAILABLE");
    const fresh = structuredClone(read);
    if (
      !isDeepStrictEqual(fresh.binding, captured.binding) ||
      fresh.account.accountKey !== captured.account.accountKey
    )
      throw new BridgeError("refused", "CHATGPT_ACCOUNT_CHANGED");
    const account = fresh.account;
    const result = await this.input.commit(
      structuredClone({
        confirmedPrincipalKey: captured.account.accountKey,
        observation: {
          state: "observed",
          source: account.source,
          principalKey: account.accountKey,
          observedAtMillis: String(account.observedAtMillis),
          expiresAtMillis: String(account.expiresAtMillis),
        } satisfies BrowserAccountObservation,
      }),
    );
    if (!this.input.current())
      throw new BridgeError("unknown", "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED");
    return structuredClone(result);
  }
}
