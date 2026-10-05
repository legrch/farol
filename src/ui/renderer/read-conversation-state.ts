import type { ReadConversationView } from "../../pkg/product-settings/chat-conversation";

export type ReadConversationTurn = Readonly<{
  view: ReadConversationView;
  text: string;
}>;
export type ReadConversationState = Readonly<{
  origin?: "typed";
  operationId: string;
  buildId: string;
  revision: number;
  turns: readonly ReadConversationTurn[];
}>;
const stable = [
  "profileId",
  "backendGeneration",
  "ownerId",
  "sessionId",
  "taskId",
  "taskEpoch",
  "participantId",
] as const;

// Window-local presentation only. Failure preserves the old display; it never
// reconstructs a backend owner or acknowledges an unadopted stream cursor.
export function adoptReadConversation(
  previous: ReadConversationState | null,
  next: ReadConversationView,
  input: Readonly<{
    action: "start" | "typed-start" | "progress" | "ack" | "follow";
    sessionId?: string;
    operationId: string;
    handleId?: string;
    cursor?: string;
    resultId?: string;
    buildId: string;
    revision: number;
  }>,
): ReadConversationState | null {
  if (
    next.operationId !== input.operationId ||
    !input.buildId ||
    next.hasResult !== Boolean(next.result) ||
    (next.result && next.result.acknowledged !== next.deliveryAcknowledged) ||
    (next.followReady &&
      (!next.hasResult ||
        !next.deliveryAcknowledged ||
        !next.lifecycleSettled ||
        !next.released))
  )
    return null;
  const old = previous?.turns.at(-1);
  let after = 0n;
  let text = "";
  let turns: ReadConversationTurn[] = [];
  if (input.action === "typed-start") {
    // A typed start has no Computer task. The window binds the reply to the
    // host's retained account inspection session, while Go owns the task ID.
    if (
      previous ||
      !input.sessionId ||
      next.binding.sessionId !== input.sessionId ||
      next.binding.turnGeneration !== "1"
    )
      return null;
  } else if (input.action === "start") {
    // The preview operation names the admitted task; Go assigns a distinct
    // admission/turn operation. The bridge verifies that exact admission tuple.
    if (previous || next.binding.taskId !== input.operationId) return null;
  } else {
    if (
      !previous ||
      !old ||
      previous.operationId !== input.operationId ||
      previous.buildId !== input.buildId ||
      previous.revision !== input.revision ||
      old.view.handleId !== input.handleId
    )
      return null;
    if (stable.some((key) => old.view.binding[key] !== next.binding[key]))
      return null;
    const knownConversation = previous.turns.find(
      (turn) => turn.view.conversationId,
    )?.view.conversationId;
    if (
      knownConversation &&
      next.conversationId &&
      knownConversation !== next.conversationId
    )
      return null;
    turns = [...previous.turns];
    if (input.action === "follow") {
      if (
        !old.view.followReady ||
        turns.length >= 32 ||
        next.handleId === old.view.handleId ||
        next.binding.turnId === old.view.binding.turnId ||
        next.binding.operationId === old.view.binding.operationId ||
        BigInt(next.binding.turnGeneration) <=
          BigInt(old.view.binding.turnGeneration)
      )
        return null;
    } else {
      if (
        JSON.stringify(old.view.binding) !== JSON.stringify(next.binding) ||
        next.handleId !== old.view.handleId ||
        input.cursor !== old.view.cursor
      )
        return null;
      if (
        (old.view.hasResult && !next.hasResult) ||
        (old.view.deliveryAcknowledged && !next.deliveryAcknowledged) ||
        (old.view.lifecycleSettled && !next.lifecycleSettled) ||
        (old.view.released && !next.released)
      )
        return null;
      if (
        old.view.result &&
        (!next.result ||
          old.view.result.resultId !== next.result.resultId ||
          old.view.result.text !== next.result.text)
      )
        return null;
      if (
        input.action === "ack" &&
        (!old.view.result ||
          old.view.result.resultId !== input.resultId ||
          !next.deliveryAcknowledged)
      )
        return null;
      after = BigInt(input.cursor);
      text = old.text;
      turns.pop();
    }
  }
  for (const frame of next.frames) {
    if (BigInt(frame.sequence) !== after + 1n) return null;
    after += 1n;
    text += frame.delta ?? "";
    if (new TextEncoder().encode(text).length > 8192) return null;
  }
  if (
    String(after) !== next.cursor ||
    (next.result && !next.result.text.startsWith(text))
  )
    return null;
  turns.push({ view: next, text });
  return {
    ...(input.action === "typed-start" || previous?.origin === "typed"
      ? { origin: "typed" as const }
      : {}),
    operationId: input.operationId,
    buildId: input.buildId,
    revision: input.revision,
    turns,
  };
}
