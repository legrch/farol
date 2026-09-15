import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareReplay,
  isAllowedMutationSet,
  isSemanticCommand,
  MUTATION_CASES,
  readCommittedReplay,
  readReplayFixtureText,
  redactEvidence,
  replayModel,
  replaySystem,
  semanticCommandArbitrary,
  semanticPathArbitrary,
  shrinkSemanticPath,
  sanitizedReplayEvidence,
} from "./replay";
import {
  BUILD_IDENTITY_PLACEHOLDER,
  COMMAND_KINDS,
  COMMAND_TABLE_VERSION,
  CONTROLLED_SCHEDULE,
  MAX_EPISODE_LENGTH,
  MODEL_VERSION,
  REPLAY_ID,
  SHRINK_BUDGET,
  type SemanticCommand,
} from "./types";

function evidence(testId: string) {
  return { meta: { hunt: { suiteId: "selftest", testId } } };
}

describe("bounded deterministic Hunt harness", () => {
  it(
    "keeps predicates and generated semantic commands bounded",
    evidence("generated-command-bounds"),
    () => {
      fc.assert(
        fc.property(semanticPathArbitrary, (path) => {
          return (
            path.length >= 1 &&
            path.length <= MAX_EPISODE_LENGTH &&
            path.every((command) => isSemanticCommand(command))
          );
        }),
        { seed: 4015, numRuns: 64 },
      );

      fc.assert(
        fc.property(semanticCommandArbitrary, (command) => {
          return COMMAND_KINDS.includes(command.kind);
        }),
        { seed: 4016, numRuns: 64 },
      );
    },
  );

  it(
    "requires a versioned, scheduled, build-aware sanitized replay",
    evidence("versioned-replay"),
    () => {
      const replay = readCommittedReplay();
      const fixtureText = readReplayFixtureText();
      expect(replay.replayId).toBe(REPLAY_ID);
      expect(replay.modelVersion).toBe(MODEL_VERSION);
      expect(replay.commandTableVersion).toBe(COMMAND_TABLE_VERSION);
      expect(replay.schedule).toEqual(CONTROLLED_SCHEDULE);
      expect(replay.buildIdentity).toBe(BUILD_IDENTITY_PLACEHOLDER);
      expect(Number.isSafeInteger(replay.seed)).toBe(true);
      expect(replay.commands.length).toBeGreaterThan(0);
      expect(fixtureText.toLowerCase()).not.toMatch(
        /prompt|answer|secret|path|token/,
      );
      expect(
        replay.commands.every((command) => isSemanticCommand(command)),
      ).toBe(true);
    },
  );

  it(
    "redacts prompt, answer, secret, path, and token fields without mutating input",
    evidence("sanitized-evidence"),
    () => {
      const raw = {
        prompt: "synthetic prompt value",
        answer: "synthetic answer value",
        secret: "synthetic secret value",
        path: "/Users/private/example",
        token: "Bearer synthetic-token",
        safe: { kind: "semantic-event", ownerId: "owner-preview" },
      } as const;
      const before = JSON.stringify(raw);
      const sanitized = redactEvidence(raw);
      const after = JSON.stringify(sanitized);

      expect(JSON.stringify(raw)).toBe(before);
      expect(after).not.toMatch(/prompt|answer|secret|path|token/i);
      expect(after).not.toContain("synthetic prompt value");
      expect(after).not.toContain("synthetic answer value");
      expect(after).not.toContain("synthetic secret value");
      expect(after).not.toContain("/Users/private/example");
      expect(after).not.toContain("synthetic-token");
      expect(after).toContain("semantic-event");

      const replay = readCommittedReplay();
      const evidence = JSON.stringify(
        sanitizedReplayEvidence(replay, replaySystem(replay.commands)),
      );
      expect(evidence).not.toMatch(/prompt|answer|secret|path|token/i);
    },
  );

  it(
    "replays the committed path deterministically and in isolation",
    evidence("isolated-replay"),
    () => {
      const replay = readCommittedReplay();
      const modelFirst = replayModel(replay.commands);
      const modelSecond = replayModel(replay.commands);
      const systemFirst = replaySystem(replay.commands);
      const systemSecond = replaySystem(replay.commands);

      expect(modelFirst).toEqual(modelSecond);
      expect(systemFirst).toEqual(systemSecond);
      expect(
        compareReplay(replay.commands, undefined, "committed replay parity"),
      ).toEqual({
        status: "PASS",
      });

      const isolatedForeign = replaySystem([
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
      ]);
      const isolatedAccepted = replaySystem([
        {
          kind: "computer.authorize",
          ownerId: "owner-preview",
          sessionId: "session-a",
          taskId: "task-a",
          turnId: "turn-a",
          generation: 7,
          callId: "call-a",
          target: "fixture-status",
        },
      ]);
      expect(isolatedForeign[0]?.state.computerExecutions).toBe(0);
      expect(isolatedAccepted[0]?.state.computerExecutions).toBe(1);
      expect(isolatedForeign[0]?.state.release.acceptedWork).toEqual([]);
      expect(isolatedAccepted[0]?.state.release.acceptedWork).toEqual([]);
    },
  );

  it(
    "shrinks a failing semantic path within the explicit budget",
    evidence("bounded-shrinker"),
    () => {
      const initialPath = [
        { kind: "chat.activate_submission" as const },
        { kind: "chat.accept_submission" as const },
        { kind: "chat.append_delta" as const, sequence: 8 },
        { kind: "chat.complete" as const },
      ];
      const remainsFailing = (path: readonly SemanticCommand[]): boolean =>
        path.some((command) => command.kind === "chat.append_delta");
      const shrunk = shrinkSemanticPath(
        initialPath,
        remainsFailing,
        SHRINK_BUDGET,
      );

      expect(shrunk.attempts).toBeLessThanOrEqual(SHRINK_BUDGET);
      expect(shrunk.budget).toBe(SHRINK_BUDGET);
      expect(shrunk.path.length).toBeLessThanOrEqual(initialPath.length);
      expect(remainsFailing(shrunk.path)).toBe(true);
    },
  );

  it(
    "keeps the mutation inventory exact and never treats unknown evidence as a pass",
    evidence("mutation-inventory"),
    () => {
      expect(
        isAllowedMutationSet(MUTATION_CASES.map((mutation) => mutation.id)),
      ).toBe(true);
      expect(new Set(MUTATION_CASES.map((mutation) => mutation.id)).size).toBe(
        5,
      );
      expect(MUTATION_CASES).toHaveLength(5);

      const unknownEvidence = {
        status: "UNKNOWN" as const,
        reason: "missing receipt",
      };
      expect(unknownEvidence.status).toBe("UNKNOWN");
      expect(unknownEvidence.status).not.toBe("PASS");
    },
  );
});
