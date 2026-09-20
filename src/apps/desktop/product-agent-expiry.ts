import type { ProductTaskAgent } from "../../modules/chat/contract/product-task";
import type { ProductAgentInput } from "./product-agent-store";

// S35-TA-7: this used to sit inline in `main.ts`, which exports nothing and
// which no test loads, so every branch of what happens when a Product
// Agent's reservation (`ProductAgentInput.expiresAt`, 30 minutes from
// creation) elapses was unpinnable by construction — a test could only
// replicate the branches and assert on the copy, exactly the kind of test an
// independent review already rejected for the sibling decisions. Same
// reason `journalUnderPromotionLease`, the registry's two durable writes,
// the Computer workspace composition, and the native freshness gate
// (`product-agent-context.ts`) were moved out.
//
// Two failure shapes are why this is a guarded decision rather than inline
// arithmetic:
//
// 1. A task that is BUSY — another mutation already holds
//    `taskMutationInFlight` — when its expiry timer fires must be
//    RESCHEDULED, never cancelled and never silently dropped. Cancelling
//    now would race the mutation already in flight; dropping the timer
//    would leave a reservation nobody is tracking anymore.
// 2. A `ProductAgentInput` recovered from disk after a restart whose
//    assignment binding (`assignmentBindingSha256`, a sha256 of
//    taskId/sessionId/assignmentId) no longer matches the task the live
//    registry says is running must be marked `outcome_unknown`, and the
//    recovery must stop there — never reaching a fresh `reschedule`.
//    Re-arming a timer against an input that no longer describes the
//    running assignment would eventually act on the wrong one.
//
// Every verdict is closed: `noop` (nothing to do), `unknown` (mark it and
// stop), `reschedule` (arm for `atMs`), or `expire` (proceed with the real
// cancellation). `main.ts` keeps every `setTimeout`, the module-level
// session/timer singletons, and the store reads/writes; only the branch
// that chooses between these four outcomes moved here.

/**
 * The fixed retry delay used whenever a timer fires while a mutation is
 * already in flight. Matches the `100`ms literal both original call sites
 * used.
 */
const EXPIRY_RETRY_DELAY_MS = 100;

type NoopVerdict = Readonly<{
  action: "noop";
  reason:
    | "session_superseded"
    | "task_not_running"
    | "no_running_task"
    | "store_unavailable";
}>;
type RescheduleVerdict = Readonly<{ action: "reschedule"; atMs: number }>;
type ExpireVerdict = Readonly<{ action: "expire" }>;
type UnknownVerdict = Readonly<{
  action: "unknown";
  reason: "input_unavailable" | "assignment_mismatch";
}>;

export type ProductAgentExpiryVerdict =
  ExpireVerdict | RescheduleVerdict | UnknownVerdict | NoopVerdict;

/**
 * What a timer firing while the Product Agent still has a live session, or
 * one recovered after a restart, can decide: proceed, retry shortly, or
 * stand down. Never `unknown` — neither fire-time decision below reads
 * anything that could mark a stored input's identity as stale; that check
 * belongs only to `productAgentExpiryRecoveryVerdict`, below.
 */
export type ProductAgentExpiryFireVerdict =
  NoopVerdict | RescheduleVerdict | ExpireVerdict;

/**
 * What deciding whether to re-arm a recovered reservation can produce.
 * Never `expire`: recovery only ever decides whether a fresh timer may be
 * armed, never that a cancellation should happen immediately.
 */
export type ProductAgentExpiryRecoveryVerdict =
  NoopVerdict | UnknownVerdict | RescheduleVerdict;

