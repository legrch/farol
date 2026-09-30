import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import {
  assertCanonicalArtifactPath,
  candidatePaths,
} from "../../tooling/candidate-contract.mjs";

// Real local package verification only; this is not GitHub or installed-update acceptance.
assert.equal(process.argv.length, 2, "UPDATE_PACKAGE_TEST_ARGUMENTS_INVALID");
const root = path.resolve(import.meta.dirname, "../..");
const { artifactFile, appPath } = candidatePaths(root);
const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
assertCanonicalArtifactPath(root, artifact);
assert.equal(artifact.updateChannel, "github-owner-beta");
const expected = { ...artifact, channel: "owner-beta", signing: "unsigned" };
const scratch = await fs.mkdtemp(
  path.join(os.tmpdir(), "farol-update-identity-"),
);
try {
  const contract = path.join(scratch, "contract.mjs");
  buildSync({
    entryPoints: [path.join(root, "src/modules/release/app/github-release.ts")],
    outfile: contract,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { packageMatchesRelease } = await import(pathToFileURL(contract).href);
  const observations = [];
  for (const [label, executable, entry] of [
    [
      "source",
      process.execPath,
      path.join(root, "tooling/verify-package-standalone.mjs"),
    ],
    [
      "packaged",
      path.join(
        appPath,
        "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron",
      ),
      path.join(appPath, "Contents/Resources/app/update-package.mjs"),
    ],
  ]) {
    const result = spawnSync(
      executable,
      [
        entry,
        artifactFile,
        appPath,
        artifact.version,
        artifact.buildVersion,
        artifact.updateChannel,
      ],
      {
        encoding: "utf8",
        maxBuffer: 8192,
        timeout: 120_000,
        killSignal: "SIGKILL",
        env: {
          PATH: "/usr/bin:/bin",
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_NO_ASAR: "1",
        },
      },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.equal(
      actual.updateChannel,
      artifact.updateChannel,
      `${label} verifier must return the measured channel`,
    );
    assert.equal(
      packageMatchesRelease(actual, expected),
      true,
      `${label} measured identity must satisfy the updater`,
    );
    assert.equal(
      packageMatchesRelease(actual, { ...expected, channel: "stable" }),
      false,
      "a foreign release channel must remain refused",
    );
    const { updateChannel: _channel, ...missingChannel } = actual;
    assert.equal(
      packageMatchesRelease(missingChannel, expected),
      false,
      "a missing channel must remain refused",
    );
    observations.push({
      verifier: label,
      exit: result.status,
      identity: actual,
    });
  }
  process.stdout.write(
    JSON.stringify({ result: "PASS", observations, liveGithub: "NOT_RUN" }) +
      "\n",
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
  await assert.rejects(fs.lstat(scratch), { code: "ENOENT" });
}
