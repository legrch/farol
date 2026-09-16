import {
  acceptSubmission,
  activateSubmission,
  appendDelta,
  cancelTurn,
  completeTurn,
  createTurn,
  markOutcomeUnknown,
  requestComputer,
  resolveComputer,
  type Turn,
} from "../../src/modules/chat/domain/turn";
import {
  authorizeComputerAction,
  createParticipantAuthority,
  deriveTaskGrant,
  type ComputerApproval,
  type ParticipantAuthority,
  type TaskAdmission,
} from "../../src/modules/computer/domain/execution-authority";
import {
  admitWork,
  createReleaseState,
  prepareUpdate,
  releaseWork,
  switchGeneration,
  verifyGeneration,
  type ReleaseState,
} from "../../src/modules/release/domain/generation";
import {
  HUNT_IDENTITY,
  type SemanticCommand,
  type StateProjection,
  type StepResult,
} from "./types";

export type DefectId =
  | "permit_foreign_owner"
  | "replay_unknown_submit"
  | "accept_stale_generation"
  | "buffer_all_text_until_terminal"
  | "apply_update_while_accepted_work_remains";

export const DEFECT_IDS: readonly DefectId[] = [
  "permit_foreign_owner",
  "replay_unknown_submit",
  "accept_stale_generation",
  "buffer_all_text_until_terminal",
  "apply_update_while_accepted_work_remains",
];

export type SystemState = Readonly<{
  turn: Turn;
  release: ReleaseState;
  computerExecutions: number;
  visibleDeltaCount: number;
}>;

const FIXTURE_ROOT = "/farol-next-hunt/fixture";
const COMPUTER_APPROVAL: ComputerApproval = {
  ownerId: HUNT_IDENTITY.ownerId,
  computerId: "hunt-computer",
  generation: 1,
  workspaces: [
    { workspaceId: "hunt-fixture", root: FIXTURE_ROOT, access: "read" },
  ],
  capabilities: ["workspace.read"],
  network: "none",
  commands: "none",
  expiresAt: 2_000,
};
const TASK_ADMISSION: TaskAdmission = {
  authorityId: "hunt-authority",
  ownerId: HUNT_IDENTITY.ownerId,
  sessionId: HUNT_IDENTITY.sessionId,
  taskId: HUNT_IDENTITY.taskId,
  taskEpoch: HUNT_IDENTITY.generation,
  computerId: COMPUTER_APPROVAL.computerId,
  computerGeneration: COMPUTER_APPROVAL.generation,
  workspaces: [
    {
      workspaceId: "hunt-fixture",
      mode: "subtree",
      root: FIXTURE_ROOT,
      access: "read",
    },
  ],
  capabilities: ["workspace.read"],
  network: "none",
  commands: "none",
  expiresAt: 2_000,
};

const FIXED_NOW = 1_000;
const taskGrant = deriveTaskGrant(COMPUTER_APPROVAL, TASK_ADMISSION, FIXED_NOW);
if (!taskGrant.ok) throw new Error("HUNT_TASK_GRANT_INVALID");
const participantAuthority = createParticipantAuthority(taskGrant.value, {
  participantId: "hunt-main",
  role: "main",
  mutationOwnership: "none",
});
if (!participantAuthority.ok) {
  throw new Error("HUNT_PARTICIPANT_AUTHORITY_INVALID");
}
const PARTICIPANT: ParticipantAuthority = participantAuthority.value;

function accepted(): StepResult {
  return { outcome: "accepted", code: null };
}

function toStepResult(
  result: { ok: true } | { ok: false; error: { code: string } },
): StepResult {
  return result.ok
    ? accepted()
    : { outcome: "rejected", code: result.error.code };
}

export function initialSystemState(): SystemState {
  return {
    turn: createTurn(HUNT_IDENTITY),
    release: createReleaseState("generation-a"),
    computerExecutions: 0,
    visibleDeltaCount: 0,
  };
}

function applyComputer(
  state: SystemState,
  command: Extract<SemanticCommand, { kind: "computer.authorize" }>,
  defect: DefectId | undefined,
): Readonly<{ state: SystemState; result: StepResult }> {
  const action = {
    ownerId: command.ownerId,
    sessionId: command.sessionId,
    taskId: command.taskId,
    taskEpoch: command.generation,
    operation: {
      kind: "workspace.read" as const,
      workspaceId: "hunt-fixture",
      path:
        command.target === "fixture-status"
          ? `${FIXTURE_ROOT}/status.txt`
          : "/farol-next-hunt/outside.txt",
    },
  };

  let result = authorizeComputerAction(
    PARTICIPANT,
    COMPUTER_APPROVAL,
    action,
    FIXED_NOW,
  );
  if (
    defect === "permit_foreign_owner" &&
    command.ownerId !== PARTICIPANT.grant.ownerId
  ) {
    result = { ok: true, value: action };
  }
  if (
    defect === "accept_stale_generation" &&
    command.generation !== PARTICIPANT.grant.taskEpoch
  ) {
    result = { ok: true, value: action };
  }

  if (!result.ok) return { state, result: toStepResult(result) };
  return {
    state: { ...state, computerExecutions: state.computerExecutions + 1 },
    result: accepted(),
  };
}

