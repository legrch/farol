import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const reportScript = fileURLToPath(
  new URL("../../tooling/hunt-report.mjs", import.meta.url),
);
const requiredSuites = [
  {
    id: "selftest",
    file: "tests/hunt/selftest.test.ts",
    testIds: [
      "generated-command-bounds",
      "versioned-replay",
      "sanitized-evidence",
      "isolated-replay",
      "bounded-shrinker",
      "mutation-inventory",
    ],
  },
  {
    id: "proof",
    file: "tests/hunt/proof.test.ts",
    testIds: ["required-mutations"],
  },
  {
    id: "model",
    file: "tests/hunt/model.test.ts",
    testIds: ["deterministic-episodes"],
  },
];
const requiredMutationIds = [
  "permit_foreign_owner",
  "replay_unknown_submit",
  "accept_stale_generation",
  "buffer_all_text_until_terminal",
  "apply_update_while_accepted_work_remains",
];

function validVitestReport(root) {
  const testResults = requiredSuites.map((suite) => ({
    name: path.join(root, suite.file),
    status: "passed",
    assertionResults: suite.testIds.map((testId) => ({
      status: "passed",
      meta: {
        hunt: {
          suiteId: suite.id,
          testId,
          ...(suite.id === "proof"
            ? {
                mutation: {
                  results: requiredMutationIds.map((id) => ({
                    id,
                    status: "killed",
                  })),
                  shrinkBudget: 24,
                },
              }
            : {}),
        },
      },
    })),
  }));
  const numTotalTests = testResults.reduce(
    (total, result) => total + result.assertionResults.length,
    0,
  );
  return {
    numTotalTestSuites: 6,
    numPassedTestSuites: 6,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests,
    numPassedTests: numTotalTests,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults,
  };
}

async function createFixtureRoot() {
  const created = await mkdtemp(
    path.join(os.tmpdir(), "farol-hunt-report-test-"),
  );
  const root = await realpath(created);
  await Promise.all([
    mkdir(path.join(root, "node_modules/vitest"), { recursive: true }),
    mkdir(path.join(root, "tooling"), { recursive: true }),
    mkdir(path.join(root, "tests/hunt/fixtures"), { recursive: true }),
    mkdir(path.join(root, "dist/app"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(root, "node_modules/vitest/vitest.mjs"),
      [
        'import fs from "node:fs";',
        'const flag = process.argv.indexOf("--outputFile");',
        "const output = flag >= 0 ? process.argv[flag + 1] : undefined;",
        "const evidence = process.env.FAKE_VITEST_REPORT;",
        "if (output && evidence) fs.copyFileSync(evidence, output);",
        "process.exit(0);",
        "",
      ].join("\n"),
    ),
    writeFile(path.join(root, "tooling/build.mjs"), "process.exit(0);\n"),
    writeFile(
      path.join(root, "tests/hunt/fixtures/semantic-replay.json"),
      `${JSON.stringify({
        buildIdentity: "<build-identity-recorded-by-final-runner>",
        commands: [{ kind: "synthetic.command" }],
      })}\n`,
    ),
    writeFile(
      path.join(root, "dist/app/build-manifest.json"),
      `${JSON.stringify({
        schema: 2,
        sourceMode: "head-exact",
        product: "Farol Next Preview",
        sourceCommit: "a".repeat(40),
        sourceTreeDigest: "b".repeat(64),
        dirty: false,
      })}\n`,
    ),
  ]);
  return root;
}

function runReport(root, evidenceFile) {
  return spawnSync(process.execPath, [reportScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(evidenceFile === undefined
        ? {}
        : { FAKE_VITEST_REPORT: evidenceFile }),
    },
  });
}

async function runWithEvidence(root, report) {
  const evidenceFile = path.join(root, "vitest-report.json");
  await writeFile(evidenceFile, `${JSON.stringify(report)}\n`);
  return runReport(root, evidenceFile);
}

