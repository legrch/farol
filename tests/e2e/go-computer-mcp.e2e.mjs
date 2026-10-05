/** Explicit native adapter witness. No Electron, tunnel, live client or provider. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertBuildIdentity } from "../../tooling/build-identity-contract.mjs";
import {
  BUILD_ENTRIES,
  verifyBuildEntries,
  verifyInputManifest,
} from "../../tooling/build-contract.mjs";
import {
  GO_CORE_ENTRIES,
  verifyGoCoreArtifact,
} from "../../tooling/go-core-artifact.mjs";
import {
  compilerProblems,
  dependencyDrift,
  readDependencyDigests,
  toolchainPackageRoots,
  packageRootOf,
} from "../../tooling/dependency-digests.mjs";
import { DECLARED_NODE_VERSIONS } from "../../tooling/dev.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const entry = "tests/e2e/go-computer-mcp.e2e.entry.ts";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const args = process.argv.slice(2),
  mode = args.shift();
assert.ok(["--check", "--run-native"].includes(mode));
const pins = {};
while (args.length) {
  const key = args.shift(),
    value = args.shift();
  assert.ok(
    ["--candidate-root", "--source-sha", "--build-id"].includes(key) &&
      value &&
      !Object.hasOwn(pins, key),
  );
  pins[key] = value;
}
const artifactRoot = pins["--candidate-root"];
assert.ok(path.isAbsolute(artifactRoot ?? ""));
assert.match(pins["--source-sha"] ?? "", /^[a-f0-9]{40}$/u);
assert.match(pins["--build-id"] ?? "", /^[a-f0-9]{64}$/u);
assert.ok(DECLARED_NODE_VERSIONS.includes(process.versions.node));
assert.equal(process.execArgv.length, 0);
assert.ok(
  !process.env.NODE_OPTIONS &&
    !process.env.NODE_PATH &&
    !process.env.ESBUILD_BINARY_PATH,
);
const output = path.join(
  root,
  "_output/evidence",
  `go-computer-mcp-${randomUUID()}`,
);
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const report = {
  schema: "farol-go-computer-mcp-witness/1",
  status: "checking",
  pins,
  limits: [
    "Production host constructors and built MCP/Go, not normal Electron startup or tunnel",
    "Synthetic disposable authority and legacy MCP stdio client, not ChatGPT qualification",
    "No provider calls or credentials; complete OS egress containment is not measured",
    "Not installed, shell/Git, restart recovery or full-range acceptance",
  ],
};
try {
  assert.equal(await fs.realpath(artifactRoot), artifactRoot);
  const json = async (name) =>
    JSON.parse(await fs.readFile(path.join(artifactRoot, name), "utf8"));
  const identity = assertBuildIdentity(await json("build-identity.json"));
  const manifest = await json("build-manifest.json");
  assert.equal(identity.sourceCommit, pins["--source-sha"]);
  assert.equal(identity.buildId, pins["--build-id"]);
  assert.equal(identity.sourceDirty, false);
  assert.equal(manifest.schema, 4);
  assert.equal(manifest.dirty, false);
  assert.equal(manifest.inputExact, true);
  assert.equal(manifest.sourceMode, "head-exact");
  assert.equal(manifest.sourceCommit, identity.sourceCommit);
  assert.equal(manifest.sourceTreeDigest, identity.sourceTreeDigest);
  assert.equal(manifest.buildId, identity.buildId);
  assert.deepEqual(
    manifest.entries,
    [...BUILD_ENTRIES, ...GO_CORE_ENTRIES].sort(),
  );
  await verifyBuildEntries(
    artifactRoot,
    manifest.entrySha256,
    manifest.entries,
  );
  await verifyInputManifest(artifactRoot, manifest);
  await verifyGoCoreArtifact(artifactRoot, manifest.core, identity);
  // A later test harness can consume a preserved candidate only when every
  // production input it joins is byte-exact to that candidate's sealed ledger.
  const ledger = new Map(
    (await json("input-manifest.json"))
      .filter(
        (v) => v.kind === "dependency" || (v.kind === "source" && v.exact),
      )
      .map((v) => [v.path, v.sha256]),
  );
  assert.deepEqual(compilerProblems(root), []);
  const packages = new Set(toolchainPackageRoots()),
    inputs = [];
  const { build } = await import("esbuild");
  const compiled = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "candidate-production-inputs",
        setup(context) {
          context.onLoad(
            { filter: /\.(?:[cm]?[jt]sx?|json)$/ },
            async ({ path: file }) => {
              const relative = path
                .relative(root, file)
                .split(path.sep)
                .join("/");
              assert.ok(
                !path.isAbsolute(relative) && !relative.startsWith("../"),
              );
              const stat = await fs.lstat(file);
              assert.ok(
                stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
              );
              const bytes = await fs.readFile(file),
                sha256 = hash(bytes);
              if (relative.startsWith("node_modules/"))
                packages.add(packageRootOf(relative));
              if (relative !== entry)
                assert.equal(
                  sha256,
                  ledger.get(relative),
                  `CANDIDATE_SOURCE_MISMATCH:${relative}`,
                );
              inputs.push({ path: relative, sha256 });
              const extension = path.extname(file).slice(1);
              return {
                contents: bytes,
                resolveDir: path.dirname(file),
                loader: ["mjs", "cjs"].includes(extension)
                  ? "js"
                  : ["mts", "cts"].includes(extension)
                    ? "ts"
                    : extension,
              };
            },
          );
        },
      },
    ],
  });
  assert.deepEqual(
    dependencyDrift(root, [...packages], readDependencyDigests(root)),
    [],
  );
  assert.equal(compiled.outputFiles.length, 1);
  const bundle = path.join(output, "witness.cjs");
  await fs.writeFile(bundle, compiled.outputFiles[0].contents, {
    flag: "wx",
    mode: 0o600,
  });
  report.identity = identity;
  report.core = manifest.core;
  report.harness = {
    sha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
    bundleSha256: hash(compiled.outputFiles[0].contents),
    inputs,
  };
  report.status = "checked-native-not-run";
  if (mode === "--run-native") {
    const { run } = createRequire(import.meta.url)(bundle);
    report.status = "native-running";
    await fs.writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    await run({
      artifactRoot,
      build: identity,
      artifact: manifest.core,
      output,
      report,
    });
    report.status = "passed-native-mcp-go-adapter";
  }
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : "unknown_failure";
  process.exitCode = 1;
} finally {
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      status: report.status,
      report: path.join(output, "report.json"),
      error: report.error,
    }) + "\n",
  );
}
