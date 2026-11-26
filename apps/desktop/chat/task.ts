import type { z } from "zod";
import type { ChatGptPageObservation } from "../../../src/apps/desktop/chatgpt-page-policy";
import { appBindingFailureCode } from "./policy";
import type {
  activatedTaskSchema,
  appBindingSchema,
  preparedTaskSchema,
} from "./probe";

// The pure decisions of a ChatGPT submission, taken from the facts the route
// has just read. The route keeps every await, every read of the live window
// and every side effect, and calls these where the inline checks stood.
//
// One rule runs through all of them: the moment a send may have left, no
// failure is a statement that nothing was sent. Before that moment a refusal
// is `failed_before_submit`; from the moment the click is requested, a throw,
// an unreadable acknowledgement or a lost page is `outcome_unknown`, and only
// the page's own in-page refusal (which touched nothing) takes the phase back.
// Nothing here retries, and nothing turns an unknown outcome into a known one.

export type TaskProfile =
  "ordinary" | "temporary-instant" | "connector-instant";

export type SubmissionPhase =
  "not_attempted" | "awaiting_acknowledgement" | "submitted";

// Budgets ------------------------------------------------------------------

export const MANUAL_SUBMISSION_BUDGET_MS = 15_000;
export const DEFAULT_TASK_TIMEOUT_MS = 180_000;
export const SUBMIT_WINDOW_MS = 5_000;
export const DEFAULT_TASK_POLL_MS = 250;
// A reply is complete only after this many consecutive stable polls.
export const STABLE_POLLS_REQUIRED = 3;

// A manual diagnostic ends at the click acknowledgement, so it gets a short
// budget; every other task, and every observation, gets the configured one.
export function taskDeadline(
  now: number,
  manualSubmissionOnly: boolean,
  taskTimeoutMs: number | undefined,
): number {
  return (
    now +
    (manualSubmissionOnly
      ? MANUAL_SUBMISSION_BUDGET_MS
      : (taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS))
  );
}

// Rounded up: a timer armed with a fractional delay is truncated, so it could
// fire while a fractional monotonic reading is still just below the deadline.
export function remainingMs(deadline: number, now: number): number {
  return Math.max(0, Math.ceil(deadline - now));
}

// One poll's wait for a probe: never longer than a poll, never past the
// deadline.
export function probeWaitMs(
  pollMs: number,
  deadline: number,
  now: number,
): number {
  return Math.min(pollMs, remainingMs(deadline, now));
}

// A content-free elapsed time for the diagnostic; a clock that ran backwards
// or produced a non-finite value reports nothing.
export function connectorTimingElapsed(
  start: number,
  now: number,
): number | null {
  const elapsed = now - start;
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  return Math.round(elapsed);
}

// The call shape ---------------------------------------------------------------

export type TaskCallFacts = Readonly<{
  profile: TaskProfile;
  hasAppTarget: boolean;
  attachmentCount: number;
  connectionCheck: boolean;
  manualDeepTest: boolean;
  manualSubmissionOnly: boolean;
  hasConnectorReceipt: boolean;
}>;

// A connection check is exactly one temporary-instant, app-bound call without
// attachments or manual flags, and a manual submission is exactly a manual deep
// test with an app target, no attachments and no connector receipt. Any other
// mix is refused before anything is touched.
export function taskCallRefusal(
  facts: TaskCallFacts,
): "CHATGPT_SUBMIT_UNAVAILABLE" | null {
  if (
    facts.connectionCheck &&
    (facts.profile !== "temporary-instant" ||
      !facts.hasAppTarget ||
      facts.attachmentCount !== 0 ||
      !facts.hasConnectorReceipt ||
      facts.manualDeepTest ||
      facts.manualSubmissionOnly)
  )
    return "CHATGPT_SUBMIT_UNAVAILABLE";
  if (
    facts.manualSubmissionOnly &&
    (!facts.manualDeepTest ||
      !facts.hasAppTarget ||
      facts.attachmentCount !== 0 ||
      facts.hasConnectorReceipt)
  )
    return "CHATGPT_SUBMIT_UNAVAILABLE";
  return null;
}

export function isValidAppTargetName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u.test(name);
}

export function taskInProgressRefusal(
  facts: Readonly<{ updateAdmission: boolean; taskInFlight: boolean }>,
): "CHATGPT_TASK_IN_PROGRESS" | null {
  return facts.updateAdmission || facts.taskInFlight
    ? "CHATGPT_TASK_IN_PROGRESS"
    : null;
}

// Readiness ------------------------------------------------------------------------

