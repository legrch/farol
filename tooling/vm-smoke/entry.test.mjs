import assert from "node:assert/strict";
import test from "node:test";
import { chooseRuntime } from "../vm-entry.mjs";

test("keeps an already declared runtime without probing", () => {
  assert.equal(
    chooseRuntime("24.20.0", "/node", ["24.20.0"], "/home", () => {
      throw Error("not called");
    }),
    "/node",
  );
});
test("an older shell runtime selects a declared local runtime", () => {
  const expected = "/home/.nvm/versions/node/v24.20.0/bin/node";
  assert.equal(
    chooseRuntime("22.19.0", "/old", ["24.20.0"], "/home", (candidate) =>
      candidate === expected ? "24.20.0" : null,
    ),
    expected,
  );
});
test("does not silently use an undeclared newer runtime or install one", () => {
  assert.throws(
    () =>
      chooseRuntime("22.19.0", "/old", ["24.20.0"], "/home", () => "26.12.0"),
    /DECLARED_NODE_RUNTIME_MISSING/,
  );
});

test("a signal-killed or status-less child is outcome unknown, never exit 1", async () => {
  const { childExitStatus } = await import("../vm-child-exit.mjs");
  const written = [];
  const stderr = { write: (text) => written.push(text) };
  assert.equal(
    childExitStatus({ status: 0, signal: null }, "SMOKE", stderr),
    0,
  );
  assert.equal(
    childExitStatus({ status: 1, signal: null }, "SMOKE", stderr),
    1,
  );
  assert.equal(
    childExitStatus({ status: 2, signal: null }, "SMOKE", stderr),
    2,
  );
  assert.deepEqual(written, []);
  assert.equal(
    childExitStatus({ status: null, signal: "SIGTERM" }, "SMOKE", stderr),
    2,
  );
  assert.equal(
    childExitStatus({ status: null, signal: null }, "DEV", stderr),
    2,
  );
  assert.match(written[0], /^VM_SMOKE_OUTCOME_UNKNOWN: .*SIGTERM/);
  assert.match(written[1], /^VM_DEV_OUTCOME_UNKNOWN/);
  assert.throws(
    () => childExitStatus({ error: Error("ENOENT") }, "SMOKE", stderr),
    /ENOENT/,
  );
});

test("the wrappers use the classified child exit mapping", async () => {
  const fs = await import("node:fs");
  for (const name of ["vm-entry.mjs", "vm-machine.mjs", "vm-smoke.mjs"]) {
    const source = fs.readFileSync(
      new URL("../" + name, import.meta.url),
      "utf8",
    );
    assert.match(source, /childExitStatus\(result, /, name);
    assert.doesNotMatch(source, /result\.status \?\? 1/, name);
  }
});

test("vm:dev outcome-unknown and unclassified codes exit 2, refusals 1", async () => {
  const { vmDevRefusalExit } = await import("../vm-dev.mjs");
  assert.equal(vmDevRefusalExit("VM_DEV_RECEIPT_INVALID"), 1);
  assert.equal(vmDevRefusalExit("VM_DEV_SESSION_OUTCOME_UNKNOWN"), 2);
  assert.equal(vmDevRefusalExit("VM_DEV_BUILD_OUTCOME_UNKNOWN"), 2);
  assert.equal(vmDevRefusalExit("VM_DEV_UNCLASSIFIED"), 2);
  assert.equal(vmDevRefusalExit("not a code"), 2);
});
