import { readFileSync } from "node:fs";
import fc from "fast-check";
import { projectModelState, replayModel } from "./model";
import {
  DEFECT_IDS,
  projectSystemState,
  replaySystem,
  type DefectId,
  type SystemState,
} from "./system";
import type { ModelStep } from "./types";
import {
  BUILD_IDENTITY_PLACEHOLDER,
  COMMAND_KINDS,
  COMMAND_TABLE_VERSION,
  CONTROLLED_SCHEDULE,
  MAX_EPISODE_LENGTH,
  MODEL_VERSION,
  REPLAY_ID,
  SHRINK_BUDGET,
  type CommandKind,
  type Evidence,
  type SemanticCommand,
  type SemanticReplay,
  type StateProjection,
  type StepResult,
} from "./types";

export { DEFECT_IDS, replayModel, replaySystem, SHRINK_BUDGET };
export type { DefectId };

export type SystemStep = Readonly<{
  command: SemanticCommand;
  state: SystemState;
  result: StepResult;
}>;

export const semanticCommandArbitrary: fc.Arbitrary<SemanticCommand> = fc.oneof(
  fc.constant({ kind: "chat.activate_submission" } satisfies SemanticCommand),
  fc.constant({ kind: "chat.accept_submission" } satisfies SemanticCommand),
  fc.integer({ min: 0, max: 8 }).map((sequence): SemanticCommand => ({
    kind: "chat.append_delta",
    sequence,
  })),
  fc.constantFrom("", "call-a", "call-b").map((callId): SemanticCommand => ({
    kind: "chat.request_computer",
    callId,
  })),
  fc
    .record({
      ownerId: fc.constantFrom("owner-preview", "foreign-owner"),
      sessionId: fc.constantFrom("session-a", "session-foreign"),
      taskId: fc.constantFrom("task-a", "task-foreign"),
      turnId: fc.constantFrom("turn-a", "turn-foreign"),
      generation: fc.constantFrom(6, 7, 8),
      callId: fc.constantFrom("call-a", "call-b", "call-foreign"),
    })
    .map((value): SemanticCommand => ({
      kind: "chat.resolve_computer",
      ...value,
    })),
  fc
    .constantFrom("provider_ack_lost", "connection_lost")
    .map((reason): SemanticCommand => ({
      kind: "chat.mark_outcome_unknown",
      reason,
    })),
  fc.constant({ kind: "chat.cancel" } satisfies SemanticCommand),
  fc.constant({ kind: "chat.complete" } satisfies SemanticCommand),
  fc
    .record({
      ownerId: fc.constantFrom("owner-preview", "foreign-owner"),
      sessionId: fc.constantFrom("session-a", "session-foreign"),
      taskId: fc.constantFrom("task-a", "task-foreign"),
      turnId: fc.constantFrom("turn-a", "turn-foreign"),
      generation: fc.constantFrom(6, 7, 8),
      callId: fc.constantFrom("call-a", "call-b"),
      target: fc.constantFrom("fixture-status", "other-target"),
    })
    .map((value): SemanticCommand => ({
      kind: "computer.authorize",
      ...value,
    })),
  fc
    .constantFrom("work-a", "work-b", "work-foreign")
    .map((workId): SemanticCommand => ({ kind: "release.admit_work", workId })),
  fc
    .constantFrom("work-a", "work-b", "work-foreign")
    .map((workId): SemanticCommand => ({
      kind: "release.release_work",
      workId,
    })),
  fc
    .constantFrom("generation-a", "generation-b", "generation-c")
    .map((candidateGeneration): SemanticCommand => ({
      kind: "release.prepare_update",
      candidateGeneration,
    })),
  fc.constant({ kind: "release.switch_generation" } satisfies SemanticCommand),
  fc.boolean().map((accepted): SemanticCommand => ({
    kind: "release.verify_generation",
    accepted,
  })),
);