export type ReadinessRefusal =
  | Readonly<{ state: "not_authenticated"; code: "CHATGPT_SIGN_IN_REQUIRED" }>
  | Readonly<{
      state: "failed_before_submit";
      code: "CHATGPT_PAGE_UNREACHABLE" | "CHATGPT_UI_UNRECOGNIZED";
    }>;

// The first read after the page opens: an unreachable page keeps its own code.
export function initialReadinessRefusal(
  readiness: ChatGptPageObservation,
): ReadinessRefusal | null {
  if (readiness.state === "signed_out")
    return { state: "not_authenticated", code: "CHATGPT_SIGN_IN_REQUIRED" };
  if (readiness.state !== "authenticated")
    return {
      state: "failed_before_submit",
      code:
        readiness.code === "CHATGPT_PAGE_UNREACHABLE"
          ? "CHATGPT_PAGE_UNREACHABLE"
          : "CHATGPT_UI_UNRECOGNIZED",
    };
  return null;
}

// Every later read of the same question, including the one that stands in for
// a read that is missing or stale: anything but a signed-out page is an
// unrecognized one.
export function readinessRefusal(
  state: ChatGptPageObservation["state"] | undefined,
): ReadinessRefusal {
  return state === "signed_out"
    ? { state: "not_authenticated", code: "CHATGPT_SIGN_IN_REQUIRED" }
    : { state: "failed_before_submit", code: "CHATGPT_UI_UNRECOGNIZED" };
}

// A connector profile never reports a missing temporary chat as such: the
// check reads it as an interface it does not recognize.
export function instantProfileFailureCode<Code extends string>(
  profile: TaskProfile,
  failure: Code,
): Code | "CHATGPT_UI_UNRECOGNIZED" {
  return profile === "connector-instant" &&
    failure === "CHATGPT_TEMPORARY_CHAT_REQUIRED"
    ? "CHATGPT_UI_UNRECOGNIZED"
    : failure;
}

// The app binding ---------------------------------------------------------------

type AppBinding = z.infer<typeof appBindingSchema>;

export type AppBindingRefusalCode =
  | "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT"
  | ReturnType<typeof appBindingFailureCode>;

// The binding made before the composer is touched. A page that moved, or an
// app that cannot be bound, refuses; a bound app proceeds.
export function appBindingRefusal(
  binding: AppBinding,
): AppBindingRefusalCode | null {
  if (binding.state === "navigated")
    return "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT";
  if (binding.state === "blocked") return appBindingFailureCode(binding.reason);
  return null;
}

// The verification made immediately before Send. An app whose selection is
// gone, or not yet observed, is a lost selection rather than a missing one.
export function appVerificationRefusal(
  binding: AppBinding,
): AppBindingRefusalCode | null {
  if (binding.state === "navigated")
    return "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT";
  if (binding.state === "blocked")
    return binding.reason === "missing" ||
      binding.reason === "selection_not_observed"
      ? "CHATGPT_APP_SELECTION_LOST"
      : appBindingFailureCode(binding.reason);
  return null;
}

// The prepared composer ---------------------------------------------------------

type Prepared = z.infer<typeof preparedTaskSchema>;
export type PreparedSnapshot = Extract<Prepared, { ready: boolean }>;

export type PreparedDecision =
  // The page itself refused before typing anything.
  | Readonly<{
      kind: "refused";
      code:
        | "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT"
        | "CHATGPT_APP_SELECTION_LOST"
        | "CHATGPT_COMPOSER_DRAFT_PRESENT";
    }>
  // The composer is not ready, or an explicit check has no text fence.
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; task: PreparedSnapshot }>;

export function preparedTaskDecision(
  prepared: Prepared,
  facts: Readonly<{ requiresComposerText: boolean }>,
): PreparedDecision {
  if ("navigated" in prepared)
    return { kind: "refused", code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT" };
  if ("appSelectionLost" in prepared)
    return { kind: "refused", code: "CHATGPT_APP_SELECTION_LOST" };
  if ("draftPresent" in prepared)
    return { kind: "refused", code: "CHATGPT_COMPOSER_DRAFT_PRESENT" };
  if (!prepared.ready) return { kind: "unavailable" };
  if (facts.requiresComposerText && prepared.preparedComposerText === undefined)
    return { kind: "unavailable" };
  return { kind: "ready", task: prepared };
}

// The Send click ------------------------------------------------------------------

type Activated = z.infer<typeof activatedTaskSchema>;

export type ActivationDecision =
  // The page declined to click and says so: nothing was submitted. This is the
  // only statement that takes the phase back to `not_attempted`.
  | Readonly<{
      kind: "refused";
      code:
        | "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT"
        | "CHATGPT_APP_SELECTION_LOST"
        | "CHATGPT_INSTANT_MODEL_REQUIRED"
        | "CHATGPT_COMPOSER_DRAFT_PRESENT";
    }>
  | Readonly<{ kind: "activated" }>
  // No click and no refusal: the control was not ready yet.
  | Readonly<{ kind: "not_activated" }>;

export function activationDecision(activated: Activated): ActivationDecision {
  if ("navigated" in activated)
    return { kind: "refused", code: "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT" };
  if ("appSelectionLost" in activated)
    return { kind: "refused", code: "CHATGPT_APP_SELECTION_LOST" };
  if ("profileLost" in activated)
    return { kind: "refused", code: "CHATGPT_INSTANT_MODEL_REQUIRED" };
  if ("draftPresent" in activated)
    return { kind: "refused", code: "CHATGPT_COMPOSER_DRAFT_PRESENT" };
  return activated.activated
    ? { kind: "activated" }
    : { kind: "not_activated" };
}

export function submissionMayHaveOccurred(phase: SubmissionPhase): boolean {
  return phase === "awaiting_acknowledgement" || phase === "submitted";
}

export function isTaskDocumentUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "ChatGPT task document unavailable"
  );
}

