import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { candidatePaths } from "../../tooling/candidate-contract.mjs";
import { packageLayout } from "../../tooling/package-layout.mjs";

// Real Electron ASAR cleanup of a disposable synthetic package. Extraction and
// verification replies are in-process fixtures; the probe owns no descendants.
// This does not prove archive extraction, package identity or a live upgrade.
const options = process.argv.slice(2);
assert(
  options.length === 0 ||
    (options.length === 1 &&
      ["--child-dispatch-fault", "--probe-timeout-fault"].includes(options[0])),
);
const childDispatchFault = options[0] === "--child-dispatch-fault";
const probeTimeoutFault = options[0] === "--probe-timeout-fault";
const root = path.resolve(import.meta.dirname, "../..");
const { artifactFile, appPath } = candidatePaths(root);
const artifact = JSON.parse(await fs.readFile(artifactFile, "utf8"));
const layout = packageLayout(artifact.schema);
const runtime = path.join(appPath, "Contents/Frameworks/Electron Runtime.app");
const executable = path.join(runtime, "Contents/MacOS/Electron");
const expected = { ...artifact, channel: "owner-beta", signing: "unsigned" };
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "farol-asar-cleanup-"));
let probeEnded = true;
try {
  const archive = path.join(scratch, "fixture.zip");
  const stage = path.join(scratch, "stage");
  await fs.mkdir(stage, { mode: 0o700 });
  const publicArtifact = {
    ...artifact,
    artifactPath: layout.appName,
  };
  const vendorAsar = path.join(runtime, "Contents/Resources/default_app.asar");
  await fs.writeFile(
    archive,
    "synthetic archive; extraction is an in-process fixture",
  );
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
const cp = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
let fixtureCalls = 0;
const noChild = () => { throw new Error("ASAR_FIXTURE_CHILD_DISPATCH_FORBIDDEN"); };
for (const name of ["exec", "spawn", "fork", "execSync", "execFileSync", "spawnSync"])
  cp[name] = () => noChild();
cp.execFile = () => noChild();
cp.execFile[promisify.custom] = async (command, args) => {
  fixtureCalls++;
  if (fixtureCalls === 1) {
    assert.equal(command, "/usr/bin/python3");
    assert.equal(args[4], ${JSON.stringify(archive)});
    const stagingRoot = args[5];
    assert.equal(path.dirname(stagingRoot), await raw.realpath(${JSON.stringify(stage)}));
    const appPath = path.join(stagingRoot, ${JSON.stringify(layout.appName)});
    const resources = path.join(appPath, "Contents/Resources");
    await raw.mkdir(resources, { recursive: true });
    await raw.copyFile(${JSON.stringify(vendorAsar)}, path.join(resources, "default_app.asar"));
    const artifactPath = path.join(stagingRoot, "artifact.json");
    await raw.writeFile(artifactPath, ${JSON.stringify(JSON.stringify(publicArtifact))});
    return { stdout: JSON.stringify({ appPath, artifactPath }), stderr: "" };
  }
  assert.equal(fixtureCalls, 2);
  assert.equal(command, process.execPath);
  assert.equal(args[0], ${JSON.stringify(fixtureReply)});
  return { stdout: JSON.stringify(${JSON.stringify({ ...artifact, signing: "unsigned" })}), stderr: "" };
};
${childDispatchFault ? 'cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);' : ""}
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
  assert.equal(fixtureCalls, 2, "extractor and verifier must be in-process fixtures");
  console.log(JSON.stringify({ result: "PASS", physicalCleanup: true, descendantDispatch: "FORBIDDEN", liveGithub: "NOT_RUN" }));
  ${probeTimeoutFault ? "setInterval(() => {}, 1000);" : ""}
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
  );
  probeEnded = false;
  const result = spawnSync(executable, [probe], {
    encoding: "utf8",
    timeout: probeTimeoutFault ? 2_000 : 120_000,
    killSignal: "SIGKILL",
    env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
  });
  probeEnded =
    Number.isInteger(result.status) || typeof result.signal === "string";
  assert(probeEnded, "ASAR_PROBE_EXIT_UNCONFIRMED: scratch retained");
  if (probeTimeoutFault) {
    assert.equal(result.error?.code, "ETIMEDOUT");
    assert.equal(result.signal, "SIGKILL");
    assert.match(result.stdout, /"physicalCleanup":true/);
    process.stdout.write(
      "PASS: owned probe timeout observed terminal; descendant dispatch forbidden.\n",
    );
  } else {
    assert.ifError(result.error);
    if (childDispatchFault) {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ASAR_FIXTURE_CHILD_DISPATCH_FORBIDDEN/);
      process.stdout.write(
        "PASS: injected descendant dispatch refused before spawn.\n",
      );
    } else {
      assert.equal(result.status, 0, result.stderr);
      process.stdout.write(result.stdout);
    }
  }
} finally {
  if (probeEnded) {
    await fs.rm(scratch, { recursive: true, force: true });
    await assert.rejects(fs.lstat(scratch), { code: "ENOENT" });
  }
}
