import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareStep,
  readCommittedReplay,
  replayModel,
  replaySystem,
  semanticPathArbitrary,
} from "./replay";
import { modelInvariantViolations } from "./model";
import { MAX_EPISODE_LENGTH } from "./types";

describe("independent Hunt model episodes", () => {
  it("checks model invariants after every command in short deterministic episodes", () => {
    const replay = readCommittedReplay();
    const firstEpisodes = fc.sample(semanticPathArbitrary, {
      seed: replay.seed,
      numRuns: 32,
    });
    const secondEpisodes = fc.sample(semanticPathArbitrary, {
      seed: replay.seed,
      numRuns: 32,
    });
    expect(firstEpisodes).toEqual(secondEpisodes);

    for (const [episodeIndex, commands] of firstEpisodes.entries()) {
      expect(commands.length).toBeGreaterThanOrEqual(1);
      expect(commands.length).toBeLessThanOrEqual(MAX_EPISODE_LENGTH);
      const modelSteps = replayModel(commands);
      const systemSteps = replaySystem(commands);
      expect(modelSteps).toHaveLength(commands.length);
      expect(systemSteps).toHaveLength(commands.length);

      for (let stepIndex = 0; stepIndex < commands.length; stepIndex += 1) {
        const modelStep = modelSteps[stepIndex];
        const systemStep = systemSteps[stepIndex];
        if (modelStep === undefined || systemStep === undefined) {
          throw new Error(
            `UNKNOWN evidence insufficiency at episode ${episodeIndex}, step ${stepIndex}: missing replay step`,
          );
        }
        expect(modelInvariantViolations(modelStep)).toEqual([]);

        const evidence = compareStep(
          modelStep,
          systemStep,
          "model state and pure API state remain equivalent after each command",
        );
        if (evidence.status === "UNKNOWN") {
          throw new Error(
            `UNKNOWN evidence insufficiency at episode ${episodeIndex}, step ${stepIndex}: ${evidence.reason}`,
          );
        }
        if (evidence.status === "FAIL") {
          throw new Error(
            `Model invariant failure at episode ${episodeIndex}, step ${stepIndex}: ${evidence.reason}`,
          );
        }
        expect(evidence.status).toBe("PASS");
      }
    }
  });
});
