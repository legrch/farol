import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import mainVitestConfig from "../../vitest.config.ts";
import { waitForOwnedSecondary } from "../e2e/owned-background-secondary.mjs";
import {
  classifyTests,
  planTests,
  fastIntegrationFiles,
  integrationUnitFiles,
  unitIntegrationFiles,
  nodeSelftests,
} from "../../tooling/test-scope-plan.mjs";
import {
  discoverTests,
  parseScopeArgs,
  suiteCommand,
  testEnvironment,
  vitestCounts,
  goCounts,
  nodeCounts,
  scopeStatus,
  installScopeSignals,
  selectionDigest,
} from "../../tooling/test-scopes.mjs";

const files = discoverTests();
const classified = classifyTests(files);
const selectedFiles = (plan) =>
  plan.suites.flatMap((suite) => suite.files ?? []);

describe("source test scopes", () => {
  it("includes the pure current-React Setup observer in unit and fast without claiming native E2E", () => {
    const observer = "tests/e2e/current-react-setup-action.test.mjs";
    expect(classified.nodeUnit).toContain(observer);
    for (const scope of ["unit", "fast"])
      expect(selectedFiles(planTests(scope, files))).toContain(observer);
    expect(selectedFiles(planTests("integration", files))).not.toContain(
      observer,
    );
  });
  it("keeps repository config native helpers outside unit and fast scopes", () => {
    const pure = "tests/unit/repository-config-access.test.ts";
    const native = "tests/integration/repository-config-access.test.ts";
    for (const scope of ["unit", "fast"]) {
      const selected = selectedFiles(planTests(scope, files));
      expect(selected).toContain(pure);
      expect(selected).not.toContain(native);
    }
    const selected = selectedFiles(planTests("integration", files));
    expect(selected).toContain(native);
    expect(selected).not.toContain(pure);
  });
  it("C09 assigns TSX fixtures to their scope and the actual main runner includes them", () => {
    const fixture = "tests/e2e/fixtures/discovery-example.test.tsx";
    const unit = "tests/unit/discovery-example.test.tsx";
    const next = classifyTests([...files, fixture, unit]);
    expect(next.integration).toContain(fixture);
    expect(next.nodeUnit).toContain(unit);
    expect(
      selectedFiles(planTests("unit", [...files, fixture, unit])),
    ).not.toContain(fixture);
    expect(
      selectedFiles(planTests("integration", [...files, fixture, unit])),
    ).not.toContain(unit);
    const accepted = (file) =>
      mainVitestConfig.test.include.some((pattern) =>
        path.matchesGlob(file, pattern),
      ) &&
      !mainVitestConfig.test.exclude.some((pattern) =>
        path.matchesGlob(file, pattern),
      );
    expect(accepted(fixture)).toBe(true);
    expect(accepted(unit)).toBe(true);
    expect(accepted("tests/renderer/discovery-example.test.tsx")).toBe(false);
  });
  it("binds the cancellation supervisor bytes even though it is not a discovered test file", () => {
    const before = selectionDigest([], () => "original");
    const changed = selectionDigest([], (file) =>
      file === "tests/e2e/owned-background-secondary.mjs"
        ? "changed"
        : "original",
    );
    expect(changed).not.toBe(before);
  });
  it("accounts for every discovered source once, with disjoint unit/integration selections", () => {
    const unit = planTests("unit", files);
    const integration = planTests("integration", files);
    const all = [...selectedFiles(unit), ...selectedFiles(integration)];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(
      files.filter((file) => !file.endsWith("_test.go")),
    );
    const goPackages = [...classified.goUnit, ...classified.goIntegration];
    expect(new Set(goPackages).size).toBe(goPackages.length);
    for (const file of files.filter((name) => name.endsWith("_test.go"))) {
      const nested = file.startsWith("resources/native/go/");
      const relative = nested
        ? file.slice("resources/native/go/".length)
        : file;
      expect(nested ? classified.goRelease : goPackages).toContain(
        "./" + path.posix.dirname(relative),
      );
    }
    expect(
      integration.suites.find((suite) => suite.runner === "node").files,
    ).toEqual(nodeSelftests);
  });

  it("classifies by reviewed behavior instead of the legacy folder alone", () => {
    for (const file of integrationUnitFiles)
      expect(classified.integration).toContain(file);
    for (const file of unitIntegrationFiles)
      expect(classified.nodeUnit).toContain(file);
    expect(classified.goUnit).toContain(
      "./modules/chat/app/services/lifecycle",
    );
    expect(classified.goIntegration).toContain(
      "./modules/chat/infra/repos/handoff",
    );
  });

  it("bounds each serial integration group without dropping or repeating a file", () => {
    const suites = planTests("integration", files).suites.filter(
      (suite) => suite.runner === "vitest",
    );
    expect(suites.length).toBeGreaterThan(1);
    expect(suites.flatMap((suite) => suite.files)).toEqual(
      classified.integration,
    );
    for (const suite of suites) {
      expect(suite.files.length).toBeGreaterThan(0);
      expect(suite.files.length).toBeLessThanOrEqual(16);
      expect(suite.timeoutMs).toBe(300000);
    }
  });

  it("fast is exactly unit plus four explicit integration files, without repeats", () => {
    const unit = planTests("unit", files);
    const fast = planTests("fast", files);
    expect(selectedFiles(fast).sort()).toEqual(
      [...selectedFiles(unit), ...fastIntegrationFiles].sort(),
    );
    expect(new Set(selectedFiles(fast)).size).toBe(selectedFiles(fast).length);
    expect(fast.suites.filter((suite) => suite.runner === "go")).toEqual(
      unit.suites.filter((suite) => suite.runner === "go"),
    );
  });

  it.each([
    ["empty discovery", () => classifyTests([])],
    ["duplicate source", () => classifyTests([...files, files[0]])],
    [
      "unknown test root",
      () => classifyTests([...files, "tests/new-scope/one.test.ts"]),
    ],
    [
      "unknown Go root",
      () => classifyTests([...files, "new-module/one_test.go"]),
    ],
    [
      "missing declared source",
      () =>
        classifyTests(files.filter((file) => file !== fastIntegrationFiles[0])),
    ],
    ["traversal", () => classifyTests([...files, "tests/../one.test.ts"])],
    ["absolute source", () => classifyTests([...files, "/one.test.ts"])],
    ["undeclared scope", () => planTests("all", files)],
  ])("refuses %s before running anything", (_name, action) =>
    expect(action).toThrow(),
  );

  it("accepts only explicit scope and optional list arguments", () => {
    expect(parseScopeArgs(["--scope=unit", "--list"])).toEqual({
      scope: "unit",
      list: true,
    });
    for (const args of [
      [],
      ["--scope=live"],
      ["--scope=unit", "--scope=unit"],
      ["--scope=fast", "--list", "--list"],
      ["--scope=unit", "--runInBand"],
    ]) {
      expect(() => parseScopeArgs(args)).toThrow();
    }
  });

  it("uses exact selected paths and packages with no nested aggregate or implicit dependency download", () => {
    for (const scope of ["unit", "integration", "fast"]) {
      for (const suite of planTests(scope, files).suites) {
        const command = suiteCommand(
          suite,
          "/reports",
          "/tools/node",
          "/tools/go",
        );
        expect(command.args).not.toContain("./...");
        expect(command.args).not.toContain("npm");
        for (const selected of suite.files ?? suite.packages)
          expect(command.args).toContain(selected);
        expect(suite.timeoutMs).toBeGreaterThan(0);
        expect(suite.timeoutMs).toBeLessThanOrEqual(300000);
      }
    }
    const environment = testEnvironment(
      {
        HOME: "/fixture/home",
        PATH: "/usr/bin",
        FAROL_TEST_GO: "/tools/go",
        OPENAI_API_KEY: "synthetic",
        NODE_OPTIONS: "--inspect",
        HTTPS_PROXY: "synthetic",
        GOTOOLCHAIN: "auto",
        GOPROXY: "synthetic",
        FAROL_NEXT_E2E: "1",
      },
      "/tools/node",
    );
    expect(environment).toMatchObject({
      HOME: "/fixture/home",
      PATH: "/tools:/usr/bin",
      FAROL_TEST_GO: "/tools/go",
      GOTOOLCHAIN: "local",
      GOPROXY: "off",
      GOSUMDB: "off",
    });
    for (const key of [
      "OPENAI_API_KEY",
      "NODE_OPTIONS",
      "HTTPS_PROXY",
      "FAROL_NEXT_E2E",
    ])
      expect(environment).not.toHaveProperty(key);
  });
});

