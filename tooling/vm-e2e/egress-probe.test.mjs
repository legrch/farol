// Host-side tests for the egress probe bundle: the probe must bundle cleanly,
// run under plain node from an empty cwd, and produce a structured per-endpoint
// report. Whether endpoints are connectable depends on the environment (a
// networked host legitimately differs from the offline guest), so these tests
// assert the report SHAPE and the reservation of the synthetic endpoints —
// never a closure claim.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundleDriver, BUNDLE_FILE } from "./bundle-driver.mjs";
import { runProbe } from "./egress-probe-entry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function bundleProbe(out) {
  return bundleDriver({ entry: path.join(HERE, "egress-probe-entry.mjs"), outputDir: out, root: ROOT });
}

test("probe bundles into a self-contained driver with a complete manifest", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "egress-probe-bundle-"));
  try {
    const manifest = bundleProbe(out);
    const bundlePath = path.join(out, BUNDLE_FILE);
    assert.ok(fs.existsSync(bundlePath), "bundle written");
    assert.equal(manifest.entry, "egress-probe-entry.mjs");
    assert.equal(manifest.bundle.file, BUNDLE_FILE);
    assert.ok(manifest.node?.path && manifest.node?.sha256, "runtime pinned by digest");
    const source = fs.readFileSync(bundlePath, "utf8");
    assert.ok(!/from\s+"\.\//u.test(source), "no relative imports remain in the bundle");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("probe report shape records every synthetic endpoint without provider contact", async () => {
  const report = await runProbe();
  assert.equal(report.scenario, "vm-e2e-egress-probe");
  assert.equal(report.probes.length, 5);
  const endpoints = new Set(report.probes.map((probe) => probe.endpoint));
  for (const reserved of ["192.0.2.1:443", "198.51.100.1:443", "203.0.113.1:443", "2001:db8::1:443", "invalid.test.invalid"]) {
    assert.ok(endpoints.has(reserved), `missing reserved endpoint ${reserved}`);
  }
  assert.equal(typeof report.externalConnectable, "boolean");
  for (const probe of report.probes) {
    assert.equal(typeof probe.connectable, "boolean");
    assert.equal(typeof probe.detail, "string");
    assert.ok(Number.isFinite(probe.milliseconds));
  }
});

test("bundled probe runs under plain node from an empty cwd and writes its result", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "egress-probe-bundle-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "egress-probe-run-"));
  try {
    const manifest = bundleProbe(out);
    const bundlePath = path.join(out, BUNDLE_FILE);
    // The bundler records the declared runtime but never copies it; staging
    // the binary is the VM step's job. Host tests run the recorded binary.
    const runtime = manifest.node?.path;
    assert.ok(runtime && fs.existsSync(runtime), "manifest records a real runtime");
    const resultDir = path.join(cwd, "results");
    const run = spawnSync(runtime, [bundlePath], {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, VM_E2E_RESULT_DIR: resultDir },
    });
    assert.equal(run.status, 0, `probe exited cleanly: ${run.stderr}`);
    const result = JSON.parse(fs.readFileSync(path.join(resultDir, "result.json"), "utf8"));
    assert.equal(result.scenario, "vm-e2e-egress-probe");
    assert.equal(result.status, "REPORTED");
    assert.equal(result.probes.length, 5);
    // The honest receipt: the run records the environment it observed, whether
    // networked host or offline guest. This host-side run makes no claim.
    assert.equal(typeof result.externalConnectable, "boolean");
    const residue = fs.readdirSync(resultDir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(residue, [], "result write left no temp residue");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