async function expectRejected(report, code) {
  const root = await createFixtureRoot();
  try {
    const result = await runWithEvidence(root, report(root));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(code);
    expect(result.stdout).not.toContain('"verdict": "PASS"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Hunt report Vitest evidence", () => {
  it("rejects an exit-zero Vitest run without a JSON report", async () => {
    const root = await createFixtureRoot();
    try {
      const result = runReport(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("HUNT_VITEST_REPORT_UNREADABLE");
      expect(result.stdout).not.toContain('"verdict": "PASS"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives exact suite, test, and mutation evidence from Vitest JSON", async () => {
    const root = await createFixtureRoot();
    try {
      const result = await runWithEvidence(root, validVitestReport(root));

      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.verdict).toBe("PASS");
      expect(report.vitest).toEqual({
        reporter: "vitest-json",
        status: "PASS",
        totalTests: 8,
        executedTests: 8,
        failedTests: 0,
        skippedTests: 0,
        todoTests: 0,
      });
      expect(
        report.suites.map((suite) => ({
          id: suite.id,
          testIds: suite.tests.map((test) => test.id),
        })),
      ).toEqual(
        requiredSuites.map((suite) => ({
          id: suite.id,
          testIds: suite.testIds,
        })),
      );
      expect(report.mutationProof).toEqual({
        status: "killed",
        killedIds: requiredMutationIds,
        survivedIds: [],
        shrinkBudget: 24,
        defects: requiredMutationIds,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["suite", "HUNT_VITEST_SUITE_ID_MISMATCH"],
    ["test", "HUNT_VITEST_TEST_IDS_MISMATCH"],
  ])("rejects a changed required %s ID", async (kind, code) => {
    await expectRejected((root) => {
      const report = validVitestReport(root);
      const hunt = report.testResults[0].assertionResults[0].meta.hunt;
      if (kind === "suite") hunt.suiteId = "renamed-suite";
      else hunt.testId = "renamed-test";
      return report;
    }, code);
  });

  it("rejects a removed required test even when Vitest reports success", async () => {
    await expectRejected((root) => {
      const report = validVitestReport(root);
      report.testResults[0].assertionResults.pop();
      report.numTotalTests -= 1;
      report.numPassedTests -= 1;
      return report;
    }, "HUNT_VITEST_TEST_IDS_MISMATCH");
  });

  it("rejects a fully skipped run even when Vitest reports success", async () => {
    await expectRejected((root) => {
      const report = validVitestReport(root);
      for (const result of report.testResults) {
        for (const assertion of result.assertionResults) {
          assertion.status = "skipped";
        }
      }
      report.numPassedTests = 0;
      report.numPendingTests = report.numTotalTests;
      return report;
    }, "HUNT_VITEST_EVIDENCE_NOT_PASSING");
  });

  it("rejects todo evidence even when every required ID remains", async () => {
    await expectRejected((root) => {
      const report = validVitestReport(root);
      report.testResults[0].assertionResults[0].status = "todo";
      report.numPassedTests -= 1;
      report.numTodoTests = 1;
      return report;
    }, "HUNT_VITEST_EVIDENCE_NOT_PASSING");
  });

  it("rejects a mutation survivor reported by the harness", async () => {
    await expectRejected((root) => {
      const report = validVitestReport(root);
      const proof = report.testResults.find((result) =>
        result.name.endsWith("proof.test.ts"),
      );
      proof.assertionResults[0].meta.hunt.mutation.results[0].status =
        "survived";
      return report;
    }, "HUNT_MUTATIONS_SURVIVED");
  });

  it("rejects a changed mutation ID reported by the harness", async () => {
    await expectRejected((root) => {
      const report = validVitestReport(root);
      const proof = report.testResults.find((result) =>
        result.name.endsWith("proof.test.ts"),
      );
      proof.assertionResults[0].meta.hunt.mutation.results[0].id =
        "renamed-mutation";
      return report;
    }, "HUNT_MUTATION_IDS_MISMATCH");
  });
});
