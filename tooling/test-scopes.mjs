// Source-level deterministic test scopes. This runner never builds a candidate,
// opens the product, qualifies a live provider, or claims full containment.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { planTests, scopes } from "./test-scope-plan.mjs";
import { waitForOwnedSecondary } from "../tests/e2e/owned-background-secondary.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const supportedNode = new Set(["24.20.0", "26.7.0"]);
const roots = [
  "tests",
  "modules",
  "boot",
  "gen",
  "transport",
  "pkg",
  "resources/native/go",
];

export function discoverTests(root = repository) {
  const files = [];
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "_output"].includes(entry.name)
      )
        continue;
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (
        file.endsWith("_test.go") ||
        /^tests\/.+\.(test\.(ts|tsx|mjs)|selftest\.mjs)$/u.test(file)
      ) {
        if (!entry.isFile()) throw Error("TEST_SOURCE_NOT_REGULAR:" + file);
        files.push(file);
      }
    }
  }
  for (const directory of roots) walk(directory);
  return files.sort();
}

export function parseScopeArgs(args) {
  let scope,
    list = false;
  for (const arg of args) {
    if (arg === "--list" && !list) list = true;
    else if (arg.startsWith("--scope=") && scope === undefined)
      scope = arg.slice(8);
    else throw Error("TEST_ARGUMENT_INVALID:" + arg);
  }
  if (!scopes.includes(scope)) throw Error("TEST_SCOPE_INVALID");
  return { scope, list };
}

export function testEnvironment(input, node = process.execPath) {
  const result = {};
  for (const key of [
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "GOCACHE",
    "GOPATH",
    "GOMODCACHE",
    "SDKROOT",
    "DEVELOPER_DIR",
  ]) {
    if (typeof input[key] === "string" && input[key]) result[key] = input[key];
  }
  result.PATH =
    path.dirname(node) + path.delimiter + (input.PATH ?? "/usr/bin:/bin");
  result.GOTOOLCHAIN = "local";
  result.GOPROXY = "off";
  result.GOSUMDB = "off";
  result.CI = "1";
  result.NO_COLOR = "1";
  result.FAROL_TEST_GO = input.FAROL_TEST_GO ?? "go";
  return result;
}

export function suiteCommand(
  suite,
  reportDirectory,
  node = process.execPath,
  go = "go",
) {
  if (suite.runner === "go") {
    return {
      executable: go,
      args: ["test", "-json", "-count=1", ...suite.packages],
    };
  }
  if (suite.runner === "node")
    return {
      executable: node,
      args: ["--test", "--test-reporter=tap", ...suite.files],
    };
  return {
    executable: node,
    args: [
      path.join(repository, "node_modules/vitest/vitest.mjs"),
      "run",
      ...suite.files,
      ...(suite.config ? ["--config", suite.config] : []),
      ...(suite.testNamePattern
        ? ["--testNamePattern", suite.testNamePattern]
        : []),
      // Threads share the process fd table even with Vitest module isolation.
      // A sibling can reuse a just-closed fd before the loader's EBADF witness.
      // Keep that witness in a separate process without changing its assertions.
      suite.files.includes("tests/integration/go-connector-launch.test.ts")
        ? "--pool=forks"
        : "--pool=threads",
      `--maxWorkers=${suite.workers ?? 1}`,
      ...(suite.workers === 2 ? [] : ["--no-file-parallelism"]),
      "--reporter=default",
      "--reporter=json",
      "--outputFile.json=" + path.join(reportDirectory, suite.id + ".json"),
    ],
  };
}

export function vitestCounts(report, requiredFiles) {
  const fields = [
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
  ];
  for (const field of fields) {
    if (!Number.isSafeInteger(report[field]) || report[field] < 0)
      throw Error("TEST_REPORT_INVALID");
  }
  if (
    report.numTotalTests === 0 ||
    report.numPassedTests + report.numFailedTests === 0
  )
    throw Error("TEST_ZERO_EXECUTED");
  if (
    report.numPassedTests +
      report.numFailedTests +
      report.numPendingTests +
      report.numTodoTests !==
    report.numTotalTests
  ) {
    throw Error("TEST_REPORT_COUNTS_INVALID");
  }
  const observed = report.testResults?.map((file) => file.name);
  if (
    !observed ||
    observed.length !== requiredFiles.length ||
    new Set(observed).size !== observed.length ||
    requiredFiles.some((file) => !observed.includes(file))
  )
    throw Error("TEST_REPORT_FILES_MISMATCH");
  if (
    typeof report.success !== "boolean" ||
    report.testResults.some(
      (file) =>
        !["passed", "failed"].includes(file.status) ||
        !file.assertionResults?.length,
    )
  )
    throw Error("TEST_REPORT_INCOMPLETE");
  const assertions = report.testResults.flatMap(
    (file) => file.assertionResults,
  );
  if (
    assertions.some(
      (assertion) =>
        !["passed", "failed", "skipped", "todo"].includes(assertion.status),
    )
  )
    throw Error("TEST_ASSERTION_INCOMPLETE");
  const tally = (status) =>
    assertions.filter((assertion) => assertion.status === status).length;
  if (
    assertions.length !== report.numTotalTests ||
    tally("passed") !== report.numPassedTests ||
    tally("failed") !== report.numFailedTests ||
    tally("skipped") !== report.numPendingTests ||
    tally("todo") !== report.numTodoTests
  )
    throw Error("TEST_ASSERTION_COUNTS_INVALID");
  return {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
    todo: report.numTodoTests,
    reportedSuccess:
      report.success &&
      report.testResults.every((file) => file.status === "passed"),
  };
}

