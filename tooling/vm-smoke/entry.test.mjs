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
