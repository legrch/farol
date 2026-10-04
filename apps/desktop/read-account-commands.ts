import { BridgeError } from "./bridge/client.ts";
import type {
  ProductConfigurationCommand,
  ProductConfigurationResult,
} from "../../src/pkg/product-settings/contract.ts";

export type ReadAccountCommand = Extract<
  ProductConfigurationCommand,
  {
    kind:
      "chatgpt.inspect-readonly-account" | "chatgpt.approve-readonly-account";
  }
>;
type Failure = Extract<ProductConfigurationResult, { ok: false }>["error"];

export function readAccountFailure(
  command: ReadAccountCommand,
  error: unknown,
): Failure {
  // Client 'unavailable' proves rejection before its request was sent. Unknown
  // transport/receipt failures and post-grant withdrawal remain uncertain.
  if (
    error instanceof BridgeError &&
    (error.state === "refused" || error.state === "unavailable")
  ) {
    if (error.code === "CHATGPT_ACCOUNT_CHANGED")
      return "CHATGPT_ACCOUNT_CHANGED";
    if (error.code === "CHATGPT_ACCOUNT_CONFIRMATION_INVALID")
      return "CHATGPT_ACCOUNT_CONFIRMATION_INVALID";
    return "CHATGPT_ACCOUNT_UNAVAILABLE";
  }
  return command.kind === "chatgpt.inspect-readonly-account"
    ? "CHATGPT_ACCOUNT_UNAVAILABLE"
    : "CHATGPT_ACCOUNT_APPROVAL_UNCONFIRMED";
}

// IPC reply retention only. Go owns account approval, lifetime and authority.
// Lookup precedes current-preview checks so an exact unknown reply cannot turn
// into a new refusal after expiry, withdrawal or retirement. No automatic retry
// or eviction of unresolved attempts; bounded exhaustion refuses new commands.
export class ReadAccountCommands {
  private readonly replies = new Map<
    string,
    {
      confirmationId: string | null;
      promise: Promise<ProductConfigurationResult>;
    }
  >();

  run(
    command: ReadAccountCommand,
    dispatch: () => Promise<ProductConfigurationResult>,
    refuse: (code: Failure) => ProductConfigurationResult,
  ): Promise<ProductConfigurationResult> {
    const key = JSON.stringify([command.operationId, command.kind]);
    const confirmationId =
      command.kind === "chatgpt.approve-readonly-account"
        ? command.confirmationId
        : null;
    const previous = this.replies.get(key);
    if (previous)
      return previous.confirmationId === confirmationId
        ? previous.promise.then((value) => structuredClone(value))
        : Promise.resolve(refuse("CHATGPT_ACCOUNT_CONFIRMATION_INVALID"));
    if (this.replies.size >= 1024)
      return Promise.resolve(refuse("CHATGPT_ACCOUNT_UNAVAILABLE"));
    const promise = Promise.resolve()
      .then(dispatch)
      .then((value) => structuredClone(value));
    this.replies.set(key, { confirmationId, promise });
    return promise.then((value) => structuredClone(value));
  }
}
