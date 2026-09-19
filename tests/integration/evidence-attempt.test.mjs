import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listEvidenceAttempts,
  openEvidenceAttempt,
} from "../../tooling/evidence-attempt.mjs";
import { EVIDENCE_LANES } from "../../tooling/evidence-cases.mjs";
import { evaluateEligibility } from "../../tooling/evidence-eligibility.mjs";

const nextRoot = path.resolve(import.meta.dirname, "../..");
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function laneRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-evidence-"));
  roots.push(root);
  return path.join(root, "artifacts", "e2e-dev");
}

const input = Object.freeze({
  sourceCommit: "a".repeat(40),
  sourceTreeDigest: "b".repeat(64),
  artifactSha256: "c".repeat(64),
});

// A child process opens attempt B in the same lane and dies by SIGKILL, the
// way a crashed runner does: no terminal receipt, no cleanup.
function crashInChild(lane) {
  const program = `
import { openEvidenceAttempt } from ${JSON.stringify(
    path.join(nextRoot, "tooling/evidence-attempt.mjs"),
  )};
const attempt = await openEvidenceAttempt(process.argv[1], {
  lane: "development-build",
  input: {},
});
await import("node:fs/promises").then((fs) =>
  fs.writeFile(attempt.directory + "/partial.png", Buffer.alloc(2048, 1)),
);
process.kill(process.pid, "SIGKILL");
`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program, lane],
    { encoding: "utf8" },
  );
}

function runnerInChild(lane, body) {
  const program = `
import { openEvidenceAttempt } from ${JSON.stringify(
    path.join(nextRoot, "tooling/evidence-attempt.mjs"),
  )};
const attempt = await openEvidenceAttempt(process.argv[1], {
  lane: "sealed-package",
  input: {},
});
attempt.installProcessHandlers();
${body}
`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", program, lane],
    { encoding: "utf8" },
  );
}

describe("EV-04 immutable evidence attempts", () => {
  it("records the first uncaught runner failure as the terminal outcome", async () => {
    const lane = await laneRoot();
    const thrown = runnerInChild(
      lane,
      'await Promise.resolve(); throw new Error("E2E_TOP_LEVEL_FAILURE");',
    );
    expect(thrown.status).toBe(1);
    const exited = runnerInChild(lane, "process.exit(0);");
    expect(exited.status).toBe(0);

    const [failed, silent] = await listEvidenceAttempts(lane);
    expect(failed.status).toBe("FAIL");
    expect(failed.terminal.firstFailure).toEqual({
      case: "uncaught",
      message: "Error: E2E_TOP_LEVEL_FAILURE",
    });
    expect(failed.terminal.exitCode).toBe(1);
    expect(failed.exit).toMatchObject({ exitCode: 1 });
    expect(silent.exit).toMatchObject({ exitCode: 0 });
    expect(silent.status).toBe("FAIL");
    expect(silent.terminal.firstFailure).toEqual({
      case: "runner",
      message: "EVIDENCE_EXIT_WITHOUT_TERMINAL_RECEIPT",
    });
  });

  it("keeps a failed attempt addressable after a later attempt starts and crashes", async () => {
    const lane = await laneRoot();
    const first = await openEvidenceAttempt(lane, {
      lane: "development-build",
      input,
    });
    await fs.writeFile(
      path.join(first.directory, "failure-wide.png"),
      Buffer.alloc(4096, 7),
    );
    first.recordFailure(
      "provider-failure",
      new Error("E2E_FIRST_FAILURE\nsecond line is dropped"),
    );
    await first.finish("FAIL", { cases: ["b-case", "a-case", "b-case"] });
    const firstDirectory = first.directory;

    const second = await openEvidenceAttempt(lane, {
      lane: "development-build",
      input,
    });
    expect(second.directory).not.toBe(firstDirectory);
    expect(
      (await fs.readFile(path.join(firstDirectory, "failure-wide.png"))).length,
    ).toBe(4096);
    await second.finish("PASS", { cases: ["a-case"] });

    const crashed = crashInChild(lane);
    expect(crashed.signal).toBe("SIGKILL");

    const third = await openEvidenceAttempt(lane, {
      lane: "development-build",
      input,
    });
    await third.finish("BLOCKED", { cases: [] });

    const attempts = await listEvidenceAttempts(lane);
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "FAIL",
      "PASS",
      "INTERRUPTED",
      "BLOCKED",
    ]);
    const [failed, , interrupted, latest] = attempts;
    expect(failed.terminal.firstFailure).toEqual({
      case: "provider-failure",
      message: "Error: E2E_FIRST_FAILURE",
    });
    expect(failed.terminal.cases).toEqual({
      raw: ["b-case", "a-case", "b-case"],
      normalized: ["a-case", "b-case"],
    });
    expect(failed.terminal.byproducts).toEqual([
      {
        path: "failure-wide.png",
        bytes: 4096,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    ]);
    expect(interrupted.interrupted).toMatchObject({
      observedBy: latest.attemptId,
      reason: "owner-process-gone",
    });
    expect(latest.started.previousAttempt).toEqual({
      attemptId: interrupted.attemptId,
      status: "INTERRUPTED",
    });
    expect(
      JSON.parse(await fs.readFile(path.join(lane, "latest.json"), "utf8")),
    ).toMatchObject({ attemptId: latest.attemptId, status: "BLOCKED" });
  });

  it("never lets a passing attempt certify an empty capture", async () => {
    const lane = await laneRoot();
    const attempt = await openEvidenceAttempt(lane, {
      lane: "sealed-package",
      input,
    });
    await fs.writeFile(path.join(attempt.directory, "complete-wide.png"), "");
    await attempt.finish("PASS", { cases: ["complete"] });

    const [recorded] = await listEvidenceAttempts(lane);
    expect(recorded.status).toBe("FAIL");
    expect(recorded.terminal.firstFailure).toEqual({
      case: "evidence",
      message: "EVIDENCE_EMPTY_BYPRODUCT:complete-wide.png",
    });
  });

  it("refuses a second terminal receipt and writes inside the attempt only", async () => {
    const lane = await laneRoot();
    const attempt = await openEvidenceAttempt(lane, {
      lane: "sealed-package",
      input,
    });
    await attempt.finish("PASS", { cases: [] });
    await expect(attempt.finish("FAIL", { cases: [] })).rejects.toThrow(
      "EVIDENCE_ATTEMPT_ALREADY_TERMINAL",
    );
    expect(() => attempt.path("../escape.png")).toThrow(
      "EVIDENCE_NAME_INVALID",
    );
    expect(() => attempt.path("terminal.json")).toThrow(
      "EVIDENCE_NAME_INVALID",
    );
  });
});

