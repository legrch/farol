import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Receipt checker only: never executes submitted commands, stages or commits.
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(message);
};
const nonempty = (value) =>
  typeof value === "string" && value.trim().length > 0;
const sameSet = (a, b) =>
  a.length === b.length &&
  new Set(a).size === a.length &&
  [...a].sort().every((v, i) => v === [...b].sort()[i]);
const omitted = new Set([
  ".git",
  "node_modules",
  "_output",
  "dist",
  "coverage",
  "artifacts",
]);
const gitEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/var/empty",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LC_ALL: "C",
};
const git = (root, ...args) =>
  execFileSync("/usr/bin/git", ["-C", root, ...args], {
    env: gitEnv,
    maxBuffer: 64 * 1024 * 1024,
  });
const zeroList = (bytes) => bytes.toString().split("\0").filter(Boolean);
export function checkpointSnapshot(root) {
  root = fs.realpathSync(root);
  if (git(root, "rev-parse", "--show-toplevel").toString().trim() !== root)
    fail("REPOSITORY_ROOT_REQUIRED");
  const head = git(root, "rev-parse", "--verify", "HEAD").toString().trim();
  const branch = git(root, "branch", "--show-current").toString().trim();
  if (!branch || ["main", "master"].includes(branch))
    fail("NAMED_WRITER_REQUIRED");
  for (const flag of zeroList(git(root, "ls-files", "-v", "-z")))
    if (!flag.startsWith("H ")) fail("INDEX_FLAG_OR_CONFLICT");
  const index = git(root, "ls-files", "--stage", "-z");
  for (const entry of zeroList(index)) {
    const match = /^(100644|100755) [a-f0-9]+ 0\t(.+)$/u.exec(entry);
    if (!match || omitted.has(match[2].split("/")[0]))
      fail("INDEX_MODE_OR_EXCLUDED_TRACKED_PATH");
  }
  const files = [];
  const walk = (directory, relative = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (!relative && name === ".git") continue;
      if (stat.isSymbolicLink()) fail(`SOURCE_SYMLINK:${rel}`);
      if (!relative && omitted.has(name)) {
        if (!stat.isDirectory()) fail(`OUTPUT_NOT_DIRECTORY:${rel}`);
        continue;
      }
      if (stat.isDirectory()) walk(file, rel);
      else if (stat.isFile())
        files.push([rel, stat.mode & 0o777, sha256(fs.readFileSync(file))]);
      else fail(`SOURCE_ENTRY_TYPE:${rel}`);
    }
  };
  walk(root);
  // No Git ignore rules are consulted: ignored source outside explicit output
  // roots is still bound. Output/dependency integrity remains an acceptance gate.
  const staged = zeroList(
    git(root, "diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD"),
  );
  const tracked = new Set(zeroList(index).map((entry) => entry.split("\t")[1]));
  const changed = [
    ...new Set([
      ...zeroList(
        git(root, "diff", "--no-renames", "--name-only", "-z", "HEAD"),
      ),
      ...files.map(([name]) => name).filter((name) => !tracked.has(name)),
    ]),
  ].sort();
  return {
    root,
    head,
    branch,
    node: process.versions.node,
    index: sha256(index),
    source: sha256(JSON.stringify(files)),
    staged,
    changed,
  };
}
function artifact(reference) {
  if (
    !reference ||
    !path.isAbsolute(reference.path ?? "") ||
    !/^[a-f0-9]{64}$/u.test(reference.sha256 ?? "")
  )
    fail("ARTIFACT_REFERENCE_INVALID");
  const file = path.resolve(reference.path);
  if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile())
    fail("ARTIFACT_NOT_REGULAR");
  const bytes = fs.readFileSync(file);
  if (!bytes.toString().trim() || sha256(bytes) !== reference.sha256)
    fail("ARTIFACT_EMPTY_OR_CHANGED");
  return bytes.toString();
}
export function testCount(format, text, inputs) {
  if (
    !Array.isArray(inputs) ||
    !inputs.length ||
    !inputs.every(nonempty) ||
    new Set(inputs).size !== inputs.length
  )
    fail("TEST_INPUTS_EMPTY_OR_DUPLICATE");
  if (format === "vitest-json") {
    const report = JSON.parse(text);
    if (
      report.success !== true ||
      !Array.isArray(report.testResults) ||
      !sameSet(
        report.testResults.map((r) => r.name),
        inputs,
      )
    )
      fail("TEST_DISCOVERY_MISMATCH");
    let count = 0;
    for (const row of report.testResults) {
      if (
        row.status !== "passed" ||
        !Array.isArray(row.assertionResults) ||
        !row.assertionResults.length ||
        row.assertionResults.some((a) => a.status !== "passed")
      )
        fail("TEST_FAILED_EMPTY_OR_SKIPPED");
      count += row.assertionResults.length;
    }
    if (
      report.numTotalTests !== count ||
      report.numPassedTests !== count ||
      report.numFailedTests !== 0 ||
      report.numPendingTests !== 0 ||
      (report.numTodoTests ?? 0) !== 0
    )
      fail("TEST_COUNTS_MISMATCH");
    return count;
  }
  if (format === "go-json") {
    const rows = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (rows.some((r) => ["skip", "fail"].includes(r.Action)))
      fail("TEST_FAILED_OR_SKIPPED");
    const packages = rows
      .filter((r) => r.Action === "pass" && !r.Test)
      .map((r) => r.Package);
    if (!sameSet(packages, inputs)) fail("TEST_DISCOVERY_MISMATCH");
    const tests = rows.filter((r) => r.Action === "pass" && nonempty(r.Test));
    if (
      !inputs.every((p) => tests.some((t) => t.Package === p)) ||
      tests.some((t) => !inputs.includes(t.Package)) ||
      new Set(tests.map((t) => `${t.Package}:${t.Test}`)).size !== tests.length
    )
      fail("TEST_EMPTY_OR_DUPLICATE");
    return tests.length;
  }
  fail("TEST_FORMAT_UNKNOWN");
}
// Binds the operator's pre-commit audit to these exact claims and current subset.
// This declaration is not authentication of the operator or tool receipts.
export function provenanceDigest(evidence) {
  const { source, paths, mapping, checks, selfReview } = evidence;
  return sha256(JSON.stringify({ source, paths, mapping, checks, selfReview }));
}
function requireProvenanceReview(evidence) {
  const review = evidence.provenanceReview;
  if (
    !review ||
    review.role !== "implementing-lead" ||
    review.decision !== "audited-original-current-task-receipts" ||
    !nonempty(review.lead) ||
    !nonempty(review.task) ||
    !nonempty(review.dependencyEvidence)
  )
    fail("PRECOMMIT_PROVENANCE_REVIEW_REQUIRED");
  if (
    review.evidenceSHA256 !== provenanceDigest(evidence) ||
    !Array.isArray(review.receipts) ||
    !review.receipts.every((r) => r && nonempty(r.toolReceipt)) ||
    !sameSet(
      review.receipts.map((r) => r.checkId),
      evidence.checks.map((c) => c.id),
    )
  )
    fail("PRECOMMIT_PROVENANCE_REVIEW_INCONSISTENT");
}
export function validateCheckpoint(evidence, current) {
  if (
    evidence?.version !== 1 ||
    evidence.intent !== "local-unaccepted-checkpoint"
  )
    fail("CHECKPOINT_INTENT_REQUIRED");
  const tested = evidence.source;
  if (
    !/^[a-f0-9]{40}$/u.test(tested?.head ?? "") ||
    !/^[a-f0-9]{64}$/u.test(tested?.index ?? "")
  )
    fail("TESTED_IDENTITY_INVALID");
  if (
    !tested ||
    !["root", "branch", "node", "source"].every(
      (key) => tested[key] === current[key],
    )
  )
    fail("TESTED_SOURCE_CHANGED");
  if (
    !evidence.mapping ||
    JSON.stringify(evidence.mapping.current) !== JSON.stringify(current) ||
    !nonempty(evidence.mapping.rationale)
  )
    fail("CURRENT_MAPPING_REQUIRED");
  if (
    !Array.isArray(evidence.paths) ||
    !evidence.paths.length ||
    new Set(evidence.paths).size !== evidence.paths.length ||
    !Array.isArray(tested.changed) ||
    evidence.paths.some((p) => !tested.changed.includes(p))
  )
    fail("TESTED_SCOPE_REQUIRED");
  if (
    !current.staged.length ||
    !Array.isArray(evidence.mapping.paths) ||
    !sameSet(evidence.mapping.paths, current.staged) ||
    current.staged.some((p) => !evidence.paths.includes(p))
  )
    fail("EXACT_NONEMPTY_STAGED_SCOPE_REQUIRED");
  if (
    !nonempty(evidence.selfReview) ||
    !Array.isArray(evidence.checks) ||
    !evidence.checks.length
  )
    fail("REVIEW_AND_CHECKS_REQUIRED");
  const kinds = new Set(),
    ids = new Set(),
    covered = new Set();
  let tests = 0;
  for (const check of evidence.checks) {
    if (!nonempty(check.id) || ids.has(check.id))
      fail("CHECK_ID_EMPTY_OR_DUPLICATE");
    ids.add(check.id);
    if (
      !["test", "type", "import"].includes(check.kind) ||
      !Array.isArray(check.argv) ||
      !check.argv.length ||
      !check.argv.every(nonempty) ||
      !nonempty(check.cwd) ||
      !nonempty(check.rationale)
    )
      fail("CHECK_COMMAND_OR_MAPPING_REQUIRED");
    if (
      check.terminal !== true ||
      check.exitCode !== 0 ||
      check.signal !== null
    )
      fail("CHECK_NOT_TERMINAL_PASS");
    if (
      !Array.isArray(check.covers) ||
      !check.covers.length ||
      check.covers.some((p) => !evidence.paths.includes(p)) ||
      new Set(check.covers).size !== check.covers.length
    )
      fail("CHECK_SCOPE_INVALID");
    artifact(check.log);
    if (check.kind === "test")
      tests += testCount(check.format, artifact(check.report), check.inputs);
    kinds.add(check.kind);
    check.covers.forEach((p) => covered.add(p));
  }
  if (
    !["test", "type", "import"].every((kind) => kinds.has(kind)) ||
    !tests ||
    !current.staged.every((p) => covered.has(p))
  )
    fail("REQUIRED_CHECK_OR_PATH_MISSING");
  requireProvenanceReview(evidence);
  return {
    status: "LOCAL_CHECKPOINT_ONLY",
    accepted: false,
    tests,
    source: current,
    paths: current.staged,
    testedSource: evidence.source,
    requiredBeforeAcceptance: [
      "complete reviewed coherent range",
      "exact clean full ci:fast including Core/Hunt/security",
      "applicable cross-module and native gates",
      "task package compiler/dependency/source/resource/package attestation",
      "applicable release/update/recovery/live gates",
    ],
  };
}
export function checkEvidence(root, filename) {
  const before = checkpointSnapshot(root);
  const result = validateCheckpoint(
    JSON.parse(fs.readFileSync(filename, "utf8")),
    before,
  );
  // Equivalence permits only forward coherent checkpoints on this writer.
  git(
    root,
    "merge-base",
    "--is-ancestor",
    result.testedSource.head,
    before.head,
  );
  git(root, "diff", "--check");
  git(root, "diff", "--cached", "--check");
  // Require exactly the tested staged bytes for every proposed commit path.
  for (const file of before.staged)
    if (git(root, "diff", "--name-only", "--", file).length)
      fail(`STAGED_WORKTREE_MISMATCH:${file}`);
  if (JSON.stringify(checkpointSnapshot(root)) !== JSON.stringify(before))
    fail("SOURCE_MOVED_DURING_CHECK");
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    let result;
    if (args.length === 1 && args[0] === "--snapshot")
      result = checkpointSnapshot(process.cwd());
    else if (args.length === 2 && args[0] === "--evidence")
      result = checkEvidence(process.cwd(), args[1]);
    else
      fail(
        "USAGE: checkpoint.mjs --snapshot | --evidence /absolute/receipt.json",
      );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`CHECKPOINT_REFUSED: ${error.message}\n`);
    process.exitCode = 2;
  }
}
