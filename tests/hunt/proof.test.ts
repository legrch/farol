import { describe, expect, it } from "vitest";
import {
  compareReplay,
  MUTATION_CASES,
  replayModel,
  replaySystem,
  shrinkSemanticPath,
} from "./replay";
import { DEFECT_IDS, type DefectId } from "./system";
import { SHRINK_BUDGET, type Evidence } from "./types";

type MutationStatus = "killed" | "invalid" | "equivalent" | "ignored";

type MutationReport = Readonly<{
  id: DefectId;
  invariant: string;
  status: MutationStatus;
  attempts: number;
  pathLength: number;
  evidence: Evidence;
  samePathWasReplayed: boolean;
}>;

function proveMutation(
  mutation: (typeof MUTATION_CASES)[number],
): MutationReport {
  const baseline = compareReplay(mutation.path, undefined, mutation.invariant);
  if (baseline.status !== "PASS") {
    return {
      id: mutation.id,
      invariant: mutation.invariant,
      status: "invalid",
      attempts: 0,
      pathLength: mutation.path.length,
      evidence: baseline,
      samePathWasReplayed: false,
    };
  }

  const initialDefect = compareReplay(
    mutation.path,
    mutation.id,
    mutation.invariant,
  );
  if (initialDefect.status === "UNKNOWN") {
    return {
      id: mutation.id,
      invariant: mutation.invariant,
      status: "invalid",
      attempts: 0,
      pathLength: mutation.path.length,
      evidence: initialDefect,
      samePathWasReplayed: false,
    };
  }
  if (initialDefect.status === "PASS") {
    return {
      id: mutation.id,
      invariant: mutation.invariant,
      status: "equivalent",
      attempts: 0,
      pathLength: mutation.path.length,
      evidence: initialDefect,
      samePathWasReplayed: true,
    };
  }

  const shrunk = shrinkSemanticPath(
    mutation.path,
    (candidate) =>
      compareReplay(candidate, mutation.id, mutation.invariant).status ===
      "FAIL",
    SHRINK_BUDGET,
  );
  const modelSteps = replayModel(shrunk.path);
  const systemSteps = replaySystem(shrunk.path, mutation.id);
  const samePathWasReplayed =
    JSON.stringify(modelSteps.map((step) => step.command)) ===
    JSON.stringify(systemSteps.map((step) => step.command));
  const shrunkEvidence = compareReplay(
    shrunk.path,
    mutation.id,
    mutation.invariant,
  );

  return {
    id: mutation.id,
    invariant: mutation.invariant,
    status: shrunkEvidence.status === "FAIL" ? "killed" : "ignored",
    attempts: shrunk.attempts,
    pathLength: shrunk.path.length,
    evidence: shrunkEvidence,
    samePathWasReplayed,
  };
}

describe("bounded Hunt mutation proof", () => {
  it(
    "plants and kills exactly the five required defects",
    {
      meta: {
        hunt: { suiteId: "proof", testId: "required-mutations" },
      },
    },
    ({ task }) => {
      expect(MUTATION_CASES.map((mutation) => mutation.id)).toEqual(DEFECT_IDS);

      const reports = MUTATION_CASES.map(proveMutation);
      task.meta.hunt = {
        suiteId: "proof",
        testId: "required-mutations",
        mutation: {
          results: reports.map((report) => ({
            id: report.id,
            status: report.status === "killed" ? "killed" : "survived",
          })),
          shrinkBudget: SHRINK_BUDGET,
        },
      };
      expect(reports).toHaveLength(5);
      expect(reports.map((report) => report.status)).toEqual([
        "killed",
        "killed",
        "killed",
        "killed",
        "killed",
      ]);

      for (const report of reports) {
        expect(report.invariant.length).toBeGreaterThan(0);
        expect(report.samePathWasReplayed).toBe(true);
        expect(report.attempts).toBeLessThanOrEqual(SHRINK_BUDGET);
        expect(report.evidence.status).toBe("FAIL");
        if (report.evidence.status === "FAIL") {
          expect(report.evidence.invariant).toBe(report.invariant);
          expect(report.evidence.step).toBeGreaterThanOrEqual(0);
        }
      }
    },
  );
});
