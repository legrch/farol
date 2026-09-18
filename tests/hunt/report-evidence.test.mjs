import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const reportScript = fileURLToPath(
  new URL("../../tooling/hunt-report.mjs", import.meta.url),
);
const sourceIdentityModule = fileURLToPath(
  new URL("../../tooling/source-identity.mjs", import.meta.url),
);
const gitEnvironment = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Hunt Fixture",
  GIT_AUTHOR_EMAIL: "hunt-fixture@example.invalid",
  GIT_COMMITTER_NAME: "Hunt Fixture",
  GIT_COMMITTER_EMAIL: "hunt-fixture@example.invalid",
});
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

// The stub build below writes this manifest for the fixture repository's
// actual source identity, the way the real build does.
function validBuildManifest(overrides = {}) {
  return {
    schema: 3,
    sourceMode: "head-exact",
    product: "Farol Next Preview",
    buildId: "c".repeat(64),
    builtAt: "2026-09-16T10:00:00.000Z",
    sourceCommit: "a".repeat(40),
    sourceTreeDigest: "b".repeat(64),
    dirty: false,
    inputExact: true,
    ...overrides,
  };
}

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

// The fixture is a real Git repository with the product under vnext/, so the
// report measures the same source identity the real build attests.
async function createFixtureRoot() {
  const created = await mkdtemp(
    path.join(os.tmpdir(), "farol-hunt-report-test-"),
  );
  const repository = await realpath(created);
  const root = path.join(repository, "vnext");
  await Promise.all([
    mkdir(path.join(root, "node_modules/vitest"), { recursive: true }),
    mkdir(path.join(root, "tooling"), { recursive: true }),
    mkdir(path.join(root, "tests/hunt/fixtures"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(repository, ".gitignore"),
      "vnext/node_modules/\nvnext/dist/\nvnext/artifacts/\n",
    ),
    writeFile(
      path.join(root, "node_modules/vitest/vitest.mjs"),
      [
        'import { execFileSync } from "node:child_process";',
        'import fs from "node:fs";',
        'const flag = process.argv.indexOf("--outputFile");',
        "const output = flag >= 0 ? process.argv[flag + 1] : undefined;",
        "const evidence = process.env.FAKE_VITEST_REPORT;",
        "if (output && evidence) fs.copyFileSync(evidence, output);",
        'if (process.env.FAKE_COMMIT_AFTER_TESTS === "1") {',
        '  fs.writeFileSync("tests/hunt/fixtures/later.txt", "source B\\n");',
        '  execFileSync("git", ["add", "-A"]);',
        '  execFileSync("git", ["commit", "-q", "-m", "source B"]);',
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(root, "tooling/build.mjs"),
      [
        'import { createHash } from "node:crypto";',
        'import fs from "node:fs";',
        'import path from "node:path";',
        `import { sourceIdentity } from ${JSON.stringify(sourceIdentityModule)};`,
        'const identity = sourceIdentity(path.resolve(process.cwd(), ".."), "vnext");',
        'const ledger = JSON.stringify([{ kind: "source", path: "src/main.ts", objectId: "0".repeat(40), sha256: "1".repeat(64), exact: true }]);',
        'const overrides = JSON.parse(process.env.FAKE_BUILD_OVERRIDES ?? "{}");',
        'fs.mkdirSync("dist/app", { recursive: true });',
        'if (process.env.FAKE_INPUT_MANIFEST !== "absent") {',
        '  fs.writeFileSync("dist/app/input-manifest.json", process.env.FAKE_INPUT_MANIFEST === "tampered" ? ledger.replace("src/main.ts", "src/other.ts") : ledger);',
        "}",
        "const manifest = {",
        `  ...${JSON.stringify(validBuildManifest())},`,
        "  sourceCommit: identity.commit,",
        "  sourceTreeDigest: identity.treeDigest,",
        "  dirty: identity.dirty,",
        '  inputLedgerSha256: createHash("sha256").update(ledger).digest("hex"),',
        "  sourceInputCount: 1,",
        "  dependencyInputCount: 0,",
        "  ...overrides,",
        "};",
        'fs.writeFileSync("dist/app/build-manifest.json", JSON.stringify(manifest) + "\\n");',
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(root, "tests/hunt/fixtures/semantic-replay.json"),
      `${JSON.stringify({
        buildIdentity: "<build-identity-recorded-by-final-runner>",
        commands: [{ kind: "synthetic.command" }],
      })}\n`,
    ),
  ]);
  const git = (arguments_) =>
    execFileSync("git", ["-C", repository, ...arguments_], {
      env: { ...process.env, ...gitEnvironment },
    });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "source A"]);
  return root;
}

function runReport(root, evidenceFile, environment = {}) {
  return spawnSync(process.execPath, [reportScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...gitEnvironment,
      ...environment,
      ...(evidenceFile === undefined
        ? {}
        : { FAKE_VITEST_REPORT: evidenceFile }),
    },
  });
}

async function runWithEvidence(root, report, environment = {}) {
  const evidenceFile = path.join(
    path.dirname(root),
    "..",
    `${path.basename(path.dirname(root))}-vitest-report.json`,
  );
  await writeFile(evidenceFile, `${JSON.stringify(report)}\n`);
  try {
    return runReport(root, evidenceFile, environment);
  } finally {
    await rm(evidenceFile, { force: true });
  }
}

async function removeFixture(root) {
  await rm(path.dirname(root), { recursive: true, force: true });
}

async function expectRejected(report, code, environment = {}) {
  const root = await createFixtureRoot();
  try {
    const result = await runWithEvidence(root, report(root), environment);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(code);
    expect(result.stdout).not.toContain('"verdict": "PASS"');
  } finally {
    await removeFixture(root);
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
      await removeFixture(root);
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
      await removeFixture(root);
    }
  });

  it.each([
    ["dirty source", { dirty: true }],
    ["inexact build input", { inputExact: false }],
  ])("refuses PASS evidence from %s", async (_name, buildOverride) => {
    const root = await createFixtureRoot();
    try {
      const result = await runWithEvidence(root, validVitestReport(root), {
        FAKE_BUILD_OVERRIDES: JSON.stringify(buildOverride),
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("HUNT_BUILD_SOURCE_NOT_EXACT");
      expect(result.stdout).not.toContain('"verdict": "PASS"');
    } finally {
      await removeFixture(root);
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

  it("EV-02 refuses to certify a build whose source moved after the tests ran", async () => {
    await expectRejected(
      (root) => validVitestReport(root),
      "HUNT_INPUT_CHANGED",
      { FAKE_COMMIT_AFTER_TESTS: "1" },
    );
  });

  it.each([
    ["absent", "HUNT_BUILD_INPUT_MANIFEST_INVALID"],
    ["tampered", "HUNT_BUILD_INPUT_MANIFEST_INVALID"],
  ])(
    "EV-07 refuses a build whose retained input manifest is %s",
    async (state, code) => {
      await expectRejected((root) => validVitestReport(root), code, {
        FAKE_INPUT_MANIFEST: state,
      });
    },
  );

  it("records the tested source identity it certifies", async () => {
    const root = await createFixtureRoot();
    try {
      const result = await runWithEvidence(root, validVitestReport(root));
      expect(result.status).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.testedSource).toEqual({
        commit: expect.stringMatching(/^[a-f0-9]{40}$/u),
        treeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(report.replay.buildIdentity).toContain(report.testedSource.commit);
    } finally {
      await removeFixture(root);
    }
  });
});
