// What makes two Product Agent session opens the same request.
//
// `ProductAgentSessionReservation` is key-addressed: an open that arrives
// while another is still in flight under the same key is handed that one's
// promise instead of running its own factory, and an open under a different
// key is refused `PRODUCT_AGENT_SESSION_BUSY`. So this key is the entire
// definition of "the same request", and anything it leaves out is something
// two callers can differ in while sharing one session handle.
//
// `scheduleExpiry` is in the key for that reason. It is not part of
// `ProductAgentInput` — it is the third argument of
// `openProductAgentSession` — and it decides whether the session that comes
// back has its `ProductAgentInput.expiresAt` reservation armed.
// `executeProductAgent` opens with it on; `cancelProductAgentTask` opens with
// it off, because it is about to cancel the session anyway. Without it in the
// key, a cancel-path open in flight would hand `executeProductAgent` a
// session whose 30-minute reservation was never armed, and nothing would
// afterwards notice that it had not been.
//
// Today the task mutation gate serialises those two callers, so they cannot
// be in flight together and the collision is not reachable. That is why this
// is the key's own invariant rather than a fix for an observed failure: the
// key should not depend on another lock to be complete.

import type { ProductAgentInput } from "./product-agent-store";

export function productAgentSessionKey(
  input: ProductAgentInput,
  scheduleExpiry: boolean,
): string {
  return JSON.stringify([
    input.taskId,
    input.assignmentId,
    input.executableSha256,
    input.schemaSha256,
    input.buildId,
    input.computerGeneration,
    input.scope,
    input.excludedPaths,
    scheduleExpiry,
  ]);
}
