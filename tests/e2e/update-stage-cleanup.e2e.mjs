import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { candidatePaths } from "../../tooling/candidate-contract.mjs";

// Real Electron ASAR cleanup of a disposable synthetic package. The verifier
// reply is a fixture; this does not prove package identity or a live upgrade.
const root = path.resolve(import.meta.dirname, "../..");
const { artifactFile, appPath } = candidatePaths(root);
const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
const runtime = path.join(appPath, "Contents/Frameworks/Electron Runtime.app");
const executable = path.join(runtime, "Contents/MacOS/Electron");
const expected = { ...artifact, channel: "owner-beta", signing: "unsigned" };
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "farol-asar-cleanup-"));
try {
  const archive = path.join(scratch, "fixture.zip");
  const stage = path.join(scratch, "stage");
  await fs.mkdir(stage, { mode: 0o700 });
  const publicArtifact = {
    ...artifact,
    artifactPath: "Farol Next Preview.app",
  };
  const vendorAsar = path.join(runtime, "Contents/Resources/default_app.asar");
  const made = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      `
import json, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_DEFLATED) as z:
    z.write(sys.argv[2], "Farol Next Preview.app/Contents/Resources/default_app.asar")
    info = zipfile.ZipInfo("artifact.json")
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    z.writestr(info, sys.argv[3])
`,
      archive,
      vendorAsar,
      JSON.stringify(publicArtifact),
    ],
    { encoding: "utf8" },
  );
  assert.equal(made.status, 0, made.stderr);
  const bytes = await fs.readFile(archive);
  const { createHash } = await import("node:crypto");
  expected.archiveSize = bytes.length;
  expected.archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  const fixtureReply = path.join(scratch, "fixture-reply.cjs");
  await fs.writeFile(
    fixtureReply,
    `console.log(${JSON.stringify(JSON.stringify({ ...artifact, signing: "unsigned" }))});`,
  );
  const verifier = path.join(scratch, "verifier.cjs");
  buildSync({
    entryPoints: [
      path.join(
        root,
        "src/modules/release/infra/native/update-package-verifier.ts",
      ),
    ],
    outfile: verifier,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const probe = path.join(scratch, "probe.cjs");
  await fs.writeFile(
    probe,
    `
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const raw = require("original-fs").promises;
const { createUpdatePackageVerifier } = require(${JSON.stringify(verifier)});
(async () => {
  let removals = 0;
  const verifier = createUpdatePackageVerifier({
    archivePathForHandle: async () => ${JSON.stringify(archive)},
    stagingParent: ${JSON.stringify(stage)},
    extractorPath: ${JSON.stringify(path.join(root, "resources/native/update_archive.py"))},
    verifierPath: ${JSON.stringify(fixtureReply)},
    removeDirectory: async (directory, force) => {
      removals++;
      await raw.rm(directory, { recursive: true, force });
    },
  });
  const result = await verifier.verifyPackage("fixture", ${JSON.stringify(expected)});
  const asar = require("node:path").join(result.stagedAppPath, "Contents/Resources/default_app.asar");
  assert.equal((await fs.stat(asar)).isDirectory(), true, "must exercise Electron virtual ASAR semantics");
  await verifier.discard("fixture");
  assert.equal(removals, 1, "physical cleanup port must remove the verified stage");
  await assert.rejects(raw.lstat(result.stagingRoot), { code: "ENOENT" });
  assert.equal(verifier.verifiedAppPath("fixture"), null);
  console.log(JSON.stringify({ result: "PASS", physicalCleanup: true, liveGithub: "NOT_RUN" }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
  );
  const result = spawnSync(executable, [probe], {
    encoding: "utf8",
    timeout: 120_000,
    env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  process.stdout.write(result.stdout);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
  await assert.rejects(fs.lstat(scratch), { code: "ENOENT" });
}
