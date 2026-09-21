import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AwaitStalledError,
  STALL_PREFIX,
  createPhaseRecorder,
} from "../e2e/await-phases.mjs";
import { openEvidenceAttempt } from "../../tooling/evidence-attempt.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function laneRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farol-phase-lane-"));
  roots.push(root);
  return root;
}

/**
 * A recorder whose budget is fired by the test rather than by the clock, so
 * a stall is proven without waiting for one.
 */
function recorderWithManualBudget(lines) {
  const pending = [];
  const recorder = createPhaseRecorder({
    sink: (line) => lines.push(line),
    schedule: (callback) => {
      const handle = { callback };
      pending.push(handle);
      return handle;
    },
    cancel: (handle) => {
      handle.cancelled = true;
    },
  });
  return { recorder, fireBudgets: () => pending.map((h) => h.callback()) };
}

describe("awaited-boundary phases", () => {
  it("records a crossed boundary and hands back its value", async () => {
    const lines = [];
    const recorder = createPhaseRecorder({ sink: (line) => lines.push(line) });
    expect(
      await recorder.step("launch.firstWindow", 1_000, () => "window"),
    ).toBe("window");
    expect(lines.map((line) => line.split(" ").slice(0, 4).join(" "))).toEqual([
      "E2E_PHASE begin #1 launch.firstWindow",
      "E2E_PHASE end #1 launch.firstWindow",
    ]);
    expect(recorder.snapshot()).toMatchObject({
      crossed: 1,
      lastCompleted: { seq: 1, name: "launch.firstWindow" },
      inFlight: [],
    });
  });

  it("names the stalled boundary when an await never settles", async () => {
    const lines = [];
    const { recorder, fireBudgets } = recorderWithManualBudget(lines);
    const stalled = recorder.step(
      "launch[demo/hidden].firstWindow",
      60_000,
      () => new Promise(() => {}),
    );
    // The boundary is open and reportable while it is still open — which is
    // the whole point: a receipt written now can say what the lane is on.
    expect(recorder.snapshot().inFlight).toMatchObject([
      { seq: 1, name: "launch[demo/hidden].firstWindow" },
    ]);
    fireBudgets();
    await expect(stalled).rejects.toThrow(
      `${STALL_PREFIX}:launch[demo/hidden].firstWindow after 60000ms`,
    );
    await stalled.catch((error) => {
      expect(error).toBeInstanceOf(AwaitStalledError);
      expect(error.phase).toBe("launch[demo/hidden].firstWindow");
      expect(error.budgetMs).toBe(60_000);
    });
    // The fail line carries the stall; the line after it is the producer
    // being adopted, which is a different fact about the same boundary.
    expect(
      lines.filter(
        (line) => line.includes(" fail ") && line.includes(`${STALL_PREFIX}:`),
      ),
    ).toHaveLength(1);
    expect(recorder.snapshot().inFlight).toEqual([]);
    expect(recorder.snapshot().abandoned).toMatchObject([
      {
        name: "launch[demo/hidden].firstWindow",
        state: "awaiting-late-result",
      },
    ]);
  });

  it("passes an application's own death through untouched", async () => {
    const { recorder } = recorderWithManualBudget([]);
    await expect(
      recorder.step("close.applicationClose", 60_000, () => {
        throw new Error("Target page, context or browser has been closed");
      }),
    ).rejects.toThrow("Target page, context or browser has been closed");
  });

  it("keeps counting boundaries across a failure", async () => {
    const { recorder } = recorderWithManualBudget([]);
    await recorder.step("a", 10, () => true);
    await expect(
      recorder.step("b", 10, () => Promise.reject(new Error("no"))),
    ).rejects.toThrow("no");
    await recorder.step("c", 10, () => true);
    expect(recorder.snapshot()).toMatchObject({
      crossed: 3,
      lastCompleted: { seq: 3, name: "c" },
      inFlight: [],
    });
  });
});

describe("a lane that cannot finish still writes a terminal receipt", () => {
  it("carries the last completed boundary and the one in flight", async () => {
    const root = laneRoot();
    const attempt = await openEvidenceAttempt(root, {
      lane: "development-build",
      input: { runner: { pid: process.pid } },
    });
    const lines = [];
    const { recorder } = recorderWithManualBudget(lines);
    attempt.trackPhases(() => recorder.snapshot());
    await recorder.step(
      "launch[demo/hidden].electron.launch",
      60_000,
      () => true,
    );
    // Left open on purpose: this is the state a watchdog's SIGTERM finds.
    void recorder.step(
      "launch[demo/hidden].firstWindow",
      60_000,
      () => new Promise(() => {}),
    );
    attempt.recordFailure("runner", "EVIDENCE_LANE_SIGNALLED:SIGTERM");
    const terminal = attempt.finishSync("FAIL", {
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(terminal.status).toBe("FAIL");
    expect(terminal.signal).toBe("SIGTERM");
    expect(terminal.firstFailure.message).toContain("SIGTERM");
    expect(terminal.phases.lastCompleted.name).toBe(
      "launch[demo/hidden].electron.launch",
    );
    expect(terminal.phases.inFlight).toMatchObject([
      { name: "launch[demo/hidden].firstWindow" },
    ]);
    expect(typeof terminal.phases.inFlight[0].elapsedMs === "number").toBe(
      true,
    );
    const onDisk = JSON.parse(
      fs.readFileSync(
        path.join(root, "attempts", attempt.attemptId, "terminal.json"),
        "utf8",
      ),
    );
    expect(onDisk.phases).toEqual(terminal.phases);
  });

  it("records no phases at all rather than inventing one", async () => {
    const root = laneRoot();
    const attempt = await openEvidenceAttempt(root, {
      lane: "development-build",
      input: {},
    });
    expect(attempt.finishSync("FAIL", { exitCode: 1 }).phases).toBeNull();
  });
});