export function goCounts(output, requiredPackages) {
  const events = output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const tests = new Map(),
    packages = new Map();
  for (const event of events) {
    if (
      typeof event.Package !== "string" ||
      !requiredPackages.includes(event.Package)
    )
      throw Error("GO_TEST_PACKAGE_UNEXPECTED");
    if (
      ["pass", "fail", "skip"].includes(event.Action) &&
      typeof event.Test === "string"
    ) {
      tests.set(event.Package + "\0" + event.Test, event.Action);
    }
    if (
      ["pass", "fail", "skip"].includes(event.Action) &&
      !Object.hasOwn(event, "Test")
    ) {
      if (packages.has(event.Package)) throw Error("GO_TEST_PACKAGE_DUPLICATE");
      packages.set(event.Package, event.Action);
    }
  }
  if (
    packages.size !== requiredPackages.length ||
    requiredPackages.some(
      (name) =>
        !packages.has(name) ||
        ![...tests.keys()].some((test) => test.startsWith(name + "\0")),
    )
  )
    throw Error("GO_TEST_REPORT_INCOMPLETE");
  const values = [...tests.values()];
  if (!values.some((value) => value === "pass" || value === "fail"))
    throw Error("TEST_ZERO_EXECUTED");
  return {
    total: values.length,
    passed: values.filter((v) => v === "pass").length,
    failed: values.filter((v) => v === "fail").length,
    skipped: values.filter((v) => v === "skip").length,
    todo: 0,
    packages: packages.size,
    includesSubtests: true,
    reportedSuccess: [...packages.values()].every((value) => value === "pass"),
  };
}

export function nodeCounts(output) {
  const count = (name) => {
    const matches = [
      ...output.matchAll(new RegExp("^# " + name + " ([0-9]+)$", "gm")),
    ];
    if (matches.length !== 1) throw Error("NODE_TEST_REPORT_INVALID");
    const value = Number(matches[0][1]);
    if (!Number.isSafeInteger(value)) throw Error("NODE_TEST_REPORT_INVALID");
    return value;
  };
  const result = {
    total: count("tests"),
    passed: count("pass"),
    failed: count("fail"),
    skipped: count("skipped"),
    todo: count("todo"),
  };
  if (
    result.total === 0 ||
    result.passed + result.failed === 0 ||
    count("cancelled") !== 0 ||
    result.total !==
      result.passed + result.failed + result.skipped + result.todo
  )
    throw Error("NODE_TEST_REPORT_INCOMPLETE");
  return result;
}

export function selectionDigest(
  files,
  read = (file) => fs.readFileSync(path.join(repository, file)),
) {
  const hash = createHash("sha256");
  const sources = [
    ...new Set([
      ...files,
      "tooling/test-scopes.mjs",
      "tooling/test-scope-plan.mjs",
      "tooling/cloud-test-prerequisites.mjs",
      "tests/e2e/owned-background-secondary.mjs",
      "vitest.config.ts",
      "vitest.renderer.config.ts",
      "go.mod",
      "resources/native/go/go.mod",
    ]),
  ].sort();
  for (const file of sources)
    hash
      .update(file + "\0")
      .update(read(file))
      .update("\0");
  return hash.digest("hex");
}

