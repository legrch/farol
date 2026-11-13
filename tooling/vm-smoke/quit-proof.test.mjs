import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
const source = fs.readFileSync(
  new URL("./quit-proof.js", import.meta.url),
  "utf8",
);
function proof(receipt, running = false, unsafe = null) {
  const context = {
    ObjC: { import() {} },
    Ref: () => [],
    $: {
      NSHomeDirectory: () => ({ js: "/guest" }),
      NSFileManager: {
        defaultManager: {
          attributesOfItemAtPathError(path, error) {
            if (unsafe === "parent-denied" && path === "/guest/Library") {
              error[0] = { domain: { js: "NSCocoaErrorDomain" }, code: 257 };
              return null;
            }
            const marker = path.endsWith(".json");
            const exists = path.endsWith("running.json")
              ? running
              : receipt !== null;
            if (
              marker &&
              !exists &&
              unsafe !== "dangling-link" &&
              unsafe !== "unsafe-type"
            ) {
              error[0] = { domain: { js: "NSCocoaErrorDomain" }, code: 260 };
              return null;
            }
            return {
              js: {},
              objectForKey: () => ({
                js: !marker
                  ? "NSFileTypeDirectory"
                  : unsafe === "dangling-link"
                    ? "NSFileTypeSymbolicLink"
                    : unsafe === "unsafe-type"
                      ? "NSFileTypeDirectory"
                      : "NSFileTypeRegular",
              }),
            };
          },
        },
      },
      NSString: {
        stringWithContentsOfFileEncodingError: (path) => ({
          js:
            path === "identity"
              ? JSON.stringify({ dataLeaf: "test.product" })
              : receipt,
        }),
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return JSON.parse(context.run(["identity"]));
}
test("quit proof recognizes only canonical confirmed drain and retains marker evidence", () => {
  const receipt = {
    schema: 1,
    at: "2026-11-07T12:00:00.000Z",
    drained: true,
    unconfirmed: [],
  };
  assert.equal(proof(JSON.stringify(receipt)).drained, true);
  assert.equal(proof(JSON.stringify(receipt), true).running, true);
  for (const change of [
    { drained: false },
    { unconfirmed: ["core"] },
    { schema: 2 },
    { at: "yesterday" },
    { extra: true },
  ]) {
    assert.equal(
      proof(JSON.stringify({ ...receipt, ...change })).drained,
      false,
    );
  }
  for (const raw of [null, "bad JSON", "null"])
    assert.equal(proof(raw).drained, false);
});

for (const state of ["parent-denied", "dangling-link", "unsafe-type"]) {
  test(`quit proof retains ${state} as unconfirmed`, () => {
    const result = proof(null, false, state);
    assert.equal(result.runningMarker, "unconfirmed");
    assert.equal(result.receiptMarker, "unconfirmed");
    assert.equal(result.running, null);
  });
}
test("unreadable receipt is unconfirmed rather than absent", () => {
  assert.equal(proof(undefined).receiptMarker, "unconfirmed");
});
