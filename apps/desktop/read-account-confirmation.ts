import { isDeepStrictEqual } from "node:util";
import { AccountObservationConfirmation } from "./account-observation-confirmation.ts";
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
  private readonly admission: ChatComputerAdmissionResponse;
  private readonly confirmation: AccountObservationConfirmation<null>;
  private observed: ReadAccountConfirmationView | null = null;
  private approved = false;

  constructor(
    input: Readonly<{
      admission: ChatComputerAdmissionResponse;
      current(): boolean;
      read(): Promise<BoundChatGptAccountObservation | null>;
      approve(
        request: ChatReadIntentAccountApprove,
      ): Promise<ChatReadIntentAccountApproved>;
    }>,
  ) {
    this.admission = structuredClone(input.admission);
    this.confirmation = new AccountObservationConfirmation({
      current: () => input.current(),
      read: () => input.read(),
      commit: async (request) => {
        const confirmedPrincipalKey = request.confirmedPrincipalKey;
        const receipt = await input.approve({
          admission: structuredClone(this.admission),
          ...request,
        });
        if (
          !isDeepStrictEqual(receipt.admission, this.admission) ||
          receipt.principalKey !== confirmedPrincipalKey
        )
          throw new BridgeError(
            "unknown",
            "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED",
          );
        return null;
      },
    });
  }

  projection(): ReadAccountConfirmationView | null {
    return this.observed
      ? {
          confirmationId: this.observed.confirmationId,
          state: this.approved ? "approved" : "observed",
        }
      : null;
  }

  async inspect(): Promise<ReadAccountConfirmationView> {
    const observed = await this.confirmation.inspect();
    this.observed ??= structuredClone(observed);
    return observed;
  }

  async confirm(confirmationId: string): Promise<ReadAccountConfirmationView> {
    if (!this.observed || confirmationId !== this.observed.confirmationId)
      throw new BridgeError("refused", "CHATGPT_ACCOUNT_CONFIRMATION_INVALID");
    await this.confirmation.confirm(confirmationId);
    this.approved = true;
    return this.projection()!;
  }
}
