import {
  HUNT_IDENTITY,
  type ModelRelease,
  type ModelState,
  type ModelStep,
  type ModelTurn,
  type SemanticCommand,
  type StateProjection,
  type StepResult,
} from "./types";

const FIXTURE_GRANT = {
  ownerId: HUNT_IDENTITY.ownerId,
  sessionId: HUNT_IDENTITY.sessionId,
  taskId: HUNT_IDENTITY.taskId,
  generation: HUNT_IDENTITY.generation,
  expiresAt: 2_000,
} as const;

const FIXED_NOW = 1_000;

function accepted(): StepResult {
  return { outcome: "accepted", code: null };
}

function rejected(code: string): StepResult {
  return { outcome: "rejected", code };
}

function terminalOrInvalid(turn: ModelTurn): StepResult {
  return turn.terminal
    ? rejected("TURN_TERMINAL")
    : rejected("TURN_INVALID_TRANSITION");
}

function sameIdentity(
  turn: ModelTurn,
  command: Extract<SemanticCommand, { kind: "chat.resolve_computer" }>,
): boolean {
  return (
    command.ownerId === HUNT_IDENTITY.ownerId &&
    command.sessionId === HUNT_IDENTITY.sessionId &&
    command.taskId === HUNT_IDENTITY.taskId &&
    command.turnId === HUNT_IDENTITY.turnId &&
    command.generation === HUNT_IDENTITY.generation &&
    turn.outstandingCallId === command.callId
  );
}

function createModelTurn(): ModelTurn {
  return {
    phase: "prepared",
    terminal: false,
    terminalReason: null,
    deltaCount: 0,
    lastSequence: 0,
    outstandingCallId: null,
  };
}

function createModelRelease(): ModelRelease {
  return {
    phase: "open",
    activeGeneration: "generation-a",
    previousGeneration: null,
    candidateGeneration: null,
    acceptedWork: [],
    lastOutcome: "none",
  };
}

export function initialModelState(): ModelState {
  return {
    turn: createModelTurn(),
    release: createModelRelease(),
    computerExecutions: 0,
    visibleDeltaCount: 0,
  };
}

function applyChat(
  state: ModelState,
  command: Extract<SemanticCommand, { kind: `chat.${string}` }>,
): Readonly<{ state: ModelState; result: StepResult }> {
  const turn = state.turn;

  switch (command.kind) {
    case "chat.activate_submission":
      if (turn.phase !== "prepared") {
        return { state, result: terminalOrInvalid(turn) };
      }
      return {
        state: { ...state, turn: { ...turn, phase: "submit_activated" } },
        result: accepted(),
      };

    case "chat.accept_submission":
      if (turn.phase !== "submit_activated") {
        return { state, result: terminalOrInvalid(turn) };
      }
      return {
        state: { ...state, turn: { ...turn, phase: "running" } },
        result: accepted(),
      };

    case "chat.append_delta":
      if (turn.phase !== "running") {
        return { state, result: terminalOrInvalid(turn) };
      }
      if (
        !Number.isSafeInteger(command.sequence) ||
        command.sequence <= turn.lastSequence
      ) {
        return { state, result: rejected("TURN_SEQUENCE") };
      }
      return {
        state: {
          ...state,
          turn: {
            ...turn,
            deltaCount: turn.deltaCount + 1,
            lastSequence: command.sequence,
          },
          visibleDeltaCount: state.visibleDeltaCount + 1,
        },
        result: accepted(),
      };

    case "chat.request_computer":
      if (turn.phase !== "running" || command.callId.length === 0) {
        return { state, result: terminalOrInvalid(turn) };
      }
      return {
        state: {
          ...state,
          turn: {
            ...turn,
            phase: "tool_wait",
            outstandingCallId: command.callId,
          },
        },
        result: accepted(),
      };

    case "chat.resolve_computer":
      if (turn.terminal) return { state, result: rejected("TURN_TERMINAL") };
      if (turn.phase !== "tool_wait" || !sameIdentity(turn, command)) {
        return { state, result: rejected("TURN_CORRELATION") };
      }
      return {
        state: {
          ...state,
          turn: { ...turn, phase: "running", outstandingCallId: null },
        },
        result: accepted(),
      };

    case "chat.mark_outcome_unknown":
      if (turn.terminal || turn.phase === "prepared") {
        return { state, result: terminalOrInvalid(turn) };
      }
      return {
        state: {
          ...state,
          turn: {
            ...turn,
            phase: "outcome_unknown",
            terminal: true,
            terminalReason: command.reason,
            outstandingCallId: null,
          },
        },
        result: accepted(),
      };

    case "chat.cancel":
      if (turn.terminal) return { state, result: rejected("TURN_TERMINAL") };
      if (turn.phase === "prepared") {
        return {
          state: {
            ...state,
            turn: {
              ...turn,
              phase: "cancelled",
              terminal: true,
              terminalReason: "not_dispatched",
            },
          },
          result: accepted(),
        };
      }
      return {
        state: {
          ...state,
          turn: {
            ...turn,
            phase: "outcome_unknown",
            terminal: true,
            terminalReason: "cancel_after_dispatch",
            outstandingCallId: null,
          },
        },
        result: accepted(),
      };

    case "chat.complete":
      if (turn.terminal) return { state, result: rejected("TURN_TERMINAL") };
      if (turn.phase !== "running") {
        return { state, result: rejected("TURN_INVALID_TRANSITION") };
      }
      if (turn.deltaCount === 0) {
        return { state, result: rejected("TURN_NO_DELTA") };
      }
      return {
        state: {
          ...state,
          turn: {
            ...turn,
            phase: "completed",
            terminal: true,
            terminalReason: "completed",
          },
        },
        result: accepted(),
      };
  }
}

