import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openEvidenceAttempt } from "../../tooling/evidence-attempt.mjs";
import { EVIDENCE_LANES } from "../../tooling/evidence-cases.mjs";
import { evaluateEligibility } from "../../tooling/evidence-eligibility.mjs";
import {
  countProcesses,
  observeAttempt,
  processTable,
  summarizeSamples,
} from "../../tooling/evidence-observe.mjs";

const roots = [];
const children = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const candidate = Object.freeze({
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  artifactSha256: "c".repeat(64),
});

// The observer asks the kernel for the process table on every sample, and
// under a full parallel suite one answer can take a second. A test that hands
// the observer this deadline must not be killed by the runner's shorter
// default first -- that failure says nothing about the observer -- so the
// suite below allows the deadline plus the work after it.
const OBSERVER_DEADLINE_MS = 30_000;

// The kernel's own process table, read by the observer as always, with the
// moment each read began and whether it listed the marker. A test waits for
// a sighting it needs instead of guessing how long the kernel takes to make
// one: a fixed sleep either wastes time or, under load, misses the process.
function watchedTable(marker) {
  const reads = [];
  return {
    reads,
    table: () => {
      const began = Date.now();
      const listing = processTable();
      reads.push({ began, sighted: listing.includes(marker) });
      return listing;
    },
  };
}