// What a throw becomes. A throw once the click was requested is unknown, and a
// page that disappeared under it says so; before that it is a refusal.
export function taskThrowOutcome(
  facts: Readonly<{ phase: SubmissionPhase; documentChanged: boolean }>,
):
  | Readonly<{
      state: "outcome_unknown";
      code: "CHATGPT_TASK_PAGE_LOST" | "CHATGPT_TASK_ERROR";
    }>
  | Readonly<{
      state: "failed_before_submit";
      code:
        "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT" | "CHATGPT_SUBMIT_UNAVAILABLE";
    }> {
  if (submissionMayHaveOccurred(facts.phase))
    return {
      state: "outcome_unknown",
      code: facts.documentChanged
        ? "CHATGPT_TASK_PAGE_LOST"
        : "CHATGPT_TASK_ERROR",
    };
  return {
    state: "failed_before_submit",
    code: facts.documentChanged
      ? "CHATGPT_TASK_NAVIGATED_BEFORE_SUBMIT"
      : "CHATGPT_SUBMIT_UNAVAILABLE",
  };
}

// The conversation a submission owns -----------------------------------------------

// A submission made from the home page is allowed exactly one transition, to
// the conversation it creates. Once pinned, any other conversation, or the home
// page again, is a page this submission does not own.
export function pinnedConversationAfter(
  pinned: string | null,
  current: string | null,
): Readonly<{ lost: true }> | Readonly<{ lost: false; pinned: string | null }> {
  if (pinned === null) return { lost: false, pinned: current };
  if (current !== pinned) return { lost: true };
  return { lost: false, pinned };
}

// The one allowed transition: from no conversation to the one an allowed
// ChatGPT page now shows.
export function conversationCreatedBySubmission(
  pinned: string | null,
  created: string | null,
  pageAllowed: boolean,
): boolean {
  return pinned === null && created !== null && pageAllowed;
}

// A page that changed address across an await, other than by creating its
// conversation, is a page the submission lost.
export function pageLostAcrossAwait(
  before: string,
  after: string,
  createdConversation: boolean,
): boolean {
  return after !== before && !createdConversation;
}

// What a probe says -------------------------------------------------------------------

type ProbeSignals = Readonly<{
  signInVisible: boolean;
  errorVisible: boolean;
  errorKind: "none" | "usage_limited" | "generic";
}>;

// A visible sign-in or error ends a submitted task as unknown: the send may
// already have been accepted.
export function submittedProbeFailureCode(
  probe: ProbeSignals,
):
  | "CHATGPT_TASK_PAGE_LOST"
  | "CHATGPT_USAGE_LIMITED"
  | "CHATGPT_TASK_ERROR"
  | null {
  if (!probe.signInVisible && !probe.errorVisible) return null;
  if (probe.signInVisible) return "CHATGPT_TASK_PAGE_LOST";
  return probe.errorKind === "usage_limited"
    ? "CHATGPT_USAGE_LIMITED"
    : "CHATGPT_TASK_ERROR";
}

// The same signals when only observing an already-sent turn: a sign-in is then
// reported as such.
export function observedProbeFailureCode(
  probe: ProbeSignals,
):
  | "CHATGPT_SIGN_IN_REQUIRED"
  | "CHATGPT_USAGE_LIMITED"
  | "CHATGPT_TASK_ERROR"
  | null {
  if (!probe.signInVisible && !probe.errorVisible) return null;
  if (probe.signInVisible) return "CHATGPT_SIGN_IN_REQUIRED";
  return probe.errorKind === "usage_limited"
    ? "CHATGPT_USAGE_LIMITED"
    : "CHATGPT_TASK_ERROR";
}

