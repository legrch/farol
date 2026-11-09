// Pure/filesystem result-producer tests. No networking, runtime downloads or VM.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { writeResult } from "./driver-runtime.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-result-contract-"));
  const context = { schema: "farol.vm-e2e.context/1", runId: "run-" + "a".repeat(32),
    scenario: "vm-e2e-prototype", selection: ["http-status", "response-body"], evidenceClass: "infrastructure",
    bundleSha256: "b".repeat(64), artifact: { sourceCommit: "c".repeat(40), buildId: "d".repeat(64),
      artifactSha256: "e".repeat(64), archiveSha256: "f".repeat(64) } };
  const file = path.join(root, "context.json");
  fs.writeFileSync(file, JSON.stringify(context));
  const saved = { context: process.env.VM_E2E_CONTEXT_FILE, result: process.env.VM_E2E_RESULT_DIR };
  process.env.VM_E2E_CONTEXT_FILE = file;
  process.env.VM_E2E_RESULT_DIR = path.join(root, "results");
  t.after(() => {
    for (const [key, value] of [["VM_E2E_CONTEXT_FILE", saved.context], ["VM_E2E_RESULT_DIR", saved.result]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const value = { scenario: context.scenario, status: "PASS",
    cases: context.selection.map((id) => ({ id, status: "PASS" })) };
  return { root, context, file, value, read: () => JSON.parse(fs.readFileSync(path.join(root, "results/result.json"), "utf8")) };
}

test("actual writer binds context bytes, selection, artifact and scenario", (t) => {
  const f = fixture(t);
  writeResult(f.value);
  const result = f.read();
  assert.equal(result.schema, "farol.vm-e2e.result/1");
  for (const key of ["runId", "scenario", "selection", "artifact", "evidenceClass", "bundleSha256"]) {
    assert.deepEqual(result[key], f.context[key]);
  }
  assert.equal(result.contextSha256, crypto.createHash("sha256").update(fs.readFileSync(f.file)).digest("hex"));
  assert.equal(result.status, "PASS");
  assert.equal(result.reason, null);
});

test("writer rejects forged binding, wrong scenario and incomplete cases", (t) => {
  const f = fixture(t);
  for (const value of [null, [], {}, { ...f.value, runId: "foreign" }, { ...f.value, scenario: "foreign" },
    { ...f.value, status: "SUCCESS" }, { ...f.value, cases: [] },
    { ...f.value, cases: [f.value.cases[0], f.value.cases[0]] },
    { ...f.value, cases: f.context.selection.map((id) => ({ id, status: "NOT_RUN" })) }]) {
    assert.throws(() => writeResult(value));
    assert.equal(fs.existsSync(path.join(f.root, "results/result.json")), false);
  }
});

test("valid FAIL has a complete bound inventory without inventing executed passes", (t) => {
  const f = fixture(t);
  writeResult({ scenario: f.context.scenario, status: "FAIL", reason: "synthetic failure",
    cases: f.context.selection.map((id) => ({ id, status: "NOT_RUN" })) });
  const result = f.read();
  assert.equal(result.status, "FAIL");
  assert.ok(result.cases.every((item) => item.status === "NOT_RUN"));
  assert.equal(result.reason, "synthetic failure");
});

test("REPORTED is diagnostic and cannot be promoted to PASS", (t) => {
  const f = fixture(t);
  f.context.evidenceClass = "diagnostic";
  fs.writeFileSync(f.file, JSON.stringify(f.context));
  assert.throws(() => writeResult(f.value), /E2E_PASS_UNSUPPORTED/);
  writeResult({ scenario: f.context.scenario, status: "REPORTED",
    cases: f.context.selection.map((id) => ({ id, status: "REPORTED" })), externalConnectable: true });
  assert.equal(f.read().status, "REPORTED");
  assert.equal(f.read().details.externalConnectable, true);
});

test("bound producer refuses malformed, missing and aliased context", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '{}');
  assert.throws(() => writeResult(f.value));
  fs.unlinkSync(f.file);
  assert.throws(() => writeResult(f.value));
  const target = path.join(f.root, "other.json");
  fs.writeFileSync(target, JSON.stringify(f.context));
  fs.symlinkSync(target, f.file);
  assert.throws(() => writeResult(f.value));
  fs.unlinkSync(f.file);
  fs.linkSync(target, f.file);
  assert.throws(() => writeResult(f.value));
  assert.equal(fs.existsSync(path.join(f.root, "results/result.json")), false);
});

test("bound producer refuses a FIFO context without hanging or writing a result", { timeout: 12000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-context-fifo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fifo = path.join(root, "context.json");
  const made = spawnSync("/usr/bin/mkfifo", [fifo], { encoding: "utf8", timeout: 5000 });
  assert.equal(made.status, 0, made.stderr);
  const program = `const {writeResult} = await import(process.argv[1]);
    try { writeResult({}); process.exit(0); }
    catch (error) { process.stderr.write(error.message); process.exit(17); }`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program,
    new URL("./driver-runtime.mjs", import.meta.url).href], {
    encoding: "utf8", timeout: 5000,
    env: { VM_E2E_CONTEXT_FILE: fifo, VM_E2E_RESULT_DIR: path.join(root, "results") },
  });
  assert.equal(result.error, undefined, "context admission must not block on a FIFO");
  assert.equal(result.status, 17, result.stderr);
  assert.match(result.stderr, /E2E_CONTEXT_FILE_INVALID/);
  assert.equal(fs.existsSync(path.join(root, "results/result.json")), false);
});

test("standalone unbound infrastructure receipts stay unqualified, not silently rebound", (t) => {
  const f = fixture(t);
  delete process.env.VM_E2E_CONTEXT_FILE;
  writeResult({ status: "REPORTED", scenario: "standalone-observation" });
  assert.equal(f.read().schema, undefined);
  assert.equal(f.read().runId, undefined);
});
