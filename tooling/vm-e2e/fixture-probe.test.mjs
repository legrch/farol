// Host-side tests for the fixture probe: bundling, the loopback-only binding,
// the fail-closed missing route, and the full check matrix. The fixture is
// synthetic — these tests assert the driver contract, never live-provider
// compatibility.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundleDriver, BUNDLE_FILE } from "./bundle-driver.mjs";
import { runFixtureProbe } from "./fixture-probe-entry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function bundleProbe(out) {
  return bundleDriver({
    entry: path.join(HERE, "fixture-probe-entry.mjs"),
    outputDir: out,
    root: ROOT,
  });
}

test("fixture probe runs the full check matrix against its own loopback fixture", async () => {
  const report = await runFixtureProbe();
  assert.equal(report.scenario, "vm-e2e-fixture-probe");
  assert.match(report.fixtureUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(
    report.ok,
    true,
    "all checks pass: " + JSON.stringify(report.failed),
  );
  const names = report.checks.map((check) => check.name);
  assert.deepEqual(names, [
    "setup-page-status",
    "json-endpoint",
    "missing-route-fails-closed",
    "loopback-only-binding",
  ]);
  const byName = Object.fromEntries(
    report.checks.map((check) => [check.name, check]),
  );
  assert.equal(byName["missing-route-fails-closed"].detail.status, 404);
  assert.equal(byName["loopback-only-binding"].detail.address, "127.0.0.1");
  // The socket is released after the report: the same port state cannot leak.
  const second = await runFixtureProbe();
  assert.equal(second.ok, true);
});

test("fixture probe bundles self-contained and runs under plain node from an empty cwd", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-probe-bundle-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-probe-run-"));
  try {
    const manifest = bundleProbe(out);
    const bundlePath = path.join(out, BUNDLE_FILE);
    const source = fs.readFileSync(bundlePath, "utf8");
    assert.ok(
      !/from\s+"\.\//u.test(source),
      "no relative imports remain in the bundle",
    );
    const runtime = manifest.node?.path;
    assert.ok(runtime && fs.existsSync(runtime));
    const resultDir = path.join(cwd, "results");
    const run = spawnSync(runtime, [bundlePath], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, VM_E2E_RESULT_DIR: resultDir },
    });
    assert.equal(run.status, 0, `probe exited cleanly: ${run.stderr}`);
    const result = JSON.parse(
      fs.readFileSync(path.join(resultDir, "result.json"), "utf8"),
    );
    assert.equal(result.scenario, "vm-e2e-fixture-probe");
    assert.equal(result.status, "PASS");
    assert.equal(result.ok, true);
    assert.deepEqual(
      fs.readdirSync(resultDir).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