export const semanticPathArbitrary = fc.array(semanticCommandArbitrary, {
  minLength: 1,
  maxLength: MAX_EPISODE_LENGTH,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid replay field: ${field}`);
  }
  return value;
}

function integerValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid replay field: ${field}`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new Error(`Invalid replay field: ${field}`);
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`Invalid replay field: ${field}`);
  }
  return value as T;
}

export function isSemanticCommand(value: unknown): value is SemanticCommand {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  try {
    parseCommand(value);
    return true;
  } catch {
    return false;
  }
}

export function parseCommand(value: Record<string, unknown>): SemanticCommand {
  const kind = oneOf(value.kind, COMMAND_KINDS, "kind");
  switch (kind) {
    case "chat.activate_submission":
      return { kind };
    case "chat.accept_submission":
      return { kind };
    case "chat.append_delta":
      return { kind, sequence: integerValue(value.sequence, "sequence") };
    case "chat.request_computer":
      return { kind, callId: stringValue(value.callId, "callId") };
    case "chat.resolve_computer":
      return {
        kind,
        ownerId: stringValue(value.ownerId, "ownerId"),
        sessionId: stringValue(value.sessionId, "sessionId"),
        taskId: stringValue(value.taskId, "taskId"),
        turnId: stringValue(value.turnId, "turnId"),
        generation: integerValue(value.generation, "generation"),
        callId: stringValue(value.callId, "callId"),
      };
    case "chat.mark_outcome_unknown":
      return {
        kind,
        reason: oneOf(
          value.reason,
          ["provider_ack_lost", "connection_lost"],
          "reason",
        ),
      };
    case "chat.cancel":
      return { kind };
    case "chat.complete":
      return { kind };
    case "computer.authorize":
      return {
        kind,
        ownerId: stringValue(value.ownerId, "ownerId"),
        sessionId: stringValue(value.sessionId, "sessionId"),
        taskId: stringValue(value.taskId, "taskId"),
        turnId: stringValue(value.turnId, "turnId"),
        generation: integerValue(value.generation, "generation"),
        callId: stringValue(value.callId, "callId"),
        target: oneOf(
          value.target,
          ["fixture-status", "other-target"],
          "target",
        ),
      };
    case "release.admit_work":
      return { kind, workId: stringValue(value.workId, "workId") };
    case "release.release_work":
      return { kind, workId: stringValue(value.workId, "workId") };
    case "release.prepare_update":
      return {
        kind,
        candidateGeneration: stringValue(
          value.candidateGeneration,
          "candidateGeneration",
        ),
      };
    case "release.switch_generation":
      return { kind };
    case "release.verify_generation":
      return { kind, accepted: booleanValue(value.accepted, "accepted") };
  }
}

export function readReplayFixtureText(): string {
  return readFileSync(
    new URL("./fixtures/semantic-replay.json", import.meta.url),
    "utf8",
  );
}

export function readCommittedReplay(): SemanticReplay {
  const raw: unknown = JSON.parse(readReplayFixtureText());
  if (!isRecord(raw)) throw new Error("Replay must be an object");
  if (raw.replayId !== REPLAY_ID) throw new Error("Unexpected replay identity");
  if (raw.modelVersion !== MODEL_VERSION)
    throw new Error("Unexpected model version");
  if (raw.commandTableVersion !== COMMAND_TABLE_VERSION) {
    throw new Error("Unexpected command-table version");
  }
  if (raw.buildIdentity !== BUILD_IDENTITY_PLACEHOLDER) {
    throw new Error("Replay must retain the final-runner build placeholder");
  }
  if (!isRecord(raw.schedule)) throw new Error("Replay schedule is missing");
  if (
    raw.schedule.identity !== CONTROLLED_SCHEDULE.identity ||
    raw.schedule.mode !== CONTROLLED_SCHEDULE.mode ||
    raw.schedule.clock !== CONTROLLED_SCHEDULE.clock
  ) {
    throw new Error("Replay schedule is not controlled");
  }
  const rawCommands = raw.commands;
  if (!Array.isArray(rawCommands) || rawCommands.length === 0) {
    throw new Error("Replay commands are missing");
  }
  const commands = rawCommands.map((command) => {
    if (!isRecord(command)) throw new Error("Replay command must be an object");
    return parseCommand(command);
  });
  return {
    replayId: REPLAY_ID,
    modelVersion: MODEL_VERSION,
    commandTableVersion: COMMAND_TABLE_VERSION,
    schedule: CONTROLLED_SCHEDULE,
    buildIdentity: BUILD_IDENTITY_PLACEHOLDER,
    seed: integerValue(raw.seed, "seed"),
    commands,
  };
}

