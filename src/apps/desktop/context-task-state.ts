import type { ProductTaskContext } from "../../modules/chat/contract/product-task";
import type { ContextSession } from "../../modules/chat/domain/context-continuity";

export function toProductTaskContext(
  session: ContextSession,
): ProductTaskContext {
  return {
    epoch: session.epoch,
    phase: session.phase,
    source:
      session.operation?.source ?? session.lastCompletedRequest?.source ?? null,
    code:
      session.phase === "blocked" || session.phase === "outcome_unknown"
        ? session.blockedCode
        : null,
  };
}
