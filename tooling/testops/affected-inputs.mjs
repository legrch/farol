// Internal data adapter. The Linux observer authenticates dependencies first.
import fs from "node:fs";
import path from "node:path";
import { snapshot, typescriptGraph, collectGo } from "./languagegraph.mjs";
import { discoverTests, vitestCounts } from "../test-scopes.mjs";
import { planTests } from "../test-scope-plan.mjs";
import { coreTestSteps, coreProtocolFiles } from "../core-test-plan.mjs";

const root = "/workspace";
const directory = path.join(root, "_output/affected-iteration");
const write = (name, value) =>
  fs.writeFileSync(path.join(directory, name), JSON.stringify(value), {
    flag: "wx",
    mode: 0o600,
  });
const [mode, name, expectedFiles, ...extra] = process.argv.slice(2);
if (extra.length) throw Error("AFFECTED_INTERNAL_ARGUMENT_INVALID");
if (
  ["collect", "collect-focused"].includes(mode) &&
  name === undefined &&
  expectedFiles === undefined
) {
  const source = snapshot(root);
  const metadata = {
    schema: 1,
    kind: "compiler-graph-plan-input",
    acceptance: false,
    executionAllowed: false,
    source,
    typescript: typescriptGraph(root),
    go: collectGo(root, source, {
      go: "/usr/local/go/bin/go",
      goSha256:
        "ccf0a11f03d2eeaa8b67eaad5ed460fd4968a0283adbc8897205d6faca59f0a9",
      cache: path.join(root, "_output"),
      ...(mode === "collect-focused" ? { runtime: "linux-arm64-race" } : {}),
    }),
  };
  if (JSON.stringify(snapshot(root)) !== JSON.stringify(source))
    throw Error("AFFECTED_COMPILER_SOURCE_CHANGED");
  write("compiler.json", metadata);
  write("cloud.json", planTests("cloud", discoverTests(root)));
} else if (
  mode === "validate-core" &&
  name === undefined &&
  expectedFiles === undefined
) {
  const lines = fs
    .readFileSync(path.join(directory, "complete-core.stdout.log"), "utf8")
    .split("\n")
    .filter((line) =>
      line.startsWith('{"schema":"farol-core-test-completion/1"'),
    );
  const expected = {
    schema: "farol-core-test-completion/1",
    completedSteps: coreTestSteps({
      nested: true,
      node: process.execPath,
      go: "go",
    }).map((step) => step.id),
    nested: true,
    protocolFiles: coreProtocolFiles,
  };
  if (
    lines.length !== 1 ||
    JSON.stringify(JSON.parse(lines[0])) !== JSON.stringify(expected)
  )
    throw Error("AFFECTED_COMPLETE_CORE_RECEIPT_REQUIRED");
  write("complete-core.completion.json", expected);
} else if (mode === "validate" && /^node-[a-z0-9-]+$/u.test(name ?? "")) {
  // This expectation comes from the original observer's memory. Test-writable
  // projection/report sidecars never become execution or validation authority.
  const files = JSON.parse(expectedFiles);
  if (
    !Array.isArray(files) ||
    !files.length ||
    new Set(files).size !== files.length ||
    files.some(
      (file) =>
        typeof file !== "string" ||
        !/^tests\/[A-Za-z0-9_./-]+\.test\.(ts|tsx|mjs)$/u.test(file) ||
        file.split("/").includes(".."),
    )
  )
    throw Error("AFFECTED_SUITE_NOT_ADMITTED");
  const counts = vitestCounts(
    JSON.parse(fs.readFileSync(path.join(directory, name + ".json"), "utf8")),
    files.map((file) => path.join(root, file)),
  );
  if (counts.failed || !counts.reportedSuccess)
    throw Error("AFFECTED_TEST_FAILURE");
  write(name + ".counts.json", counts);
} else {
  throw Error("AFFECTED_INTERNAL_ARGUMENT_INVALID");
}