function applyComputer(
  state: ModelState,
  command: Extract<SemanticCommand, { kind: "computer.authorize" }>,
): Readonly<{ state: ModelState; result: StepResult }> {
  if (command.ownerId !== FIXTURE_GRANT.ownerId) {
    return { state, result: rejected("COMPUTER_OWNER_MISMATCH") };
  }
  if (command.sessionId !== FIXTURE_GRANT.sessionId) {
    return { state, result: rejected("COMPUTER_SESSION_MISMATCH") };
  }
  if (command.taskId !== FIXTURE_GRANT.taskId) {
    return { state, result: rejected("COMPUTER_TASK_MISMATCH") };
  }
  if (command.generation !== FIXTURE_GRANT.generation) {
    return { state, result: rejected("COMPUTER_STALE_GENERATION") };
  }
  if (FIXED_NOW > FIXTURE_GRANT.expiresAt) {
    return { state, result: rejected("COMPUTER_GRANT_EXPIRED") };
  }
  if (command.target !== "fixture-status") {
    return { state, result: rejected("COMPUTER_TARGET_DENIED") };
  }
  return {
    state: { ...state, computerExecutions: state.computerExecutions + 1 },
    result: accepted(),
  };
}

function applyRelease(
  state: ModelState,
  command: Extract<SemanticCommand, { kind: `release.${string}` }>,
): Readonly<{ state: ModelState; result: StepResult }> {
  const release = state.release;

  switch (command.kind) {
    case "release.admit_work":
      if (release.phase !== "open")
        return { state, result: rejected("RELEASE_CLOSED") };
      if (release.acceptedWork.includes(command.workId)) {
        return { state, result: rejected("RELEASE_DUPLICATE_WORK") };
      }
      return {
        state: {
          ...state,
          release: {
            ...release,
            acceptedWork: [...release.acceptedWork, command.workId],
          },
        },
        result: accepted(),
      };

    case "release.release_work":
      if (!release.acceptedWork.includes(command.workId)) {
        return { state, result: rejected("RELEASE_UNKNOWN_WORK") };
      }
      return {
        state: {
          ...state,
          release: {
            ...release,
            acceptedWork: release.acceptedWork.filter(
              (workId) => workId !== command.workId,
            ),
          },
        },
        result: accepted(),
      };

    case "release.prepare_update":
      if (release.phase !== "open") {
        return { state, result: rejected("RELEASE_INVALID_PHASE") };
      }
      if (release.activeGeneration === command.candidateGeneration) {
        return { state, result: rejected("RELEASE_SAME_GENERATION") };
      }
      return {
        state: {
          ...state,
          release: {
            ...release,
            phase: "draining",
            candidateGeneration: command.candidateGeneration,
          },
        },
        result: accepted(),
      };

    case "release.switch_generation":
      if (
        release.phase !== "draining" ||
        release.candidateGeneration === null
      ) {
        return { state, result: rejected("RELEASE_INVALID_PHASE") };
      }
      if (release.acceptedWork.length > 0) {
        return { state, result: rejected("RELEASE_DRAIN_REQUIRED") };
      }
      return {
        state: {
          ...state,
          release: {
            ...release,
            phase: "verifying",
            previousGeneration: release.activeGeneration,
            activeGeneration: release.candidateGeneration,
          },
        },
        result: accepted(),
      };

    case "release.verify_generation":
      if (
        release.phase !== "verifying" ||
        release.previousGeneration === null
      ) {
        return { state, result: rejected("RELEASE_INVALID_PHASE") };
      }
      return {
        state: {
          ...state,
          release: {
            ...release,
            phase: "open",
            activeGeneration: command.accepted
              ? release.activeGeneration
              : release.previousGeneration,
            previousGeneration: null,
            candidateGeneration: null,
            lastOutcome: command.accepted ? "activated" : "rolled_back",
          },
        },
        result: accepted(),
      };
  }
}