describe("observed test reports", () => {
  const report = () => ({
    numTotalTests: 4,
    numPassedTests: 2,
    numFailedTests: 0,
    numPendingTests: 1,
    numTodoTests: 1,
    success: true,
    testResults: [
      {
        name: "/one.test.ts",
        status: "passed",
        assertionResults: [
          { status: "passed" },
          { status: "passed" },
          { status: "skipped" },
          { status: "todo" },
        ],
      },
    ],
  });
  it("requires exact Vitest file observations, including no substring overmatch", () => {
    expect(vitestCounts(report(), ["/one.test.ts"])).toEqual({
      total: 4,
      passed: 2,
      failed: 0,
      skipped: 1,
      todo: 1,
      reportedSuccess: true,
    });
    for (const required of [
      ["/other.test.ts"],
      ["/one.test.ts", "/missing.test.ts"],
      [],
    ])
      expect(() => vitestCounts(report(), required)).toThrow("FILES_MISMATCH");
    const duplicate = report();
    duplicate.testResults.push(duplicate.testResults[0]);
    expect(() =>
      vitestCounts(duplicate, ["/one.test.ts", "/other.test.ts"]),
    ).toThrow("FILES_MISMATCH");
  });
  it("refuses zero, inconsistent or unsuccessful Vitest reports", () => {
    for (const change of [
      { numTotalTests: 0 },
      { numTotalTests: 5 },
      { numPassedTests: -1 },
      {
        testResults: [
          { name: "/one.test.ts", status: "passed", assertionResults: [] },
        ],
      },
    ]) {
      expect(() =>
        vitestCounts({ ...report(), ...change }, ["/one.test.ts"]),
      ).toThrow();
    }
  });
  it("retains failed Vitest counts and rejects unfinished assertions", () => {
    const failed = report();
    failed.numPassedTests = 1;
    failed.numFailedTests = 1;
    failed.success = false;
    failed.testResults[0].status = "failed";
    failed.testResults[0].assertionResults[0].status = "failed";
    expect(vitestCounts(failed, ["/one.test.ts"])).toMatchObject({
      passed: 1,
      failed: 1,
      reportedSuccess: false,
    });
    const pending = report();
    pending.testResults[0].assertionResults[2].status = "pending";
    expect(() => vitestCounts(pending, ["/one.test.ts"])).toThrow(
      "ASSERTION_INCOMPLETE",
    );
    const inconsistent = report();
    inconsistent.testResults[0].assertionResults[2].status = "passed";
    expect(() => vitestCounts(inconsistent, ["/one.test.ts"])).toThrow(
      "ASSERTION_COUNTS_INVALID",
    );
  });
  const events = (packages) =>
    packages
      .flatMap((Package) => [
        { Action: "pass", Package, Test: "TestOne" },
        { Action: "pass", Package },
      ])
      .map((event) => JSON.stringify(event))
      .join("\n");
  it("requires exact Go packages and nonempty tests, including subtest counts", () => {
    expect(
      goCounts(events(["farol/one", "farol/two"]), ["farol/one", "farol/two"]),
    ).toMatchObject({
      total: 2,
      passed: 2,
      packages: 2,
      includesSubtests: true,
    });
    expect(() => goCounts(events(["farol/other"]), ["farol/one"])).toThrow(
      "PACKAGE_UNEXPECTED",
    );
    expect(() =>
      goCounts(events(["farol/one"]), ["farol/one", "farol/two"]),
    ).toThrow("INCOMPLETE");
    expect(() =>
      goCounts(events(["farol/one", "farol/one"]), ["farol/one"]),
    ).toThrow("DUPLICATE");
    expect(() =>
      goCounts('{"Action":"pass","Package":"farol/one"}', ["farol/one"]),
    ).toThrow("INCOMPLETE");
  });
  it("retains Go test counts when the package reports a normal assertion failure", () => {
    const output = events(["farol/one"]).replaceAll('"pass"', '"fail"');
    expect(goCounts(output, ["farol/one"])).toMatchObject({
      total: 1,
      failed: 1,
      passed: 0,
      reportedSuccess: false,
    });
  });
  it("requires one complete nonzero TAP summary with no cancellation", () => {
    const tap =
      "# tests 3\n# pass 2\n# fail 0\n# skipped 1\n# todo 0\n# cancelled 0\n";
    expect(nodeCounts(tap)).toMatchObject({ total: 3, passed: 2, skipped: 1 });
    for (const invalid of [
      "",
      tap + tap,
      tap.replace("cancelled 0", "cancelled 1"),
      tap.replace("tests 3", "tests 0"),
      tap.replace("pass 2", "pass 0").replace("skipped 1", "skipped 3"),
    ])
      expect(() => nodeCounts(invalid)).toThrow();
  });
  it("never upgrades prerequisites, unknown children, missing suites or changed selections to PASS", () => {
    const base = { failed: 0, blocked: 0, notRun: 0, scopeErrors: [] };
    expect(scopeStatus(base)).toBe("PASS");
    expect(
      scopeStatus({ ...base, prerequisiteError: "missing tool", notRun: 3 }),
    ).toBe("BLOCKED");
    expect(scopeStatus({ ...base, blocked: 1 })).toBe("BLOCKED");
    for (const change of [
      { failed: 1 },
      { notRun: 1 },
      { scopeErrors: ["TEST_SELECTION_CHANGED_DURING_RUN"] },
      { cancelled: "SIGTERM" },
    ])
      expect(scopeStatus({ ...base, ...change })).toBe("FAIL");
  });
});

