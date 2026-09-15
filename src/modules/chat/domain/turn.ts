import {
  failure,
  success,
  type Result,
} from "../../../pkg/kernel/domain/result";

export type TurnPhase =
  | "prepared"
  | "submit_activated"
  | "running"
  | "tool_wait"
  | "completed"
  | "cancelled"
  | "failed"
  | "outcome_unknown";

export type TurnErrorCode =
  | "TURN_INVALID_TRANSITION"
  | "TURN_TERMINAL"
  | "TURN_SEQUENCE"
  | "TURN_NO_DELTA"
  | "TURN_CORRELATION";

export type TurnIdentity = Readonly<{
  ownerId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  generation: number;
}>;

export type ComputerCorrelation = TurnIdentity & Readonly<{ callId: string }>;

export type Turn = Readonly<{
  identity: TurnIdentity;
  phase: TurnPhase;
  terminal: boolean;
  terminalReason: string | null;
  deltaCount: number;
  lastSequence: number;
  outstandingCallId: string | null;
}>;

function terminalFailure(turn: Turn): Result<Turn, TurnErrorCode> {
  return turn.terminal
    ? failure("TURN_TERMINAL")
    : failure("TURN_INVALID_TRANSITION");
}

export function createTurn(identity: TurnIdentity): Turn {
  return {
    identity: {
      ownerId: identity.ownerId,
      sessionId: identity.sessionId,
      taskId: identity.taskId,
      turnId: identity.turnId,
      generation: identity.generation,
    },
    phase: "prepared",
    terminal: false,
    terminalReason: null,
    deltaCount: 0,
    lastSequence: 0,
    outstandingCallId: null,
  };
}

export function activateSubmission(turn: Turn): Result<Turn, TurnErrorCode> {
  if (turn.phase !== "prepared") return terminalFailure(turn);
  return success({ ...turn, phase: "submit_activated" });
}

export function acceptSubmission(turn: Turn): Result<Turn, TurnErrorCode> {
  if (turn.phase !== "submit_activated") return terminalFailure(turn);
  return success({ ...turn, phase: "running" });
}

export function appendDelta(
  turn: Turn,
  sequence: number,
): Result<Turn, TurnErrorCode> {
  if (turn.phase !== "running") return terminalFailure(turn);
  if (!Number.isSafeInteger(sequence) || sequence <= turn.lastSequence) {
    return failure("TURN_SEQUENCE");
  }
  return success({
    ...turn,
    deltaCount: turn.deltaCount + 1,
    lastSequence: sequence,
  });
}

export function requestComputer(
  turn: Turn,
  callId: string,
): Result<Turn, TurnErrorCode> {
  if (turn.phase !== "running" || callId.length === 0)
    return terminalFailure(turn);
  return success({ ...turn, phase: "tool_wait", outstandingCallId: callId });
}

function sameIdentity(left: TurnIdentity, right: TurnIdentity): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.sessionId === right.sessionId &&
    left.taskId === right.taskId &&
    left.turnId === right.turnId &&
    left.generation === right.generation
  );
}

export function resolveComputer(
  turn: Turn,
  correlation: ComputerCorrelation,
): Result<Turn, TurnErrorCode> {
  if (turn.terminal) return failure("TURN_TERMINAL");
  if (
    turn.phase !== "tool_wait" ||
    turn.outstandingCallId !== correlation.callId ||
    !sameIdentity(turn.identity, correlation)
  ) {
    return failure("TURN_CORRELATION");
  }
  return success({ ...turn, phase: "running", outstandingCallId: null });
}

export function completeTurn(turn: Turn): Result<Turn, TurnErrorCode> {
  if (turn.terminal) return failure("TURN_TERMINAL");
  if (turn.phase !== "running") return failure("TURN_INVALID_TRANSITION");
  if (turn.deltaCount === 0) return failure("TURN_NO_DELTA");
  return success({
    ...turn,
    phase: "completed",
    terminal: true,
    terminalReason: "completed",
  });
}

export function markOutcomeUnknown(
  turn: Turn,
  reason: string,
): Result<Turn, TurnErrorCode> {
  if (turn.terminal) return failure("TURN_TERMINAL");
  if (turn.phase === "prepared") return failure("TURN_INVALID_TRANSITION");
  return success({
    ...turn,
    phase: "outcome_unknown",
    terminal: true,
    terminalReason: reason,
    outstandingCallId: null,
  });
}

export function failTurn(
  turn: Turn,
  reason: string,
): Result<Turn, TurnErrorCode> {
  if (turn.terminal) return failure("TURN_TERMINAL");
  return success({
    ...turn,
    phase: "failed",
    terminal: true,
    terminalReason: reason,
    outstandingCallId: null,
  });
}

export function cancelTurn(turn: Turn): Result<Turn, TurnErrorCode> {
  if (turn.terminal) return failure("TURN_TERMINAL");
  if (turn.phase === "prepared") {
    return success({
      ...turn,
      phase: "cancelled",
      terminal: true,
      terminalReason: "not_dispatched",
    });
  }
  return markOutcomeUnknown(turn, "cancel_after_dispatch");
}
