// The two limitations §5 of the model-lifecycle deep check named, proven
// where each one actually lives.
//
// A budget cancels the WAIT, not the producer: a launch that missed its
// budget can still hand over a live application afterwards. And the budget's
// timer is unref'd, so a process with nothing referenced left exits before it
// fires — a path a fake scheduler can never exercise, because the fake
// scheduler is what keeps the test alive.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  AwaitStalledError,
  createPhaseRecorder,
} from "../e2e/await-phases.mjs";

const run = promisify(execFile);
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function laneRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farol-phase-exit-"));
  roots.push(root);
  return root;
}

/** A stand-in for what `electron.launch` hands over: a closable process. */
function ownedApplication(name) {
  return {
    name,
    closed: false,
    async close() {
      this.closed = true;
    },
  };
}

function manualBudgets() {
  const pending = [];
  return {
    pending,
    schedule: (callback) => {
      const handle = { callback, cancelled: false };
      pending.push(handle);
      return handle;
    },
    cancel: (handle) => {
      handle.cancelled = true;
    },
    fireLast: () => pending.at(-1).callback(),
  };
}

/** Let every already-resolved continuation run, without a timer. */
async function drainMicrotasks() {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("late success after a timed-out launch", () => {
  it("registers the late application, closes it, and touches nothing else", async () => {
    const lines = [];
    const budgets = manualBudgets();
    const recorder = createPhaseRecorder({
      sink: (line) => lines.push(line),
      schedule: budgets.schedule,
      cancel: budgets.cancel,
    });

    // A second instance, from another boundary of the same lane, that this
    // one must not touch.
    const other = ownedApplication("other-run");
    await recorder.step(
      "launch[other/hidden].electron.launch",
      1_000,
      () => other,
      {
        dispose: (late) => late.close(),
      },
    );

    let handOver;
    const late = ownedApplication("late-run");
    const stalled = recorder.step(
      "launch[demo/hidden].electron.launch",
      60_000,
      () => new Promise((resolve) => (handOver = resolve)),
      { dispose: (application) => application.close() },
    );
    budgets.fireLast();
    await expect(stalled).rejects.toBeInstanceOf(AwaitStalledError);

    // Registered while the producer is still running: the receipt written at
    // this instant says a resource is outstanding, not that all is well.
    expect(recorder.snapshot().abandoned).toMatchObject([
      {
        name: "launch[demo/hidden].electron.launch",
        state: "awaiting-late-result",
        held: true,
      },
    ]);
    expect(late.closed).toBe(false);

    handOver(late);
    const stillHeld = await recorder.drainLateResults(1_000);

    expect(late.closed).toBe(true);
    expect(other.closed).toBe(false);
    expect(stillHeld).toEqual([]);
    expect(recorder.snapshot().abandoned).toMatchObject([
      { state: "late-result-disposed", held: false },
    ]);
    expect(lines.some((line) => line.includes("late-result-disposed"))).toBe(
      true,
    );
  });

  it("keeps an unfinished resource recorded when the release does not complete", async () => {
    const budgets = manualBudgets();
    const recorder = createPhaseRecorder({
      sink: () => {},
      schedule: budgets.schedule,
      cancel: budgets.cancel,
    });
    let handOver;
    const stalled = recorder.step(
      "launch[demo/hidden].electron.launch",
      60_000,
      () => new Promise((resolve) => (handOver = resolve)),
      { dispose: () => new Promise(() => {}), disposeBudgetMs: 5_000 },
    );
    budgets.fireLast();
    await expect(stalled).rejects.toBeInstanceOf(AwaitStalledError);
    handOver(ownedApplication("unreleasable"));
    await drainMicrotasks();
    // The release budget is the last one scheduled; firing it is the release
    // failing to finish, not the wait failing again.
    budgets.fireLast();
    await drainMicrotasks();

    const [unknown] = recorder.snapshot().abandoned;
    expect(unknown).toMatchObject({
      state: "late-result-unknown",
      held: true,
    });
    expect(await recorder.drainLateResults(0)).toHaveLength(1);
  });

  it("holds a late value it was given no way to release, rather than guessing", async () => {
    const budgets = manualBudgets();
    const recorder = createPhaseRecorder({
      sink: () => {},
      schedule: budgets.schedule,
      cancel: budgets.cancel,
    });
    let handOver;
    const stalled = recorder.step(
      "launch[demo/hidden].firstWindow",
      60_000,
      () => new Promise((resolve) => (handOver = resolve)),
    );
    budgets.fireLast();
    await expect(stalled).rejects.toBeInstanceOf(AwaitStalledError);
    handOver({ some: "page" });
    await drainMicrotasks();
    expect(recorder.snapshot().abandoned).toMatchObject([
      { state: "late-result-held", held: true },
    ]);
  });

  it("records a producer that failed on its own as holding nothing", async () => {
    const budgets = manualBudgets();
    const recorder = createPhaseRecorder({
      sink: () => {},
      schedule: budgets.schedule,
      cancel: budgets.cancel,
    });
    let fail;
    const stalled = recorder.step(
      "launch[demo/hidden].electron.launch",
      60_000,
      () => new Promise((resolve, reject) => (fail = reject)),
      { dispose: (late) => late.close() },
    );
    budgets.fireLast();
    await expect(stalled).rejects.toBeInstanceOf(AwaitStalledError);
    fail(new Error("Electron exited"));
    await drainMicrotasks();
    expect(recorder.snapshot().abandoned).toMatchObject([
      { state: "late-result-rejected", held: false },
    ]);
    expect(await recorder.drainLateResults(0)).toEqual([]);
  });
});

describe("a real process whose only timer is the unref'd budget", () => {
  const child = path.resolve("tests/integration/fixtures/phase-exit-child.mjs");

  it("exits on its own and still leaves a truthful receipt naming the open boundary", async () => {
    const root = laneRoot();
    const startedAt = Date.now();
    const { stdout } = await run(process.execPath, [child, root, "stalled"]);
    const elapsedMs = Date.now() - startedAt;

    // The budget in the fixture is 600 s. A process that waited for it would
    // not be back yet; this is the whole point of the unref'd timer.
    expect(elapsedMs).toBeLessThan(30_000);
    const attemptId = /CHILD_ATTEMPT (\S+)/u.exec(stdout)[1];
    const directory = path.join(root, "attempts", attemptId);
    const terminal = JSON.parse(
      fs.readFileSync(path.join(directory, "terminal.json"), "utf8"),
    );
    const exit = JSON.parse(
      fs.readFileSync(path.join(directory, "exit.json"), "utf8"),
    );

    expect(terminal.status).toBe("FAIL");
    expect(terminal.firstFailure.message).toContain(
      "EVIDENCE_EXIT_WITHOUT_TERMINAL_RECEIPT",
    );
    expect(terminal.phases.lastCompleted.name).toBe(
      "launch[demo/hidden].electron.launch",
    );
    expect(terminal.phases.inFlight).toMatchObject([
      { name: "launch[demo/hidden].firstWindow" },
    ]);
    expect(typeof terminal.phases.inFlight[0].elapsedMs).toBe("number");
    expect(Number.isInteger(exit.exitCode)).toBe(true);
  });

  it("does not keep a process alive once every boundary has been crossed", async () => {
    const root = laneRoot();
    const startedAt = Date.now();
    const { stdout } = await run(process.execPath, [child, root, "complete"]);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(30_000);
    const attemptId = /CHILD_ATTEMPT (\S+)/u.exec(stdout)[1];
    const terminal = JSON.parse(
      fs.readFileSync(
        path.join(root, "attempts", attemptId, "terminal.json"),
        "utf8",
      ),
    );
    expect(terminal.phases.inFlight).toEqual([]);
    expect(terminal.phases.lastCompleted.name).toBe(
      "launch[demo/hidden].electron.launch",
    );
  });
});
