export const MODEL_VERSION = "farol-hunt-model/v1" as const;
export const COMMAND_TABLE_VERSION = "farol-hunt-commands/v1" as const;
export const REPLAY_ID = "farol-hunt-replay/v1" as const;
export const BUILD_IDENTITY_PLACEHOLDER =
  "<build-identity-recorded-by-final-runner>" as const;

export const CONTROLLED_SCHEDULE = {
  identity: "farol-hunt/schedule/serial-v1",
  mode: "serial",
  clock: "fixed-1000",
} as const;

export const HUNT_IDENTITY = {
  ownerId: "owner-preview",
  sessionId: "session-a",
  taskId: "task-a",
  turnId: "turn-a",
  generation: 7,
} as const;

export const MAX_EPISODE_LENGTH = 12;
export const SHRINK_BUDGET = 24;

export type SemanticCommand =
  | Readonly<{ kind: "chat.activate_submission" }>
  | Readonly<{ kind: "chat.accept_submission" }>
  | Readonly<{ kind: "chat.append_delta"; sequence: number }>
  | Readonly<{ kind: "chat.request_computer"; callId: string }>
  | Readonly<{
      kind: "chat.resolve_computer";
      ownerId: string;
      sessionId: string;
      taskId: string;
      turnId: string;
      generation: number;
      callId: string;
    }>
  | Readonly<{
      kind: "chat.mark_outcome_unknown";
      reason: "provider_ack_lost" | "connection_lost";
    }>
  | Readonly<{ kind: "chat.cancel" }>
  | Readonly<{ kind: "chat.complete" }>
  | Readonly<{
      kind: "computer.authorize";
      ownerId: string;
      sessionId: string;
      taskId: string;
      turnId: string;
      generation: number;
      callId: string;
      target: "fixture-status" | "other-target";
    }>
  | Readonly<{ kind: "release.admit_work"; workId: string }>
  | Readonly<{ kind: "release.release_work"; workId: string }>
  | Readonly<{ kind: "release.prepare_update"; candidateGeneration: string }>
  | Readonly<{ kind: "release.switch_generation" }>
  | Readonly<{ kind: "release.verify_generation"; accepted: boolean }>;

export type CommandKind = SemanticCommand["kind"];

export const COMMAND_KINDS = [
  "chat.activate_submission",
  "chat.accept_submission",
  "chat.append_delta",
  "chat.request_computer",
  "chat.resolve_computer",
  "chat.mark_outcome_unknown",
  "chat.cancel",
  "chat.complete",
  "computer.authorize",
  "release.admit_work",
  "release.release_work",
  "release.prepare_update",
  "release.switch_generation",
  "release.verify_generation",
] as const satisfies readonly CommandKind[];

export type ModelTurnPhase =
  | "prepared"
  | "submit_activated"
  | "running"
  | "tool_wait"
  | "completed"
  | "cancelled"
  | "failed"
  | "outcome_unknown";

export type ModelTurn = Readonly<{
  phase: ModelTurnPhase;
  terminal: boolean;
  terminalReason: string | null;
  deltaCount: number;
  lastSequence: number;
  outstandingCallId: string | null;
}>;

export type ModelRelease = Readonly<{
  phase: "open" | "draining" | "verifying";
  activeGeneration: string;
  previousGeneration: string | null;
  candidateGeneration: string | null;
  acceptedWork: readonly string[];
  lastOutcome: "none" | "activated" | "rolled_back";
}>;

export type ModelState = Readonly<{
  turn: ModelTurn;
  release: ModelRelease;
  computerExecutions: number;
  visibleDeltaCount: number;
}>;

export type StepResult = Readonly<{
  outcome: "accepted" | "rejected";
  code: string | null;
}>;

export type StateProjection = Readonly<{
  chat: Readonly<{
    phase: ModelTurnPhase;
    terminal: boolean;
    terminalReason: string | null;
    deltaCount: number;
    lastSequence: number;
    outstandingCallId: string | null;
  }>;
  stream: Readonly<{ visibleDeltaCount: number }>;
  computer: Readonly<{ executions: number }>;
  release: Readonly<{
    phase: "open" | "draining" | "verifying";
    activeGeneration: string;
    previousGeneration: string | null;
    candidateGeneration: string | null;
    acceptedWork: readonly string[];
    lastOutcome: "none" | "activated" | "rolled_back";
  }>;
}>;

export type ModelStep = Readonly<{
  command: SemanticCommand;
  state: ModelState;
  result: StepResult;
}>;

export type ScheduleMetadata = Readonly<{
  identity: string;
  mode: "serial";
  clock: "fixed-1000";
}>;

export type SemanticReplay = Readonly<{
  replayId: string;
  modelVersion: string;
  commandTableVersion: string;
  schedule: ScheduleMetadata;
  buildIdentity: string;
  seed: number;
  commands: readonly SemanticCommand[];
}>;

export type Evidence =
  | Readonly<{ status: "PASS" }>
  | Readonly<{
      status: "FAIL";
      invariant: string;
      step: number;
      reason: string;
    }>
  | Readonly<{ status: "UNKNOWN"; reason: string }>;