export type CorrelationStep =
  | Readonly<{ kind: "none" | "keep" | "changed" }>
  | Readonly<{ kind: "adopt"; id: string; userId: string }>;

// The first sight of the user's turn is adopted; afterwards another user turn
// is a changed output.
export function userCorrelation(
  probeUserId: string | null,
  correlatedUserId: string | null,
): CorrelationStep {
  if (probeUserId === null) return { kind: "none" };
  if (correlatedUserId === null)
    return { kind: "adopt", id: probeUserId, userId: probeUserId };
  return { kind: probeUserId === correlatedUserId ? "keep" : "changed" };
}

// An assistant turn counts only beside the user turn already correlated, and,
// once adopted, never changes.
export function assistantCorrelation(
  probeUserId: string | null,
  probeAssistantId: string | null,
  correlatedUserId: string | null,
  correlatedAssistantId: string | null,
): CorrelationStep {
  if (probeAssistantId === null) return { kind: "none" };
  if (probeUserId === null || probeUserId !== correlatedUserId)
    return { kind: "changed" };
  if (correlatedAssistantId === null)
    return { kind: "adopt", id: probeAssistantId, userId: probeUserId };
  return {
    kind: probeAssistantId === correlatedAssistantId ? "keep" : "changed",
  };
}

// Observing an already-sent turn: the user turn is known, so a probe that has
// not reached it, or has no assistant turn yet, only waits.
export type ObservedTurnDecision =
  | Readonly<{ kind: "wait" }>
  | Readonly<{ kind: "changed" }>
  | Readonly<{ kind: "adopt" | "keep"; assistantId: string }>;

export function observedTurnDecision(
  probeUserId: string | null,
  probeAssistantId: string | null,
  inputUserId: string,
  correlatedAssistantId: string | null,
): ObservedTurnDecision {
  if (probeUserId !== inputUserId) return { kind: "wait" };
  if (probeAssistantId === null) return { kind: "wait" };
  if (correlatedAssistantId === null)
    return { kind: "adopt", assistantId: probeAssistantId };
  return probeAssistantId === correlatedAssistantId
    ? { kind: "keep", assistantId: probeAssistantId }
    : { kind: "changed" };
}

export function observationAdmissionRefusal(
  facts: Readonly<{
    updateAdmission: boolean;
    taskInFlight: boolean;
    turnUserId: string;
    prompt: string;
  }>,
): "CHATGPT_TASK_IN_PROGRESS" | "CHATGPT_TASK_OUTPUT_CHANGED" | null {
  if (facts.updateAdmission || facts.taskInFlight)
    return "CHATGPT_TASK_IN_PROGRESS";
  if (!facts.turnUserId || !facts.prompt) return "CHATGPT_TASK_OUTPUT_CHANGED";
  return null;
}

export function observedReadinessCode(
  state: ChatGptPageObservation["state"],
): "CHATGPT_SIGN_IN_REQUIRED" | "CHATGPT_UI_UNRECOGNIZED" {
  return state === "signed_out"
    ? "CHATGPT_SIGN_IN_REQUIRED"
    : "CHATGPT_UI_UNRECOGNIZED";
}

// The reply text --------------------------------------------------------------------

export type TextGrowth =
  // The page shows what is already recorded.
  | "unchanged"
  // The page shows less than is recorded: a transient shorter read.
  | "regressed"
  // The page shows text that is no extension of what is recorded.
  | "diverged"
  | "grew";

export function textGrowth(observed: string, shown: string): TextGrowth {
  if (shown === observed) return "unchanged";
  if (observed.startsWith(shown)) return "regressed";
  if (!shown.startsWith(observed)) return "diverged";
  return "grew";
}

// Semantic output: each answer item joins the answer with a blank line.
export function appendAnswerItem(answer: string, text: string): string {
  return `${answer}${answer ? "\n\n" : ""}${text}`;
}

export function nextStablePolls(
  facts: Readonly<{
    grew: boolean;
    correlated: boolean;
    observedCharacters: number;
    busy: boolean;
    sendVisible: boolean;
    stablePolls: number;
  }>,
): number {
  if (facts.grew) return 0;
  return facts.correlated &&
    facts.observedCharacters > 0 &&
    !facts.busy &&
    facts.sendVisible
    ? facts.stablePolls + 1
    : 0;
}

export function textTurnCompleted(
  facts: Readonly<{
    accepted: boolean;
    correlated: boolean;
    observedCharacters: number;
    sendVisible: boolean;
    stablePolls: number;
  }>,
): boolean {
  return (
    facts.accepted &&
    facts.correlated &&
    facts.observedCharacters > 0 &&
    facts.sendVisible &&
    facts.stablePolls >= STABLE_POLLS_REQUIRED
  );
}
