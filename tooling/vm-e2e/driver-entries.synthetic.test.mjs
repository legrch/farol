// Evaluate actual entrypoint source with explicit in-memory HTTP/TCP/DNS adapters.
// No socket or DNS resolver is called. Result writing uses the real module.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { writeResult } from "./driver-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const contracts = JSON.parse(fs.readFileSync(path.join(HERE, "scenario-contracts.json"), "utf8"));

async function exercise(t, entry, badHTTP = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-entry-synthetic-"));
  const contextFile = path.join(root, "context.json");
  const selected = contracts.entries[entry];
  fs.writeFileSync(contextFile, JSON.stringify({ schema: "farol.vm-e2e.context/1", runId: "run-" + "a".repeat(32),
    ...selected, bundleSha256: "b".repeat(64), artifact: { sourceCommit: "c".repeat(40),
      buildId: "d".repeat(64), artifactSha256: "e".repeat(64), archiveSha256: "f".repeat(64) } }));
  const saved = [process.env.VM_E2E_CONTEXT_FILE, process.env.VM_E2E_RESULT_DIR];
  process.env.VM_E2E_CONTEXT_FILE = contextFile;
  process.env.VM_E2E_RESULT_DIR = path.join(root, "results");
  t.after(() => {
    for (const [i, key] of ["VM_E2E_CONTEXT_FILE", "VM_E2E_RESULT_DIR"].entries()) {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let handler;
  let stopped = false;
  let fakeConnections = 0;
  const http = { createServer(callback) {
    handler = callback;
    return { once() {}, listen(_port, _host, done) { queueMicrotask(done); },
      address: () => ({ address: "127.0.0.1", port: 12345 }), closeIdleConnections() {},
      close(done) { stopped = true; queueMicrotask(done); } };
  } };
  const fetch = async (url) => {
    let status, body;
    handler({ url: new URL(url).pathname }, { writeHead(code) { status = badHTTP ? 503 : code; }, end(value) { body = value; } });
    return { status, text: async () => body, json: async () => JSON.parse(body) };
  };
  const net = { connect() {
    fakeConnections++;
    const socket = new EventEmitter();
    socket.setTimeout = () => socket;
    socket.destroy = () => socket;
    queueMicrotask(() => socket.emit("error", Object.assign(Error("synthetic network adapter"), { code: "ENETUNREACH" })));
    return socket;
  } };
  const dns = { resolve4(_name, done) { queueMicrotask(() => done({ code: "ENOTFOUND" })); } };
  let exit;
  const completed = new Promise((resolve) => { exit = resolve; });
  const file = path.join(HERE, entry);
  const context = vm.createContext({ Buffer, URL, fetch,
    process: { argv: [process.execPath, file], exit }, console: { error() {} } });
  const modules = {
    "node:http": { default: http }, "node:net": { default: net }, "node:dns": { default: dns },
    "node:fs": { default: fs }, "node:path": { default: path }, "node:url": { fileURLToPath },
    "./driver-runtime.mjs": { writeResult },
  };
  const module = new vm.SourceTextModule(fs.readFileSync(file, "utf8"), {
    context, identifier: pathToFileURL(file).href,
    initializeImportMeta(meta) { meta.url = pathToFileURL(file).href; },
  });
  await module.link((specifier) => {
    assert.ok(Object.hasOwn(modules, specifier), "unexpected dependency: " + specifier);
    const values = modules[specifier];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  let timer;
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(Error("synthetic entry did not terminate")), 2000); });
  let code;
  try { code = await Promise.race([completed, timeout]); } finally { clearTimeout(timer); }
  const result = JSON.parse(fs.readFileSync(path.join(root, "results/result.json"), "utf8"));
  assert.equal(result.schema, "farol.vm-e2e.result/1");
  assert.equal(result.scenario, selected.scenario);
  assert.deepEqual(result.cases.map((item) => item.id), selected.selection);
  return { code, result, stopped, fakeConnections };
}

test("actual prototype entry emits bound PASS with synthetic HTTP only", async (t) => {
  const r = await exercise(t, "prototype-entry.mjs");
  assert.equal(r.code, 0); assert.equal(r.result.status, "PASS"); assert.equal(r.stopped, true);
});
test("actual prototype assertion failure emits bound FAIL", async (t) => {
  const r = await exercise(t, "prototype-entry.mjs", true);
  assert.equal(r.code, 1); assert.equal(r.result.status, "FAIL"); assert.equal(r.stopped, true);
});
test("actual fixture entry emits all mandatory bound checks", async (t) => {
  const r = await exercise(t, "fixture-probe-entry.mjs");
  assert.equal(r.code, 0); assert.equal(r.result.status, "PASS"); assert.equal(r.stopped, true);
});
test("actual fixture failed checks remain FAIL", async (t) => {
  const r = await exercise(t, "fixture-probe-entry.mjs", true);
  assert.equal(r.code, 1); assert.equal(r.result.status, "FAIL");
  assert.ok(r.result.cases.some((item) => item.status === "FAIL"));
});
test("actual egress entry remains REPORTED with synthetic DNS/TCP only", async (t) => {
  const r = await exercise(t, "egress-probe-entry.mjs");
  assert.equal(r.code, 0); assert.equal(r.result.status, "REPORTED");
  assert.equal(r.result.evidenceClass, "diagnostic"); assert.equal(r.fakeConnections, 4);
});
