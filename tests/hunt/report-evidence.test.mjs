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
const buildIdentityModule = fileURLToPath(
  new URL("../../tooling/build-identity-contract.mjs", import.meta.url),
);
const buildContractModule = fileURLToPath(
  new URL("../../tooling/build-contract.mjs", import.meta.url),
);
const coreArtifactModule = fileURLToPath(
  new URL("../../tooling/go-core-artifact.mjs", import.meta.url),
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

// The controlled Dev producer writes real hash/identity envelopes around
// synthetic files. Its 64-byte Mach-O header is never executed and is not
// compiler, native backend or assembled-product evidence.
function validBuildManifest(overrides = {}) {
  return {
    schema: 4,
    sourceMode: "head-exact",
    product: "Farol",
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

// The fixture is a standalone Git repository inside a disposable fixture parent, so the
// report measures the same source identity the real build attests.
async function createFixtureRoot() {
  const created = await mkdtemp(
    path.join(os.tmpdir(), "farol-hunt-report-test-"),
  );
  const repository = path.join(await realpath(created), "source");
  const root = repository;
  await Promise.all([
    mkdir(path.join(root, "node_modules/vitest"), { recursive: true }),
    mkdir(path.join(root, "tooling"), { recursive: true }),
    mkdir(path.join(root, "tests/hunt/fixtures"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(repository, ".gitignore"), "node_modules/\n_output/\n"),
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
      path.join(root, "tooling/dev.mjs"),
      [
        'import { createHash } from "node:crypto";',
        'import fs from "node:fs";',
        'import path from "node:path";',
        `import { sourceIdentity } from ${JSON.stringify(sourceIdentityModule)};`,
        `import { createBuildIdentity } from ${JSON.stringify(buildIdentityModule)};`,
        `import { BUILD_ENTRIES } from ${JSON.stringify(buildContractModule)};`,
        `import { GO_CORE_ENTRIES } from ${JSON.stringify(coreArtifactModule)};`,
        'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--check"])) throw new Error("HUNT_DEV_CHECK_REQUIRED");',
        "const identity = sourceIdentity(process.cwd());",
        'const ledger = JSON.stringify([{ kind: "source", path: "src/main.ts", objectId: "0".repeat(40), sha256: "1".repeat(64), exact: true }]);',
        'const overrides = JSON.parse(process.env.FAKE_BUILD_OVERRIDES ?? "{}");',
        'fs.mkdirSync("_output/build/app", { recursive: true });',
        'const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");',
        'const outer = createBuildIdentity({ version: "0.2.0", builtAt: "2026-09-16T10:00:00.000Z", sourceCommit: identity.commit, sourceTreeDigest: identity.treeDigest, sourceDirty: identity.dirty });',
        "const binary = Buffer.alloc(64); binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x0100000c, 4); binary.writeUInt32LE(2, 12);",
        'const core = { schema: "farol-core-artifact/1", build: { buildId: outer.buildId, sourceSHA: outer.sourceCommit, sourceTreeDigest: outer.sourceTreeDigest, platform: { goos: "darwin", goarch: "arm64" } }, binary: { path: "farol-backend", size: binary.length, sha256: sha256(binary) } };',
        'if (process.env.FAKE_CORE === "forged-outer") core.build.buildId = "0".repeat(64);',
        "const entries = [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort();",
        'const content = Object.fromEntries(entries.map(entry => [entry, Buffer.from("synthetic " + entry + "\\n")]));',
        'content["build-identity.json"] = Buffer.from(JSON.stringify(outer));',
        'content["core-artifact.json"] = Buffer.from(JSON.stringify(core));',
        'content["farol-backend"] = binary;',
        'content["input-manifest.json"] = Buffer.from(ledger);',
        "for (const [entry, bytes] of Object.entries(content)) {",
        '  if (entry === "input-manifest.json" && process.env.FAKE_INPUT_MANIFEST === "absent") continue;',
        '  if (entry === "farol-backend" && process.env.FAKE_CORE === "absent") continue;',
        '  fs.writeFileSync(path.join("_output/build/app", entry), bytes, { mode: entry === "farol-backend" ? 0o500 : 0o600 });',
        "}",
        'if (process.env.FAKE_INPUT_MANIFEST === "tampered") fs.writeFileSync("_output/build/app/input-manifest.json", ledger.replace("src/main.ts", "src/other.ts"));',
        'if (process.env.FAKE_CORE === "tampered") { fs.chmodSync("_output/build/app/farol-backend", 0o700); const changed = Buffer.from(binary); changed[63] = 1; fs.writeFileSync("_output/build/app/farol-backend", changed); }',
        "const manifest = {",
        `  ...${JSON.stringify(validBuildManifest())},`,
        "  buildId: outer.buildId,",
        "  sourceCommit: identity.commit,",
        "  sourceTreeDigest: identity.treeDigest,",
        "  dirty: identity.dirty,",
        '  inputLedgerSha256: createHash("sha256").update(ledger).digest("hex"),',
        "  sourceInputCount: 1,",
        "  dependencyInputCount: 0,",
        "  entries,",
        "  entrySha256: Object.fromEntries(Object.entries(content).map(([entry, bytes]) => [entry, sha256(bytes)])),",
        "  core,",
        "  ...overrides,",
        "};",
        'if (process.env.FAKE_CORE === "missing-entry") manifest.entries = entries.filter(entry => entry !== "farol-backend");',
        'fs.writeFileSync("_output/build/app/build-manifest.json", JSON.stringify(manifest) + "\\n");',
        "",
      ].join("\n"),
    ),
    writeFile(
      path.join(root, "tooling/build.mjs"),
      'throw new Error("HUNT_LEGACY_PRODUCER_FORBIDDEN");\n',
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
    ["absent", "HUNT_BUILD_ARTIFACT_INVALID"],
    ["tampered", "HUNT_BUILD_ARTIFACT_INVALID"],
  ])(
    "EV-07 refuses a build whose retained input manifest is %s",
    async (state, code) => {
      await expectRejected((root) => validVitestReport(root), code, {
        FAKE_INPUT_MANIFEST: state,
      });
    },
  );

  it("refuses a schema3 result even when the selected producer exits zero", async () => {
    await expectRejected(validVitestReport, "HUNT_BUILD_IDENTITY_INVALID", {
      FAKE_BUILD_OVERRIDES: JSON.stringify({ schema: 3 }),
    });
  });

  it.each(["absent", "tampered", "forged-outer", "missing-entry"])(
    "refuses an unattested Go backend: %s",
    async (state) => {
      await expectRejected(validVitestReport, "HUNT_BUILD_ARTIFACT_INVALID", {
        FAKE_CORE: state,
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
