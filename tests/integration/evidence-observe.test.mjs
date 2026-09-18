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
  });

  it("binds its receipt to the attempt it watched from before its start until after its terminal receipt, and the verifier accepts exactly that run", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-observe-"),
    );
    roots.push(root);
    const laneRoot = path.join(root, "artifacts", "e2e");
    await fs.mkdir(laneRoot, { recursive: true });
    // A marker only the owned process carries.
    const marker = `farol-observer-marker-${process.pid}`;
    const observed = observeAttempt({
      laneRoot,
      lane: "sealed-package",
      attemptId: null,
      subject: candidate,
      processPattern: new RegExp(marker, "u"),
      intervalMs: 50,
      timeoutMs: 20_000,
    });
    // The runner starts after the observer: opens the attempt, runs the
    // "product" (a child process carrying the marker), writes its report and
    // finishes.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const attempt = await openEvidenceAttempt(laneRoot, {
      lane: "sealed-package",
      input: { ...candidate },
    });
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 700)", marker],
      { stdio: "ignore" },
    );
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fs.writeFile(
      path.join(attempt.directory, "report.json"),
      JSON.stringify({ status: "PASS" }),
    );
    await new Promise((resolve) => child.once("exit", resolve));
    await attempt.finish("PASS", {
      cases: [...EVIDENCE_LANES["sealed-package"].cases],
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

  it("reports an unhealthy receipt when no attempt ever appears", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-observe-"),
    );
    roots.push(root);
    const receipt = await observeAttempt({
      laneRoot: path.join(root, "artifacts", "e2e"),
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
});