/**
 * The decision `armProductAgentExpiry`'s timer makes for a Product Agent
 * that still has a live, in-memory session (`ActiveProductAgentSession`).
 *
 * `sessionIsActive` is the caller's own `activeProductAgentSession ===
 * session` — a timer left over from a session that has since been replaced
 * or closed must never act on it (`noop`, "session_superseded"; this is the
 * guard a naive rewrite drops first, since neither headline behaviour below
 * depends on it). `taskPhase` is
 * `liveTaskRegistry.get(session.taskId)?.agent?.phase`: once the task is no
 * longer `"running"` there is nothing left to expire (`noop`,
 * "task_not_running"). Only once both hold does `mutationInFlight` matter:
 * a mutation already in flight reschedules a short retry rather than racing
 * it or dropping the reservation; otherwise the caller proceeds to cancel
 * the live session.
 */
export function productAgentSessionExpiryVerdict(state: {
  sessionIsActive: boolean;
  taskPhase: ProductTaskAgent["phase"] | undefined;
  mutationInFlight: boolean;
  now: number;
}): ProductAgentExpiryFireVerdict {
  if (!state.sessionIsActive) {
    return { action: "noop", reason: "session_superseded" };
  }
  if (state.taskPhase !== "running") {
    return { action: "noop", reason: "task_not_running" };
  }
  if (state.mutationInFlight) {
    return { action: "reschedule", atMs: state.now + EXPIRY_RETRY_DELAY_MS };
  }
  return { action: "expire" };
}

/**
 * The decision `schedulePersistedProductAgentExpiry`'s timer makes for a
 * Product Agent that has no in-memory session — the timer armed by
 * `productAgentExpiryRecoveryVerdict` after a restart. There is no session
 * object here to be superseded, only the task's live phase: once it stops
 * being `"running"` there is nothing left to expire (`noop`,
 * "task_not_running"). Otherwise, exactly as for the live session: a
 * mutation already in flight reschedules a short retry instead of racing it
 * or dropping the reservation; otherwise the caller proceeds to cancel.
 */
export function persistedProductAgentExpiryVerdict(state: {
  taskPhase: ProductTaskAgent["phase"] | undefined;
  mutationInFlight: boolean;
  now: number;
}): ProductAgentExpiryFireVerdict {
  if (state.taskPhase !== "running") {
    return { action: "noop", reason: "task_not_running" };
  }
  if (state.mutationInFlight) {
    return { action: "reschedule", atMs: state.now + EXPIRY_RETRY_DELAY_MS };
  }
  return { action: "expire" };
}

/**
 * The decision `recoverProductAgentExpiry` makes once, at startup, for
 * whichever task the live registry says was left `"running"`: whether its
 * persisted expiry timer may be re-armed at all.
 *
 * `hasRunningTask`/`storeAvailable` mirror the original's single combined
 * guard (`!task || !productAgentStore`) — either missing and there is
 * nothing to recover (`noop`). `input` is whatever
 * `productAgentStore.load(task.taskId)` produced, with `null` covering both
 * "no file" and "load threw". `assignmentMatches` is the caller's own
 * `productAgentAssignmentMatches(task.agent, input)` result — that helper
 * stays in `main.ts` because it is shared with call sites this decision
 * does not own (it also gates the manual cancel path).
 *
 * A missing input, or one whose assignment binding no longer matches the
 * task the registry says is running, is marked `unknown` and the function
 * stops — it never reaches the final `reschedule`. Re-arming a timer
 * against an input that no longer describes the running assignment would
 * eventually act on the wrong one.
 */
export function productAgentExpiryRecoveryVerdict(state: {
  hasRunningTask: boolean;
  storeAvailable: boolean;
  input: ProductAgentInput | null;
  assignmentMatches: boolean;
  now: number;
}): ProductAgentExpiryRecoveryVerdict {
  if (!state.hasRunningTask || !state.storeAvailable) {
    return {
      action: "noop",
      reason: state.hasRunningTask ? "store_unavailable" : "no_running_task",
    };
  }
  if (!state.input || !state.assignmentMatches) {
    return {
      action: "unknown",
      reason: state.input ? "assignment_mismatch" : "input_unavailable",
    };
  }
  return {
    action: "reschedule",
    atMs: Math.max(state.now, state.input.expiresAt),
  };
}