const SENSITIVE_KEY = /(prompt|answer|secret|path|token)/i;
const SENSITIVE_TEXT = /(prompt|answer|secret|path|token|\/Users\/|bearer\s+)/i;

export function redactEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactEvidence(entry));
  if (isRecord(value)) {
    const clean: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue;
      clean[key] = redactEvidence(entry);
    }
    return clean;
  }
  if (typeof value === "string" && SENSITIVE_TEXT.test(value))
    return "[omitted]";
  return value;
}

export function sanitizedReplayEvidence(
  replay: SemanticReplay,
  steps: readonly (ModelStep | SystemStep)[],
): unknown {
  return redactEvidence({
    replayId: replay.replayId,
    modelVersion: replay.modelVersion,
    commandTableVersion: replay.commandTableVersion,
    schedule: replay.schedule,
    buildIdentity: replay.buildIdentity,
    steps: steps.map((step) => ({
      command: step.command,
      result: step.result,
      state: projectState(step.state),
    })),
  });
}

function projectState(
  state: ModelStep["state"] | SystemState,
): StateProjection {
  if ("identity" in state.turn) return projectSystemState(state as SystemState);
  return projectModelState(state as ModelStep["state"]);
}

export function compareStep(
  model: ModelStep | undefined,
  system: SystemStep | undefined,
  invariant: string,
): Evidence {
  if (model === undefined || system === undefined) {
    return {
      status: "UNKNOWN",
      reason: "the replay did not produce a step for both engines",
    };
  }
  if (model.command.kind !== system.command.kind) {
    return {
      status: "UNKNOWN",
      reason: "the model and system did not consume the same semantic command",
    };
  }
  if (JSON.stringify(model.result) !== JSON.stringify(system.result)) {
    return {
      status: "FAIL",
      invariant,
      step: 0,
      reason: `result mismatch: model=${JSON.stringify(model.result)} system=${JSON.stringify(system.result)}`,
    };
  }
  if (
    JSON.stringify(projectModelState(model.state)) !==
    JSON.stringify(projectSystemState(system.state))
  ) {
    return {
      status: "FAIL",
      invariant,
      step: 0,
      reason: "state projection mismatch",
    };
  }
  return { status: "PASS" };
}

export function compareReplay(
  commands: readonly SemanticCommand[],
  defect: DefectId | undefined,
  invariant: string,
): Evidence {
  const modelSteps = replayModel(commands);
  const systemSteps = replaySystem(commands, defect);
  if (modelSteps.length !== systemSteps.length) {
    return { status: "UNKNOWN", reason: "replay lengths differ" };
  }
  for (let index = 0; index < modelSteps.length; index += 1) {
    const evidence = compareStep(
      modelSteps[index],
      systemSteps[index],
      invariant,
    );
    if (evidence.status !== "PASS") {
      return evidence.status === "FAIL"
        ? { ...evidence, step: index }
        : evidence;
    }
  }
  return { status: "PASS" };
}

function commandVariants(command: SemanticCommand): readonly SemanticCommand[] {
  switch (command.kind) {
    case "chat.append_delta":
      return command.sequence === 1 ? [] : [{ ...command, sequence: 1 }];
    case "chat.resolve_computer":
      return command.generation === 7 ? [] : [{ ...command, generation: 7 }];
    case "computer.authorize":
      return command.generation === 7 ? [] : [{ ...command, generation: 7 }];
    case "release.prepare_update":
      return command.candidateGeneration === "generation-b"
        ? []
        : [{ ...command, candidateGeneration: "generation-b" }];
    case "chat.activate_submission":
    case "chat.accept_submission":
    case "chat.request_computer":
    case "chat.mark_outcome_unknown":
    case "chat.cancel":
    case "chat.complete":
    case "release.admit_work":
    case "release.release_work":
    case "release.switch_generation":
    case "release.verify_generation":
      return [];
  }
}

