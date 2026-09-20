// The lifecycle soak's budget statistic fits one line across the whole
// measured window, and that window contains two application restarts. These
// cover the additional reading only: it must describe the generations
// honestly and must never be able to change a verdict.
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { retentionDiagnostics } from "../../tooling/soak-retention.mjs";

const e2eSource = fs.readFileSync(
  path.resolve("tests/e2e/preview.e2e.mjs"),
  "utf8",
);

// One synthetic run shaped like the saved ones: three generations of 3/5/3
// samples, each warming from the same floor and reset by a restart, with a
// small, deliberate carry-over across the cycle.
function point(batch, pid, total, extra = {}) {
  return {
    batch,
    workingSetSizeKiB: total,
    processCount: 2,
    fileDescriptorCount: 190,
    activeResourceCount: 9,
    windowCount: 1,
    webContentsCount: 1,
    taskViewCount: 0,
    processMetrics: [
      { pid, type: "Browser", workingSetSizeKiB: total - 60_000 },
      {
        pid: pid + 1,
        type: "Utility",
        name: "Farol Next Runtime",
        workingSetSizeKiB: 60_000,
      },
    ],
    ...extra,
  };
}

const run = {
  baseline: point(0, 100, 540_000),
  samples: [
    point(1, 100, 545_000),
    point(2, 100, 550_000),
    point(3, 200, 545_100),
    point(4, 200, 575_100),
    point(5, 200, 605_100),
    point(6, 200, 635_100),
    point(7, 200, 665_100),
    point(8, 300, 545_200),
    point(9, 300, 575_200),
    point(10, 300, 605_200),
  ],
  recoveryEvents: [
    { batch: 3, kind: "application-restart" },
    { batch: 8, kind: "application-restart" },
  ],
};

describe("the soak's additional retention reading", () => {
  const diagnostics = retentionDiagnostics(run);

  it("splits the window at each restart, by the process identity that changed", () => {
    expect(diagnostics.restartsInsideMeasuredWindow).toBe(2);
    expect(diagnostics.generationCount).toBe(3);
    expect(diagnostics.generations.map((g) => g.sampleCount)).toEqual([
      3, 5, 3,
    ]);
    expect(diagnostics.generations.map((g) => g.browserPid)).toEqual([
      100, 200, 300,
    ]);
  });

  it("reports a trend only for a generation with enough points", () => {
    const [first, second, third] = diagnostics.generations;
    expect(first.workingSetSlopeKiBPerBatch).toBe(null);
    expect(third.workingSetSlopeKiBPerBatch).toBe(null);
    expect(second.workingSetSlopeKiBPerBatch).toBe(30_000);
    expect(diagnostics.longestGenerationSampleCount).toBe(5);
  });

  it("compares the same phase either side of a restart, not across one", () => {
    const samePhase = diagnostics.samePhaseAcrossRestart;
    expect(samePhase.previousBrowserPid).toBe(200);
    expect(samePhase.latestBrowserPid).toBe(300);
    expect(samePhase.comparedPoints).toBe(3);
    // 100 KiB carried across the whole cycle, not the ~100 MiB of warm-up the
    // single fitted line would have reported.
    expect(samePhase.workingSetDeltaKiB).toEqual([100, 100, 100]);
    expect(samePhase.meanWorkingSetDeltaKiB).toBe(100);
    expect(samePhase.meanPerBatchKiB).toBe(20);
  });

  it("attributes the carry-over to the processes that hold it", () => {
    const perProcess = diagnostics.samePhaseAcrossRestart.perProcessDeltaKiB;
    expect(perProcess["Browser"].mean).toBe(100);
    expect(perProcess["Utility:Farol Next Runtime"].mean).toBe(0);
  });

  it("survives a run with no restart at all", () => {
    const flat = retentionDiagnostics({
      baseline: point(0, 100, 540_000),
      samples: [point(1, 100, 545_000), point(2, 100, 550_000)],
    });
    expect(flat.generationCount).toBe(1);
    expect(flat.restartsInsideMeasuredWindow).toBe(0);
    expect(flat.samePhaseAcrossRestart).toBe(null);
    expect(flat.longestGenerationSlopeKiBPerBatch).toBe(null);
  });
});

describe("the soak lane's verdict", () => {
  it("still judges the original statistic against the original budget", () => {
    expect(e2eSource).toContain("workingSetSlopeKiBPerBatch: 8 * 1_024,");
    expect(e2eSource).toMatch(
      /workingSetSlopeKiBPerBatch: \{\s*measured: workingSetSlopeKiBPerBatch,\s*budget: lifecycleSoakBudget\.workingSetSlopeKiBPerBatch,\s*\}/u,
    );
  });

  it("keeps the additional reading out of every verdict and failure list", () => {
    const verdicts = e2eSource.slice(
      e2eSource.indexOf("const budgetVerdicts = {"),
      e2eSource.indexOf("const budgetFailures = "),
    );
    expect(verdicts).not.toContain("retentionDiagnostics");
    const failures = e2eSource.slice(
      e2eSource.indexOf("const budgetFailures = "),
    );
    expect(failures.slice(0, 200)).not.toContain("retentionDiagnostics");
  });
});
