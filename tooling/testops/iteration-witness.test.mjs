// A controlled synthetic execution witness, not a public affected-test executor.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { snapshot, typescriptGraph } from "./languagegraph.mjs";
import { vitestCounts } from "../test-scopes.mjs";
import { waitForOwnedSecondary } from "../../tests/e2e/owned-background-secondary.mjs";

const repository = path.resolve(import.meta.dirname, "../..");

test("fresh compiler planning executes exactly the affected fixture files and preserves full-run case membership", async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "testops-iteration-")),
  );
  const output = path.join(root, "_output");
  const env = {
    PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
    HOME: path.join(output, "home"),
    TMPDIR: path.join(output, "tmp"),
    CI: "1",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const files = {
    ".gitignore": "_output/\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
      },
      include: ["tests/**/*.ts"],
    }),
    "tsconfig.renderer.json": '{"extends":"./tsconfig.json"}',
    "vitest.config.mjs":
      'export default {cacheDir:"_output/vite",test:{globals:true,include:["tests/**/*.test.ts"],pool:"threads",maxWorkers:1,fileParallelism:false}};\n',
    "tests/a.test.ts":
      'export const value=1; it("direct",()=>expect(value).toBe(1));\n',
    "tests/consumer.test.ts":
      'import {value} from "./a.test.js"; it("consumer",()=>expect(value+1).toBe(2));\n',
    "tests/unrelated.test.ts": 'it("unrelated",()=>expect(3).toBe(3));\n',
  };
  let complete = false;
  try {
    for (const [file, bytes] of Object.entries(files)) {
      const absolute = path.join(root, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, bytes, { flag: "wx" });
    }
    for (const directory of [env.HOME, env.TMPDIR])
      fs.mkdirSync(directory, { recursive: true });
    const git = (...args) =>
      execFileSync(
        "/usr/bin/git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ],
        { cwd: root, env, stdio: "pipe" },
      );
    git("init", "-q");
    git("add", ".");
    git("commit", "--no-gpg-sign", "-qm", "fixture");
    fs.appendFileSync(
      path.join(root, "tests/a.test.ts"),
      "// controlled working-tree test change\n",
    );
    const source = snapshot(root);
    // Collect immediately from these bytes; no caller-supplied graph is accepted.
    const metadata = {
      schema: 1,
      kind: "compiler-graph-plan-input",
      acceptance: false,
      executionAllowed: false,
      source,
      typescript: typescriptGraph(root),
      go: null,
    };
    const metadataFile = path.join(output, "fresh-compiler.json");
    fs.writeFileSync(metadataFile, JSON.stringify(metadata));
    const plan = JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        [
          "-B",
          path.join(import.meta.dirname, "testops.py"),
          "--root",
          root,
          "affected",
          "--base",
          "HEAD",
          "--compiler-metadata",
          metadataFile,
        ],
        { cwd: root, env, encoding: "utf8", timeout: 30000 },
      ),
    );
    const selected = plan.selected.map((record) => record.path);
    assert.equal(plan.status, "PLAN_ONLY");
    assert.equal(plan.executionAllowed, false);
    assert.deepEqual(selected, ["tests/a.test.ts", "tests/consumer.test.ts"]);
    assert.deepEqual(snapshot(root), source);

    const reports = [];
    for (const [mode, selection] of [
      [
        "complete",
        Object.keys(files)
          .filter((file) => file.endsWith(".test.ts"))
          .sort(),
      ],
      ["selected", selected],
    ]) {
      const reportFile = path.join(output, mode + ".json");
      const args = [
        path.join(repository, "node_modules/vitest/vitest.mjs"),
        "run",
        "--root",
        root,
        "--config",
        path.join(root, "vitest.config.mjs"),
        ...selection,
        "--maxWorkers=1",
        "--no-file-parallelism",
        "--reporter=json",
        "--outputFile=" + reportFile,
      ];
      const stdout = fs.openSync(path.join(output, mode + ".stdout.log"), "wx");
      const stderr = fs.openSync(path.join(output, mode + ".stderr.log"), "wx");
      const child = spawn(process.execPath, args, {
        cwd: root,
        env,
        stdio: ["ignore", stdout, stderr],
      });
      // Install terminal observation immediately; no receipt I/O precedes it.
      const waiting = waitForOwnedSecondary(child, {
        timeoutMs: 30000,
        cleanupTimeoutMs: 5000,
      });
      let closeError;
      for (const descriptor of [stdout, stderr]) {
        try {
          fs.closeSync(descriptor);
        } catch (error) {
          closeError ??= error;
        }
      }
      const terminal = await waiting;
      fs.writeFileSync(
        path.join(output, mode + ".terminal.json"),
        JSON.stringify(terminal),
      );
      if (closeError) throw closeError;
      assert.equal(
        terminal.terminal,
        true,
        "Retain fixture: original child terminal unknown",
      );
      assert.equal(terminal.exit, 0);
      assert.equal(terminal.signal, null);
      assert.equal(terminal.timedOut, false);
      assert.equal(terminal.stopRequested, false);
      const report = JSON.parse(fs.readFileSync(reportFile));
      const counts = vitestCounts(
        report,
        selection.map((file) => path.join(root, file)),
      );
      assert.equal(counts.failed, 0);
      assert.equal(counts.reportedSuccess, true);
      assert.deepEqual(
        snapshot(root),
        source,
        "Runner cache/HOME must not change observed source",
      );
      reports.push(report);
    }
    const cases = (records) =>
      records.map((record) => [
        record.name,
        record.assertionResults.map((a) => [a.fullName, a.status]),
      ]);
    assert.deepEqual(
      cases(
        reports[0].testResults.filter((record) =>
          selected.some((file) => record.name === path.join(root, file)),
        ),
      ),
      cases(reports[1].testResults),
    );
    assert.equal(reports[0].numTotalTests, 4);
    assert.equal(reports[1].numTotalTests, 3);
    complete = true;
  } catch (error) {
    error.message += "; retained owned fixture: " + root;
    throw error;
  } finally {
    // Failure/unknown evidence and vendor state stay local, never copied as source.
    if (complete) fs.rmSync(root, { recursive: true });
  }
});
