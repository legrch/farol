import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listEvidenceAttempts,
  openEvidenceAttempt,
} from "../../tooling/evidence-attempt.mjs";

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