async function executeSuite(
  suite,
  directory,
  environment,
  onStarted,
  stopSignal,
) {
  const command = suiteCommand(
    suite,
    directory,
    process.execPath,
    environment.FAROL_TEST_GO,
  );
  const child = spawn(command.executable, command.args, {
    cwd: path.join(repository, suite.cwd),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = {
    id: suite.id,
    command,
    pid: child.pid ?? null,
    status: "RUNNING",
    stdoutBytes: 0,
    stderrBytes: 0,
  };
  const output = { stdout: "", stderr: "" };
  const terminal = waitForOwnedSecondary(child, {
    timeoutMs: suite.timeoutMs,
    cleanupTimeoutMs: 5000,
    stopSignal,
    onObservation: (value) => {
      (record.observations ??= []).push(value);
    },
  });
  const limit = 16 * 1024 * 1024;
  for (const name of ["stdout", "stderr"]) {
    child[name].on("data", (chunk) => {
      record[name + "Bytes"] += chunk.length;
      if (record[name + "Bytes"] > limit) record.outputLimit = true;
      else output[name] += chunk.toString("utf8");
    });
  }
  // Observation is installed before receipt I/O: a write failure must not leave
  // an issued child without its one bounded terminal observation.
  try {
    onStarted(record);
  } catch (error) {
    record.error = String(error);
  }
  record.terminal = await terminal;
  record.status = "FAIL";
  try {
    for (const name of ["stdout", "stderr"])
      fs.writeFileSync(
        path.join(directory, suite.id + "." + name + ".log"),
        output[name],
      );
    if (!record.outputLimit && !record.error) {
      if (suite.runner === "go") {
        const module =
          suite.cwd === "." ? "github.com/legrch/farol" : "farol.local/native";
        record.counts = goCounts(
          output.stdout,
          suite.packages.map((name) => module + name.slice(1)),
        );
      } else if (suite.runner === "node")
        record.counts = nodeCounts(output.stdout);
      else {
        const file = path.join(directory, suite.id + ".json");
        if (fs.statSync(file).size > limit) throw Error("TEST_REPORT_LIMIT");
        record.counts = vitestCounts(
          JSON.parse(fs.readFileSync(file, "utf8")),
          suite.files.map((name) => path.join(repository, name)),
        );
      }
      if (
        record.terminal.terminal &&
        record.terminal.exit === 0 &&
        record.terminal.signal === null &&
        !record.terminal.timedOut &&
        !record.terminal.cancelled &&
        !stopSignal.aborted &&
        record.counts.failed === 0 &&
        record.counts.reportedSuccess !== false
      )
        record.status = "PASS";
    }
  } catch (error) {
    record.error = String(error);
    record.countsUnavailable = true;
  }
  if (!record.terminal.terminal) record.status = "BLOCKED";
  return record;
}

export function installScopeSignals(source) {
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  source.on("SIGINT", interrupt);
  source.on("SIGTERM", terminate);
  return {
    signal: controller.signal,
    dispose() {
      source.removeListener("SIGINT", interrupt);
      source.removeListener("SIGTERM", terminate);
    },
  };
}

export async function runScope(args = process.argv.slice(2)) {
  const cancellation = installScopeSignals(process);
  try {
    return await executeScope(args, cancellation.signal);
  } finally {
    cancellation.dispose();
  }
}

async function executeScope(args, stopSignal) {
  const { scope, list } = parseScopeArgs(args);
  const files = discoverTests();
  const plan = planTests(scope, files);
  if (list) {
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return 0;
  }
  const environment = testEnvironment(process.env);
  const directory = path.join(
    repository,
    "_output/evidence/test-scopes",
    randomUUID(),
  );
  fs.mkdirSync(directory, { recursive: true });
  const before = selectionDigest(files);
  const report = {
    ...plan,
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    selectionSHA256: before,
    source: "current working tree; not candidate attestation",
    selected: plan.suites.length,
    executed: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    notRun: plan.suites.length,
    results: [],
    scopeErrors: [],
  };
  const save = () =>
    fs.writeFileSync(
      path.join(directory, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  save();
  try {
    if (scope === "native" && process.platform !== "darwin")
      throw Error("TEST_NATIVE_PREREQUISITE:darwin");
    if (!supportedNode.has(process.versions.node))
      throw Error("TEST_NODE_PREREQUISITE:" + process.versions.node);
    report.go = execFileSync(environment.FAROL_TEST_GO, ["version"], {
      cwd: repository,
      env: environment,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (!report.go.startsWith("go version go1.26.2 "))
      throw Error("TEST_GO_PREREQUISITE:" + report.go);
  } catch (error) {
    report.prerequisiteError = String(error);
  }
  if (!report.prerequisiteError) {
    try {
      for (const suite of plan.suites) {
        if (stopSignal.aborted) break;
        const result = await executeSuite(
          suite,
          directory,
          environment,
          (pending) => {
            report.results.push(pending);
            report.executed++;
            report.notRun--;
            save();
          },
          stopSignal,
        );
        if (result.status === "PASS") report.passed++;
        else if (result.status === "BLOCKED") report.blocked++;
        else report.failed++;
        save();
        if (result.status !== "PASS") break; // Never retry an issued suite.
      }
      if (selectionDigest(discoverTests()) !== before)
        report.scopeErrors.push("TEST_SELECTION_CHANGED_DURING_RUN");
    } catch (error) {
      report.scopeErrors.push(String(error));
    }
  }
  if (stopSignal.aborted) report.cancelled = stopSignal.reason;
  report.status = scopeStatus(report);
  report.finishedAt = new Date().toISOString();
  save();
  process.stdout.write(
    JSON.stringify({
      scope,
      status: report.status,
      selected: report.selected,
      executed: report.executed,
      passed: report.passed,
      failed: report.failed,
      blocked: report.blocked,
      notRun: report.notRun,
      report: path.join(directory, "report.json"),
    }) + "\n",
  );
  return report.status === "PASS" ? 0 : 1;
}

export function scopeStatus(report) {
  if (report.prerequisiteError || report.blocked) return "BLOCKED";
  if (
    report.failed ||
    report.notRun ||
    report.scopeErrors.length ||
    report.cancelled
  )
    return "FAIL";
  return "PASS";
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runScope();
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  }
}