export function modelStep(
  state: ModelState,
  command: SemanticCommand,
): ModelStep {
  const result = command.kind.startsWith("chat.")
    ? applyChat(
        state,
        command as Extract<SemanticCommand, { kind: `chat.${string}` }>,
      )
    : command.kind === "computer.authorize"
      ? applyComputer(state, command)
      : applyRelease(
          state,
          command as Extract<SemanticCommand, { kind: `release.${string}` }>,
        );
  return { command, state: result.state, result: result.result };
}

export function replayModel(
  commands: readonly SemanticCommand[],
): readonly ModelStep[] {
  let state = initialModelState();
  const steps: ModelStep[] = [];
  for (const command of commands) {
    const step = modelStep(state, command);
    steps.push(step);
    state = step.state;
  }
  return steps;
}

export function projectModelState(state: ModelState): StateProjection {
  return {
    chat: {
      phase: state.turn.phase,
      terminal: state.turn.terminal,
      terminalReason: state.turn.terminalReason,
      deltaCount: state.turn.deltaCount,
      lastSequence: state.turn.lastSequence,
      outstandingCallId: state.turn.outstandingCallId,
    },
    stream: { visibleDeltaCount: state.visibleDeltaCount },
    computer: { executions: state.computerExecutions },
    release: {
      phase: state.release.phase,
      activeGeneration: state.release.activeGeneration,
      previousGeneration: state.release.previousGeneration,
      candidateGeneration: state.release.candidateGeneration,
      acceptedWork: [...state.release.acceptedWork],
      lastOutcome: state.release.lastOutcome,
    },
  };
}

export function modelInvariantViolations(step: ModelStep): readonly string[] {
  const violations: string[] = [];
  const { turn, release } = step.state;
  const terminalPhases = new Set(["completed", "cancelled", "outcome_unknown"]);

  if (turn.terminal !== terminalPhases.has(turn.phase)) {
    violations.push("terminal flag must match the closed turn phases");
  }
  if (turn.deltaCount < 0 || turn.lastSequence < 0) {
    violations.push("delta counters must remain non-negative");
  }
  if (step.state.visibleDeltaCount !== turn.deltaCount) {
    violations.push(
      "every accepted delta must be visible before terminal completion",
    );
  }
  if (release.phase === "verifying" && release.acceptedWork.length > 0) {
    violations.push("generation switching requires an empty accepted-work set");
  }
  if (release.phase === "open" && release.candidateGeneration !== null) {
    violations.push("an open release cannot retain a candidate generation");
  }
  return violations;
}