function applyChat(
  state: SystemState,
  command: Extract<SemanticCommand, { kind: `chat.${string}` }>,
  defect: DefectId | undefined,
): Readonly<{ state: SystemState; result: StepResult }> {
  switch (command.kind) {
    case "chat.activate_submission": {
      const result = activateSubmission(state.turn);
      return result.ok
        ? { state: { ...state, turn: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }

    case "chat.accept_submission": {
      if (
        defect === "replay_unknown_submit" &&
        state.turn.phase === "outcome_unknown"
      ) {
        return {
          state: {
            ...state,
            turn: {
              ...state.turn,
              phase: "running",
              terminal: false,
              terminalReason: null,
            },
          },
          result: accepted(),
        };
      }
      const result = acceptSubmission(state.turn);
      return result.ok
        ? { state: { ...state, turn: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }

    case "chat.append_delta": {
      const result = appendDelta(state.turn, command.sequence);
      if (!result.ok) return { state, result: toStepResult(result) };
      const visibleDeltaCount =
        defect === "buffer_all_text_until_terminal"
          ? state.visibleDeltaCount
          : result.value.deltaCount;
      return {
        state: { ...state, turn: result.value, visibleDeltaCount },
        result: accepted(),
      };
    }

    case "chat.request_computer": {
      const result = requestComputer(state.turn, command.callId);
      return result.ok
        ? { state: { ...state, turn: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }

    case "chat.resolve_computer": {
      const result = resolveComputer(state.turn, {
        ownerId: command.ownerId,
        sessionId: command.sessionId,
        taskId: command.taskId,
        turnId: command.turnId,
        generation: command.generation,
        callId: command.callId,
      });
      return result.ok
        ? { state: { ...state, turn: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }

    case "chat.mark_outcome_unknown": {
      const result = markOutcomeUnknown(state.turn, command.reason);
      return result.ok
        ? { state: { ...state, turn: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }

    case "chat.cancel": {
      const result = cancelTurn(state.turn);
      return result.ok
        ? { state: { ...state, turn: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }

    case "chat.complete": {
      const result = completeTurn(state.turn);
      if (!result.ok) return { state, result: toStepResult(result) };
      return {
        state: {
          ...state,
          turn: result.value,
          visibleDeltaCount:
            defect === "buffer_all_text_until_terminal"
              ? result.value.deltaCount
              : state.visibleDeltaCount,
        },
        result: accepted(),
      };
    }
  }
}

function applyRelease(
  state: SystemState,
  command: Extract<SemanticCommand, { kind: `release.${string}` }>,
  defect: DefectId | undefined,
): Readonly<{ state: SystemState; result: StepResult }> {
  const release = state.release;

  switch (command.kind) {
    case "release.admit_work": {
      const result = admitWork(release, command.workId);
      return result.ok
        ? { state: { ...state, release: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }

    case "release.release_work": {
      const result = releaseWork(release, command.workId);
      return result.ok
        ? { state: { ...state, release: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }

    case "release.prepare_update": {
      const result = prepareUpdate(release, command.candidateGeneration);
      return result.ok
        ? { state: { ...state, release: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }

    case "release.switch_generation": {
      if (
        defect === "apply_update_while_accepted_work_remains" &&
        release.phase === "draining" &&
        release.candidateGeneration !== null &&
        release.acceptedWork.length > 0
      ) {
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
      }
      const result = switchGeneration(release);
      return result.ok
        ? { state: { ...state, release: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }

    case "release.verify_generation": {
      const result = verifyGeneration(release, command.accepted);
      return result.ok
        ? { state: { ...state, release: result.value }, result: accepted() }
        : { state, result: toStepResult(result) };
    }
  }
}

export function systemStep(
  state: SystemState,
  command: SemanticCommand,
  defect?: DefectId,
): Readonly<{ state: SystemState; result: StepResult }> {
  if (command.kind.startsWith("chat.")) {
    return applyChat(
      state,
      command as Extract<SemanticCommand, { kind: `chat.${string}` }>,
      defect,
    );
  }
  if (command.kind === "computer.authorize")
    return applyComputer(state, command, defect);
  return applyRelease(
    state,
    command as Extract<SemanticCommand, { kind: `release.${string}` }>,
    defect,
  );
}

export function replaySystem(
  commands: readonly SemanticCommand[],
  defect?: DefectId,
): readonly Readonly<{
  command: SemanticCommand;
  state: SystemState;
  result: StepResult;
}>[] {
  let state = initialSystemState();
  const steps: Readonly<{
    command: SemanticCommand;
    state: SystemState;
    result: StepResult;
  }>[] = [];
  for (const command of commands) {
    const result = systemStep(state, command, defect);
    state = result.state;
    steps.push({ command, state: result.state, result: result.result });
  }
  return steps;
}

export function projectSystemState(state: SystemState): StateProjection {
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