async function until(condition) {
  const deadline = Date.now() + OBSERVER_DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("EV-03/EV-08 effect observer", () => {
  it("counts only the owned processes the kernel lists and tolerates bounded gaps", () => {
    const table = [
      "PID COMMAND",
      "1 /sbin/launchd",
      "42 /Applications/Farol Next Preview.app/Contents/MacOS/Farol Next Preview",
      "43 /Applications/Farol Next Preview.app/Contents/Frameworks/x (Renderer)",
      "",
    ].join("\n");
    expect(countProcesses(/Farol Next Preview/u, table)).toBe(2);
    expect(countProcesses(/Legacy/u, table)).toBe(0);
    expect(
      summarizeSamples(
        [
          { at: "2026-09-18T09:00:00.000Z", processes: 0 },
          { at: "2026-09-18T09:00:00.500Z", processes: 2 },
          { at: "2026-09-18T09:00:03.000Z", processes: 0 },
        ],
        500,
      ),
    ).toMatchObject({ samples: 3, maxGapMs: 2_500, gapTolerated: false });
    expect(
      summarizeSamples(
        [
          { at: "2026-09-18T09:00:00.000Z", processes: 0 },
          { at: "2026-09-18T09:00:01.500Z", processes: 1 },
        ],
        50,
      ),
    ).toMatchObject({ maxGapMs: 1_500, gapTolerated: true });
    // A slow kernel answer is observation time, not a gap.
    expect(
      summarizeSamples(
        [
          { at: "2026-09-18T09:00:00.000Z", durationMs: 2_800, processes: 0 },
          { at: "2026-09-18T09:00:03.000Z", durationMs: 10, processes: 1 },
        ],
        500,
      ),
    ).toMatchObject({ maxGapMs: 200, gapTolerated: true });
  });

  it("binds its receipt to the attempt it watched from before its start until after its terminal receipt, and the verifier accepts exactly that run", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-observe-"),
    );
    roots.push(root);
    const laneRoot = path.join(root, "_output", "evidence", "e2e");
    await fs.mkdir(laneRoot, { recursive: true });
    // A marker only the owned process carries.
    const marker = `farol-observer-marker-${process.pid}`;
    const kernel = watchedTable(marker);
    const observed = observeAttempt({
      laneRoot,
      lane: "sealed-package",
      attemptId: null,
      subject: candidate,
      processPattern: new RegExp(marker, "u"),
      intervalMs: 100,
      timeoutMs: OBSERVER_DEADLINE_MS,
      table: kernel.table,
    });
    // The runner starts after the observer: opens the attempt, runs the
    // "product" (a child process carrying the marker) until the kernel has
    // listed it inside the attempt, writes its report and finishes.
    await until(() => kernel.reads.length > 0);
    const attempt = await openEvidenceAttempt(laneRoot, {
      lane: "sealed-package",
      input: { ...candidate },
    });
    const opened = Date.now();
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)", marker],
      { stdio: "ignore" },
    );
    children.push(child);
    await until(() =>
      kernel.reads.some((read) => read.sighted && read.began > opened),
    );
    await fs.writeFile(
      path.join(attempt.directory, "report.json"),
      JSON.stringify({ status: "PASS" }),
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
    await attempt.finish("PASS", {
      cases: [...EVIDENCE_LANES["sealed-package"].cases],
      productAgentQualification:
        EVIDENCE_LANES["sealed-package"].productAgentQualification,
    });
    await fs.writeFile(
      path.join(attempt.directory, "exit.json"),
      JSON.stringify({
        schema: "farol.next.evidence-attempt/v1",
        attemptId: attempt.attemptId,
        exitCode: 0,
        exitedAt: new Date().toISOString(),
      }),
    );
    const receipt = await observed;

    expect(receipt).toMatchObject({
      lane: "sealed-package",
      attemptId: attempt.attemptId,
      subject: {
        sourceCommit: candidate.sourceCommit,
        artifactSha256: candidate.artifactSha256,
      },
      healthy: true,
      reasons: [],
    });
    expect(receipt.summary.processes.max).toBeGreaterThanOrEqual(1);
    expect(receipt.summary.processes.last).toBe(0);
    expect(receipt.effects.byproducts).toEqual([
      expect.objectContaining({ path: "report.json" }),
    ]);
    expect(receipt.effects.terminalSeenAt).not.toBeNull();

    const { listEvidenceAttempts } =
      await import("../../tooling/evidence-attempt.mjs");
    const [loaded] = await listEvidenceAttempts(laneRoot);
    const review = {
      reviewer: "independent",
      verdict: "ACCEPT",
      subject: { ...candidate },
    };
    expect(
      evaluateEligibility({
        lane: "sealed-package",
        attempt: loaded,
        candidate,
        review,
        observer: receipt,
      }),
    ).toMatchObject({ acceptable: true, reasons: [] });
    // The same receipt says nothing about another attempt or candidate.
    expect(
      evaluateEligibility({
        lane: "sealed-package",
        attempt: { ...loaded, attemptId: "20260918T080000000Z-0000000b" },
        candidate,
        review,
        observer: receipt,
      }).reasons,
    ).toContain("OBSERVER_ATTEMPT_MISMATCH");
  });

  it("is not healthy when it never saw the product's own process, however clean the files it hashed", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-observe-"),
    );
    roots.push(root);
    const laneRoot = path.join(root, "_output", "evidence", "e2e");
    await fs.mkdir(laneRoot, { recursive: true });
    // The runner does start a process, but not one the pattern names: the
    // observer watched the files and never the product.
    const observed = observeAttempt({
      laneRoot,
      lane: "sealed-package",
      attemptId: null,
      subject: candidate,
      processPattern: new RegExp(`farol-observer-absent-${process.pid}`, "u"),
      intervalMs: 100,
      timeoutMs: OBSERVER_DEADLINE_MS,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const attempt = await openEvidenceAttempt(laneRoot, {
      lane: "sealed-package",
      input: { ...candidate },
    });
    const child = spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => {}, 700)",
        `farol-observer-other-${process.pid}`,
      ],
      { stdio: "ignore" },
    );
    children.push(child);
    // Subscribe before any await: under load this short-lived child can exit
    // while the observer samples or the byproduct write is still pending.
    const childClosed = new Promise((resolve) => child.once("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fs.writeFile(
      path.join(attempt.directory, "report.json"),
      JSON.stringify({ status: "PASS" }),
    );
    await childClosed;
    await attempt.finish("PASS", {
      cases: [...EVIDENCE_LANES["sealed-package"].cases],
    });
    const receipt = await observed;

    expect(receipt.attemptId).toBe(attempt.attemptId);
    expect(receipt.effects.terminalSeenAt).not.toBeNull();
    expect(receipt.summary.processes.max).toBe(0);
    expect(receipt.healthy).toBe(false);
    expect(receipt.reasons).toEqual(["PRODUCT_NOT_OBSERVED"]);
  });

  it("does not count a product process that was gone before the attempt it binds had started", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-observe-"),
    );
    roots.push(root);
    const laneRoot = path.join(root, "_output", "evidence", "e2e");
    await fs.mkdir(laneRoot, { recursive: true });
    const marker = `farol-observer-leftover-${process.pid}`;
    const kernel = watchedTable(marker);
    const observed = observeAttempt({
      laneRoot,
      lane: "sealed-package",
      attemptId: null,
      subject: candidate,
      processPattern: new RegExp(marker, "u"),
      intervalMs: 50,
      timeoutMs: OBSERVER_DEADLINE_MS,
      table: kernel.table,
    });
    // A process carrying the product's marker -- a previous run's leftover --
    // is listed by the kernel while the observer already watches and exits,
    // and only then does the attempt this receipt binds open. The attempt
    // itself never runs it.
    const leftover = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)", marker],
      { stdio: "ignore" },
    );
    children.push(leftover);
    await until(() => kernel.reads.some((read) => read.sighted));
    const exited = new Promise((resolve) => leftover.once("exit", resolve));
    leftover.kill("SIGTERM");
    await exited;
    const attempt = await openEvidenceAttempt(laneRoot, {
      lane: "sealed-package",
      input: { ...candidate },
    });
    const opened = Date.now();
    await fs.writeFile(
      path.join(attempt.directory, "report.json"),
      JSON.stringify({ status: "PASS" }),
    );
    await until(() => kernel.reads.some((read) => read.began > opened));
    await attempt.finish("PASS", {
      cases: [...EVIDENCE_LANES["sealed-package"].cases],
    });
    const receipt = await observed;

    expect(receipt.attemptId).toBe(attempt.attemptId);
    // The watch as a whole did see the marker; the attempt's interval did not.
    expect(receipt.summary.processes.max).toBeGreaterThanOrEqual(1);
    expect(receipt.healthy).toBe(false);
    expect(receipt.reasons).toEqual(["PRODUCT_NOT_OBSERVED"]);
  });

  it("reports an unhealthy receipt when no attempt ever appears, and never binds to a run that started before it did", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-observe-"),
    );
    roots.push(root);
    // The lane's pointer names an earlier, already finished attempt.
    const earlier = await openEvidenceAttempt(
      path.join(root, "_output", "evidence", "e2e"),
      { lane: "sealed-package", input: { ...candidate } },
    );
    await fs.writeFile(path.join(earlier.directory, "report.json"), "{}");
    await earlier.finish("PASS", {
      cases: [...EVIDENCE_LANES["sealed-package"].cases],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const receipt = await observeAttempt({
      laneRoot: path.join(root, "_output", "evidence", "e2e"),
      lane: "sealed-package",
      attemptId: null,
      subject: candidate,
      processPattern: /never-matches-anything-here/u,
      intervalMs: 20,
      timeoutMs: 120,
    });
    expect(receipt.healthy).toBe(false);
    expect(receipt.attemptId).toBeNull();
    expect(receipt.reasons).toContain("ATTEMPT_NOT_BOUND");
    expect(receipt.reasons).toContain("TERMINAL_NOT_OBSERVED");
  });
}, 45_000);
