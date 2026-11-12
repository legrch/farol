import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(
  new URL("./import-dev.js", import.meta.url),
  "utf8",
);

// No synthetic Foundation operation may run: this surface cannot qualify
// either durable ordering or descriptor-rooted destination confinement.
for (const state of [
  "absent receipt",
  "matching receipt",
  "unreadable receipt",
  "invalid UTF-8 receipt",
  "dangling receipt symlink",
  "symlinked profile",
  "symlinked intermediate credential parent",
]) {
  test(`import refuses ${state} before all filesystem and credential access`, () => {
    const calls = [];
    const forbidden = new Proxy(function () {}, {
      get(_target, key) {
        calls.push(String(key));
        throw Error("UNQUALIFIED_FILESYSTEM_ACCESS");
      },
      apply() {
        calls.push("call");
        throw Error("UNQUALIFIED_FILESYSTEM_ACCESS");
      },
    });
    const context = vm.createContext({ $: forbidden, ObjC: { import() {} } });
    vm.runInContext(source, context);
    assert.throws(
      () => context.run(["identity", "/synthetic/stage"]),
      /GUEST_IMPORT_PERSISTENCE_UNQUALIFIED/,
    );
    assert.deepEqual(calls, []);
  });
}
