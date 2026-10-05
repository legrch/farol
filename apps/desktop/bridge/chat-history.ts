import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeError, type Client } from "./client.ts";
import {
  validate,
  type ChatHistoryKey,
  type ChatHistoryListRequest,
  type ChatHistorySummary,
  type ChatHistoryPage,
  type ChatHistoryResult,
  type Context,
  type Json,
  type Outcome,
} from "./wire.ts";

const timeoutMs = 16000;

function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== "object") return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

function sameContext(a: Context, b: Context): boolean {
  return (
    a.profileId === b.profileId && a.backendGeneration === b.backendGeneration
  );
}

function originalBinding(
  summary: Pick<ChatHistorySummary, "key" | "binding">,
  current: Context,
): boolean {
  return (
    summary.key.operationId === summary.binding.operationId &&
    summary.key.backendGeneration === summary.binding.backendGeneration &&
    summary.binding.profileId === current.profileId &&
    summary.binding.backendGeneration !== current.backendGeneration
  );
}

// Read-only transport projection. Keys identify retained results; they do not
// establish owner authority. Go qualifies the current owner and ancestor chain.
// Each invocation dispatches once, without a handle, ACK or replay policy.
export class ChatHistoryBridge {
  constructor(private readonly client: Client) {}

  async list(offset = 0): Promise<ChatHistoryPage> {
    const input: ChatHistoryListRequest = { offset };
    if (!validate("ChatHistoryListRequest", input))
      throw new BridgeError("refused", "chat_history_request_invalid");
    const context = this.captureContext();
    const page = await this.read<ChatHistoryPage>(
      "chat.history.list",
      input,
      "ChatHistoryPage",
      context,
    );
    this.recheckContext(context);
    if (
      page.offset !== offset ||
      offset > page.total ||
      page.entries.length !== Math.min(32, page.total - offset)
    )
      throw new BridgeError("unknown", "chat_history_page_invalid");
    const seen = new Set<string>();
    for (const summary of page.entries) {
      if (!validate("ChatHistorySummary", summary))
        throw new BridgeError("unknown", "chat_history_response_invalid");
      if (!originalBinding(summary, context))
        throw new BridgeError("unknown", "chat_history_binding_crossed");
      const key = JSON.stringify([
        summary.key.backendGeneration,
        summary.key.operationId,
      ]);
      if (seen.has(key))
        throw new BridgeError("unknown", "chat_history_key_duplicate");
      seen.add(key);
    }
    return page;
  }

  async result(summary: ChatHistorySummary): Promise<ChatHistoryResult> {
    if (!validate("ChatHistorySummary", summary))
      throw new BridgeError("refused", "chat_history_request_invalid");
    const selected = immutableCopy(summary);
    const context = this.captureContext();
    if (!originalBinding(selected, context))
      throw new BridgeError("refused", "chat_history_selection_invalid");
    const key: ChatHistoryKey = selected.key;
    const result = await this.read<ChatHistoryResult>(
      "chat.history.result",
      key,
      "ChatHistoryResult",
      context,
    );
    this.recheckContext(context);
    if (
      !isDeepStrictEqual(result.key, selected.key) ||
      !isDeepStrictEqual(result.binding, selected.binding) ||
      result.resultId !== selected.resultId ||
      result.conversationId !== selected.conversationId
    )
      throw new BridgeError("unknown", "chat_history_selection_crossed");
    if (
      result.phase !== "delivered" ||
      result.outcome !== "completed" ||
      !result.complete ||
      !result.acknowledged
    )
      throw new BridgeError("unknown", "chat_history_result_unsettled");
    return result;
  }

  private captureContext(): Readonly<Context> {
    const context = this.client.verifiedContext;
    if (!validate("Context", context))
      throw new BridgeError("refused", "chat_history_context_invalid");
    return immutableCopy(context);
  }

  private recheckContext(expected: Context): void {
    let current: Readonly<Context>;
    try {
      current = this.client.verifiedContext;
    } catch {
      // A peer unavailable after a successful read cannot validate that reply.
      throw new BridgeError("unknown", "chat_history_peer_changed");
    }
    if (!validate("Context", current) || !sameContext(current, expected))
      throw new BridgeError("unknown", "chat_history_peer_changed");
  }

  private async read<T>(
    method: "chat.history.list" | "chat.history.result",
    input: ChatHistoryListRequest | ChatHistoryKey,
    outputShape: "ChatHistoryPage" | "ChatHistoryResult",
    context: Context,
  ): Promise<T> {
    const id = randomUUID();
    const deadline = Date.now() + timeoutMs;
    // Separate frozen transport bytes from the selected reference used below.
    // Client owns transport deadlines; its rejection classification is preserved.
    const raw: unknown = await this.client.request(
      method,
      immutableCopy(input) as unknown as Json,
      Object.freeze({ id, timeoutMs }),
    );
    this.recheckContext(context);
    if (Date.now() >= deadline)
      throw new BridgeError("unknown", "chat_history_response_late");
    if (!validate("Outcome", raw))
      throw new BridgeError("unknown", "chat_history_response_invalid");
    const outcome = raw as Outcome;
    if (
      outcome.requestId !== id ||
      outcome.operationId !== undefined ||
      !sameContext(outcome.context, context)
    )
      throw new BridgeError("unknown", "chat_history_response_context");
    if (outcome.status !== "ok")
      throw new BridgeError(
        outcome.status,
        outcome.code ?? "chat_history_request_failed",
      );
    if (!validate(outputShape, outcome.data))
      throw new BridgeError("unknown", "chat_history_response_invalid");
    return immutableCopy(outcome.data) as T;
  }
}
