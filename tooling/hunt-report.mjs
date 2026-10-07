import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { qualifyGoBuild } from "../tests/e2e/qualified-go-build.mjs";
import { openEvidenceAttempt } from "./evidence-attempt.mjs";
import { sourceIdentity } from "./source-identity.mjs";

const root = process.cwd();
const repositoryRoot = root;
const scope = ".";
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const suites = [
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

function fail(code, detail) {
  throw new Error(detail === undefined ? code : `${code}:${detail}`);
}

function record(value, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code);
  }
  return value;
}

function count(report, field) {
  const value = report[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("HUNT_VITEST_COUNT_INVALID", field);
  }
  return value;
}

function exactIds(actual, expected, code) {
  if (new Set(actual).size !== actual.length) {
    fail(`${code}_DUPLICATE`);
  }
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((id) => !actualSet.has(id));
  const unexpected = actual.filter((id) => !expectedSet.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    fail(
      code,
      `missing=${missing.join(",") || "none"};unexpected=${unexpected.join(",") || "none"}`,
    );
  }
}

function relativeTestFile(name) {
  if (typeof name !== "string" || name.length === 0) {
    fail("HUNT_VITEST_FILE_INVALID");
  }
  const absolute = path.isAbsolute(name) ? name : path.resolve(root, name);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith("../")
  ) {
    fail("HUNT_VITEST_FILE_OUTSIDE_ROOT");
  }
  return relative;
}

function testStatus(status) {
  if (
    status !== "passed" &&
    status !== "failed" &&
    status !== "skipped" &&
    status !== "pending" &&
    status !== "todo" &&
    status !== "disabled"
  ) {
    fail("HUNT_VITEST_STATUS_INVALID");
  }
  return status;
}

function huntMetadata(assertion) {
  const meta = record(assertion.meta, "HUNT_VITEST_META_INVALID");
  const hunt = record(meta.hunt, "HUNT_VITEST_HUNT_META_MISSING");
  if (typeof hunt.suiteId !== "string" || typeof hunt.testId !== "string") {
    fail("HUNT_VITEST_HUNT_ID_INVALID");
  }
  return hunt;
}

function mutationEvidence(tests) {
  const carriers = tests.filter((test) => test.hunt.mutation !== undefined);
  if (carriers.length !== 1) {
    fail("HUNT_MUTATION_EVIDENCE_AMBIGUOUS", String(carriers.length));
  }
  const carrier = carriers[0];
  if (
    carrier === undefined ||
    carrier.hunt.suiteId !== "proof" ||
    carrier.hunt.testId !== "required-mutations"
  ) {
    fail("HUNT_MUTATION_EVIDENCE_OWNER_INVALID");
  }
  const mutation = record(
    carrier.hunt.mutation,
    "HUNT_MUTATION_EVIDENCE_INVALID",
  );
  if (
    !Number.isSafeInteger(mutation.shrinkBudget) ||
    mutation.shrinkBudget <= 0 ||
    !Array.isArray(mutation.results)
  ) {
    fail("HUNT_MUTATION_EVIDENCE_INVALID");
  }

  const statuses = mutation.results.map((entry) => {
    const result = record(entry, "HUNT_MUTATION_RESULT_INVALID");
    if (
      typeof result.id !== "string" ||
      (result.status !== "killed" && result.status !== "survived")
    ) {
      fail("HUNT_MUTATION_RESULT_INVALID");
    }
    return { id: result.id, status: result.status };
  });
  exactIds(
    statuses.map((entry) => entry.id),
    requiredMutationIds,
    "HUNT_MUTATION_IDS_MISMATCH",
  );

  const byId = new Map(statuses.map((entry) => [entry.id, entry.status]));
  const killedIds = requiredMutationIds.filter(
    (id) => byId.get(id) === "killed",
  );
  const survivedIds = requiredMutationIds.filter(
    (id) => byId.get(id) === "survived",
  );
  if (survivedIds.length > 0) {
    fail("HUNT_MUTATIONS_SURVIVED", survivedIds.join(","));
  }
  return {
    status: survivedIds.length === 0 ? "killed" : "survived",
    killedIds,
    survivedIds,
    shrinkBudget: mutation.shrinkBudget,
  };
}

