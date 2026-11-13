// Host-side tests for the egress probe bundle. vm:test is closed and offline:
// these tests never run the probe, so no DNS query or TCP SYN leaves the host.
// The probe's behaviour is exercised with in-memory DNS/TCP doubles in
// driver-entries.synthetic.test.mjs; here only bundling is checked, under a
// guard that fails if anything reaches node:net or node:dns.
import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundleDriver, BUNDLE_FILE } from "./bundle-driver.mjs";

const egress = [];
for (const [module, names] of [
  [net, ["connect", "createConnection"]],
  [dns, ["resolve", "resolve4", "resolve6", "lookup"]],
]) {
  for (const name of names) {
    module[name] = (...args) => {
      egress.push([name, String(args[0])]);
      throw Error("vm:test must not perform network I/O");
    };
  }
}
await import("./egress-probe-entry.mjs"); // importing alone never probes

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function bundleProbe(out) {
  return bundleDriver({
    entry: path.join(HERE, "egress-probe-entry.mjs"),
    outputDir: out,
    root: ROOT,
  });
}

test("probe bundles into a self-contained driver with a complete manifest", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "egress-probe-bundle-"));
  try {
    const manifest = bundleProbe(out);
    const bundlePath = path.join(out, BUNDLE_FILE);
    assert.ok(fs.existsSync(bundlePath), "bundle written");
    assert.equal(manifest.entry, "egress-probe-entry.mjs");
    assert.equal(manifest.bundle.file, BUNDLE_FILE);
    assert.ok(
      manifest.node?.path && manifest.node?.sha256,
      "runtime pinned by digest",
    );
    const source = fs.readFileSync(bundlePath, "utf8");
    assert.ok(
      !/from\s+"\.\//u.test(source),
      "no relative imports remain in the bundle",
    );
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("vm:test never performs DNS or TCP egress for the probe", () => {
  assert.deepEqual(egress, []);
});