describe("HR-010 acceptance re-reads what the receipts claim", () => {
  const candidate = Object.freeze({
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    artifactSha256: "c".repeat(64),
  });

  // A complete sealed-package attempt produced by a real runner process:
  // started, a report, a PASS terminal with every case, and the exit receipt
  // the process handlers write.
  async function completeAttempt() {
    const lane = await laneRoot();
    const cases = JSON.stringify([...EVIDENCE_LANES["sealed-package"].cases]);
    const result = runnerInChild(
      lane,
      `
const fs = await import("node:fs/promises");
await fs.writeFile(attempt.directory + "/report.json", JSON.stringify({ status: "PASS" }));
await attempt.finish("PASS", { cases: ${cases} });
process.exitCode = 0;
`,
    );
    if (result.status !== 0) throw new Error(result.stderr);
    const [attempt] = await listEvidenceAttempts(lane);
    return { lane, attempt };
  }

  function evaluate(attempt, observer) {
    return evaluateEligibility({
      lane: "sealed-package",
      attempt,
      candidate,
      review: {
        reviewer: "independent",
        verdict: "ACCEPT",
        subject: { ...candidate },
      },
      // This describe block exercises the loader's own re-read checks, not
      // observer binding: the default observer below reports exactly what
      // the attempt currently claims, so it never contributes an
      // OBSERVER_BYPRODUCT_MISMATCH/OBSERVER_TERMINAL_MISMATCH reason of
      // its own here.
      observer: observer ?? {
        schema: "farol.next.effect-observer/v1",
        healthy: true,
        lane: "sealed-package",
        attemptId: attempt.attemptId,
        subject: { ...candidate },
        interval: {
          startedAt: "2000-01-01T00:00:00.000Z",
          endedAt: "2100-01-01T00:00:00.000Z",
        },
        effects: {
          processSamples: [
            { at: attempt.started?.startedAt, processes: 1 },
            { at: attempt.terminal?.endedAt, processes: 0 },
          ],
          terminalSeenAt: attempt.terminal?.endedAt,
          byproducts: attempt.terminal?.byproducts ?? [],
          terminalSha256: attempt.terminalSha256 ?? null,
        },
      },
    });
  }

  it("accepts a complete attempt whose bytes still match, and refuses it once a byproduct is missing, changed, emptied or added", async () => {
    const { lane, attempt } = await completeAttempt();
    expect(attempt.verification).toEqual({ receipts: [], byproducts: [] });
    expect(attempt.started.input).toEqual({});
    // The subject is bound at start; this fixture started with none, so the
    // positive control supplies it the way a runner does.
    attempt.started.input = { ...candidate };
    expect(evaluate(attempt).acceptable).toBe(true);

    const report = path.join(attempt.directory, "report.json");
    const original = await fs.readFile(report);
    const reload = async () => {
      const [loaded] = await listEvidenceAttempts(lane);
      loaded.started.input = { ...candidate };
      return loaded;
    };

    await fs.writeFile(report, Buffer.concat([original, Buffer.from(" ")]));
    let loaded = await reload();
    expect(loaded.verification.byproducts).toEqual([
      "BYPRODUCT_CHANGED:report.json",
    ]);
    expect(evaluate(loaded)).toMatchObject({
      acceptable: false,
      eligibility: "INVALID",
    });

    await fs.writeFile(report, "");
    loaded = await reload();
    expect(loaded.verification.byproducts).toEqual([
      "BYPRODUCT_CHANGED:report.json",
    ]);

    await fs.rm(report);
    loaded = await reload();
    expect(loaded.verification.byproducts).toEqual([
      "BYPRODUCT_MISSING:report.json",
    ]);
    expect(evaluate(loaded).reasons).toContain("BYPRODUCT_MISSING:report.json");

    await fs.writeFile(report, original);
    await fs.writeFile(path.join(attempt.directory, "extra.png"), "late");
    loaded = await reload();
    expect(loaded.verification.byproducts).toEqual([
      "BYPRODUCT_UNRECORDED:extra.png",
    ]);
    await fs.rm(path.join(attempt.directory, "extra.png"));

    // A byproduct replaced by a symbolic link is not the recorded file.
    await fs.rm(report);
    await fs.symlink(path.join(lane, "..", "elsewhere.json"), report);
    loaded = await reload();
    expect(loaded.verification.byproducts).toEqual([
      "BYPRODUCT_KIND:report.json",
    ]);
    await fs.rm(report);
    await fs.writeFile(report, original);
    loaded = await reload();
    expect(loaded.verification).toEqual({ receipts: [], byproducts: [] });
    expect(evaluate(loaded).acceptable).toBe(true);
  });

  it("refuses receipts that name another attempt or lane, and a recorded path that leaves the attempt", async () => {
    const { lane, attempt } = await completeAttempt();
    const other = "20260918T080000000Z-0000000b";
    const rewrite = async (name, mutate) => {
      const file = path.join(attempt.directory, name);
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      const original = await fs.readFile(file);
      await fs.writeFile(file, JSON.stringify(mutate(value)));
      const [loaded] = await listEvidenceAttempts(lane);
      await fs.writeFile(file, original);
      return loaded;
    };

    expect(
      (
        await rewrite("terminal.json", (value) => ({
          ...value,
          attemptId: other,
        }))
      ).verification.receipts,
    ).toEqual(["RECEIPT_IDENTITY:terminal"]);
    expect(
      (await rewrite("exit.json", (value) => ({ ...value, attemptId: other })))
        .verification.receipts,
    ).toEqual(["RECEIPT_IDENTITY:exit"]);
    expect(
      (
        await rewrite("started.json", (value) => ({
          ...value,
          attemptId: other,
          lane: "hunt",
        }))
      ).verification.receipts,
    ).toEqual(["RECEIPT_IDENTITY:started", "RECEIPT_LANE:terminal"]);
    expect(
      (await rewrite("terminal.json", (value) => ({ ...value, lane: "hunt" })))
        .verification.receipts,
    ).toEqual(["RECEIPT_LANE:terminal"]);
    const escaping = await rewrite("terminal.json", (value) => ({
      ...value,
      byproducts: [
        { path: "../outside.json", bytes: 1, sha256: "d".repeat(64) },
        ...value.byproducts,
      ],
    }));
    expect(escaping.verification.byproducts).toEqual([
      "BYPRODUCT_PATH_INVALID:../outside.json",
    ]);
    const [intact] = await listEvidenceAttempts(lane);
    expect(intact.verification).toEqual({ receipts: [], byproducts: [] });
  });
});
