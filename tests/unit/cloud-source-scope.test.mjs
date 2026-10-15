import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  cloudDeferredFiles,
  cloudMixedFiles,
  cloudSelection,
  cloudPattern,
} from "../../tooling/cloud-test-prerequisites.mjs";
import { planTests } from "../../tooling/test-scope-plan.mjs";
import {
  discoverTests,
  suiteCommand,
  selectionDigest,
} from "../../tooling/test-scopes.mjs";

const files = discoverTests();
describe("Cloud source scope", () => {
  it("includes every ordinary file by default and records every deferred resource boundary", () => {
    const plan = planTests("cloud", files);
    const selected = plan.suites.flatMap((suite) => suite.files ?? []);
    const all = files.filter((file) => !file.endsWith("_test.go"));
    expect(new Set(selected).size).toBe(selected.length);
    expect(
      [...selected, ...plan.deferredFiles.map((entry) => entry.file)].sort(),
    ).toEqual(all);
    for (const entry of plan.deferredFiles)
      expect(entry.prerequisite.length).toBeGreaterThan(20);
    expect(selected).toContain("tests/unit/shell-support-build.test.mjs");
    expect(selected).toContain("tests/unit/installed-update-startup.test.ts");
    expect(selected).toContain("tests/integration/bounded-process.test.mjs");
    expect(plan.goChecks).toContain("test:core");
  });
  it("keeps source Hunt properties in Cloud and build-bound reporting in full CI", () => {
    const plan = planTests("cloud", files);
    const selected = plan.suites.flatMap((suite) => suite.files ?? []);
    for (const file of [
      "tests/hunt/model.test.ts",
      "tests/hunt/proof.test.ts",
      "tests/hunt/selftest.test.ts",
    ])
      expect(selected).toContain(file);
    const scripts = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ).scripts;
    expect(scripts["ci:cloud"]).not.toContain("hunt:report");
    expect(scripts.ci).toContain("hunt:report");
    expect(plan.artifactGates).toContain("NOT RUN");
    for (const suite of plan.suites.filter(
      (item) => item.id.startsWith("node-cloud-") && !item.id.includes("mixed"),
    )) {
      expect(suiteCommand(suite, "/reports", "/node", "/go").args).toContain(
        "--maxWorkers=2",
      );
      expect(suite.timeoutMs).toBe(300000);
    }
    for (const suite of planTests("unit", files).suites.filter(
      (item) => item.runner === "vitest",
    ))
      expect(suiteCommand(suite, "/reports", "/node", "/go").args).toContain(
        "--no-file-parallelism",
      );
  });
  it("includes new portable files without a passing-test allowlist", () => {
    const added = "tests/integration/new-portable-contract.test.ts";
    const plan = planTests("cloud", [...files, added]);
    expect(plan.suites.flatMap((suite) => suite.files ?? [])).toContain(added);
  });
  it("refuses stale native declarations instead of silently retaining an exception", () => {
    expect(() =>
      cloudSelection(
        files.filter((file) => file !== cloudDeferredFiles[0].file),
      ),
    ).toThrow("CLOUD_PREREQUISITE_DECLARATION_INVALID");
  });
  it("retains mixed-file portable tests and passes an escaped native-case selector to Vitest", () => {
    const plan = planTests("cloud", files);
    for (const entry of cloudMixedFiles) {
      const suite = plan.suites.find(
        (candidate) =>
          candidate.files?.length === 1 && candidate.files[0] === entry.file,
      );
      const pattern = new RegExp(suite.testNamePattern);
      if (entry.excludedTests) {
        expect(pattern.test("group a new portable assertion")).toBe(true);
        for (const name of entry.excludedTests)
          expect(pattern.test("group " + name)).toBe(false);
      } else {
        expect(
          pattern.test(entry.includedSuite + " validates a response"),
        ).toBe(true);
        expect(
          pattern.test("public full-read raw source digest native read"),
        ).toBe(false);
      }
      expect(suiteCommand(suite, "/reports", "/node", "/go").args).toContain(
        suite.testNamePattern,
      );
    }
    const pattern = new RegExp(
      cloudPattern({ excludedTests: ["literal (a)+.[b]?"] }),
    );
    expect(pattern.test("group literal (a)+.[b]?")).toBe(false);
    expect(pattern.test("group literal aaaaxb")).toBe(true);
  });
  it("binds selection policy bytes and never labels its partial selection as native acceptance", () => {
    const before = selectionDigest([], () => "original");
    expect(
      selectionDigest([], (file) =>
        file === "tooling/cloud-test-prerequisites.mjs"
          ? "changed"
          : "original",
      ),
    ).not.toBe(before);
    const plan = planTests("cloud", files);
    expect(plan.claim).toContain("NOT RUN");
    expect(plan.deferredFiles.some((entry) => entry.mixed)).toBe(true);
    expect(plan.suites.some((suite) => suite.runner === "go")).toBe(false);
    expect(plan.suites.find((suite) => suite.runner === "node").files).toEqual([
      "tests/fixtures/ordinary-git-environment.selftest.mjs",
    ]);
  });
});