function shrinkCandidates(
  path: readonly SemanticCommand[],
): readonly SemanticCommand[][] {
  const candidates: SemanticCommand[][] = [];
  for (let index = 0; index < path.length; index += 1) {
    candidates.push([...path.slice(0, index), ...path.slice(index + 1)]);
  }
  for (let index = 0; index < path.length; index += 1) {
    const command = path[index];
    if (command === undefined) continue;
    for (const replacement of commandVariants(command)) {
      candidates.push([
        ...path.slice(0, index),
        replacement,
        ...path.slice(index + 1),
      ]);
    }
  }
  return candidates;
}

export type ShrinkResult = Readonly<{
  path: readonly SemanticCommand[];
  attempts: number;
  budget: number;
}>;

export function shrinkSemanticPath(
  path: readonly SemanticCommand[],
  remainsFailing: (candidate: readonly SemanticCommand[]) => boolean,
  budget = SHRINK_BUDGET,
): ShrinkResult {
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new Error("Shrinker budget must be a non-negative safe integer");
  }
  let current = [...path];
  let attempts = 0;
  let changed = true;
  while (changed && attempts < budget) {
    changed = false;
    for (const candidate of shrinkCandidates(current)) {
      if (attempts >= budget) break;
      attempts += 1;
      if (candidate.length >= current.length) continue;
      if (!remainsFailing(candidate)) continue;
      current = candidate;
      changed = true;
      break;
    }
  }
  return { path: current, attempts, budget };
}

export type MutationCase = Readonly<{
  id: DefectId;
  invariant: string;
  path: readonly SemanticCommand[];
}>;

export const MUTATION_CASES: readonly MutationCase[] = [
  {
    id: "permit_foreign_owner",
    invariant:
      "foreign owner requests are rejected before computer capability execution",
    path: [
      {
        kind: "computer.authorize",
        ownerId: "foreign-owner",
        sessionId: "session-a",
        taskId: "task-a",
        turnId: "turn-a",
        generation: 7,
        callId: "call-a",
        target: "fixture-status",
      },
    ],
  },
  {
    id: "replay_unknown_submit",
    invariant:
      "an outcome-unknown turn is a terminal tombstone and rejects a replayed submit",
    path: [
      { kind: "chat.activate_submission" },
      { kind: "chat.mark_outcome_unknown", reason: "provider_ack_lost" },
      { kind: "chat.accept_submission" },
    ],
  },
  {
    id: "accept_stale_generation",
    invariant: "a computer request from a stale generation is rejected",
    path: [
      {
        kind: "computer.authorize",
        ownerId: "owner-preview",
        sessionId: "session-a",
        taskId: "task-a",
        turnId: "turn-a",
        generation: 6,
        callId: "call-a",
        target: "fixture-status",
      },
    ],
  },
  {
    id: "buffer_all_text_until_terminal",
    invariant: "each accepted text delta is visible before terminal completion",
    path: [
      { kind: "chat.activate_submission" },
      { kind: "chat.accept_submission" },
      { kind: "chat.append_delta", sequence: 1 },
      { kind: "chat.complete" },
    ],
  },
  {
    id: "apply_update_while_accepted_work_remains",
    invariant: "generation update cannot switch while accepted work remains",
    path: [
      { kind: "release.admit_work", workId: "work-a" },
      { kind: "release.prepare_update", candidateGeneration: "generation-b" },
      { kind: "release.switch_generation" },
    ],
  },
];

export function hasKnownCommandKind(kind: string): kind is CommandKind {
  return COMMAND_KINDS.includes(kind as CommandKind);
}

export function isAllowedMutationSet(ids: readonly DefectId[]): boolean {
  return (
    ids.length === DEFECT_IDS.length &&
    ids.every((id, index) => id === DEFECT_IDS[index])
  );
}