describe("scope cancellation without a real child", () => {
  afterEach(() => vi.useRealTimers());
  it.each(["SIGINT", "SIGTERM"])(
    "observes one owned terminal after %s and removes signal handlers",
    async (signal) => {
      vi.useFakeTimers();
      const source = new EventEmitter();
      const cancellation = installScopeSignals(source);
      const child = Object.assign(new EventEmitter(), {
        pid: 1234,
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn(),
        stdout: { destroy: vi.fn() },
        stderr: { destroy: vi.fn() },
        unref: vi.fn(),
      });
      child.kill.mockImplementation(() => {
        setTimeout(() => {
          child.signalCode = "SIGTERM";
          child.emit("close", null, "SIGTERM");
        }, 2);
        return true;
      });
      const waiting = waitForOwnedSecondary(child, {
        timeoutMs: 300000,
        cleanupTimeoutMs: 10,
        stopSignal: cancellation.signal,
      });
      source.emit(signal);
      source.emit(signal);
      await vi.advanceTimersByTimeAsync(15);
      expect(await waiting).toMatchObject({
        cancelled: true,
        timedOut: false,
        terminal: true,
        signal: "SIGTERM",
      });
      expect(cancellation.signal.reason).toBe(signal);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      cancellation.dispose();
      expect(source.listenerCount("SIGINT")).toBe(0);
      expect(source.listenerCount("SIGTERM")).toBe(0);
    },
  );
  it("retains unknown cancellation after a bounded wait without a second signal", async () => {
    vi.useFakeTimers();
    const source = new EventEmitter();
    const cancellation = installScopeSignals(source);
    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: vi.fn(() => true),
      stdout: { destroy: vi.fn() },
      stderr: { destroy: vi.fn() },
      unref: vi.fn(),
    });
    const waiting = waitForOwnedSecondary(child, {
      timeoutMs: 300000,
      cleanupTimeoutMs: 10,
      stopSignal: cancellation.signal,
    });
    source.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(15);
    expect(await waiting).toMatchObject({
      cancelled: true,
      terminal: false,
      stopRequested: true,
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledOnce();
    cancellation.dispose();
  });
});
