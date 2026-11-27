import type { HandoffReadContext } from "../port/handoff";

/** Cancellation and the optional read deadline both still admit the work. */
export function readAllowed(
  context: HandoffReadContext,
  now: () => number,
): boolean {
  return (
    !context.signal?.aborted &&
    (context.deadlineAt === undefined ||
      (Number.isSafeInteger(context.deadlineAt) &&
        context.deadlineAt >= 0 &&
        now() < context.deadlineAt))
  );
}

/** The mutation window still open and the caller has not cancelled. */
export function mutationAdmitted(
  signal: AbortSignal | undefined,
  now: () => number,
  expiresAt: number,
): boolean {
  return !signal?.aborted && now() < expiresAt;
}

/** A caller deadline can only shorten, never extend, the mutation window. */
export function boundedContext(
  context: HandoffReadContext,
  expiresAt: number,
): HandoffReadContext {
  return {
    ...context,
    deadlineAt: Math.min(context.deadlineAt ?? expiresAt, expiresAt),
  };
}