function validateVitestEvidence(raw) {
  const report = record(raw, "HUNT_VITEST_REPORT_INVALID");
  if (!Array.isArray(report.testResults)) {
    fail("HUNT_VITEST_RESULTS_INVALID");
  }

  const resultByFile = new Map();
  for (const rawResult of report.testResults) {
    const result = record(rawResult, "HUNT_VITEST_FILE_RESULT_INVALID");
    const file = relativeTestFile(result.name);
    if (resultByFile.has(file)) {
      fail("HUNT_VITEST_FILE_DUPLICATE", file);
    }
    resultByFile.set(file, result);
  }
  exactIds(
    [...resultByFile.keys()],
    suites.map((suite) => suite.file),
    "HUNT_VITEST_FILES_MISMATCH",
  );

  const observedTests = [];
  const suiteEvidence = suites.map((suite) => {
    const result = resultByFile.get(suite.file);
    if (result === undefined || !Array.isArray(result.assertionResults)) {
      fail("HUNT_VITEST_ASSERTIONS_INVALID", suite.id);
    }
    const tests = result.assertionResults.map((rawAssertion) => {
      const assertion = record(rawAssertion, "HUNT_VITEST_ASSERTION_INVALID");
      const hunt = huntMetadata(assertion);
      if (hunt.suiteId !== suite.id) {
        fail("HUNT_VITEST_SUITE_ID_MISMATCH", hunt.suiteId);
      }
      const observed = {
        hunt,
        id: hunt.testId,
        status: testStatus(assertion.status),
      };
      observedTests.push(observed);
      return observed;
    });
    exactIds(
      tests.map((test) => test.id),
      suite.testIds,
      "HUNT_VITEST_TEST_IDS_MISMATCH",
    );
    const byId = new Map(tests.map((test) => [test.id, test]));
    const executedTests = tests.filter(
      (test) => test.status === "passed" || test.status === "failed",
    ).length;
    const skippedTests = tests.filter(
      (test) =>
        test.status === "skipped" ||
        test.status === "pending" ||
        test.status === "disabled",
    ).length;
    const todoTests = tests.filter((test) => test.status === "todo").length;
    const failedTests = tests.filter((test) => test.status === "failed").length;
    const status =
      result.status === "passed" &&
      executedTests > 0 &&
      failedTests === 0 &&
      skippedTests === 0 &&
      todoTests === 0 &&
      tests.every((test) => test.status === "passed")
        ? "PASS"
        : "FAIL";
    return {
      id: suite.id,
      status,
      file: suite.file,
      executedTests,
      skippedTests,
      todoTests,
      tests: suite.testIds.map((id) => ({
        id,
        status: byId.get(id)?.status === "passed" ? "PASS" : "FAIL",
      })),
    };
  });

  const passedTests = observedTests.filter(
    (test) => test.status === "passed",
  ).length;
  const failedTests = observedTests.filter(
    (test) => test.status === "failed",
  ).length;
  const skippedTests = observedTests.filter(
    (test) =>
      test.status === "skipped" ||
      test.status === "pending" ||
      test.status === "disabled",
  ).length;
  const todoTests = observedTests.filter(
    (test) => test.status === "todo",
  ).length;
  const executedTests = passedTests + failedTests;
  const totalTests = observedTests.length;

  const rawTotalTests = count(report, "numTotalTests");
  const rawPassedTests = count(report, "numPassedTests");
  const rawFailedTests = count(report, "numFailedTests");
  const rawPendingTests = count(report, "numPendingTests");
  const rawTodoTests = count(report, "numTodoTests");
  const totalSuites = count(report, "numTotalTestSuites");
  const passedSuites = count(report, "numPassedTestSuites");
  const failedSuites = count(report, "numFailedTestSuites");
  const pendingSuites = count(report, "numPendingTestSuites");
  if (
    rawTotalTests !== totalTests ||
    rawPassedTests !== passedTests ||
    rawFailedTests !== failedTests ||
    rawPendingTests !== skippedTests ||
    rawTodoTests !== todoTests ||
    totalSuites !== passedSuites + failedSuites + pendingSuites
  ) {
    fail("HUNT_VITEST_COUNTS_MISMATCH");
  }

  const mutationProof = mutationEvidence(observedTests);
  const status =
    report.success === true &&
    totalSuites > 0 &&
    failedSuites === 0 &&
    pendingSuites === 0 &&
    executedTests > 0 &&
    failedTests === 0 &&
    skippedTests === 0 &&
    todoTests === 0 &&
    suiteEvidence.every(
      (suite) => suite.status === "PASS" && suite.executedTests > 0,
    )
      ? "PASS"
      : "FAIL";
  if (status !== "PASS") {
    fail("HUNT_VITEST_EVIDENCE_NOT_PASSING");
  }
  return {
    status,
    reporter: "vitest-json",
    totalTests,
    executedTests,
    failedTests,
    skippedTests,
    todoTests,
    suites: suiteEvidence,
    mutationProof,
  };
}

async function collectVitestEvidence() {
  // The raw reporter output stays in this attempt as the evidence the
  // sanitized path.json summarizes.
  const outputFile = path.join(huntAttempt.directory, "vitest-report.json");
  {
    const run = spawnSync(
      process.execPath,
      [
        vitest,
        "run",
        ...suites.map((suite) => suite.file),
        "--no-file-parallelism",
        "--reporter=json",
        "--outputFile",
        outputFile,
      ],
      {
        cwd: root,
        env: { ...process.env, CI: "1" },
        stdio: "inherit",
      },
    );
    if (run.error !== undefined) throw run.error;
    if (run.status !== 0) {
      fail(
        "HUNT_VITEST_PROCESS_FAILED",
        run.signal === null ? String(run.status) : `signal=${run.signal}`,
      );
    }
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(outputFile, "utf8"));
    } catch (error) {
      fail(
        "HUNT_VITEST_REPORT_UNREADABLE",
        error instanceof Error ? (error.code ?? error.name) : "unknown",
      );
    }
    return validateVitestEvidence(raw);
  }
}

