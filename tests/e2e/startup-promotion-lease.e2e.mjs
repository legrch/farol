import { desktopIdentity as harnessDesktopIdentity } from "../../tooling/harness-identity.ts";
// Exact built Electron startup against a held, real macOS promotion lease.
// Disposable native HOME/profile only. No swap, updater open, account, connector
// or model action; this does not qualify the separate relaunch handoff.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sourceIdentity } from "../../tooling/source-identity.mjs";
import { verifyInputManifest } from "../../tooling/build-contract.mjs";
import {
  acquirePromotionLease,
  releasePromotionLease,
} from "../../tooling/promotion-lease.mjs";

assert.deepEqual(process.argv.slice(2), []);
const root = process.cwd();
const buildRoot = path.join(root, "_output/build/app");
const source = sourceIdentity(root, ".");
const build = JSON.parse(
  await fs.readFile(path.join(buildRoot, "build-manifest.json"), "utf8"),
);
const identity = JSON.parse(
  await fs.readFile(path.join(buildRoot, "build-identity.json"), "utf8"),
);
assert.equal(source.dirty, false, "STARTUP_LEASE_SOURCE_DIRTY");
assert.equal(build.sourceCommit, source.commit, "STARTUP_LEASE_BUILD_COMMIT");
assert.equal(
  build.sourceTreeDigest,
  source.treeDigest,
  "STARTUP_LEASE_BUILD_TREE",
);
assert.equal(build.dirty, false);
assert.equal(build.inputExact, true);
await verifyInputManifest(buildRoot, build);
const attemptId = randomUUID();
const evidence = path.join(
  root,
  "_output/evidence/startup-promotion-lease",
  attemptId,
);
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const report = {
  attemptId,
  source,
  buildId: identity.buildId,
  status: "running",
  child: null,
  failure: null,
  profile: null,
  checks: [],
};
const save = () =>
  fs.writeFile(
    path.join(evidence, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
await save();
const profile = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "farol-e2e-home-")),
);
report.profile = profile;
await fs.chmod(profile, 0o700);
const appData = path.join(profile, "app-data");
const userData = harnessDesktopIdentity("dev", appData).userData;
await fs.mkdir(appData, { mode: 0o700 });
const proof = randomUUID();
await fs.writeFile(path.join(profile, ".farol-e2e-root"), proof, {
  mode: 0o600,
});
const lease = await acquirePromotionLease(
  userData,
  "synthetic-updater",
  "promotion",
);
assert.ok(lease, "STARTUP_LEASE_HOLDER_REFUSED");
const marker = path.join(userData, "farol-state/running.json");
await assert.rejects(fs.lstat(marker), { code: "ENOENT" });
let child;
let closed = false;
try {
  await save();
  child = spawn(
    path.join(
      root,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    [
      path.join(buildRoot, "main.cjs"),
      `--user-data-dir=${userData}`,
      "--preview-window-mode=hidden",
    ],
    {
      cwd: root,
      env: {
        HOME: profile,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        TMPDIR: os.tmpdir(),
        FAROL_ENVIRONMENT: "dev",
        FAROL_E2E: "1",
        FAROL_E2E_APP_DATA: appData,
        FAROL_E2E_TEST_ROOT: profile,
        FAROL_E2E_TEST_PROOF: proof,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  report.child = {
    pid: child.pid ?? null,
    status: "running",
    exitCode: null,
    signal: null,
  };
  const completion = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let failure;
    const timer = setTimeout(() => {
      failure = new Error("STARTUP_LEASE_CHILD_TIMEOUT");
      // Retain the original handle/evidence. Never look up or signal a PID.
      try {
        child.kill("SIGKILL");
      } catch (error) {
        failure = error;
      }
    }, 15000);
    const collect = (target, bytes) => {
      if (stdout.length + stderr.length + bytes.length > 65536) {
        if (!failure) {
          failure = new Error("STARTUP_LEASE_CHILD_OUTPUT_BOUND");
          try {
            child.kill("SIGKILL");
          } catch (error) {
            failure = error;
          }
        }
        return;
      }
      if (target === "stdout") stdout += bytes.toString("utf8");
      else stderr += bytes.toString("utf8");
    };
    child.stdout.on("data", (bytes) => collect("stdout", bytes));
    child.stderr.on("data", (bytes) => collect("stderr", bytes));
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      report.child = { ...report.child, status: "closed", exitCode, signal };
      if (failure) reject(failure);
      else resolve({ exitCode, signal, stdout, stderr });
    });
  });
  // Attach observation before any asynchronous evidence write can miss a fast
  // launch error/close. This handler retains the original promise's result.
  void completion.catch(() => undefined);
  await save();
  const result = await completion;
  assert.equal(result.exitCode, 1, "STARTUP_LEASE_REFUSAL_EXIT");
  assert.equal(result.signal, null);
  assert.match(result.stderr, /FAROL_STARTUP_FAILURE:STARTUP_PROMOTION_BUSY/u);
  assert.match(result.stderr, /FAROL_SECOND_INSTANCE_RESULT:startup-failed/u);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /FAROL_SECOND_INSTANCE_RESULT:primary-started/u,
  );
  await assert.rejects(fs.lstat(marker), { code: "ENOENT" });
  report.checks = [
    "actual compiled startup refused held lease",
    "original child exited1/no signal",
    "fresh closed profile remains without a run marker",
    "no accepted primary startup",
  ];
  report.runMarker = "absent before and after refused startup";
  report.status = "passed";
} catch (error) {
  report.failure =
    error instanceof Error ? error.message : "STARTUP_LEASE_UNKNOWN";
  report.status = "failed";
  throw error;
} finally {
  // A known child close precedes lease release. An unknown close keeps both
  // receipt and lease until this harness exits; no recovery/startup is retried.
  if (!child || closed) await releasePromotionLease(lease);
  await save();
}
console.log(
  JSON.stringify({
    attemptId,
    source: source.commit,
    status: report.status,
    child: report.child,
    profileRetained: true,
    relaunch: "NOT_RUN",
  }),
);