// The report may certify only the exact source its tests ran against: the
// identity is measured before the tests, then compared with the build and
// measured again after it.
const testedSource = sourceIdentity(repositoryRoot, scope);
const huntAttempt = await openEvidenceAttempt(
  path.join(root, "_output/evidence/hunt"),
  {
    lane: "hunt",
    input: {
      sourceCommit: testedSource.commit,
      sourceTreeDigest: testedSource.treeDigest,
      sourceDirty: testedSource.dirty,
    },
  },
);
huntAttempt.installProcessHandlers();
const vitestEvidence = await collectVitestEvidence();
execFileSync(
  process.execPath,
  [path.join(root, "tooling/dev.mjs"), "--check"],
  {
    cwd: root,
    stdio: "inherit",
  },
);

const fixture = JSON.parse(
  await fs.readFile(
    path.join(root, "tests/hunt/fixtures/semantic-replay.json"),
    "utf8",
  ),
);
const build = JSON.parse(
  await fs.readFile(
    path.join(root, "_output/build/app/build-manifest.json"),
    "utf8",
  ),
);
if (
  fixture.buildIdentity !== "<build-identity-recorded-by-final-runner>" ||
  !Array.isArray(fixture.commands) ||
  fixture.commands.length === 0
) {
  throw new Error("HUNT_REPLAY_FIXTURE_INVALID");
}
if (
  build.schema !== 4 ||
  build.sourceMode !== "head-exact" ||
  build.product !== "Farol Next Preview" ||
  !/^[a-f0-9]{64}$/u.test(build.buildId) ||
  typeof build.builtAt !== "string" ||
  !/^[a-f0-9]{40}$/u.test(build.sourceCommit) ||
  !/^[a-f0-9]{64}$/u.test(build.sourceTreeDigest) ||
  typeof build.dirty !== "boolean" ||
  typeof build.inputExact !== "boolean"
) {
  throw new Error("HUNT_BUILD_IDENTITY_INVALID");
}
if (build.dirty || !build.inputExact) {
  throw new Error("HUNT_BUILD_SOURCE_NOT_EXACT");
}
if (testedSource.dirty) {
  throw new Error("HUNT_TESTED_SOURCE_NOT_EXACT");
}
const builtSource = sourceIdentity(repositoryRoot, scope);
if (
  build.sourceCommit !== testedSource.commit ||
  build.sourceTreeDigest !== testedSource.treeDigest ||
  builtSource.commit !== testedSource.commit ||
  builtSource.treeDigest !== testedSource.treeDigest ||
  builtSource.dirty
) {
  throw new Error("HUNT_INPUT_CHANGED");
}
try {
  await qualifyGoBuild(path.join(root, "_output/build/app"), testedSource);
} catch (error) {
  fail(
    "HUNT_BUILD_ARTIFACT_INVALID",
    error instanceof Error ? error.message : "unknown",
  );
}

const buildIdentity = [
  "farol-next",
  build.buildId,
  build.sourceCommit,
  build.sourceTreeDigest,
  build.dirty ? "dirty" : "clean",
].join(":");
const report = {
  schema: 1,
  verdict:
    vitestEvidence.status === "PASS" &&
    vitestEvidence.mutationProof.survivedIds.length === 0
      ? "PASS"
      : "FAIL",
  vitest: {
    reporter: vitestEvidence.reporter,
    status: vitestEvidence.status,
    totalTests: vitestEvidence.totalTests,
    executedTests: vitestEvidence.executedTests,
    failedTests: vitestEvidence.failedTests,
    skippedTests: vitestEvidence.skippedTests,
    todoTests: vitestEvidence.todoTests,
  },
  suites: vitestEvidence.suites,
  mutationProof: {
    ...vitestEvidence.mutationProof,
    defects: vitestEvidence.mutationProof.killedIds,
  },
  testedSource: {
    commit: testedSource.commit,
    treeDigest: testedSource.treeDigest,
  },
  replay: { ...fixture, buildIdentity },
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (/(prompt|answer|secret|token|\/Users\/|bearer\s+)/iu.test(serialized)) {
  throw new Error("HUNT_REPORT_PRIVACY_CANARY");
}
await fs.writeFile(path.join(huntAttempt.directory, "path.json"), serialized, {
  mode: 0o600,
});
await huntAttempt.finish("PASS", {
  cases: vitestEvidence.suites.map((suite) => suite.file),
});
process.stdout.write(serialized);
